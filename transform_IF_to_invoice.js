/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/log', 'N/https', 'N/search'], function (record, log, https, search) {

    var TM_B_ITEM_ID = 909;
    var AR_ACCOUNT = 675;
    var KEY_FIELD = 'custcol_3pl_fulfillment_key';

    // SHIPPING
    var TYPE_FIELD = 'custcol_item_parentcomp';
    var TYPE_PARENT = '1';
    var PARENT_SHIPPING = 150;

    var SUITELET_URL = 'https://1039693.extforms.netsuite.com/app/site/hosting/scriptlet.nl'
        + '?script=3296&deploy=1&compid=1039693'
        + '&ns-at=AAEJ7tMQ7FbIvC7C4CXmDC6HpNyrI0buOQ0wPxjhFUdFg5WJjWA';


    function beforeSubmit(context) {
        try {
            if (context.type !== context.UserEventType.CREATE && context.type !== context.UserEventType.EDIT) return;

            var fulfillment = context.newRecord;
            var fulfillmentId = fulfillment.id;
            var salesOrderId = fulfillment.getValue({ fieldId: 'createdfrom' });

            if (!salesOrderId) return;

            var so = record.load({ type: record.Type.SALES_ORDER, id: salesOrderId });
            var soShipping = Number(so.getValue({ fieldId: 'shippingcost' })) || 0;

            if (!soShipping) {
                fulfillment.setValue({ fieldId: 'shippingcost', value: 0 });
                return;
            }

            var parentQty = 0;
            var lineCount = fulfillment.getLineCount({ sublistId: 'item' });

            for (var i = 0; i < lineCount; i++) {
                var itemReceive = fulfillment.getSublistValue({ sublistId: 'item', fieldId: 'itemreceive', line: i });
                if (!itemReceive) continue;

                var type = String(fulfillment.getSublistValue({ sublistId: 'item', fieldId: TYPE_FIELD, line: i }) || '');

                if (type === TYPE_PARENT) {
                    parentQty += Number(fulfillment.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i })) || 0;
                }
            }

            var currentShipping = parentQty * PARENT_SHIPPING;
            var previousShipping = 0;

            var filters = [
                ['createdfrom', 'anyof', salesOrderId],
                'AND',
                ['mainline', 'is', 'T']
            ];

            if (fulfillmentId) filters.push('AND', ['internalid', 'noneof', fulfillmentId]);

            search.create({
                type: search.Type.ITEM_FULFILLMENT,
                filters: filters,
                columns: [search.createColumn({ name: 'shippingamount', summary: search.Summary.SUM })]
            }).run().each(function (result) {
                previousShipping = Number(result.getValue({ name: 'shippingamount', summary: search.Summary.SUM })) || 0;
                return false;
            });

            var totalShipping = previousShipping + currentShipping;
            var shippingToSet = totalShipping <= soShipping ? currentShipping : 0;

            fulfillment.setValue({ fieldId: 'shippingcost', value: shippingToSet });

            log.audit('Shipping Calculation', {
                salesOrder: salesOrderId,
                soShipping: soShipping,
                parentQty: parentQty,
                currentShipping: currentShipping,
                previousShipping: previousShipping,
                totalShipping: totalShipping,
                shippingApplied: shippingToSet
            });

        } catch (e) {
            log.error('Shipping Calculation Error', e.name + ': ' + e.message);
        }
    }


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

            // Only TM-B item
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

            var fulfillmentShipping = Number(fulfillment.getValue({ fieldId: 'shippingcost' })) || 0;

            var invoiceId = createInvoice(
                salesOrderId,
                fulfilledLines,
                fulfillmentLocation,
                fulfillmentId,
                fulfillmentShipping
            );

            if (hasDepositItem) closeSoLine(salesOrderId, TM_B_ITEM_ID);

            if (invoiceId) https.get({ url: SUITELET_URL + '&recid=' + invoiceId });

        } catch (e) {
            log.error('Invoice Creation Error', e.name + ': ' + e.message);
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

        // UPDATED: use fulfillment shipping instead of 0
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
        beforeSubmit: beforeSubmit,
        afterSubmit: afterSubmit
    };
});