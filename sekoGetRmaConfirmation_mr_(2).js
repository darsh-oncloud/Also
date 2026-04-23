/**
 * @NApiVersion 2.x
 * @NScriptType MapReduceScript
 */
define(['N/search', 'N/runtime', 'N/record', 'N/https'],
function (search, runtime, record, https) {

    function getInputData() {
        var results_array = [];

        var searchId = runtime.getCurrentScript().getParameter('custscript_createdrmaconfirmationsearch');
        var rmaSearchObj = search.load({ id: searchId });

        var result_set = rmaSearchObj.run();
        var current_range = result_set.getRange({
            start: 0,
            end: 1000
        });

        var i = 0;
        var j = 0;

        while (j < current_range.length) {
            var result = current_range[j];

            var internalid = result.getValue(result_set.columns[0]);
            var rma_docno = result.getValue(result_set.columns[1]);

            results_array.push({
                internalid: internalid,
                rma_docno: rma_docno
            });

            i++;
            j++;

            if (j == 1000) {
                j = 0;
                current_range = result_set.getRange({
                    start: i,
                    end: i + 1000
                });
            }
        }

        log.debug('results_array', results_array);
        return results_array;
    }

    function reduce(context) {
        try {
            var search_result = context.values;
            var resultObj = JSON.parse(search_result[0]);

            var rma_id = resultObj.internalid;
            var rma_docno = resultObj.rma_docno;

            log.debug('reduce - rma_id', rma_id);
            log.debug('reduce - rma_docno', rma_docno);

            var companyId = runtime.getCurrentScript().getParameter('custscript_rmaconfirmationcompanyId');
            var sub_key = runtime.getCurrentScript().getParameter('custscript_rmaconfirmationkey');
            var fulfillmentCenterId = runtime.getCurrentScript().getParameter('custscript_rmaconfirmationfulfillId');

            var tempurl = 'https://devapi.sekologistics.com/wms/v2/rma-receipt-confirmation?companyId=' +
                companyId +
                '&fulfillmentCenterId=' +
                fulfillmentCenterId +
                '&returnAuthorization=' +
                rma_docno +
                '&hbRef';

            log.debug('tempurl', tempurl);

            var headers = {
                'Content-Type': 'application/json',
                'Ocp-Apim-Subscription-Key': sub_key
            };

            var response = https.get({
                url: tempurl,
                headers: headers
            });

            log.debug('SEKO Response Code', response.code);
            log.debug('SEKO Response Body', response.body);

            if (response.code == 200 && response.body) {
                var parsedResponse = JSON.parse(response.body);
                log.debug('parsedResponse', parsedResponse);

                var item_receiptId = createItemReceiptFromRMA(rma_id, parsedResponse);
                log.debug('item_receiptId', item_receiptId);
            }

        } catch (e) {
            log.audit({
                title: e.name,
                details: e.message
            });
        }
    }

    function getItemIdText(itemInternalId) {
        try {
            var itemLookup = search.lookupFields({
                type: search.Type.ITEM,
                id: itemInternalId,
                columns: ['itemid']
            });

            var itemIdText = itemLookup.itemid || '';
            log.debug('getItemIdText', {
                itemInternalId: itemInternalId,
                itemIdText: itemIdText
            });

            return itemIdText;
        } catch (e) {
            log.audit('ERROR IN getItemIdText', e.name + ' : ' + e.message);
            return '';
        }
    }

    function createItemReceiptFromRMA(rmaId, responseData) {
        var responseObj = responseData && responseData.length ? responseData[0] : null;

        log.debug('createItemReceiptFromRMA - rmaId', rmaId);
        log.debug('createItemReceiptFromRMA - responseObj', responseObj);

        if (!responseObj) {
            log.audit('No SEKO data found', 'No receipt confirmation data returned.');
            return '';
        }

        var confirmedDate = responseObj.ConfirmedDate;
        var details = responseObj.details || [];

        log.debug('confirmedDate', confirmedDate);
        log.debug('details', details);

        var itemReceipt = record.transform({
            fromType: record.Type.RETURN_AUTHORIZATION,
            fromId: parseInt(rmaId, 10),
            toType: record.Type.ITEM_RECEIPT,
            isDynamic: true
        });

        log.debug('Transform Success', 'Return Authorization transformed to Item Receipt');

        if (confirmedDate) {
            try {
                var confirmedDateOnly = confirmedDate.split('T')[0];
                var dateParts = confirmedDateOnly.split('-');

                var tranDateObj = new Date(
                    parseInt(dateParts[0], 10),
                    parseInt(dateParts[1], 10) - 1,
                    parseInt(dateParts[2], 10)
                );

                log.debug('confirmedDate raw', confirmedDate);
                log.debug('confirmedDateOnly', confirmedDateOnly);
                log.debug('tranDateObj', tranDateObj);

                itemReceipt.setValue({
                    fieldId: 'trandate',
                    value: tranDateObj
                });

                log.debug('trandate set success', tranDateObj);
            } catch (e) {
                log.audit('ERROR SETTING TRANDATE', e.name + ' : ' + e.message);
                throw e;
            }
        }

        var lineCount = itemReceipt.getLineCount({ sublistId: 'item' });
        log.debug('itemReceipt lineCount', lineCount);

        var i;
        var j;

        // Uncheck all lines first
        for (i = 0; i < lineCount; i++) {
            try {
                itemReceipt.selectLine({
                    sublistId: 'item',
                    line: i
                });

                log.debug('Uncheck Line', {
                    index: i,
                    item: itemReceipt.getCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'item'
                    }),
                    linevalue: itemReceipt.getCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'line'
                    }),
                    quantity: itemReceipt.getCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantity'
                    }),
                    location: itemReceipt.getCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'location'
                    })
                });

                itemReceipt.setCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'itemreceive',
                    value: false
                });

                itemReceipt.commitLine({
                    sublistId: 'item'
                });

            } catch (e) {
                log.audit('ERROR UNCHECKING LINE ' + i, e.name + ' : ' + e.message);
                throw e;
            }
        }

        // Match only confirmed lines
        for (j = 0; j < details.length; j++) {
            var responseLineNumber = parseInt(details[j].lineNumber, 10);
            var responseItemName = details[j].product;
            var responseQty = details[j].quantity;

            log.debug('Processing SEKO Detail', {
                detailIndex: j,
                responseLineNumber: responseLineNumber,
                responseItemName: responseItemName,
                responseQty: responseQty
            });

            for (i = 0; i < lineCount; i++) {
                var nsItemInternalId = itemReceipt.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: i
                });

                var nsItemName = getItemIdText(nsItemInternalId);

                var nsLineValue = parseInt(itemReceipt.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'line',
                    line: i
                }), 10);

                log.debug('Comparing Line', {
                    nsIndex: i,
                    nsLineValue: nsLineValue,
                    nsItemInternalId: nsItemInternalId,
                    nsItemName: nsItemName,
                    responseLineNumber: responseLineNumber,
                    responseItemName: responseItemName
                });

                if (nsLineValue === responseLineNumber && nsItemName === responseItemName) {
                    try {
                        log.debug('MATCH FOUND', {
                            nsIndex: i,
                            nsLineValue: nsLineValue,
                            nsItemInternalId: nsItemInternalId,
                            nsItemName: nsItemName,
                            responseQty: responseQty
                        });

                        itemReceipt.selectLine({
                            sublistId: 'item',
                            line: i
                        });

                        log.debug('Before Set Values', {
                            currentItemInternalId: itemReceipt.getCurrentSublistValue({
                                sublistId: 'item',
                                fieldId: 'item'
                            }),
                            currentLine: itemReceipt.getCurrentSublistValue({
                                sublistId: 'item',
                                fieldId: 'line'
                            }),
                            currentQty: itemReceipt.getCurrentSublistValue({
                                sublistId: 'item',
                                fieldId: 'quantity'
                            }),
                            currentLocation: itemReceipt.getCurrentSublistValue({
                                sublistId: 'item',
                                fieldId: 'location'
                            })
                        });

                        itemReceipt.setCurrentSublistValue({
                            sublistId: 'item',
                            fieldId: 'itemreceive',
                            value: true
                        });
                        log.debug('itemreceive set success', true);

                        itemReceipt.setCurrentSublistValue({
                            sublistId: 'item',
                            fieldId: 'quantity',
                            value: responseQty
                        });
                        log.debug('quantity set success', responseQty);

                     /*   itemReceipt.setCurrentSublistValue({
                            sublistId: 'item',
                            fieldId: 'location',
                            value: 16
                        });
                        log.debug('location set success', 16);

                        itemReceipt.commitLine({
                            sublistId: 'item'
                        }); 
                        log.debug('commitLine success', i); */

itemReceipt.setCurrentSublistValue({
    sublistId: 'item',
    fieldId: 'location',
    value: 7
});
log.debug('location set success', 7);

// Add Inventory Detail with Damaged status
var invDetail = itemReceipt.getCurrentSublistSubrecord({
    sublistId: 'item',
    fieldId: 'inventorydetail'
});

invDetail.selectNewLine({
    sublistId: 'inventoryassignment'
});

invDetail.setCurrentSublistValue({
    sublistId: 'inventoryassignment',
    fieldId: 'quantity',
    value: responseQty
});

invDetail.setCurrentSublistValue({
    sublistId: 'inventoryassignment',
    fieldId: 'inventorystatus',
    value: 2
});

invDetail.commitLine({
    sublistId: 'inventoryassignment'
});

itemReceipt.commitLine({
    sublistId: 'item'
});
log.debug('commitLine success', i);

                        break;
                    } catch (e) {
                        log.audit('ERROR ON MATCHED LINE ' + i, e.name + ' : ' + e.message);
                        throw e;
                    }
                }
            }
        }

        try {
            log.debug('Saving Item Receipt', 'start');
            var receiptId = itemReceipt.save({
                enableSourcing: true,
                ignoreMandatoryFields: false
            });
            log.debug('Item Receipt Saved', receiptId);
            return receiptId;
        } catch (e) {
            log.audit('ERROR SAVING ITEM RECEIPT', e.name + ' : ' + e.message);
            throw e;
        }
    }

    function summarize(summary) {
        log.audit({
            title: 'Usage',
            details: summary.usage
        });
        log.audit({
            title: 'Concurrency',
            details: summary.concurrency
        });
        log.audit({
            title: 'Yields',
            details: summary.yields
        });
    }

    return {
        getInputData: getInputData,
        reduce: reduce,
        summarize: summarize
    };
});