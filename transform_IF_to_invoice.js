
/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/search', 'N/log', 'N/https'],
function (record, search, log, https) {

    // CONFIGURATION
    var TM_B_ITEM_ID = [909, 4075, 4076];
    var AR_ACCOUNT = 675;
    var KEY_FIELD = 'custcol_3pl_fulfillment_key';

    // Shipping Configuration
    var TYPE_FIELD = 'custcol_item_parentcomp';
    var TYPE_PARENT = '1', TYPE_OFF_BIKE = '4', TYPE_ON_BIKE = '3';
    var ALSO_CATEGORY_FIELD = 'custitem_also_category', MERCH_FIELD = 'custitem_merch_item';
    var SHIPPING_RECORD = 'customrecord_shipping_rate_setup';
    var SHIP_ITEM_CATEGORY = 'custrecord_item_category', SHIP_CATEGORY = 'custrecord_category';
    var SHIP_COST = 'custrecord_shipping_cost', SHIP_MERCH = 'custrecord_merch_item';

    var SUITELET_URL = 'https://1039693.extforms.netsuite.com/app/site/hosting/scriptlet.nl'
        + '?script=3296&deploy=1&compid=1039693'
        + '&ns-at=AAEJ7tMQ7FbIvC7C4CXmDC6HpNyrI0buOQ0wPxjhFUdFg5WJjWA';

    // GET RESERVATION ITEMS
    function getReservationItems(candidateIds) {
        var items = {};
        TM_B_ITEM_ID.forEach(function (id) { items[String(id)] = true; });
        if (!candidateIds.length) return items;

        var ids = TM_B_ITEM_ID.map(String);
        try {
            search.create({
                type: 'noninventoryitem',
                filters: [
                    ['type', 'anyof', 'NonInvtPart'], 'AND',
                    ['internalid', 'anyof'].concat(candidateIds), 'AND',
                    [['internalid', 'anyof'].concat(ids), 'OR', ['parent', 'anyof'].concat(ids)]
                ],
                columns: ['internalid']
            }).run().each(function (r) {
                items[String(r.id)] = true;
                return true;
            });
        } catch (e) {
            log.error('Reservation Item Search Failed', e.name + ': ' + e.message);
        }

        log.debug('Reservation Items', Object.keys(items));
        return items;
    }

    // MAP SALES ORDER DISCOUNT LINES
    function getDiscountParents(salesOrderId) {
        var map = {};
        try {
            var so = record.load({ type: record.Type.SALES_ORDER, id: salesOrderId });
            var parent = null;

            for (var i = 0; i < so.getLineCount({ sublistId: 'item' }); i++) {
                var type = so.getSublistValue({ sublistId: 'item', fieldId: 'itemtype', line: i });
                var lineId = String(so.getSublistValue({ sublistId: 'item', fieldId: 'line', line: i }));

                if (type === 'Discount') {
                    if (parent) map[lineId] = parent;
                    continue;
                }
                if (type === 'Description') continue;
                if (type === 'Subtotal') { parent = null; continue; }

                parent = {
                    key: String(so.getSublistValue({ sublistId: 'item', fieldId: KEY_FIELD, line: i }) || ''),
                    item: String(so.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i }))
                };
            }
        } catch (e) {
            log.error('Discount Parent Map Failed', e.name + ': ' + e.message);
        }

        log.debug('SO Discount Parents', map);
        return map;
    }

    // MAIN AFTER SUBMIT
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
            var candidateIds = [];

            for (var i = 0; i < lineCount; i++) {
                var candId = String(fulfillment.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i }));
                if (candId && candidateIds.indexOf(candId) === -1) candidateIds.push(candId);
            }

            var reservationItems = getReservationItems(candidateIds);

            // Only Reservation Item Fulfilled
            if (lineCount === 1) {
                var onlyItemId = String(fulfillment.getSublistValue({ sublistId: 'item', fieldId: 'item', line: 0 }));
                if (reservationItems[onlyItemId]) {
                    closeSoLines(salesOrderId, [onlyItemId]);
                    log.audit('SO Closed', 'Only Reservation Item ' + onlyItemId + ' fulfilled; no invoice created.');
                    return;
                }
            }

            var fulfilledLines = {}, itemsToClose = [], fulfillmentLocation = '';

            for (var j = 0; j < lineCount; j++) {
                var itemId = String(fulfillment.getSublistValue({ sublistId: 'item', fieldId: 'item', line: j }));
                if (!fulfillment.getSublistValue({ sublistId: 'item', fieldId: 'itemreceive', line: j })) continue;

                if (reservationItems[itemId]) {
                    if (itemsToClose.indexOf(itemId) === -1) itemsToClose.push(itemId);
                    continue;
                }

                var fulfillmentKey = fulfillment.getSublistValue({ sublistId: 'item', fieldId: KEY_FIELD, line: j });
                if (!fulfillmentKey) continue;

                fulfilledLines[String(fulfillmentKey)] =
                    Number(fulfillment.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: j })) || 0;

                if (!fulfillmentLocation) fulfillmentLocation = fulfillment.getSublistValue({ sublistId: 'item', fieldId: 'location', line: j });
            }

            log.debug('Fulfilled Lines', fulfilledLines);
            log.debug('Reservation Items To Close', itemsToClose);

            // NEW: SHIPPING COST AUTOMATION
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

            // EXISTING INVOICE CREATION
            var invoiceId = createInvoice(salesOrderId, fulfilledLines, fulfillmentLocation, fulfillmentId, reservationItems, fulfillmentShipping);

            closeSoLines(salesOrderId, itemsToClose);
            if (invoiceId) https.get({ url: SUITELET_URL + '&recid=' + invoiceId });

        } catch (e) {
            log.error('Invoice Creation Error', e.name + ': ' + e.message);
        }
    }

    // NEW: SHIPPING COST CALCULATION
    function getShippingCost(fulfillment, salesOrderId, fulfillmentId) {
        try {
            var so = record.load({ type: record.Type.SALES_ORDER, id: salesOrderId });
            var soShipping = Number(so.getValue({ fieldId: 'shippingcost' })) || 0;

            if (!soShipping) {
                log.audit('Shipping Skipped', 'Sales Order ' + salesOrderId + ' has no shipping cost.');
                return 0;
            }

            var lines = [], itemIds = [];
            var lineCount = fulfillment.getLineCount({ sublistId: 'item' });

            // Read Fulfilled Parent, Off-Bike and On-Bike Lines
            for (var i = 0; i < lineCount; i++) {
                if (!fulfillment.getSublistValue({ sublistId: 'item', fieldId: 'itemreceive', line: i })) continue;

                var itemId = String(fulfillment.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i }) || '');
                var type = String(fulfillment.getSublistValue({ sublistId: 'item', fieldId: TYPE_FIELD, line: i }) || '');
                var qty = Number(fulfillment.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i })) || 0;

                if (!itemId || TM_B_ITEM_ID.indexOf(Number(itemId)) !== -1) continue;
                if (type !== TYPE_PARENT && type !== TYPE_OFF_BIKE && type !== TYPE_ON_BIKE) continue;

                lines.push({ itemId: itemId, type: type, qty: qty });
                if ((type === TYPE_OFF_BIKE || type === TYPE_ON_BIKE) && itemIds.indexOf(itemId) === -1) itemIds.push(itemId);
            }

            if (!lines.length) {
                log.audit('Shipping Calculation', 'No eligible shipping lines found.');
                return 0;
            }

            // Get Item Attributes
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

            // Get Shipping Rates from Custom Record
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

            // Calculate Shipping Per Item
            var calculatedShipping = 0;

            for (var x = 0; x < lines.length; x++) {
                var line = lines[x], itemCategory = '', category = '', merch = false, rate = 0;

                if (line.type === TYPE_PARENT) {
                    itemCategory = TYPE_PARENT;
                    rate = Number(rules[TYPE_PARENT + '||F']) || 0;
                }

                if (line.type === TYPE_OFF_BIKE || line.type === TYPE_ON_BIKE) {
                    var item = itemData[line.itemId];
                    if (!item) continue;

                    itemCategory = line.type;
                    category = item.category;
                    merch = item.merch;

                    rate = Number(rules[itemCategory + '|' + category + '|' + (merch ? 'T' : 'F')]) || 0;
                    if (!rate && merch) rate = Number(rules[itemCategory + '||T']) || 0;
                }

                var amount = rate * line.qty;
                calculatedShipping += amount;

                log.audit('Shipping Line', {
                    item: line.itemId, type: line.type, itemCategory: itemCategory,
                    category: category, merch: merch, qty: line.qty, rate: rate, amount: amount
                });

                if (!rate) log.audit('Shipping Rate Not Found', {
                    item: line.itemId, type: line.type, itemCategory: itemCategory,
                    category: category, merch: merch
                });
            }

            // Shipping Already Charged on Other Fulfillments
            var previousShipping = 0;

            search.create({
                type: search.Type.ITEM_FULFILLMENT,
                filters: [
                    ['createdfrom', 'anyof', salesOrderId], 'AND',
                    ['mainline', 'is', 'T'], 'AND',
                    ['internalid', 'noneof', fulfillmentId]
                ],
                columns: [search.createColumn({ name: 'shippingamount', summary: search.Summary.SUM })]
            }).run().each(function (r) {
                previousShipping = Number(r.getValue({
                    name: 'shippingamount', summary: search.Summary.SUM
                })) || 0;
                return false;
            });

            // Do Not Exceed Sales Order Shipping
            var totalShipping = previousShipping + calculatedShipping;
            var shippingToSet = totalShipping <= soShipping ? calculatedShipping : 0;

            log.audit('Shipping Calculation', {
                salesOrder: salesOrderId, soShipping: soShipping,
                calculatedShipping: calculatedShipping, previousShipping: previousShipping,
                totalShipping: totalShipping, shippingApplied: shippingToSet
            });

            return shippingToSet;

        } catch (e) {
            log.error('Shipping Calculation Error', e.name + ': ' + e.message);
            return 0;
        }
    }

    // EXISTING INVOICE CREATION + SHIPPING FIELD
    function createInvoice(salesOrderId, fulfilledLines, fulfillmentLocation, fulfillmentId, reservationItems, fulfillmentShipping) {

        if (!Object.keys(fulfilledLines).length) {
            log.audit('Invoice Not Created', 'No fulfilled lines with a ' + KEY_FIELD + ' were found.');
            return null;
        }

        var discountParents = getDiscountParents(salesOrderId);
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
        invoice.setValue({ fieldId: 'shippingcost', value: fulfillmentShipping });
        invoice.setValue({ fieldId: 'custbody_ava_disable_tax_calculation', value: true });

        var lineCount = invoice.getLineCount({ sublistId: 'item' });
        var keepQty = {}, keepDiscount = {}, invoicedKeys = {};

        // STEP 1: Keep Fulfilled Item Lines
        for (var j = 0; j < lineCount; j++) {
            var type = invoice.getSublistValue({ sublistId: 'item', fieldId: 'itemtype', line: j });
            if (type === 'Discount' || type === 'Subtotal' || type === 'Description') continue;

            var lineItem = String(invoice.getSublistValue({ sublistId: 'item', fieldId: 'item', line: j }));
            if (reservationItems[lineItem]) continue;

            var key = String(invoice.getSublistValue({ sublistId: 'item', fieldId: KEY_FIELD, line: j }) || '');
            if (!fulfilledLines[key]) continue;

            keepQty[j] = fulfilledLines[key];
            invoicedKeys[key] = true;
        }

        // STEP 2: Keep Applicable Discounts
        for (var d = 0; d < lineCount; d++) {
            if (invoice.getSublistValue({ sublistId: 'item', fieldId: 'itemtype', line: d }) !== 'Discount') continue;

            var orderLine = String(invoice.getSublistValue({ sublistId: 'item', fieldId: 'orderline', line: d }) || '');
            var parent = discountParents[orderLine];

            if (parent && parent.key && invoicedKeys[parent.key] && !reservationItems[parent.item]) {
                keepDiscount[d] = true;
                log.debug('Discount Kept', 'Invoice line ' + d + ' | SO line ' + orderLine + ' | parent key ' + parent.key);
            } else {
                log.debug('Discount Dropped', 'Invoice line ' + d + ' | SO line ' + orderLine);
            }
        }

        // STEP 3: Set Fulfilled Quantities
        Object.keys(keepQty).forEach(function (idx) {
            invoice.selectLine({ sublistId: 'item', line: Number(idx) });
            invoice.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: keepQty[idx] });
            invoice.commitLine({ sublistId: 'item' });
        });

        // STEP 4: Remove Unfulfilled Lines
        for (var r = lineCount - 1; r >= 0; r--) {
            if (keepQty[r] === undefined && !keepDiscount[r]) invoice.removeLine({ sublistId: 'item', line: r });
        }

        if (!invoice.getLineCount({ sublistId: 'item' })) {
            log.audit('Invoice Not Created', 'No Invoice lines matched the fulfilled ' + KEY_FIELD + ' values.');
            return null;
        }

        if (fulfillmentLocation) invoice.setValue({ fieldId: 'location', value: fulfillmentLocation });

        var invoiceId = invoice.save({ enableSourcing: true, ignoreMandatoryFields: true });
        log.audit('Invoice Created', 'Invoice ' + invoiceId + ' created from Item Fulfillment ' + fulfillmentId);
        return invoiceId;
    }

    // EXISTING RESERVATION LINE CLOSING
    function closeSoLines(salesOrderId, itemIds) {
        if (!itemIds || !itemIds.length) return;

        try {
            var so = record.load({ type: record.Type.SALES_ORDER, id: salesOrderId, isDynamic: true });
            var lineCount = so.getLineCount({ sublistId: 'item' });
            var closed = 0;

            for (var i = lineCount - 1; i >= 0; i--) {
                var soItem = String(so.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i }));
                if (itemIds.indexOf(soItem) === -1) continue;
                if (so.getSublistValue({ sublistId: 'item', fieldId: 'isclosed', line: i })) continue;

                so.selectLine({ sublistId: 'item', line: i });
                so.setCurrentSublistValue({ sublistId: 'item', fieldId: 'isclosed', value: true });
                so.commitLine({ sublistId: 'item' });
                closed++;

                log.debug('SO Line Marked Closed', 'SO ' + salesOrderId + ' | line index ' + i + ' | item ' + soItem);
            }

            if (!closed) {
                log.debug('Reservation Item Not Found',
                    'Items ' + JSON.stringify(itemIds) + ' not found (or already closed) on Sales Order ' + salesOrderId);
                return;
            }

            so.save({ enableSourcing: true, ignoreMandatoryFields: true });
            log.audit('SO Line Closed', closed + ' Reservation Item line(s) closed on Sales Order ' + salesOrderId);

        } catch (e) {
            log.error('SO Line Close Error', e.name + ': ' + e.message);
        }
    }

    return { afterSubmit: afterSubmit };
});
