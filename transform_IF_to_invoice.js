/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Same logic as before, only the hardcoded item 909 is replaced by a list:
 *
 *   Reservation Item = an ID in TM_B_ITEM_ID, or a Non-Inventory Item whose
 *                      PARENT is one of those IDs.
 *
 *   Reservation Items -> NOT invoiced, their Sales Order line is CLOSED
 *   Everything else   -> invoiced (qty = fulfilled qty, matched on KEY_FIELD)
 */
define(['N/record', 'N/search', 'N/log', 'N/https'],
function (record, search, log, https) {

    // ============================================================
    // CONFIG
    // ============================================================

    // Add any new Reservation Item ID here. Children are found by search.
    var TM_B_ITEM_ID = [909, 4075, 4076];

    var AR_ACCOUNT = 675;
    var KEY_FIELD  = 'custcol_3pl_fulfillment_key';

    // VERIFY for Sandbox / Production
    var SUITELET_URL =
        'https://1039693.extforms.netsuite.com/app/site/hosting/scriptlet.nl'
        + '?script=3296&deploy=1&compid=1039693'
        + '&ns-at=AAEJ7tMQ7FbIvC7C4CXmDC6HpNyrI0buOQ0wPxjhFUdFg5WJjWA';


    // ============================================================
    // GET RESERVATION ITEMS
    // ============================================================

    /**
     * Only checks the items actually on this fulfillment, so the search stays
     * small no matter how many child items exist.
     *
     * @param {Array} candidateIds - item ids on the fulfillment
     * @returns {Object} { "909": true, "4080": true, ... }
     */
    function getReservationItems(candidateIds) {

        var items = {};

        // Configured IDs are always Reservation Items, search or no search.
        TM_B_ITEM_ID.forEach(function (id) {
            items[String(id)] = true;
        });

        if (!candidateIds.length) return items;

        var ids = TM_B_ITEM_ID.map(String);

        try {
            search.create({
                type: 'noninventoryitem',
                filters: [
                    ['type', 'anyof', 'NonInvtPart'],
                    'AND',
                    ['internalid', 'anyof'].concat(candidateIds),
                    'AND',
                    [
                        ['internalid', 'anyof'].concat(ids),
                        'OR',
                        ['parent', 'anyof'].concat(ids)
                    ]
                ],
                columns: [search.createColumn({ name: 'internalid' })]
            }).run().each(function (result) {
                items[String(result.id)] = true;
                return true;
            });
        } catch (e) {
            log.error('Reservation Item Search Failed', e.name + ': ' + e.message);
        }

        log.debug('Reservation Items', Object.keys(items));
        return items;
    }


    // ============================================================
    // AFTER SUBMIT
    // ============================================================

    function afterSubmit(context) {

        try {

            if (context.type !== context.UserEventType.CREATE &&
                context.type !== context.UserEventType.EDIT) {
                return;
            }

            var fulfillment   = context.newRecord;
            var fulfillmentId = fulfillment.id;
            var salesOrderId  = fulfillment.getValue({ fieldId: 'createdfrom' });
            var orderId       = fulfillment.getValue({ fieldId: 'custbody_celigo_etail_order_id' });

            if (!salesOrderId || !orderId) {
                log.audit('Invoice Not Created', 'Missing createdfrom or Celigo eTail Order ID.');
                return;
            }

            var lineCount = fulfillment.getLineCount({ sublistId: 'item' });

            // ----------------------------------------------------
            // PASS 1 - items on this fulfillment -> resolve reservation items
            // ----------------------------------------------------
            var candidateIds = [];

            for (var i = 0; i < lineCount; i++) {
                var candId = String(fulfillment.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i }));
                if (candId && candidateIds.indexOf(candId) === -1) candidateIds.push(candId);
            }

            var reservationItems = getReservationItems(candidateIds);

            // ----------------------------------------------------
            // ONLY A RESERVATION ITEM ON THE FULFILLMENT
            // Nothing to invoice - just close that SO line.
            // ----------------------------------------------------
            if (lineCount === 1) {

                var onlyItemId = String(fulfillment.getSublistValue({ sublistId: 'item', fieldId: 'item', line: 0 }));

                if (reservationItems[onlyItemId]) {
                    closeSoLines(salesOrderId, [onlyItemId]);
                    log.audit('SO Closed',
                        'Only Reservation Item ' + onlyItemId + ' fulfilled; Sales Order '
                        + salesOrderId + ' line closed, no invoice created.');
                    return;
                }
            }

            // ----------------------------------------------------
            // BUILD FULFILLED LINES
            // ----------------------------------------------------
            var fulfilledLines      = {};   // KEY_FIELD -> fulfilled qty
            var itemsToClose        = [];   // reservation items to close on the SO
            var fulfillmentLocation = '';

            for (var j = 0; j < lineCount; j++) {

                var itemId = String(fulfillment.getSublistValue({ sublistId: 'item', fieldId: 'item', line: j }));

                if (!fulfillment.getSublistValue({ sublistId: 'item', fieldId: 'itemreceive', line: j })) continue;

                // ----- RESERVATION ITEM: skip invoice, close SO line later -----
                if (reservationItems[itemId]) {
                    if (itemsToClose.indexOf(itemId) === -1) itemsToClose.push(itemId);
                    continue;
                }

                // ----- NORMAL LINE -----
                var fulfillmentKey = fulfillment.getSublistValue({ sublistId: 'item', fieldId: KEY_FIELD, line: j });
                if (!fulfillmentKey) continue;

                fulfilledLines[String(fulfillmentKey)] =
                    Number(fulfillment.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: j })) || 0;

                if (!fulfillmentLocation) {
                    fulfillmentLocation = fulfillment.getSublistValue({ sublistId: 'item', fieldId: 'location', line: j });
                }
            }

            log.debug('Fulfilled Lines', fulfilledLines);
            log.debug('Reservation Items To Close', itemsToClose);

            // ----------------------------------------------------
            // CREATE INVOICE
            // ----------------------------------------------------
            var invoiceId = createInvoice(salesOrderId, fulfilledLines, fulfillmentLocation, fulfillmentId, reservationItems);

            // ----------------------------------------------------
            // CLOSE RESERVATION LINES - one load, one save
            // ----------------------------------------------------
            closeSoLines(salesOrderId, itemsToClose);

            // ----------------------------------------------------
            // CALL SUITELET
            // ----------------------------------------------------
            if (invoiceId) {
                https.get({ url: SUITELET_URL + '&recid=' + invoiceId });
            }

        } catch (e) {
            log.error('Invoice Creation Error', e.name + ': ' + e.message);
        }
    }


    // ============================================================
    // CREATE INVOICE
    // ============================================================
    /**
     * Transforms Sales Order to Invoice, keeping only the lines whose
     * KEY_FIELD matches this fulfillment.
     */
    function createInvoice(salesOrderId, fulfilledLines, fulfillmentLocation, fulfillmentId, reservationItems) {

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
            log.audit('Invoice Not Created',
                'Sales Order ' + salesOrderId + ' has nothing left to bill (' + e.name + ').');
            return null;
        }

        invoice.setValue({ fieldId: 'account', value: AR_ACCOUNT });
        invoice.setValue({ fieldId: 'shippingcost', value: 0 });

        var lineCount = invoice.getLineCount({ sublistId: 'item' });

        // Loop backwards - lines are being removed.
        for (var j = lineCount - 1; j >= 0; j--) {

            // A Reservation Item is never invoiced.
            var lineItem = String(invoice.getSublistValue({ sublistId: 'item', fieldId: 'item', line: j }));

            if (reservationItems[lineItem]) {
                invoice.removeLine({ sublistId: 'item', line: j });
                continue;
            }

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


    // ============================================================
    // CLOSE RESERVATION ITEM LINES ON THE SALES ORDER
    // ============================================================
    /**
     * Closes every line whose item is in itemIds. One load, one save,
     * no matter how many Reservation Items there are.
     */
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
            log.audit('SO Line Closed',
                closed + ' Reservation Item line(s) closed on Sales Order ' + salesOrderId);

        } catch (e) {
            log.error('SO Line Close Error', e.name + ': ' + e.message);
        }
    }


    return {
        afterSubmit: afterSubmit
    };

});