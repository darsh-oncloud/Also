/**
 * @NApiVersion 2.x
 * @NScriptType MapReduceScript
 */
define(['N/file', 'N/search', 'N/runtime', 'N/record', 'N/https'], function (file, search, runtime, record, https) {

    var PROCESSED_FOLDER_ID = 23781;
    var ERROR_FOLDER_ID = 23782; //test

    var IF_PAYLOAD_FIELD = 'custbody_fulfilled_order_number';
    var IF_LINE_MATCH_FIELD = 'custcol_3pl_fulfillment_key';

    var SO_HEADER_STATUS_FIELD = 'custbody_3pl_export_status';
    var SO_LINE_STATUS_FIELD = 'custcol_3pl_export_status';

    var PARENT_COMP_FIELD = 'custcol_item_parentcomp';
    var PARENT_ITEM_FIELD = 'custcol_parent_item';

    var STATUS_SENT = '2';
    var STATUS_PARTIALLY_SENT = '7';
    var STATUS_FULFILLED = '8';
    var STATUS_PARTIALLY_FULFILLED = '9';

    function getInputData() {
        var resultsArray = [];
        var searchId = runtime.getCurrentScript().getParameter('custscript_createdsosearch');
        var soSearchObj = search.load({ id: searchId });

        var pagedData = soSearchObj.runPaged({ pageSize: 1000 });

        pagedData.pageRanges.forEach(function (pageRange) {
            var page = pagedData.fetch({ index: pageRange.index });

            page.data.forEach(function (result) {
                resultsArray.push({
                    internalid: result.getValue(soSearchObj.columns[0]),
                    so_docno: result.getValue(soSearchObj.columns[1]),
                    payloadcount: result.getValue(soSearchObj.columns[2])
                });
            });
        });

        log.debug('getInputData resultsArray length', resultsArray.length);
        return resultsArray;
    }

    function reduce(context) {
        try {
            var resultObj = JSON.parse(context.values[0]);
            var soId = resultObj.internalid;
            var soDocNo = resultObj.so_docno;
            var payloadCount = parseInt(resultObj.payloadcount, 10);

            if (!soId || !soDocNo) {
                log.error('Missing search values', JSON.stringify(resultObj));
                return;
            }

            if (isNaN(payloadCount) || payloadCount <= 0) {
                log.debug('No payload count found for SO', soDocNo);
                return;
            }

            log.debug('Processing SO', {
                soId: soId,
                soDocNo: soDocNo,
                payloadCount: payloadCount
            });

            for (var i = 1; i < payloadCount; i++) {
                var payloadId = soDocNo + '_' + String(i);

                try {
                    if (isPayloadAlreadyFulfilled(soId, payloadId)) {
                        log.debug('Payload already fulfilled, skipping', payloadId);
                        continue;
                    }

                    processPayloadForFulfillment(soId, payloadId);

                } catch (payloadErr) {
                    log.error('Payload processing error for ' + payloadId, payloadErr);
                }
            }

        } catch (e) {
            log.error('reduce error', e);
        }
    }

    function processPayloadForFulfillment(soId, payloadId) {
        var payloadObj = getShipmentPayloadFromSeko(payloadId);

        if (!payloadObj) {
            log.debug('No shipment found for payload', payloadId);
            return;
        }

        try {
            var ifResult = createItemFulfillmentFromPayload(soId, payloadId, payloadObj);

            if (ifResult && ifResult.ifId) {
                updateSalesOrderStatusesAfterFulfillment(soId, payloadObj, ifResult.parentItemsToUpdate);
                savePayloadFile(payloadId, payloadObj, null, PROCESSED_FOLDER_ID);

                log.audit('Fulfillment created successfully', {
                    payloadId: payloadId,
                    ifId: ifResult.ifId
                });
            }

        } catch (e) {
            log.error('Fulfillment creation failed for ' + payloadId, e);
            savePayloadFile(payloadId, payloadObj, getErrorMessage(e), ERROR_FOLDER_ID);
            throw e;
        }
    }

    function getShipmentPayloadFromSeko(payloadId) {
        var companyId = runtime.getCurrentScript().getParameter('custscript_shipmentconfirmationcompanyId');
        var subKey = runtime.getCurrentScript().getParameter('custscript_shipmentconfirmationkey');
        var fulfillmentCenterId = runtime.getCurrentScript().getParameter('custscript_shipmentconfirmationfulfillId');

        var url = 'https://devapi.sekologistics.com/wms/v2/shipment-detail?companyId=' +
            encodeURIComponent(companyId) +
            '&fulfillmentCenterId=' + encodeURIComponent(fulfillmentCenterId) +
            '&salesOrderId=' + encodeURIComponent(payloadId);

        var headers = {
            'Content-Type': 'application/json',
            'Ocp-Apim-Subscription-Key': subKey
        };

        var response = https.get({
            url: url,
            headers: headers
        });

        log.debug('SEKO shipment response for ' + payloadId, {
            code: response.code,
            body: response.body
        });

        if (String(response.code) !== '200') {
            log.debug('Non-200 from SEKO, skipping payload', payloadId);
            return null;
        }

        var payloadObj = {};
        try {
            payloadObj = JSON.parse(response.body || '{}');
        } catch (e) {
            log.error('Unable to parse SEKO response JSON for ' + payloadId, e);
            return null;
        }

        if (payloadObj.error === 'No Data Found') {
            log.debug('SEKO returned No Data Found', payloadId);
            return null;
        }

        return payloadObj;
    }

    function createItemFulfillmentFromPayload(soId, payloadId, payloadObj) {
        var details = payloadObj.details || [];
        if (!details.length) {
            throw 'Payload has no detail lines for fulfillment';
        }

        var itemFulfillmentObj = record.transform({
            fromType: record.Type.SALES_ORDER,
            fromId: soId,
            toType: record.Type.ITEM_FULFILLMENT,
            isDynamic: true
        });

        itemFulfillmentObj.setValue({
            fieldId: 'shipstatus',
            value: 'C'
        });

        if (payloadObj.ToDispatchDate) {
            var dispatchDate = parseIsoDate(payloadObj.ToDispatchDate);
            if (dispatchDate) {
                itemFulfillmentObj.setValue({
                    fieldId: 'trandate',
                    value: dispatchDate
                });
            }
        }

        itemFulfillmentObj.setValue({
            fieldId: IF_PAYLOAD_FIELD,
            value: payloadId
        });

        clearPackageLines(itemFulfillmentObj);
        addSinglePackageLine(itemFulfillmentObj, payloadObj);

        var lineCount = itemFulfillmentObj.getLineCount({ sublistId: 'item' });
        var parentMinQtyMap = {};
        var parentItemsToUpdate = {};
        var matchedLineCount = 0;
        var i, j;

        // uncheck all first
        for (i = 0; i < lineCount; i++) {
            itemFulfillmentObj.selectLine({
                sublistId: 'item',
                line: i
            });

            itemFulfillmentObj.setCurrentSublistValue({
                sublistId: 'item',
                fieldId: 'itemreceive',
                value: false
            });

            itemFulfillmentObj.commitLine({
                sublistId: 'item'
            });
        }

        // match by custcol_3pl_fulfillment_key = payload lineNumber
        for (i = 0; i < details.length; i++) {
            var payloadLineNumber = normalizeKey(details[i].lineNumber);
            var payloadQty = toNumber(details[i].originalQuantity);
            var found = false;

            for (j = 0; j < lineCount; j++) {
                var ifFulfillmentKey = normalizeKey(itemFulfillmentObj.getSublistValue({
                    sublistId: 'item',
                    fieldId: IF_LINE_MATCH_FIELD,
                    line: j
                }));

                var parentCompText = itemFulfillmentObj.getSublistText({
                    sublistId: 'item',
                    fieldId: PARENT_COMP_FIELD,
                    line: j
                }) || '';

                var parentItemValue = itemFulfillmentObj.getSublistValue({
                    sublistId: 'item',
                    fieldId: PARENT_ITEM_FIELD,
                    line: j
                });

                var alreadyChecked = itemFulfillmentObj.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'itemreceive',
                    line: j
                });

                if (
                    String(parentCompText).toLowerCase() !== 'parent' &&
                    !alreadyChecked &&
                    ifFulfillmentKey === payloadLineNumber
                ) {
                    itemFulfillmentObj.selectLine({
                        sublistId: 'item',
                        line: j
                    });

                    itemFulfillmentObj.setCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'itemreceive',
                        value: true
                    });

                    itemFulfillmentObj.setCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantity',
                        value: payloadQty
                    });

                    itemFulfillmentObj.commitLine({
                        sublistId: 'item'
                    });

                    matchedLineCount++;

                    if (parentItemValue) {
                        parentItemsToUpdate[String(parentItemValue)] = true;
                        updateParentMinQtyMap(parentMinQtyMap, String(parentItemValue), payloadQty);
                    }

                    log.debug('Matched payload line to IF line by fulfillment key', {
                        payloadId: payloadId,
                        payloadLineNumber: payloadLineNumber,
                        quantity: payloadQty,
                        line: j,
                        parentItemValue: parentItemValue
                    });

                    found = true;
                    break;
                }
            }

            if (!found) {
                log.debug('Payload line not found in IF by fulfillment key, skipping', {
                    payloadId: payloadId,
                    payloadLineNumber: payloadLineNumber,
                    quantity: payloadQty
                });
            }
        }

        // parent lines
        for (i = 0; i < lineCount; i++) {
            var lineItemId = itemFulfillmentObj.getSublistValue({
                sublistId: 'item',
                fieldId: 'item',
                line: i
            });

            var lineParentCompText = itemFulfillmentObj.getSublistText({
                sublistId: 'item',
                fieldId: PARENT_COMP_FIELD,
                line: i
            }) || '';

            if (
                parentItemsToUpdate[String(lineItemId)] &&
                String(lineParentCompText).toLowerCase() === 'parent' &&
                parentMinQtyMap[String(lineItemId)] > 0
            ) {
                itemFulfillmentObj.selectLine({
                    sublistId: 'item',
                    line: i
                });

                itemFulfillmentObj.setCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'itemreceive',
                    value: true
                });

                itemFulfillmentObj.setCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantity',
                    value: parentMinQtyMap[String(lineItemId)]
                });

                itemFulfillmentObj.commitLine({
                    sublistId: 'item'
                });

                matchedLineCount++;

                log.debug('Parent IF line fulfilled', {
                    payloadId: payloadId,
                    parentItemId: lineItemId,
                    quantity: parentMinQtyMap[String(lineItemId)]
                });
            }
        }

        if (matchedLineCount === 0) {
            throw 'No matching IF lines found from payload details';
        }

        var ifId = itemFulfillmentObj.save({
            enableSourcing: false,
            ignoreMandatoryFields: true
        });

        return {
            ifId: ifId,
            parentItemsToUpdate: parentItemsToUpdate
        };
    }

    function updateSalesOrderStatusesAfterFulfillment(soId, payloadObj, parentItemsToUpdate) {
        var details = payloadObj.details || [];
        if (!details.length) {
            return;
        }

        var fulfilledLineKeys = buildPayloadLineKeyMap(details);

        var soRec = record.load({
            type: record.Type.SALES_ORDER,
            id: soId,
            isDynamic: false
        });

        var lineCount = soRec.getLineCount({ sublistId: 'item' });
        var i;

        for (i = 0; i < lineCount; i++) {
            var currentLineUniqueKey = soRec.getSublistValue({
                sublistId: 'item',
                fieldId: 'lineuniquekey',
                line: i
            });

            var currentLineStatus = soRec.getSublistValue({
                sublistId: 'item',
                fieldId: SO_LINE_STATUS_FIELD,
                line: i
            });

            var currentItemId = soRec.getSublistValue({
                sublistId: 'item',
                fieldId: 'item',
                line: i
            });

            var currentParentCompText = soRec.getSublistText({
                sublistId: 'item',
                fieldId: PARENT_COMP_FIELD,
                line: i
            }) || '';

            var newStatus = '';

            if (fulfilledLineKeys[String(currentLineUniqueKey)]) {
                newStatus = getNextFulfillmentStatus(currentLineStatus);
                if (newStatus) {
                    soRec.setSublistValue({
                        sublistId: 'item',
                        fieldId: SO_LINE_STATUS_FIELD,
                        line: i,
                        value: newStatus
                    });
                }
            }

            if (
                parentItemsToUpdate &&
                parentItemsToUpdate[String(currentItemId)] &&
                String(currentParentCompText).toLowerCase() === 'parent'
            ) {
                newStatus = getNextFulfillmentStatus(currentLineStatus);
                if (newStatus) {
                    soRec.setSublistValue({
                        sublistId: 'item',
                        fieldId: SO_LINE_STATUS_FIELD,
                        line: i,
                        value: newStatus
                    });
                }
            }
        }

        var currentHeaderStatus = soRec.getValue({
            fieldId: SO_HEADER_STATUS_FIELD
        });

        var newHeaderStatus = getNextFulfillmentStatus(currentHeaderStatus);
        if (newHeaderStatus) {
            soRec.setValue({
                fieldId: SO_HEADER_STATUS_FIELD,
                value: newHeaderStatus
            });
        }

        soRec.save({
            enableSourcing: false,
            ignoreMandatoryFields: true
        });

        log.debug('Sales Order statuses updated', soId);
    }

    function isPayloadAlreadyFulfilled(soId, payloadId) {
        var ifSearch = search.create({
            type: search.Type.ITEM_FULFILLMENT,
            filters: [
                ['mainline', 'is', 'T'],
                'AND',
                ['createdfrom', 'anyof', soId],
                'AND',
                [IF_PAYLOAD_FIELD, 'is', payloadId]
            ],
            columns: [
                search.createColumn({ name: 'internalid' })
            ]
        });

        var count = ifSearch.runPaged({ pageSize: 1 }).count;
        return count > 0;
    }

    function clearPackageLines(itemFulfillmentObj) {
        var packageCount = itemFulfillmentObj.getLineCount({
            sublistId: 'package'
        });

        for (var i = packageCount - 1; i >= 0; i--) {
            itemFulfillmentObj.removeLine({
                sublistId: 'package',
                line: i
            });
        }
    }

    function addSinglePackageLine(itemFulfillmentObj, payloadObj) {
        itemFulfillmentObj.selectNewLine({
            sublistId: 'package'
        });

        itemFulfillmentObj.setCurrentSublistValue({
            sublistId: 'package',
            fieldId: 'packageweight',
            value: toNumber(payloadObj.weightShipment) * 2.2
        });

        if (!isNullOrEmpty(payloadObj.trackingNumber02)) {
            itemFulfillmentObj.setCurrentSublistValue({
                sublistId: 'package',
                fieldId: 'packagetrackingnumber',
                value: String(payloadObj.trackingNumber02)
            });
        }

        itemFulfillmentObj.commitLine({
            sublistId: 'package'
        });
    }

    function buildPayloadLineKeyMap(details) {
        var map = {};
        for (var i = 0; i < details.length; i++) {
            map[String(details[i].lineNumber)] = true;
        }
        return map;
    }

    function updateParentMinQtyMap(parentMinQtyMap, parentItemId, qty) {
        if (!parentItemId) {
            return;
        }

        if (parentMinQtyMap[parentItemId] === undefined || parentMinQtyMap[parentItemId] === null) {
            parentMinQtyMap[parentItemId] = qty;
            return;
        }

        if (qty < parentMinQtyMap[parentItemId]) {
            parentMinQtyMap[parentItemId] = qty;
        }
    }

    function getNextFulfillmentStatus(currentStatus) {
        currentStatus = currentStatus !== null && currentStatus !== undefined ? String(currentStatus) : '';

        if (currentStatus === STATUS_SENT) {
            return STATUS_FULFILLED;
        }

        if (currentStatus === STATUS_PARTIALLY_SENT) {
            return STATUS_PARTIALLY_FULFILLED;
        }

        return '';
    }

    function parseIsoDate(value) {
        if (!value) {
            return null;
        }

        var d = new Date(value);
        if (isNaN(d.getTime())) {
            return null;
        }

        return d;
    }

    function normalizeKey(value) {
        return String(value || '').replace(/,/g, '').replace(/^\s+|\s+$/g, '');
    }

    function toNumber(value) {
        if (value === null || value === '' || value === undefined) {
            return 0;
        }

        var num = parseFloat(value);
        if (isNaN(num)) {
            return 0;
        }

        return num;
    }

    function isNullOrEmpty(objVariable) {
        return (
            objVariable === null ||
            objVariable === '' ||
            objVariable === undefined ||
            objVariable === 'undefined'
        );
    }

    function getErrorMessage(e) {
        if (!e) {
            return '';
        }

        if (typeof e === 'string') {
            return e;
        }

        if (e.message) {
            return e.message;
        }

        try {
            return JSON.stringify(e);
        } catch (jsonErr) {
            return String(e);
        }
    }

    function savePayloadFile(payloadId, payloadObj, errorMessage, folderId) {
        try {
            var timestamp = getTimeStampString();
            var fileName = payloadId + '_' + timestamp + '.json';

            var contentObj = {
                payloadId: payloadId,
                timestamp: timestamp,
                payload: payloadObj || {}
            };

            if (errorMessage) {
                contentObj.error = errorMessage;
            }

            var payloadFile = file.create({
                name: fileName,
                fileType: file.Type.JSON,
                contents: JSON.stringify(contentObj, null, 2),
                folder: folderId
            });

            var fileId = payloadFile.save();
            log.debug('Payload file saved', {
                payloadId: payloadId,
                fileId: fileId,
                folderId: folderId
            });

        } catch (e) {
            log.error('Unable to save payload file for ' + payloadId, e);
        }
    }

    function getTimeStampString() {
        var now = new Date();

        return now.getFullYear() +
            pad(now.getMonth() + 1) +
            pad(now.getDate()) + '_' +
            pad(now.getHours()) +
            pad(now.getMinutes()) +
            pad(now.getSeconds());
    }

    function pad(value) {
        value = parseInt(value, 10);
        if (value < 10) {
            return '0' + value;
        }
        return String(value);
    }

    function summarize(summary) {
        log.audit('Usage', summary.usage);
        log.audit('Concurrency', summary.concurrency);
        log.audit('Yields', summary.yields);

        if (summary.inputSummary && summary.inputSummary.error) {
            log.error('Input Error', summary.inputSummary.error);
        }

        if (summary.reduceSummary && summary.reduceSummary.errors) {
            summary.reduceSummary.errors.iterator().each(function (key, error) {
                log.error('Reduce Error for key: ' + key, error);
                return true;
            });
        }
    }

    return {
        getInputData: getInputData,
        reduce: reduce,
        summarize: summarize
    };
});