/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Item Fulfillment -> Invoice
 *
 *   Reservation Item = an ID in TM_B_ITEM_ID, or a Non-Inventory Item whose
 *                      PARENT is one of those IDs.
 *
 *   Reservation Items -> NOT invoiced, their Sales Order line is CLOSED
 *   Everything else   -> invoiced (qty = fulfilled qty, matched on KEY_FIELD)
 *
 *   Line-level discounts:
 *     STEP 1 - decide which item lines are invoiced
 *     STEP 2 - keep a Discount line only if, on the SALES ORDER, it sits
 *              directly under an item that was invoiced in STEP 1
 *              (invoice line -> SO line matched via 'orderline')
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
    // MAP SO DISCOUNT LINES -> PARENT ITEM
    // ============================================================

    /**
     * Line-level discount = Discount line directly under an item on the SO.
     *
     * @param {string|number} salesOrderId
     * @returns {Object} { "<SO line id>": { key: '<KEY_FIELD>', item: '<item id>' } }
     */
    function getDiscountParents(salesOrderId) {

        var map = {};

        try {
            var so = record.load({ type: record.Type.SALES_ORDER, id: salesOrderId });
            var lineCount = so.getLineCount({ sublistId: 'item' });
            var parent = null;

            for (var i = 0; i < lineCount; i++) {

                var type   = so.getSublistValue({ sublistId: 'item', fieldId: 'itemtype', line: i });
                var lineId = String(so.getSublistValue({ sublistId: 'item', fieldId: 'line', line: i }));

                if (type === 'Discount') {
                    if (parent) map[lineId] = parent;   // belongs to the item above it
                    continue;
                }

                if (type === 'Description') continue;
                if (type === 'Subtotal') { parent = null; continue; }

                // Real item line - becomes the parent for discounts below it
                parent = {
                    key:  String(so.getSublistValue({ sublistId: 'item', fieldId: KEY_FIELD, line: i }) || ''),
                    item: String(so.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i }))
                };
            }
        } catch (e) {
            log.error('Discount Parent Map Failed', e.name + ': ' + e.message);
        }

        log.debug('SO Discount Parents', map);
        return map;
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
     * Transforms Sales Order to Invoice.
     *   STEP 1 - keep item lines whose KEY_FIELD matches this fulfillment
     *   STEP 2 - keep Discount lines that sit under a kept item on the SO
     *   STEP 3 - set quantities
     *   STEP 4 - remove everything else
     */
    function createInvoice(salesOrderId, fulfilledLines, fulfillmentLocation, fulfillmentId, reservationItems) {

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
            log.audit('Invoice Not Created',
                'Sales Order ' + salesOrderId + ' has nothing left to bill (' + e.name + ').');
            return null;
        }

        invoice.setValue({ fieldId: 'account', value: AR_ACCOUNT });
        //invoice.setValue({ fieldId: 'shippingcost', value: 0 });
        invoice.setValue({ fieldId: 'custbody_ava_disable_tax_calculation', value: true });

        var lineCount    = invoice.getLineCount({ sublistId: 'item' });
        var keepQty      = {};   // invoice line index -> qty   (items)
        var keepDiscount = {};   // invoice line index -> true  (discounts)
        var invoicedKeys = {};   // KEY_FIELD values actually invoiced

        // ----------------------------------------------------
        // STEP 1 - items that need to be invoiced
        // ----------------------------------------------------
        for (var j = 0; j < lineCount; j++) {

            var type = invoice.getSublistValue({ sublistId: 'item', fieldId: 'itemtype', line: j });
            if (type === 'Discount' || type === 'Subtotal' || type === 'Description') continue;

            // A Reservation Item is never invoiced.
            var lineItem = String(invoice.getSublistValue({ sublistId: 'item', fieldId: 'item', line: j }));
            if (reservationItems[lineItem]) continue;

            var key = String(invoice.getSublistValue({ sublistId: 'item', fieldId: KEY_FIELD, line: j }) || '');
            if (!fulfilledLines[key]) continue;

            keepQty[j]        = fulfilledLines[key];
            invoicedKeys[key] = true;
        }

        // ----------------------------------------------------
        // STEP 2 - discounts that sit under an invoiced item on the SO
        // ----------------------------------------------------
        for (var d = 0; d < lineCount; d++) {

            if (invoice.getSublistValue({ sublistId: 'item', fieldId: 'itemtype', line: d }) !== 'Discount') continue;

            var orderLine = String(invoice.getSublistValue({ sublistId: 'item', fieldId: 'orderline', line: d }) || '');
            var parent    = discountParents[orderLine];

            if (parent && parent.key && invoicedKeys[parent.key] && !reservationItems[parent.item]) {
                keepDiscount[d] = true;
                log.debug('Discount Kept',
                    'Invoice line ' + d + ' | SO line ' + orderLine + ' | parent key ' + parent.key);
            } else {
                log.debug('Discount Dropped', 'Invoice line ' + d + ' | SO line ' + orderLine);
            }
        }

        // ----------------------------------------------------
        // STEP 3 - set quantities (indexes still stable)
        // ----------------------------------------------------
        Object.keys(keepQty).forEach(function (idx) {
            invoice.selectLine({ sublistId: 'item', line: Number(idx) });
            invoice.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: keepQty[idx] });
            invoice.commitLine({ sublistId: 'item' });
        });

        // ----------------------------------------------------
        // STEP 4 - remove everything else (backwards)
        // ----------------------------------------------------
        for (var r = lineCount - 1; r >= 0; r--) {
            if (keepQty[r] === undefined && !keepDiscount[r]) {
                invoice.removeLine({ sublistId: 'item', line: r });
            }
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