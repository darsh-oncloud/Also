/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/log', 'N/https'], function (record, log, https) {

    function afterSubmit(context) {
        try {
            if (
                context.type !== context.UserEventType.CREATE &&
                context.type !== context.UserEventType.EDIT
            ) {
                return;
            }

            var TM_B_ITEM_ID = 909;
            var AR_ACCOUNT = 675;
            var KEY_FIELD = 'custcol_3pl_fulfillment_key';

            var fulfillment = context.newRecord;
            var fulfillmentId = fulfillment.id;

            var salesOrderId = fulfillment.getValue({
                fieldId: 'createdfrom'
            });

            var orderId = fulfillment.getValue({
                fieldId: 'custbody_celigo_etail_order_id'
            });

            if (!salesOrderId) {
                log.audit(
                    'Invoice Not Created',
                    'Item Fulfillment does not have a source Sales Order.'
                );
                return;
            }

            if (!orderId) {
                log.audit(
                    'Invoice Not Created',
                    'Celigo eTail Order ID is empty.'
                );
                return;
            }

            var lineCount = fulfillment.getLineCount({
                sublistId: 'item'
            });

            var fulfilledLines = {};
            var hasDepositItem = false;
            var fulfillmentLocation = '';

            /*
             * Collect fulfilled lines by 3PL Fulfillment Key.
             */
            for (var i = 0; i < lineCount; i++) {

                var itemId = Number(
                    fulfillment.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'item',
                        line: i
                    })
                );

                var itemReceive = fulfillment.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'itemreceive',
                    line: i
                });

                var fulfillmentKey = fulfillment.getSublistValue({
                    sublistId: 'item',
                    fieldId: KEY_FIELD,
                    line: i
                });

                var quantity = Number(
                    fulfillment.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantity',
                        line: i
                    })
                ) || 0;

                var location = fulfillment.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'location',
                    line: i
                });

                if (itemId === TM_B_ITEM_ID && itemReceive) {
                    hasDepositItem = true;
                    continue;
                }

                if (itemReceive && fulfillmentKey) {
                    fulfilledLines[String(fulfillmentKey)] = quantity;

                    if (!fulfillmentLocation && location) {
                        fulfillmentLocation = location;
                    }
                }
            }

            var invoiceId = null;

            if (Object.keys(fulfilledLines).length > 0) {

                var invoice;

                /*
                 * Transform Sales Order to Invoice.
                 *
                 * When the order has nothing left to bill,
                 * log a simple message instead of an error.
                 */
                try {
                    invoice = record.transform({
                        fromType: record.Type.SALES_ORDER,
                        fromId: salesOrderId,
                        toType: record.Type.INVOICE,
                        isDynamic: true
                    });

                } catch (transformError) {

                    if (
                        transformError.name === 'INVALID_INITIALIZE_REF' ||
                        transformError.message.indexOf(
                            'invalid reference'
                        ) !== -1
                    ) {
                        log.audit(
                            'Invoice Not Created',
                            'Sales Order ' + salesOrderId +
                            ' has nothing left to bill.'
                        );

                        return;
                    }

                    throw transformError;
                }

                invoice.setValue({
                    fieldId: 'account',
                    value: AR_ACCOUNT
                });

                invoice.setValue({
                    fieldId: 'shippingcost',
                    value: 0
                });

                var invoiceLineCount = invoice.getLineCount({
                    sublistId: 'item'
                });

                /*
                 * Keep only Invoice lines whose 3PL Fulfillment Key
                 * exists on the Item Fulfillment.
                 */
                for (var j = invoiceLineCount - 1; j >= 0; j--) {

                    var invoiceKey = invoice.getSublistValue({
                        sublistId: 'item',
                        fieldId: KEY_FIELD,
                        line: j
                    });

                    invoiceKey = String(invoiceKey || '');

                    if (!fulfilledLines[invoiceKey]) {
                        invoice.removeLine({
                            sublistId: 'item',
                            line: j
                        });

                        continue;
                    }

                    invoice.selectLine({
                        sublistId: 'item',
                        line: j
                    });

                    invoice.setCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantity',
                        value: fulfilledLines[invoiceKey]
                    });

                    invoice.commitLine({
                        sublistId: 'item'
                    });
                }

                if (fulfillmentLocation) {
                    invoice.setValue({
                        fieldId: 'location',
                        value: fulfillmentLocation
                    });
                }

                var remainingLines = invoice.getLineCount({
                    sublistId: 'item'
                });

                if (remainingLines > 0) {
                    invoiceId = invoice.save({
                        enableSourcing: true,
                        ignoreMandatoryFields: true
                    });

                    log.audit(
                        'Invoice Created',
                        'Invoice ' + invoiceId +
                        ' created from Item Fulfillment ' +
                        fulfillmentId
                    );

                } else {
                    log.audit(
                        'Invoice Not Created',
                        'No Invoice lines matched the Item Fulfillment ' +
                        '3PL Fulfillment Keys.'
                    );
                }

            } else {
                log.audit(
                    'Invoice Not Created',
                    'No fulfilled lines with a 3PL Fulfillment Key were found.'
                );
            }

            /*
             * Existing TM-B line-closing logic.
             */
            if (hasDepositItem) {
                try {
                    var salesOrder = record.load({
                        type: record.Type.SALES_ORDER,
                        id: salesOrderId,
                        isDynamic: true
                    });

                    var depositLine =
                        salesOrder.findSublistLineWithValue({
                            sublistId: 'item',
                            fieldId: 'item',
                            value: TM_B_ITEM_ID
                        });

                    if (depositLine !== -1) {
                        salesOrder.selectLine({
                            sublistId: 'item',
                            line: depositLine
                        });

                        salesOrder.setCurrentSublistValue({
                            sublistId: 'item',
                            fieldId: 'isclosed',
                            value: true
                        });

                        salesOrder.commitLine({
                            sublistId: 'item'
                        });

                        salesOrder.save({
                            enableSourcing: true,
                            ignoreMandatoryFields: true
                        });

                        log.audit(
                            'TM-B Line Closed',
                            'TM-B line closed on Sales Order ' +
                            salesOrderId
                        );
                    }

                } catch (depositError) {
                    log.error(
                        'TM-B Line Closing Error',
                        depositError
                    );
                }
            }

            /*
             * Existing Suitelet call.
             */
            if (invoiceId) {
                https.get({
                    url:
                        'https://1039693.extforms.netsuite.com' +
                        '/app/site/hosting/scriptlet.nl' +
                        '?script=3296' +
                        '&deploy=1' +
                        '&compid=1039693' +
                        '&ns-at=AAEJ7tMQ7FbIvC7C4CXmDC6HpNyrI0buOQ0wPxjhFUdFg5WJjWA' +
                        '&recid=' + invoiceId
                });
            }

        } catch (e) {
            log.error(
                'Invoice Creation Error',
                e.name + ': ' + e.message
            );
        }
    }

    return {
        afterSubmit: afterSubmit
    };
});