/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */
define(
    ['N/record', 'N/log', 'N/search', 'N/url', 'N/https', 'N/runtime'],
    function (record, log, search, url, https, runtime) {

        function afterSubmit(context) {
            try {
                // Existing trigger logic remains unchanged
                if (
                    context.type !== context.UserEventType.CREATE &&
                    context.type !== context.UserEventType.EDIT
                ) {
                    return;
                }

                const TM_B_ITEM_ID = 909;
                const AR_ACCOUNT = 675;

                // Same custom column field exists on:
                // Sales Order, Item Fulfillment, and Invoice
                const FULFILLMENT_KEY_FIELD =
                    'custcol_3pl_fulfillment_key';

                var fulfillment = context.newRecord;
                var fulfillmentId = fulfillment.id;

                var orderId = fulfillment.getValue({
                    fieldId: 'custbody_celigo_etail_order_id'
                });

                var lineCount = fulfillment.getLineCount({
                    sublistId: 'item'
                });

                log.debug({
                    title: 'Item Fulfillment Line Count',
                    details: lineCount
                });

                var createdFrom = fulfillment.getValue({
                    fieldId: 'createdfrom'
                });

                if (!createdFrom) {
                    log.error({
                        title: 'Missing Source',
                        details:
                            'Item Fulfillment has no Created From Sales Order.'
                    });
                    return;
                }

                if (!orderId) {
                    log.debug({
                        title: 'Skip',
                        details:
                            'custbody_celigo_etail_order_id is empty. ' +
                            'Skipping invoice creation.'
                    });
                    return;
                }

                /*
                 * Existing Sales Order loading logic
                 */
                var soRec = record.load({
                    type: record.Type.SALES_ORDER,
                    id: createdFrom,
                    isDynamic: true
                });

                var soLineCount = soRec.getLineCount({
                    sublistId: 'item'
                });

                log.debug({
                    title: 'Sales Order Line Count',
                    details: soLineCount
                });

                /*
                 * Existing single TM-B item logic remains unchanged
                 */
                if (soLineCount === 1) {
                    var firstItemId = fulfillment.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'item',
                        line: 0
                    });

                    if (
                        parseInt(firstItemId, 10) === TM_B_ITEM_ID
                    ) {
                        log.debug({
                            title: 'Skip',
                            details:
                                'Only one line exists and it is TM-B item ' +
                                TM_B_ITEM_ID +
                                '. Skipping invoice creation.'
                        });

                        try {
                            for (
                                var closeLine = 0;
                                closeLine < soLineCount;
                                closeLine++
                            ) {
                                soRec.selectLine({
                                    sublistId: 'item',
                                    line: closeLine
                                });

                                soRec.setCurrentSublistValue({
                                    sublistId: 'item',
                                    fieldId: 'isclosed',
                                    value: true
                                });

                                soRec.commitLine({
                                    sublistId: 'item'
                                });
                            }

                            var soId = soRec.save({
                                enableSourcing: true,
                                ignoreMandatoryFields: true
                            });

                            log.audit({
                                title: 'Sales Order Closed',
                                details:
                                    'Sales Order ' +
                                    soId +
                                    ' was closed because it only contained ' +
                                    'the TM-B item.'
                            });
                        } catch (closeError) {
                            log.error({
                                title: 'Error Closing Sales Order',
                                details: closeError
                            });
                        }

                        return;
                    }
                }

                var fulfillmentLocation = '';
                var hasInvoiceableFulfilledLine = false;
                var hasDepositeItem = false;
                var invoiceIdIs = null;

                /*
                 * Check fulfillment lines.
                 *
                 * Any received line with a 3PL Fulfillment Key is invoiceable,
                 * except the existing TM-B special item.
                 */
                for (var i = 0; i < lineCount; i++) {
                    var lineItemId = parseInt(
                        fulfillment.getSublistValue({
                            sublistId: 'item',
                            fieldId: 'item',
                            line: i
                        }),
                        10
                    );

                    var itemReceive =
                        fulfillment.getSublistValue({
                            sublistId: 'item',
                            fieldId: 'itemreceive',
                            line: i
                        });

                    var fulfillmentKey =
                        fulfillment.getSublistValue({
                            sublistId: 'item',
                            fieldId: FULFILLMENT_KEY_FIELD,
                            line: i
                        });

                    log.debug({
                        title: 'Fulfillment Line',
                        details: {
                            line: i,
                            itemId: lineItemId,
                            itemReceive: itemReceive,
                            fulfillmentKey: fulfillmentKey
                        }
                    });

                    if (
                        itemReceive &&
                        fulfillmentKey &&
                        lineItemId !== TM_B_ITEM_ID
                    ) {
                        hasInvoiceableFulfilledLine = true;
                    }

                    if (
                        lineItemId === TM_B_ITEM_ID &&
                        itemReceive
                    ) {
                        log.debug({
                            title: 'Found TM-B Item',
                            details: {
                                line: i,
                                itemId: lineItemId
                            }
                        });

                        hasDepositeItem = true;
                    }
                }

                log.debug({
                    title: 'Has Invoiceable Fulfilled Line',
                    details: hasInvoiceableFulfilledLine
                });

                if (hasInvoiceableFulfilledLine) {
                    /*
                     * Transform the Sales Order into an Invoice.
                     */
                    var invoiceRec = record.transform({
                        fromType: record.Type.SALES_ORDER,
                        fromId: createdFrom,
                        toType: record.Type.INVOICE,
                        isDynamic: true
                    });

                    invoiceRec.setValue({
                        fieldId: 'account',
                        value: AR_ACCOUNT
                    });

                    invoiceRec.setValue({
                        fieldId: 'shippingcost',
                        value: 0
                    });

                    /*
                     * Collect received Item Fulfillment lines by the
                     * custom 3PL Fulfillment Key.
                     *
                     * Example:
                     * {
                     *     "638020": { quantity: 1 },
                     *     "638021": { quantity: 1 }
                     * }
                     */
                    var fulfilledLinesByKey = {};

                    for (
                        var fulfillmentLine = 0;
                        fulfillmentLine < lineCount;
                        fulfillmentLine++
                    ) {
                        var fulfilledItemId = parseInt(
                            fulfillment.getSublistValue({
                                sublistId: 'item',
                                fieldId: 'item',
                                line: fulfillmentLine
                            }),
                            10
                        );

                        var lineReceived =
                            fulfillment.getSublistValue({
                                sublistId: 'item',
                                fieldId: 'itemreceive',
                                line: fulfillmentLine
                            });

                        var lineFulfillmentKey =
                            fulfillment.getSublistValue({
                                sublistId: 'item',
                                fieldId: FULFILLMENT_KEY_FIELD,
                                line: fulfillmentLine
                            });

                        var fulfilledQuantity = Number(
                            fulfillment.getSublistValue({
                                sublistId: 'item',
                                fieldId: 'quantity',
                                line: fulfillmentLine
                            })
                        ) || 0;

                        var lineLocation =
                            fulfillment.getSublistValue({
                                sublistId: 'item',
                                fieldId: 'location',
                                line: fulfillmentLine
                            });

                        /*
                         * Preserve the existing TM-B special handling.
                         * All other received lines with a key are collected.
                         */
                        if (
                            !lineReceived ||
                            !lineFulfillmentKey ||
                            fulfilledItemId === TM_B_ITEM_ID
                        ) {
                            continue;
                        }

                        var key = String(lineFulfillmentKey);

                        /*
                         * The key should be unique, but adding quantities
                         * also protects against the same key appearing more
                         * than once unexpectedly.
                         */
                        if (!fulfilledLinesByKey[key]) {
                            fulfilledLinesByKey[key] = {
                                quantity: 0,
                                location: lineLocation || ''
                            };
                        }

                        fulfilledLinesByKey[key].quantity +=
                            fulfilledQuantity;

                        if (
                            !fulfillmentLocation &&
                            lineLocation
                        ) {
                            fulfillmentLocation = lineLocation;
                        }
                    }

                    log.debug({
                        title: 'Fulfilled Lines By 3PL Key',
                        details: fulfilledLinesByKey
                    });

                    if (
                        Object.keys(fulfilledLinesByKey).length > 0
                    ) {
                        var invoiceLineCount =
                            invoiceRec.getLineCount({
                                sublistId: 'item'
                            });

                        log.debug({
                            title: 'Invoice Lines Before Filtering',
                            details: invoiceLineCount
                        });

                        var keepMap = {};
                        var usedKeys = {};

                        /*
                         * Read the same custom field from the transformed
                         * Invoice lines.
                         */
                        for (
                            var invoiceLine = 0;
                            invoiceLine < invoiceLineCount;
                            invoiceLine++
                        ) {
                            var invoiceItemId = parseInt(
                                invoiceRec.getSublistValue({
                                    sublistId: 'item',
                                    fieldId: 'item',
                                    line: invoiceLine
                                }),
                                10
                            );

                            var invoiceFulfillmentKey =
                                invoiceRec.getSublistValue({
                                    sublistId: 'item',
                                    fieldId:
                                        FULFILLMENT_KEY_FIELD,
                                    line: invoiceLine
                                });

                            var invoiceKey = String(
                                invoiceFulfillmentKey || ''
                            );

                            var matchingFulfillmentLine =
                                fulfilledLinesByKey[invoiceKey];

                            log.debug({
                                title: 'Invoice Key Matching',
                                details: {
                                    invoiceLine: invoiceLine,
                                    itemId: invoiceItemId,
                                    invoiceKey: invoiceKey,
                                    matched:
                                        Boolean(
                                            matchingFulfillmentLine
                                        )
                                }
                            });

                            /*
                             * Keep only the Invoice line whose custom key
                             * exists on the Item Fulfillment.
                             */
                            if (
                                matchingFulfillmentLine &&
                                !usedKeys[invoiceKey]
                            ) {
                                keepMap[invoiceLine] = true;
                                usedKeys[invoiceKey] = true;

                                /*
                                 * Set the Invoice quantity equal to the
                                 * fulfilled quantity.
                                 */
                                if (
                                    matchingFulfillmentLine.quantity > 0
                                ) {
                                    invoiceRec.selectLine({
                                        sublistId: 'item',
                                        line: invoiceLine
                                    });

                                    invoiceRec.setCurrentSublistValue({
                                        sublistId: 'item',
                                        fieldId: 'quantity',
                                        value:
                                            matchingFulfillmentLine
                                                .quantity
                                    });

                                    invoiceRec.commitLine({
                                        sublistId: 'item'
                                    });
                                }
                            }
                        }

                        /*
                         * Collect all unmatched Invoice lines.
                         */
                        var linesToRemove = [];

                        for (
                            var checkLine = 0;
                            checkLine < invoiceLineCount;
                            checkLine++
                        ) {
                            if (!keepMap[checkLine]) {
                                linesToRemove.push(checkLine);
                            }
                        }

                        log.debug({
                            title: 'Invoice Lines To Remove',
                            details: linesToRemove
                        });

                        /*
                         * Remove lines from the bottom upward so line
                         * indexes do not change during removal.
                         */
                        for (
                            var removeIndex =
                                linesToRemove.length - 1;
                            removeIndex >= 0;
                            removeIndex--
                        ) {
                            invoiceRec.removeLine({
                                sublistId: 'item',
                                line:
                                    linesToRemove[removeIndex]
                            });
                        }

                        var remainingLineCount =
                            invoiceRec.getLineCount({
                                sublistId: 'item'
                            });

                        log.debug({
                            title: 'Invoice Lines After Filtering',
                            details: remainingLineCount
                        });

                        /*
                         * Existing location logic remains unchanged.
                         */
                        if (fulfillmentLocation) {
                            invoiceRec.setValue({
                                fieldId: 'location',
                                value: fulfillmentLocation
                            });
                        }

                        if (remainingLineCount > 0) {
                            var invoiceId =
                                invoiceRec.save({
                                    enableSourcing: true,
                                    ignoreMandatoryFields: true
                                });

                            log.audit({
                                title: 'Invoice Created',
                                details: {
                                    invoiceId: invoiceId,
                                    fulfillmentId:
                                        fulfillmentId,
                                    salesOrderId: createdFrom,
                                    invoiceLines:
                                        remainingLineCount
                                }
                            });

                            if (invoiceId) {
                                invoiceIdIs = invoiceId;
                            }
                        } else {
                            log.debug({
                                title: 'No Invoice Lines',
                                details:
                                    'No Invoice line 3PL Fulfillment Key ' +
                                    'matched the Item Fulfillment.'
                            });
                        }
                    } else {
                        log.debug({
                            title: 'No Fulfillment Keys',
                            details:
                                'No received Item Fulfillment lines had a ' +
                                '3PL Fulfillment Key.'
                        });
                    }
                } else {
                    log.debug({
                        title: 'No Invoiceable Fulfillment Lines',
                        details:
                            'No received non-TM-B fulfillment line had a ' +
                            '3PL Fulfillment Key.'
                    });
                }

                /*
                 * Existing TM-B Sales Order line closing logic
                 * remains unchanged.
                 */
                if (hasDepositeItem) {
                    try {
                        var loadSalesOrder = record.load({
                            type: record.Type.SALES_ORDER,
                            id: createdFrom,
                            isDynamic: true
                        });

                        var lineIndex =
                            loadSalesOrder.findSublistLineWithValue({
                                sublistId: 'item',
                                fieldId: 'item',
                                value: TM_B_ITEM_ID
                            });

                        if (lineIndex !== -1) {
                            loadSalesOrder.selectLine({
                                sublistId: 'item',
                                line: lineIndex
                            });

                            loadSalesOrder.setCurrentSublistValue({
                                sublistId: 'item',
                                fieldId: 'isclosed',
                                value: true
                            });

                            loadSalesOrder.commitLine({
                                sublistId: 'item'
                            });

                            loadSalesOrder.save({
                                enableSourcing: true,
                                ignoreMandatoryFields: true
                            });
                        }
                    } catch (depositError) {
                        log.error({
                            title:
                                'Error While Closing TM-B Order Line',
                            details: depositError
                        });
                    }
                }

                /*
                 * Existing Suitelet call remains unchanged.
                 */
                if (invoiceIdIs) {
                    https.get({
                        url:
                            'https://1039693.extforms.netsuite.com' +
                            '/app/site/hosting/scriptlet.nl' +
                            '?script=3296' +
                            '&deploy=1' +
                            '&compid=1039693' +
                            '&ns-at=AAEJ7tMQ7FbIvC7C4CXmDC6HpNyrI0buOQ0wPxjhFUdFg5WJjWA' +
                            '&recid=' +
                            invoiceIdIs
                    });
                }
            } catch (e) {
                log.error({
                    title: 'Error Creating Invoice',
                    details: {
                        name: e.name,
                        message: e.message,
                        stack: e.stack
                    }
                });
            }
        }

        return {
            afterSubmit: afterSubmit
        };
    }
);