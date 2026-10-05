/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/log', 'N/https', 'N/search'], function (record, log, https, search) {

    var TM_B_ITEM_ID = 909;
    var AR_ACCOUNT = 675;
    var KEY_FIELD = 'custcol_3pl_fulfillment_key';

    // Parent / Component line type
    var TYPE_FIELD = 'custcol_item_parentcomp';
    var TYPE_PARENT = '1';
    var TYPE_OFF_BIKE = '4';

    // Item fields
    var ALSO_CATEGORY_FIELD = 'custitem_also_category';
    var MERCH_FIELD = 'custitem_merch_item';

    // Shipping Rate Setup
    var SHIPPING_RECORD = 'customrecord_shipping_rate_setup'; // VERIFY THIS ID
    var SHIP_ITEM_CATEGORY = 'custrecord_item_category';
    var SHIP_CATEGORY = 'custrecord_category';
    var SHIP_COST = 'custrecord_shipping_cost';
    var SHIP_MERCH = 'custrecord_merch_item';

    var SUITELET_URL = 'https://1039693.extforms.netsuite.com/app/site/hosting/scriptlet.nl'
        + '?script=3296&deploy=1&compid=1039693'
        + '&ns-at=AAEJ7tMQ7FbIvC7C4CXmDC6HpNyrI0buOQ0wPxjhFUdFg5WJjWA';


    function afterSubmit(context) {
        try {
            if (context.type !== context.UserEventType.CREATE && context.type !== context.UserEventType.EDIT) return;

            var fulfillment = context.newRecord;
            var fulfillmentId = fulfillment.id;
            var salesOrderId = fulfillment.getValue({ fieldId: 'createdfrom' });
            var orderId = fulfillment.getValue({ fieldId: 'custbody_celigo_etail_order_id' });

            if (!salesOrderId || !orderId) {
                log.audit('Invoice Not Created', 'Missing createdfrom or Celigo eTail Order ID.');
                return;
            }

            var lineCount = fulfillment.getLineCount({ sublistId: 'item' });

            // Only TM-B deposit item
            if (lineCount === 1) {
                var onlyItemId = Number(fulfillment.getSublistValue({ sublistId: 'item', fieldId: 'item', line: 0 }));

                if (onlyItemId === TM_B_ITEM_ID) {
                    closeSoLine(salesOrderId, TM_B_ITEM_ID);
                    log.audit('SO Closed', 'Only TM-B item fulfilled; Sales Order ' + salesOrderId + ' closed, no invoice created.');
                    return;
                }
            }

            var fulfilledLines = {};
            var hasDepositItem = false;
            var fulfillmentLocation = '';

            for (var i = 0; i < lineCount; i++) {
                var itemId = Number(fulfillment.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i }));
                var itemReceive = fulfillment.getSublistValue({ sublistId: 'item', fieldId: 'itemreceive', line: i });

                if (!itemReceive) continue;

                if (itemId === TM_B_ITEM_ID) {
                    hasDepositItem = true;
                    continue;
                }

                var fulfillmentKey = fulfillment.getSublistValue({ sublistId: 'item', fieldId: KEY_FIELD, line: i });
                if (!fulfillmentKey) continue;

                fulfilledLines[String(fulfillmentKey)] = Number(fulfillment.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i })) || 0;

                if (!fulfillmentLocation) fulfillmentLocation = fulfillment.getSublistValue({ sublistId: 'item', fieldId: 'location', line: i });
            }


            // ---------------- SHIPPING ----------------
            var fulfillmentShipping = getShippingCost(fulfillment, salesOrderId, fulfillmentId);
            var currentIFShipping = Number(fulfillment.getValue({ fieldId: 'shippingcost' })) || 0;

            if (currentIFShipping !== fulfillmentShipping) {
                record.submitFields({
                    type: record.Type.ITEM_FULFILLMENT,
                    id: fulfillmentId,
                    values: { shippingcost: fulfillmentShipping },
                    options: { enableSourcing: false, ignoreMandatoryFields: true }
                });

                log.audit('IF Shipping Updated', {
                    fulfillmentId: fulfillmentId,
                    oldShipping: currentIFShipping,
                    newShipping: fulfillmentShipping
                });
            }


            // ---------------- INVOICE ----------------
            var invoiceId = createInvoice(salesOrderId, fulfilledLines, fulfillmentLocation, fulfillmentId, fulfillmentShipping);

            if (hasDepositItem) closeSoLine(salesOrderId, TM_B_ITEM_ID);
            if (invoiceId) https.get({ url: SUITELET_URL + '&recid=' + invoiceId });

        } catch (e) {
            log.error('Invoice Creation Error', e.name + ': ' + e.message);
        }
    }


    function getShippingCost(fulfillment, salesOrderId, fulfillmentId) {
        try {
            // 1. Get SO shipping
            var so = record.load({ type: record.Type.SALES_ORDER, id: salesOrderId });
            var soShipping = Number(so.getValue({ fieldId: 'shippingcost' })) || 0;

            if (!soShipping) {
                log.audit('Shipping Skipped', 'Sales Order ' + salesOrderId + ' has no shipping cost.');
                return 0;
            }


            // 2. Read only Parent + Off-Bike fulfilled lines
            var lines = [];
            var itemIds = [];
            var lineCount = fulfillment.getLineCount({ sublistId: 'item' });

            for (var i = 0; i < lineCount; i++) {
                if (!fulfillment.getSublistValue({ sublistId: 'item', fieldId: 'itemreceive', line: i })) continue;

                var itemId = String(fulfillment.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i }) || '');
                var type = String(fulfillment.getSublistValue({ sublistId: 'item', fieldId: TYPE_FIELD, line: i }) || '');
                var qty = Number(fulfillment.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i })) || 0;

                if (!itemId || Number(itemId) === TM_B_ITEM_ID) continue;
                if (type !== TYPE_PARENT && type !== TYPE_OFF_BIKE) continue;

                lines.push({ itemId: itemId, type: type, qty: qty });

                // Parent doesn't need Item lookup; Off-Bike does
                if (type === TYPE_OFF_BIKE && itemIds.indexOf(itemId) === -1) itemIds.push(itemId);
            }

            if (!lines.length) {
                log.audit('Shipping Calculation', 'No Parent or Off-Bike lines found.');
                return 0;
            }


            // 3. Get Off-Bike item attributes
            var itemData = {};

            if (itemIds.length) {
                search.create({
                    type: search.Type.ITEM,
                    filters: [['internalid', 'anyof', itemIds]],
                    columns: ['internalid', ALSO_CATEGORY_FIELD, MERCH_FIELD]
                }).run().each(function (r) {

                    itemData[String(r.id)] = {
                        category: String(r.getValue(ALSO_CATEGORY_FIELD) || ''),
                        merch: r.getValue(MERCH_FIELD) === true || r.getValue(MERCH_FIELD) === 'T'
                    };

                    return true;
                });
            }


            // 4. Load Shipping Rate Setup records
            var rules = {};

            search.create({
                type: SHIPPING_RECORD,
                filters: [['isinactive', 'is', 'F']],
                columns: [SHIP_ITEM_CATEGORY, SHIP_CATEGORY, SHIP_MERCH, SHIP_COST]
            }).run().each(function (r) {

                var itemCategory = String(r.getValue(SHIP_ITEM_CATEGORY) || '');
                var category = String(r.getValue(SHIP_CATEGORY) || '');
                var merch = r.getValue(SHIP_MERCH) === true || r.getValue(SHIP_MERCH) === 'T';
                var rate = Number(r.getValue(SHIP_COST)) || 0;

                rules[itemCategory + '|' + category + '|' + (merch ? 'T' : 'F')] = rate;
                return true;
            });


            // 5. Calculate current IF shipping
            var calculatedShipping = 0;

            for (var x = 0; x < lines.length; x++) {
                var line = lines[x];
                var itemCategory = '';
                var category = '';
                var merch = false;
                var rate = 0;


                // Parent = Parent setup record
                if (line.type === TYPE_PARENT) {
                    itemCategory = TYPE_PARENT;
                    rate = Number(rules[TYPE_PARENT + '||F']) || 0;
                }


                // Off-Bike = match Item Category + Category + Merch
                if (line.type === TYPE_OFF_BIKE) {
                    var item = itemData[line.itemId];
                    if (!item) continue;

                    itemCategory = line.type;
                    category = item.category;
                    merch = item.merch;

                    // Exact match first
                    rate = Number(rules[itemCategory + '|' + category + '|' + (merch ? 'T' : 'F')]) || 0;

                    // Merch setup has blank Category
                    if (!rate && merch) rate = Number(rules[itemCategory + '||T']) || 0;
                }


                var amount = rate * line.qty;
                calculatedShipping += amount;

                log.audit('Shipping Line', {
                    item: line.itemId,
                    type: line.type,
                    itemCategory: itemCategory,
                    category: category,
                    merch: merch,
                    qty: line.qty,
                    rate: rate,
                    amount: amount
                });

                if (!rate) {
                    log.audit('Shipping Rate Not Found', {
                        item: line.itemId,
                        type: line.type,
                        itemCategory: itemCategory,
                        category: category,
                        merch: merch
                    });
                }
            }


            // 6. Sum shipping already used on other IFs
            var previousShipping = 0;

            search.create({
                type: search.Type.ITEM_FULFILLMENT,
                filters: [
                    ['createdfrom', 'anyof', salesOrderId],
                    'AND',
                    ['mainline', 'is', 'T'],
                    'AND',
                    ['internalid', 'noneof', fulfillmentId]
                ],
                columns: [
                    search.createColumn({
                        name: 'shippingamount',
                        summary: search.Summary.SUM
                    })
                ]
            }).run().each(function (r) {

                previousShipping = Number(r.getValue({
                    name: 'shippingamount',
                    summary: search.Summary.SUM
                })) || 0;

                return false;
            });


            // 7. Never exceed SO shipping
            var totalShipping = previousShipping + calculatedShipping;
            var shippingToSet = totalShipping <= soShipping ? calculatedShipping : 0;

            log.audit('Shipping Calculation', {
                salesOrder: salesOrderId,
                soShipping: soShipping,
                calculatedShipping: calculatedShipping,
                previousShipping: previousShipping,
                totalShipping: totalShipping,
                shippingApplied: shippingToSet
            });

            return shippingToSet;

        } catch (e) {
            log.error('Shipping Calculation Error', e.name + ': ' + e.message);
            return 0;
        }
    }


    function createInvoice(salesOrderId, fulfilledLines, fulfillmentLocation, fulfillmentId, fulfillmentShipping) {
        if (!Object.keys(fulfilledLines).length) {
            log.audit('Invoice Not Created', 'No fulfilled lines with a ' + KEY_FIELD + ' were found.');
            return null;
        }

        var invoice;

        try {
            invoice = record.transform({
                fromType: record.Type.SALES_ORDER,
                fromId: salesOrderId,
                toType: record.Type.INVOICE,
                isDynamic: true
            });
        } catch (e) {
            log.audit('Invoice Not Created', 'Sales Order ' + salesOrderId + ' has nothing left to bill (' + e.name + ').');
            return null;
        }

        invoice.setValue({ fieldId: 'account', value: AR_ACCOUNT });
        invoice.setValue({ fieldId: 'shippingcost', value: fulfillmentShipping || 0 });

        var lineCount = invoice.getLineCount({ sublistId: 'item' });

        for (var j = lineCount - 1; j >= 0; j--) {
            var key = String(invoice.getSublistValue({ sublistId: 'item', fieldId: KEY_FIELD, line: j }) || '');

            if (!fulfilledLines[key]) {
                invoice.removeLine({ sublistId: 'item', line: j });
                continue;
            }

            invoice.selectLine({ sublistId: 'item', line: j });
            invoice.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: fulfilledLines[key] });
            invoice.commitLine({ sublistId: 'item' });
        }

        if (!invoice.getLineCount({ sublistId: 'item' })) {
            log.audit('Invoice Not Created', 'No Invoice lines matched the fulfilled ' + KEY_FIELD + ' values.');
            return null;
        }

        if (fulfillmentLocation) invoice.setValue({ fieldId: 'location', value: fulfillmentLocation });

        var invoiceId = invoice.save({ enableSourcing: true, ignoreMandatoryFields: true });

        log.audit('Invoice Created', {
            invoiceId: invoiceId,
            fulfillmentId: fulfillmentId,
            shippingCost: fulfillmentShipping
        });

        return invoiceId;
    }


    function closeSoLine(salesOrderId, itemId) {
        try {
            var so = record.load({ type: record.Type.SALES_ORDER, id: salesOrderId, isDynamic: true });
            var lineIndex = so.findSublistLineWithValue({ sublistId: 'item', fieldId: 'item', value: itemId });

            if (lineIndex === -1) return;

            so.selectLine({ sublistId: 'item', line: lineIndex });
            so.setCurrentSublistValue({ sublistId: 'item', fieldId: 'isclosed', value: true });
            so.commitLine({ sublistId: 'item' });
            so.save({ enableSourcing: true, ignoreMandatoryFields: true });

            log.audit('SO Line Closed', 'Item ' + itemId + ' line closed on Sales Order ' + salesOrderId);

        } catch (e) {
            log.error('SO Line Close Error', e.name + ': ' + e.message);
        }
    }


    return {
        afterSubmit: afterSubmit
    };
});