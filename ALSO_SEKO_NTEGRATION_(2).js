/**
 * @NApiVersion 2.x
 * @NScriptType MapReduceScript
 */
define(['N/search', 'N/https', 'N/record', 'N/runtime'], function (search, https, record, runtime) {

    var SEARCH_ID = '';


    var STATUS_READY_TO_SEND = '1';
    var STATUS_SENT = '2';
    var STATUS_ERROR = '3';
    var STATUS_PARTIALLY_READY = '6';
    var STATUS_PARTIALLY_SENT = '7';

    var LINE_UNIQUE_STORE_FIELD = 'custcol_3pl_fulfillment_key';
    var ERROR_FIELD = 'custbody_3pl_error';
    var HEADER_STATUS_FIELD = 'custbody_3pl_export_status';
    var LINE_STATUS_FIELD = 'custcol_3pl_export_status';
    var REQUEST_COUNT_FIELD = 'custbody_3pl_request_count';
    var HEADER_CHECK_FIELD = 'custbody_sekotransactioncheck';
    var TYPE_FIELD = 'custcol_item_parentcomp';

    function getInputData() {

        SEARCH_ID = runtime.getCurrentScript().getParameter({
          name: 'custscript_seko_saved_search'
        });
      
        var rows = [];
        var soSearch = search.load({ id: SEARCH_ID });
        var pagedData = soSearch.runPaged({ pageSize: 1000 });

        pagedData.pageRanges.forEach(function (pageRange) {
            var page = pagedData.fetch({ index: pageRange.index });
            page.data.forEach(function (result) {
                rows.push(extractRowByIndex(result, soSearch.columns));
            });
        });

        log.debug('getInputData.rows', rows.length);
        return rows;
    }

    function map(context) {
        try {
            var row = JSON.parse(context.value);
            var soId = row.internalId;

            if (!soId) {
                log.error('MAP MISSING INTERNAL ID', JSON.stringify(row));
                return;
            }

            context.write({
                key: String(soId),
                value: JSON.stringify(row)
            });
        } catch (e) {
            log.error('map error', e);
        }
    }

    function reduce(context) {
        var soId = context.key;

        try {
            var rows = [];
            var i;
            var header;
            var currentRequestCount;
            var grouped;
            var componentRequests;
            var resultInfo = {
                anyFailure: false,
                errorMessages: []
            };

            for (i = 0; i < context.values.length; i++) {
                rows.push(JSON.parse(context.values[i]));
            }

            if (!rows.length) {
                log.error('NO ROWS FOUND FOR ORDER', 'SO Internal ID: ' + soId);
                return;
            }

            header = rows[0];
            currentRequestCount = parseInt(header.requestCount, 10);
            if (isNaN(currentRequestCount) || currentRequestCount < 1) {
                currentRequestCount = 1;
            }

            grouped = groupRowsBy3plType(rows);

            if (grouped.component.length) {
                componentRequests = splitComponentRowsIntoRequests(grouped.component);

                for (i = 0; i < componentRequests.length; i++) {
                    currentRequestCount = processTypeGroup(
                        soId,
                        header,
                        componentRequests[i],
                        'COMPONENT',
                        currentRequestCount,
                        resultInfo
                    );
                }
            }

            if (grouped.addon.length) {
                currentRequestCount = processTypeGroup(
                    soId,
                    header,
                    grouped.addon,
                    'ADDON',
                    currentRequestCount,
                    resultInfo
                );
            }

            if (grouped.merch.length) {
                currentRequestCount = processTypeGroup(
                    soId,
                    header,
                    grouped.merch,
                    'MERCH',
                    currentRequestCount,
                    resultInfo
                );
            }

            finalizeHeaderStatus(soId, resultInfo);

        } catch (e) {
            log.error('reduce error SO ' + soId, e);
        }
    }

    function processTypeGroup(soId, header, rows, typeCode, requestCount, resultInfo) {
        var salesOrderIdToSend = String(header.documentNumber || '') + '_' + String(requestCount);
        var payload = buildPayload(header, rows, salesOrderIdToSend, typeCode);
        var headers = {
            'Content-Type': 'application/json',
            'Ocp-Apim-Subscription-Key': '24317d6663034ad4a19f5fce71b1cbe7'
        };
        var response;
        var errorMessage = '';

        log.debug('SEND GROUP', {
            soId: soId,
            type: typeCode,
            requestCount: requestCount,
            rowCount: rows.length,
            salesOrderIdToSend: salesOrderIdToSend
        });

        log.audit('SEKO TEST PAYLOAD SO ' + soId + ' ' + typeCode, JSON.stringify(payload));

        response = https.post({
            url: 'https://devapi.sekologistics.com/wms/v2/salesOrder',
            body: JSON.stringify(payload),
            headers: headers
        });

        log.debug('SEKO Response ' + typeCode, response);
        log.debug('SEKO Response Code ' + typeCode, response.code);
        log.debug('SEKO Response Body ' + typeCode, response.body);

        if (response.code == 200) {
            updateSalesOrderGroupSuccess(soId, rows, requestCount + 1, typeCode);
            return requestCount + 1;
        }

        errorMessage = extractErrorMessage(response, typeCode, salesOrderIdToSend);
        updateSalesOrderGroupError(soId, rows, typeCode, errorMessage);

        resultInfo.anyFailure = true;
        resultInfo.errorMessages.push(errorMessage);

        return requestCount;
    }

    function buildPayload(header, rows, salesOrderIdToSend, typeCode) {
        var shipTitle = truncateText(header.shipAddressee || '', 20);
        var details = [];
        var i;

       var carrierId = 'FEDEX';
       var carrierService = 'FEDEX_GROUND';

       if (typeCode === 'COMPONENT') {
          carrierId = 'Seko Rateshopping';
          carrierService = ' ';
         }

        for (i = 0; i < rows.length; i++) {
            details.push({
                "salesOrderId": salesOrderIdToSend,
                "lineNumber": parseInt(rows[i].lineNumber, 10),
                "product": rows[i].itemText || "",
                "quantity": toNumber(rows[i].requestQty),
                "price": toNumber(rows[i].itemRate),
                "discountDollars": 0,
                "customerLineNumber": parseInt(rows[i].lineNumber, 10) || "",
                "customerProductDescription": rows[i].description || "",
                "tax": 0,
                "lot": "",
                "reference": rows[i].itemValue || "",
                "CurrencyCode": rows[i].currencyText || rows[i].currencyValue || ""
            });
        }

        return {
            "tenantId": salesOrderIdToSend,
            "companyId": "ALSO",
            "fulfillmentCenterId": "SEKOLAX2",
            "salesOrderId": salesOrderIdToSend,
            "ShipTo": {
                "Title": shipTitle,
                "FirstName": header.firstName || "",
                "LastName": header.lastName || "",
                "ShipToId": "WEBORDERALSOINC",
                "Company": "Web Order",
                "Line1": header.shipAddress1 || "",
                "Line2": header.shipAddress2 || "",
                "Line3": header.shipAttention || "",
                "Line4": header.shipAddressee || "",
                "City": header.shipCity || "",
                "County": header.shipState || "",
                "CountryCode": header.shipCountryCode || header.shipCountry || "",
                "PostcodeZip": header.shipZip || "",
                "PhoneNumber": header.phone || "",
                "EmailAddress": header.email || "",
                "BranchCode": "",
                "LookupDeliveryAddress": "",
                "DeliveryContactIDNumber": "111111111",
                "ContactCode": "11111111"
            },
            "specialInstructions": header.deliveryInstructions || "",
            "salesOrderType": "Web",
            "giftCardMessage": "",
            "giftCard": "",
            "quoteReferenceNumber": header.internalId || "",
            "carrierId": carrierId,
            "carrierService": carrierService,
            "orderDate": formatDate(header.orderDate),
            "plannedShipDate": formatDate(header.shipDate),
            "purchaseOrderNumber": header.poNumber || "",
            "accountingCode": "",
            "query01": "",
            "action": "INSERT",
            "customer.Type": "Web",
            "note": header.memo || "",
            "shipmentTerms": header.bolFreightTerms || "",
            "controlReferenceNumber": "",
            "GUID": "",
            "billToCompany": header.billAddressee || "",
            "acknowledgement": "",
            "arnReferenceNumber": "",
            "DeliveryAddressLocationType": "RESIDENTIAL",
            "DoNotPushToDC": "",
            "LocationType": "",
            "OnHold": "",
            "Ultimatedestination": "",
            "NotificationMethod": "NotificationMethod",
            "ShippingTerm": header.bolFreightTerms || "",
            "TaxTotal": toNumber(header.taxTotal),
            "SubTotal": toNumber(header.orderTotal),
            "Channel": header.etailChannel || "",
            "BillingDetails": {
                "City": header.billCity || "",
                "CountryCode": header.billCountryCode || header.billCountry || "",
                "County": header.billState || "",
                "EmailAddress": header.email || "",
                "FirstName": header.firstName || "",
                "LastName": header.lastName || "",
                "Line1": header.billAddress1 || "",
                "Line2": header.billAddress2 || "",
                "Line3": header.billAddressee || "",
                "Line4": header.billAttention || "",
                "PhoneNumber": header.phone || "",
                "PostcodeZip": header.billZip || "",
                "Title": ""
            },
            "details": details
        };
    }

    function groupRowsBy3plType(rows) {
        var grouped = { component: [], addon: [], merch: [] };
        var i;
        var typeKey;

        for (i = 0; i < rows.length; i++) {
            typeKey = get3plTypeKey(rows[i].parentCompType, rows[i].parentCompValue);

            if (typeKey === 'component') {
                rows[i].requestQty = toNumber(rows[i].exportQty);
                grouped.component.push(rows[i]);
            } else if (typeKey === 'addon') {
                rows[i].requestQty = toNumber(rows[i].exportQty);
                grouped.addon.push(rows[i]);
            } else if (typeKey === 'merch') {
                rows[i].requestQty = toNumber(rows[i].exportQty);
                grouped.merch.push(rows[i]);
            }
        }

        return grouped;
    }

    function splitComponentRowsIntoRequests(componentRows) {
        var byParent = {};
        var requests = [];
        var i;
        var row;
        var parentId;
        var parentRows;
        var maxQty;
        var reqNo;
        var clonedRow;

        for (i = 0; i < componentRows.length; i++) {
            row = componentRows[i];
            parentId = String(row.parentItemValue || '');

            if (!parentId) {
                parentId = 'NO_PARENT_' + String(i);
            }

            if (!byParent[parentId]) {
                byParent[parentId] = [];
            }

            byParent[parentId].push(row);
        }

        for (parentId in byParent) {
            if (!byParent.hasOwnProperty(parentId)) {
                continue;
            }

            parentRows = byParent[parentId];
            maxQty = getMaxExportQty(parentRows);

            for (reqNo = 1; reqNo <= maxQty; reqNo++) {
                var requestRows = [];

                for (i = 0; i < parentRows.length; i++) {
                    clonedRow = cloneRow(parentRows[i]);
                    clonedRow.requestQty = 1;
                    requestRows.push(clonedRow);
                }

                requests.push(requestRows);
            }
        }

        return requests;
    }

    function getMaxExportQty(rows) {
        var maxQty = 0;
        var i;
        var qty;

        for (i = 0; i < rows.length; i++) {
            qty = parseInt(rows[i].exportQty, 10);
            if (isNaN(qty) || qty < 0) {
                qty = 0;
            }
            if (qty > maxQty) {
                maxQty = qty;
            }
        }

        return maxQty;
    }

    function cloneRow(row) {
        var obj = {};
        var key;

        for (key in row) {
            if (row.hasOwnProperty(key)) {
                obj[key] = row[key];
            }
        }

        return obj;
    }

    function get3plTypeKey(typeText, typeValue) {
        var text = String(typeText || '').toLowerCase();
        var value = String(typeValue || '');

        if (value === '2' || text === 'component') return 'component';
        if (value === '3' || text === 'add-on' || text === 'addon') return 'addon';
        if (value === '4' || text === 'merch') return 'merch';

        return '';
    }

    function updateSalesOrderGroupSuccess(soId, rows, newRequestCount, typeCode) {
        var soRec = record.load({
            type: record.Type.SALES_ORDER,
            id: soId,
            isDynamic: false
        });

        var itemCount = soRec.getLineCount({ sublistId: 'item' });
        var sentLineUniqueKeys = {};
        var parentItemsToUpdate = {};
        var i;
        var currentLineUniqueKey;
        var currentLineStatus;
        var currentLineItem;
        var currentLineTypeText;
        var newStatus;

        for (i = 0; i < rows.length; i++) {
            if (rows[i].lineNumber) {
                sentLineUniqueKeys[String(rows[i].lineNumber)] = true;
            }

            if (typeCode === 'COMPONENT' && rows[i].parentItemValue) {
                parentItemsToUpdate[String(rows[i].parentItemValue)] = true;
            }
        }

        soRec.setValue({
            fieldId: HEADER_CHECK_FIELD,
            value: true
        });

        soRec.setValue({
            fieldId: REQUEST_COUNT_FIELD,
            value: parseInt(newRequestCount, 10)
        });

        for (i = 0; i < itemCount; i++) {
            currentLineUniqueKey = soRec.getSublistValue({
                sublistId: 'item',
                fieldId: 'lineuniquekey',
                line: i
            });

            currentLineStatus = soRec.getSublistValue({
                sublistId: 'item',
                fieldId: LINE_STATUS_FIELD,
                line: i
            });

            currentLineItem = soRec.getSublistValue({
                sublistId: 'item',
                fieldId: 'item',
                line: i
            });

            currentLineTypeText = soRec.getSublistText({
                sublistId: 'item',
                fieldId: TYPE_FIELD,
                line: i
            });

            if (sentLineUniqueKeys[String(currentLineUniqueKey)]) {
                soRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: LINE_UNIQUE_STORE_FIELD,
                    line: i,
                    value: String(currentLineUniqueKey || '').replace(/,/g, '')
                });

                newStatus = getNext3plStatus(currentLineStatus);
                if (newStatus) {
                    soRec.setSublistValue({
                        sublistId: 'item',
                        fieldId: LINE_STATUS_FIELD,
                        line: i,
                        value: newStatus
                    });
                }
            }

            if (
                typeCode === 'COMPONENT' &&
                parentItemsToUpdate[String(currentLineItem)] &&
                currentLineTypeText &&
                String(currentLineTypeText).toLowerCase() === 'parent'
            ) {
                newStatus = getNext3plStatus(currentLineStatus);
                if (newStatus) {
                    soRec.setSublistValue({
                        sublistId: 'item',
                        fieldId: LINE_STATUS_FIELD,
                        line: i,
                        value: newStatus
                    });
                }
            }
        }

        soRec.save({
            enableSourcing: false,
            ignoreMandatoryFields: true
        });
    }

    function extractErrorMessage(response, typeCode, salesOrderIdToSend) {
        var msg = '';
        var bodyObj;

        try {
            if (response && response.body) {
                bodyObj = JSON.parse(response.body);

                if (
                    bodyObj &&
                    bodyObj.Response &&
                    bodyObj.Response.CallStatus &&
                    bodyObj.Response.CallStatus.Message
                ) {
                    msg = String(bodyObj.Response.CallStatus.Message || '');
                }
            }
        } catch (e) {
            msg = '';
        }

        if (!msg) {
            msg = typeCode + ' ERROR for ' + salesOrderIdToSend + ' (HTTP ' + response.code + ')';
        } else {
            msg = typeCode + ' ERROR: ' + msg;
        }

        return msg;
    }

    function updateSalesOrderGroupError(soId, rows, typeCode, errorMessage) {
        try {
            var soRec = record.load({
                type: record.Type.SALES_ORDER,
                id: soId,
                isDynamic: false
            });

            var itemCount = soRec.getLineCount({ sublistId: 'item' });
            var sentLineUniqueKeys = {};
            var parentItemsToUpdate = {};
            var i;
            var currentLineUniqueKey;
            var currentLineItem;
            var currentLineTypeText;
            var oldErrorText = String(soRec.getValue({ fieldId: ERROR_FIELD }) || '');
            var newErrorText = oldErrorText ? oldErrorText + '\n' + errorMessage : errorMessage;

            for (i = 0; i < rows.length; i++) {
                if (rows[i].lineNumber) {
                    sentLineUniqueKeys[String(rows[i].lineNumber)] = true;
                }

                if (typeCode === 'COMPONENT' && rows[i].parentItemValue) {
                    parentItemsToUpdate[String(rows[i].parentItemValue)] = true;
                }
            }

            soRec.setValue({
                fieldId: HEADER_CHECK_FIELD,
                value: true
            });

            soRec.setValue({
                fieldId: HEADER_STATUS_FIELD,
                value: STATUS_ERROR
            });

            soRec.setValue({
                fieldId: ERROR_FIELD,
                value: newErrorText
            });

            for (i = 0; i < itemCount; i++) {
                currentLineUniqueKey = soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'lineuniquekey',
                    line: i
                });

                currentLineItem = soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: i
                });

                currentLineTypeText = soRec.getSublistText({
                    sublistId: 'item',
                    fieldId: TYPE_FIELD,
                    line: i
                });

                if (sentLineUniqueKeys[String(currentLineUniqueKey)]) {
                    soRec.setSublistValue({
                        sublistId: 'item',
                        fieldId: LINE_UNIQUE_STORE_FIELD,
                        line: i,
                        value: String(currentLineUniqueKey || '').replace(/,/g, '')
                    });

                    soRec.setSublistValue({
                        sublistId: 'item',
                        fieldId: LINE_STATUS_FIELD,
                        line: i,
                        value: STATUS_ERROR
                    });
                }

                if (
                    typeCode === 'COMPONENT' &&
                    parentItemsToUpdate[String(currentLineItem)] &&
                    currentLineTypeText &&
                    String(currentLineTypeText).toLowerCase() === 'parent'
                ) {
                    soRec.setSublistValue({
                        sublistId: 'item',
                        fieldId: LINE_STATUS_FIELD,
                        line: i,
                        value: STATUS_ERROR
                    });
                }
            }

            soRec.save({
                enableSourcing: false,
                ignoreMandatoryFields: true
            });

        } catch (e) {
            log.error('updateSalesOrderGroupError error SO ' + soId, e);
            throw e;
        }
    }

    function finalizeHeaderStatus(soId, resultInfo) {
        try {
            var soRec = record.load({
                type: record.Type.SALES_ORDER,
                id: soId,
                isDynamic: false
            });

            var currentHeaderStatus = soRec.getValue({ fieldId: HEADER_STATUS_FIELD });
            var newStatus = '';

            if (resultInfo.anyFailure) {
                newStatus = STATUS_ERROR;
            } else {
                newStatus = getNext3plStatus(currentHeaderStatus);
            }

            if (newStatus) {
                soRec.setValue({
                    fieldId: HEADER_STATUS_FIELD,
                    value: newStatus
                });
            }

            soRec.save({
                enableSourcing: false,
                ignoreMandatoryFields: true
            });

        } catch (e) {
            log.error('finalizeHeaderStatus error SO ' + soId, e);
            throw e;
        }
    }

    function getNext3plStatus(currentStatus) {
        currentStatus = currentStatus !== null && currentStatus !== undefined ? String(currentStatus) : '';

        if (currentStatus === STATUS_READY_TO_SEND) return STATUS_SENT;
        if (currentStatus === STATUS_PARTIALLY_READY) return STATUS_PARTIALLY_SENT;

        return '';
    }

    function extractRowByIndex(result, columns) {
        return {
            internalId: getValue(result, columns, 0),
            documentNumber: getValue(result, columns, 1),
            customerName: getText(result, columns, 2) || getValue(result, columns, 2),
            deliveryInstructions: getValue(result, columns, 3),
            orderDate: getValue(result, columns, 4),
            shipDate: getValue(result, columns, 5),
            poNumber: getValue(result, columns, 6),
            memo: getValue(result, columns, 7),
            taxTotal: getValue(result, columns, 8),
            orderTotal: getValue(result, columns, 9),
            currencyValue: getValue(result, columns, 10),
            currencyText: getText(result, columns, 10),
            etailChannel: getText(result, columns, 11) || getValue(result, columns, 11),
            firstName: getValue(result, columns, 12),
            lastName: getValue(result, columns, 13),
            email: getValue(result, columns, 14),
            phone: getValue(result, columns, 15),
            billAddress1: getValue(result, columns, 16),
            billAddress2: getValue(result, columns, 17),
            billAddressee: getValue(result, columns, 18),
            billAttention: getValue(result, columns, 19),
            billCity: getValue(result, columns, 20),
            billZip: getValue(result, columns, 21),
            billState: getValue(result, columns, 22),
            billCountry: getValue(result, columns, 23),
            billCountryCode: getValue(result, columns, 24),
            shipAddress1: getValue(result, columns, 25),
            shipAddress2: getValue(result, columns, 26),
            shipAddressee: getValue(result, columns, 27),
            shipAttention: getValue(result, columns, 28),
            shipCity: getValue(result, columns, 29),
            shipZip: getValue(result, columns, 30),
            shipState: getValue(result, columns, 31),
            shipCountry: getValue(result, columns, 32),
            shipCountryCode: getValue(result, columns, 33),
            itemType: getText(result, columns, 34) || getValue(result, columns, 34),
            description: getValue(result, columns, 35),
            itemValue: getValue(result, columns, 36),
            itemText: getText(result, columns, 36) || getValue(result, columns, 36),
            exportQty: getValue(result, columns, 37),
            itemRate: getValue(result, columns, 38),
            groupKey: getValue(result, columns, 39),
            shipVia: getText(result, columns, 40) || getValue(result, columns, 40),
            shippingCarrier: getText(result, columns, 41) || getValue(result, columns, 41),
            bolFreightTerms: getText(result, columns, 42) || getValue(result, columns, 42),
            requestCount: getValue(result, columns, 43),
            lineNumber: getValue(result, columns, 44),
            header3plStatus: getValue(result, columns, 45),
            line3plStatus: getValue(result, columns, 46),
            parentItemValue: getValue(result, columns, 47),
            parentItemText: getText(result, columns, 47) || getValue(result, columns, 47),
            parentCompValue: getValue(result, columns, 48),
            parentCompType: getText(result, columns, 48) || getValue(result, columns, 48)
        };
    }

    function getValue(result, columns, index) {
        return columns[index] ? result.getValue(columns[index]) : '';
    }

    function getText(result, columns, index) {
        return columns[index] ? result.getText(columns[index]) : '';
    }

    function truncateText(value, maxLen) {
        var text = String(value || '');
        return text.length > maxLen ? text.substring(0, maxLen) : text;
    }

    function toNumber(value) {
        var num = parseFloat(value);
        return isNaN(num) ? 0 : num;
    }

    function formatDate(value) {
        if (!value) return '';

        var d = new Date(value);
        var day, month, year;

        if (isNaN(d.getTime())) return '';

        day = d.getDate();
        month = d.getMonth() + 1;
        year = d.getFullYear();

        if (day < 10) day = '0' + day;
        if (month < 10) month = '0' + month;

        return year + '-' + month + '-' + day;
    }

    function summarize(summary) {
        log.audit('Usage', summary.usage);
        log.audit('Concurrency', summary.concurrency);
        log.audit('Yields', summary.yields);

        if (summary.mapSummary && summary.mapSummary.errors) {
            summary.mapSummary.errors.iterator().each(function (key, error) {
                log.error('Map Error for key: ' + key, error);
                return true;
            });
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
        map: map,
        reduce: reduce,
        summarize: summarize
    };
});