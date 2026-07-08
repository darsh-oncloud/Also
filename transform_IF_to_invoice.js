/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */
define(['N/record', 'N/log', 'N/search', 'N/url', 'N/https','N/runtime'], function (record, log, search, url, https, runtime) {

    function afterSubmit(context) {
        try {
            // Only trigger on create or edit
            if (context.type !== context.UserEventType.CREATE && context.type !== context.UserEventType.EDIT) {
              return;
            }

            const TM_B_ITEM_ID = 909;
            const MERCHANDISE_ITEM_ID = 908;

            // ✅ NEW: promo discount item (only used for "next line after 908" logic)
            const PROMO_DISCOUNT_ITEM_ID = 911;

            const AR_account = 675;

            // ✅ NEW: cache item merch checkbox lookup
            var merchItemCache = {};

            // ✅ NEW: keep old 908 logic + also check item field custitem_merch_item
            function isInvoiceableMerchItem(itemId) {
                itemId = parseInt(itemId, 10);

                // Keep existing hardcoded merchandise item logic
                if (itemId === MERCHANDISE_ITEM_ID) {
                    return true;
                }

                if (!itemId) {
                    return false;
                }

                if (Object.prototype.hasOwnProperty.call(merchItemCache, itemId)) {
                    return merchItemCache[itemId];
                }

                try {
                    var itemFields = search.lookupFields({
                        type: search.Type.ITEM,
                        id: itemId,
                        columns: ['custitem_merch_item']
                    });

                    var isMerchItem = itemFields.custitem_merch_item === true || itemFields.custitem_merch_item === 'T';

                    merchItemCache[itemId] = isMerchItem;
                    return isMerchItem;

                } catch (e) {
                    log.error('Item Merch Checkbox Lookup Failed', {
                        itemId: itemId,
                        error: e
                    });

                    merchItemCache[itemId] = false;
                    return false;
                }
            }

            var fulfillment = context.newRecord;
            var fulfillmentId = fulfillment.id;
            var orderId = fulfillment.getValue('custbody_celigo_etail_order_id');

            var lineCount = fulfillment.getLineCount({ sublistId: 'item' });
            log.debug('lineCount', lineCount);

            var createdFrom = fulfillment.getValue('createdfrom');
            if (!createdFrom) {
                log.error('Missing Source', 'Item Fulfillment has no createdfrom (Sales Order) field.');
                return;
            }

            if (!orderId) {
                log.debug('Skip', 'custbody_celigo_etail_order_id is empty. Skipping invoice creation.');
                return;
            }

            var soRec = record.load({
               type: record.Type.SALES_ORDER,
               id: createdFrom,
               isDynamic: true
            });

            // Loop through lines and mark them closed
            var soLineCount = soRec.getLineCount({ sublistId: 'item' });

            log.debug('soLineCount', soLineCount);

            if (soLineCount === 1) {
                var firstItemId = fulfillment.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: 0
                });

                if (parseInt(firstItemId, 10) === TM_B_ITEM_ID) {
                  log.debug('Skip', 'Only one line item and it is TM_B_ITEM_ID (' + TM_B_ITEM_ID + '). Skipping invoice creation.');

                  try {
                        for (var i = 0; i < soLineCount; i++) {
                            soRec.selectLine({ sublistId: 'item', line: i });
                            soRec.setCurrentSublistValue({
                                sublistId: 'item',
                                fieldId: 'isclosed',
                                value: true
                            });
                            soRec.commitLine({ sublistId: 'item' });
                        }

                        // Save Sales Order
                        var soId = soRec.save({
                            enableSourcing: true,
                            ignoreMandatoryFields: true
                        });

                        log.audit('Sales Order Closed', 'Sales Order ' + soId + ' was closed since only TM_B_ITEM_ID was fulfilled.');
                    } catch (e) {
                        log.debug("Error in closing SO", e);
                    }

                  return;
                }
            }

            var fulfillmentLocation = '';

            var hasMerchandiseItem = false;
            var hasDepositeItem = false;
            var invoiceIdIs = null;
            for (var i = 0; i < lineCount; i++) {
                var lineItemId = parseInt(fulfillment.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: i
                }), 10);

                var itemreceive = fulfillment.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'itemreceive',
                    line: i
                })
                log.debug('itemreceive',itemreceive);

                if (isInvoiceableMerchItem(lineItemId) && itemreceive) {
                    log.debug('Found Merchandise Item');
                    hasMerchandiseItem = true;
                }

                if (lineItemId === TM_B_ITEM_ID && itemreceive) {
                    log.debug('Found TM_B Item on IF');
                    hasDepositeItem = true;
                }
            }
            log.debug('hasMerchandiseItem', hasMerchandiseItem);

            if (hasMerchandiseItem) {
                // Transform Sales Order into Invoice
                var invoiceRec = record.transform({
                    fromType: record.Type.SALES_ORDER,
                    fromId: createdFrom,
                    toType: record.Type.INVOICE,
                    isDynamic: true
                });
                invoiceRec.setValue({fieldId:'account',value:AR_account})
                invoiceRec.setValue({ fieldId: 'shippingcost', value: 0 });

                // Collect fulfilled orderline values from Item Fulfillment
                var fulfilledOrderLines = [];
                for (var i = 0; i < lineCount; i++) {
                    var fulfilledItemId = fulfillment.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'item',
                        line: i
                    });

                    var fulfilledOrderLine = fulfillment.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'orderline',
                        line: i
                    });

                     var itemreceive = fulfillment.getSublistValue({
                      sublistId: 'item',
                      fieldId: 'itemreceive',
                      line: i
                    })

                    if (isInvoiceableMerchItem(fulfilledItemId) && fulfilledOrderLine && itemreceive) {
                        fulfillmentLocation = fulfillment.getSublistValue({
                            sublistId: 'item',
                            fieldId: 'location',
                            line: i
                        });
                        fulfilledOrderLines.push(parseInt(fulfilledOrderLine, 10));
                    }
                }

                log.debug('Fulfilled Order Lines', fulfilledOrderLines);

                if (fulfilledOrderLines.length) {
                    var invoiceLineCount = invoiceRec.getLineCount({ sublistId: 'item' });
                    log.debug('Before Filtering - Invoice Lines', invoiceLineCount);

                    // Collect fulfilled Celigo etail order line IDs
                    var fulfilledEtailOrderLineIds = [];
                    for (var i = 0; i < lineCount; i++) {
                        var fulfilledItemId = parseInt(fulfillment.getSublistValue({
                            sublistId: 'item',
                            fieldId: 'item',
                            line: i
                        }), 10);

                        var itemreceive = fulfillment.getSublistValue({
                         sublistId: 'item',
                         fieldId: 'itemreceive',
                         line: i
                        })

                        if (isInvoiceableMerchItem(fulfilledItemId) && itemreceive) {
                            var etailOrderLineId = fulfillment.getSublistValue({
                                sublistId: 'item',
                                fieldId: 'custcol_celigo_etail_order_line_id',
                                line: i
                            });

                            if (etailOrderLineId) {
                                fulfilledEtailOrderLineIds.push(etailOrderLineId);
                            }
                        }
                    }

                    log.debug('Fulfilled Etail Order Line IDs', fulfilledEtailOrderLineIds);

                    // Filter invoice lines
                    var linesToRemove = [];

                    log.debug('invoiceLineCount', invoiceLineCount);

                    // ✅ NEW: keep-map so we can also keep "next line 911" after a kept 908
                    var keepMap = {}; // { lineIndex: true }

                    for (var j = 0; j < invoiceLineCount; j++) {
                        var invItemId = parseInt(invoiceRec.getSublistValue({
                            sublistId: 'item',
                            fieldId: 'item',
                            line: j
                        }), 10);

                        var invEtailOrderLineId = invoiceRec.getSublistValue({
                            sublistId: 'item',
                            fieldId: 'custcol_celigo_etail_order_line_id',
                            line: j
                        });

                        // Check if invoice line should be kept (existing logic + merch checkbox item logic)
                        var hasMerchandiseOrderline = fulfilledEtailOrderLineIds.indexOf(invEtailOrderLineId) != -1;
                        var shouldKeep = isInvoiceableMerchItem(invItemId) && hasMerchandiseOrderline;

                        if (shouldKeep) {
                            keepMap[j] = true;

                            // ✅ NEW: if NEXT line after this kept 908 is 911, keep it too
                            if (j + 1 < invoiceLineCount) {
                                var nextItemId = parseInt(invoiceRec.getSublistValue({
                                    sublistId: 'item',
                                    fieldId: 'item',
                                    line: j + 1
                                }), 10);

                                log.debug('Check Next Line For Discount', {
                                  keepLine: j,
                                  keepItem: invItemId,
                                  nextLine: (j + 1),
                                  nextItemId: nextItemId
                                });

                                if (nextItemId === PROMO_DISCOUNT_ITEM_ID) {
                                    keepMap[j + 1] = true;
                                    log.audit('Keeping Promo Discount Line', {
                                      baseMerchLine: j,
                                      promoLine: (j + 1),
                                      promoItemId: nextItemId
                                    });
                                }
                            }
                        }
                    }

                    for (var x = 0; x < invoiceLineCount; x++) {
                        if (!keepMap[x]) {
                          linesToRemove.push(x);
                        }
                    }

                    log.debug('Lines to Remove', linesToRemove);

                    // Remove lines in descending order to avoid re-index issues
                    for (var r = linesToRemove.length - 1; r >= 0; r--) {
                        invoiceRec.removeLine({
                            sublistId: 'item',
                            line: linesToRemove[r]
                        });
                    }

                    log.debug('After Filtering - Invoice Lines', invoiceRec.getLineCount({ sublistId: 'item' }));

                    // Apply location and save invoice
                    if (fulfillmentLocation) {
                        invoiceRec.setValue({ fieldId: 'location', value: fulfillmentLocation });
                    }

                    if (invoiceRec.getLineCount({ sublistId: 'item' })) {
                      var invoiceId = invoiceRec.save({
                        enableSourcing: true,
                        ignoreMandatoryFields: true
                      });

                      log.audit('Invoice Created', 'Invoice ' + invoiceId + ' created from Fulfillment ' + fulfillmentId);

                      if (invoiceId) {
                        invoiceIdIs = invoiceId;

                      }
                    } else {
                      log.debug('No Lines found for invoicing');
                    }

                } else {
                    log.debug('No matching orderlines found for merchandise item');
                }
            } else {
                log.debug('No merchandise item found for invoicing on IF');
            }

            if (hasDepositeItem) {
                try {
                    var loadSalesOrder = record.load({
                      type: record.Type.SALES_ORDER,
                      id: createdFrom,
                      isDynamic: true
                    })
                    // Find line number for a specific item
                    var lineIndex = loadSalesOrder.findSublistLineWithValue({
                        sublistId: 'item',
                        fieldId: 'item',
                        value: TM_B_ITEM_ID
                    });

                    if (lineIndex !== -1) {
                        loadSalesOrder.selectLine({ sublistId: 'item', line: lineIndex });

                        loadSalesOrder.setCurrentSublistValue({
                          sublistId: 'item',
                          fieldId: 'isclosed',
                          value: true
                        });
                        loadSalesOrder.commitLine({ sublistId: 'item' });
                        loadSalesOrder.save({
                        enableSourcing: true,
                        ignoreMandatoryFields: true
                    });
                    }
                } catch (error) {
                    log.debug('error while saving order on reservation', error);
                }
            }

            if (invoiceIdIs) {
              var response = https.get({
                   url: 'https://1039693.extforms.netsuite.com/app/site/hosting/scriptlet.nl?script=3296&deploy=1&compid=1039693&ns-at=AAEJ7tMQ7FbIvC7C4CXmDC6HpNyrI0buOQ0wPxjhFUdFg5WJjWA&recid=' + invoiceIdIs,
              });
            }

        } catch (e) {
            log.error('Error Creating Invoice', e.name + ': ' + e.message);
        }
    }

    return {
        afterSubmit: afterSubmit
    };
});