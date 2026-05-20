/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/https', 'N/search', 'N/record', 'N/log'], function (https, search, record, log) {

    var CELIGO_API_TOKEN = '511e8201ff034b16bb3aa6b64413246a';

    var API_BASE_URL = 'https://api.integrator.io/v1';

    var FLOW_ID = '68e819893fe2e005c7712f48';
    var IMPORT_STEP_ID = '68e8197b53e4a108b091452c';

    var ERROR_CODE = 'closed_salesorder';
    var SHOPIFY_ORDER_FIELD = 'custbody_celigo_etail_order_id';

    function getInputData() {
        try {
            log.audit('START', 'Getting Celigo errors');

            logImportList();

            var url = API_BASE_URL + '/errors?filter=' + encodeURIComponent(JSON.stringify({
                _flowId: FLOW_ID,
                _expOrImpId: IMPORT_STEP_ID
            }));

            log.audit('ERROR API URL', url);

            var response = https.get({
                url: url,
                headers: getCeligoHeaders()
            });

            log.audit('ERROR API RESPONSE CODE', response.code);
            log.debug('ERROR API RESPONSE BODY', response.body);

            if (response.code < 200 || response.code >= 300) {
                log.error('FAILED TO GET CELIGO ERRORS', response.body);
                return [];
            }

            var body = JSON.parse(response.body || '{}');
            var errors = body.errors || body.data || body.results || [];

            log.audit('TOTAL ERRORS FOUND FROM API', errors.length);

            for (var i = 0; i < errors.length; i++) {
                var err = errors[i];

                var code = err.code || err.errorCode || '';
                var message = err.message || err.errorMessage || '';

                log.debug('CHECKING ERROR ' + i, JSON.stringify({
                    code: code,
                    message: message
                }));

                if (code == ERROR_CODE || message.indexOf('already "Closed"') > -1) {
                    log.audit('MATCHING ERROR FOUND - PROCESSING ONLY 1', JSON.stringify(err));
                    return [err];
                }
            }

            log.audit('NO MATCHING closed_salesorder ERROR FOUND', '');
            return [];

        } catch (e) {
            log.error('getInputData ERROR', e);
            return [];
        }
    }

    function logImportList() {
        try {
            var url = API_BASE_URL + '/imports';

            log.audit('IMPORT LIST URL', url);

            var response = https.get({
                url: url,
                headers: getCeligoHeaders()
            });

            log.audit('IMPORT LIST CODE', response.code);
            log.debug('IMPORT LIST BODY', response.body);

        } catch (e) {
            log.error('IMPORT LIST ERROR', e);
        }
    }

    function getCeligoHeaders() {
        return {
            'Authorization': 'Bearer ' + CELIGO_API_TOKEN,
            'Content-Type': 'application/json'
        };
    }

    function map(context) {
        try {
            var err = JSON.parse(context.value);

            log.audit('PROCESSING ERROR', JSON.stringify(err));

            var message = err.message || err.errorMessage || '';
            var retryDataKey = err.retryDataKey || err.retryDataKeyId || err._retryDataKey || err.id || err._id;

            log.audit('RETRY DATA KEY', retryDataKey);

            var shopifyOrderId = getShopifyOrderId(message);

            log.audit('SHOPIFY ORDER ID FROM ERROR', shopifyOrderId);

            if (!shopifyOrderId) {
                log.error('MISSING SHOPIFY ORDER ID', message);
                return;
            }

            var salesOrderId = findSalesOrder(shopifyOrderId);

            log.audit('NETSUITE SALES ORDER ID', salesOrderId);

            if (!salesOrderId) {
                log.error('SALES ORDER NOT FOUND', shopifyOrderId);
                return;
            }

            var openedLines = openAllClosedLines(salesOrderId);

            log.audit('OPENED CLOSED LINES', JSON.stringify(openedLines));

            var retryResult = retryCeligoError(retryDataKey);

            log.audit('CELIGO RETRY RESULT', JSON.stringify(retryResult));

            if (retryResult.success) {
                closeOnlyOpenedLines(salesOrderId, openedLines);
            } else {
                log.error('RETRY FAILED - LINES LEFT OPEN', JSON.stringify({
                    salesOrderId: salesOrderId,
                    openedLines: openedLines,
                    retryResult: retryResult
                }));
            }

        } catch (e) {
            log.error('map ERROR', e);
        }
    }

    function getShopifyOrderId(message) {
        var match = message.match(/Shopify order #(\d+)/);
        return match && match[1] ? match[1] : '';
    }

    function findSalesOrder(shopifyOrderId) {
        var soSearch = search.create({
            type: search.Type.SALES_ORDER,
            filters: [
                ['mainline', 'is', 'T'],
                'AND',
                [SHOPIFY_ORDER_FIELD, 'is', shopifyOrderId]
            ],
            columns: ['internalid', 'tranid']
        });

        var result = soSearch.run().getRange({ start: 0, end: 1 });

        if (result && result.length > 0) {
            log.audit('SALES ORDER FOUND', JSON.stringify({
                internalId: result[0].getValue('internalid'),
                tranid: result[0].getValue('tranid')
            }));
            return result[0].getValue('internalid');
        }

        return '';
    }

    function openAllClosedLines(salesOrderId) {
        var soRec = record.load({
            type: record.Type.SALES_ORDER,
            id: salesOrderId,
            isDynamic: false
        });

        var lineCount = soRec.getLineCount({ sublistId: 'item' });
        var openedLines = [];

        log.audit('TOTAL SO ITEM LINES', lineCount);

        for (var i = 0; i < lineCount; i++) {
            var isClosed = soRec.getSublistValue({
                sublistId: 'item',
                fieldId: 'isclosed',
                line: i
            });

            var lineUniqueKey = soRec.getSublistValue({
                sublistId: 'item',
                fieldId: 'lineuniquekey',
                line: i
            });

            var itemId = soRec.getSublistValue({
                sublistId: 'item',
                fieldId: 'item',
                line: i
            });

            log.debug('LINE CHECK', JSON.stringify({
                line: i,
                itemId: itemId,
                lineUniqueKey: lineUniqueKey,
                isClosed: isClosed
            }));

            if (isClosed === true || isClosed === 'T') {
                openedLines.push(String(lineUniqueKey));

                soRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'isclosed',
                    line: i,
                    value: false
                });

                log.audit('OPENED LINE', JSON.stringify({
                    line: i,
                    itemId: itemId,
                    lineUniqueKey: lineUniqueKey
                }));
            }
        }

        if (openedLines.length > 0) {
            var savedId = soRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            log.audit('SALES ORDER SAVED AFTER OPENING LINES', savedId);
        } else {
            log.audit('NO CLOSED LINES FOUND TO OPEN', salesOrderId);
        }

        return openedLines;
    }

    function retryCeligoError(retryDataKey) {
        try {
            if (!retryDataKey) {
                return {
                    success: false,
                    message: 'Missing retryDataKey / error id'
                };
            }

            var url = API_BASE_URL + '/errors/retry';

            var payload = {
                retryDataKeys: [retryDataKey]
            };

            log.audit('RETRY API URL', url);
            log.audit('RETRY PAYLOAD', JSON.stringify(payload));

            var response = https.post({
                url: url,
                headers: getCeligoHeaders(),
                body: JSON.stringify(payload)
            });

            log.audit('RETRY RESPONSE CODE', response.code);
            log.debug('RETRY RESPONSE BODY', response.body);

            return {
                success: response.code >= 200 && response.code < 300,
                code: response.code,
                body: response.body
            };

        } catch (e) {
            log.error('retryCeligoError ERROR', e);
            return {
                success: false,
                message: e.message
            };
        }
    }

    function closeOnlyOpenedLines(salesOrderId, openedLines) {
        if (!openedLines || openedLines.length === 0) {
            log.audit('NO OPENED LINES TO CLOSE BACK', salesOrderId);
            return;
        }

        var openedLineMap = {};

        for (var x = 0; x < openedLines.length; x++) {
            openedLineMap[String(openedLines[x])] = true;
        }

        var soRec = record.load({
            type: record.Type.SALES_ORDER,
            id: salesOrderId,
            isDynamic: false
        });

        var lineCount = soRec.getLineCount({ sublistId: 'item' });

        for (var i = 0; i < lineCount; i++) {
            var lineUniqueKey = soRec.getSublistValue({
                sublistId: 'item',
                fieldId: 'lineuniquekey',
                line: i
            });

            if (openedLineMap[String(lineUniqueKey)]) {
                soRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'isclosed',
                    line: i,
                    value: true
                });

                log.audit('CLOSED LINE BACK', lineUniqueKey);
            }
        }

        var savedId = soRec.save({
            enableSourcing: true,
            ignoreMandatoryFields: true
        });

        log.audit('SALES ORDER SAVED AFTER CLOSING LINES BACK', savedId);
    }

    function summarize(summary) {
        log.audit('SUMMARY STARTED', '');

        if (summary.inputSummary.error) {
            log.error('INPUT ERROR', summary.inputSummary.error);
        }

        summary.mapSummary.errors.iterator().each(function (key, error) {
            log.error('MAP ERROR FOR KEY ' + key, error);
            return true;
        });

        log.audit('SUMMARY COMPLETE', {
            usage: summary.usage,
            concurrency: summary.concurrency,
            yields: summary.yields
        });
    }

    return {
        getInputData: getInputData,
        map: map,
        summarize: summarize
    };
});