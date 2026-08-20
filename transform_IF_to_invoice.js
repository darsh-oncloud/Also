/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/log', 'N/https'], function (record, log, https) {

    var TM_B_ITEM_ID = 909;
    var AR_ACCOUNT = 675;
    var KEY_FIELD = 'custcol_3pl_fulfillment_key';
    // ⚠️ VERIFY: confirm this compid/script/deploy/ns-at is correct for THIS account
    // (sandbox vs production often need different values here).
    var SUITELET_URL = 'https://1039693.extforms.netsuite.com/app/site/hosting/scriptlet.nl'
        + '?script=3296&deploy=1&compid=1039693'
        + '&ns-at=AAEJ7tMQ7FbIvC7C4CXmDC6HpNyrI0buOQ0wPxjhFUdFg5WJjWA';

    function afterSubmit(context) {
        try {
            if (context.type !== context.UserEventType.CREATE && context.type !== context.UserEventType.EDIT) {
                return;
            }

            var fulfillment = context.newRecord;
            var fulfillmentId = fulfillment.id;
            var salesOrderId = fulfillment.getValue({ fieldId: 'createdfrom' });
            var orderId = fulfillment.getValue({ fieldId: 'custbody_celigo_etail_order_id' });

            if (!salesOrderId || !orderId) {
                log.audit('Invoice Not Created', 'Missing createdfrom or Celigo eTail Order ID.');
                return;
            }

            var lineCount = fulfillment.getLineCount({ sublistId: 'item' });

            // --- Shortcut: only line on the fulfillment is the TM-B deposit item ---
            // Nothing to invoice; just close that line on the Sales Order.
            if (lineCount === 1) {
                var onlyItemId = Number(fulfillment.getSublistValue({ sublistId: 'item', fieldId: 'item', line: 0 }));

                if (onlyItemId === TM_B_ITEM_ID) {
                    closeSoLine(salesOrderId, TM_B_ITEM_ID);
                    log.audit('SO Closed', 'Only TM-B item fulfilled; Sales Order ' + salesOrderId + ' closed, no invoice created.');
                    return;
                }
            }

            // --- Single pass: bucket fulfilled lines by 3PL Fulfillment Key, flag deposit item ---
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

                if (!fulfillmentLocation) {
                    fulfillmentLocation = fulfillment.getSublistValue({ sublistId: 'item', fieldId: 'location', line: i });
                }
            }

            var invoiceId = createInvoice(salesOrderId, fulfilledLines, fulfillmentLocation, fulfillmentId);

            if (hasDepositItem) {
                closeSoLine(salesOrderId, TM_B_ITEM_ID);
            }

            if (invoiceId) {
                https.get({ url: SUITELET_URL + '&recid=' + invoiceId });
            }

        } catch (e) {
            log.error('Invoice Creation Error', e.name + ': ' + e.message);
        }
    }

    /**
     * Transforms the Sales Order to an Invoice, keeping only lines whose
     * KEY_FIELD matches something fulfilled, and sets quantity to what was fulfilled.
     */
    function createInvoice(salesOrderId, fulfilledLines, fulfillmentLocation, fulfillmentId) {
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
        invoice.setValue({ fieldId: 'shippingcost', value: 0 });

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

        if (fulfillmentLocation) {
            invoice.setValue({ fieldId: 'location', value: fulfillmentLocation });
        }

        var invoiceId = invoice.save({ enableSourcing: true, ignoreMandatoryFields: true });
        log.audit('Invoice Created', 'Invoice ' + invoiceId + ' created from Item Fulfillment ' + fulfillmentId);
        return invoiceId;
    }

    /** Marks the given item's line as closed on the Sales Order. */
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