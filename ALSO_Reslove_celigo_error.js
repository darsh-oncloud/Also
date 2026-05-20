/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/https', 'N/search', 'N/record', 'N/log'], function (https, search, record, log) {

    var CELIGO_API_TOKEN = '511e8201ff034b16bb3aa6b64413246a';

    var API_BASE_URL = 'https://api.integrator.io/v1';

    var FLOW_ID = '68e819893fe2e005c7712f48';
    var STEP_NAME_TO_FIND = 'Post orders to NetSuite';

    var ERROR_CODE = 'closed_salesorder';
    var SHOPIFY_ORDER_FIELD = 'custbody_celigo_etail_order_id';

    function getInputData() {
        try {
            log.audit('START', 'Finding Celigo step/import ID');

            var importId = findImportIdByName();

            if (!importId) {
                log.error('IMPORT STEP NOT FOUND', 'Could not find step name: ' + STEP_NAME_TO_FIND);
                return [];
            }

            log.audit('FINAL IMPORT STEP ID USED', importId);

            var errors = getCeligoErrors(importId);

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
                    err.importId = importId;
                    return [err];
                }
            }

            log.audit('NO MATCHING CLOSED ORDER ERROR FOUND', '');
            return [];

        } catch (e) {
            log.error('getInputData ERROR', e);
            return [];
        }
    }

    function findImportIdByName() {
        var url = API_BASE_URL + '/imports';

        log.audit('IMPORT LIST URL', url);

        var response = https.get({
            url: url,
            headers: getHeaders()
        });

        log.audit('IMPORT LIST CODE', response.code);
        log.debug('IMPORT LIST BODY', response.body);

        if (response.code < 200 || response.code >= 300) {
            log.error('FAILED TO GET IMPORTS', response.body);
            return '';
        }

        var imports = JSON.parse(response.body || '[]');

        for (var i = 0; i < imports.length; i++) {
            var imp = imports[i];

            if (imp.name == STEP_NAME_TO_FIND) {
                log.audit('MATCHING IMPORT FOUND', JSON.stringify({
                    id: imp._id,
                    name: imp.name,
                    apiIdentifier: imp.apiIdentifier,
                    integrationId: imp._integrationId
                }));

                return imp._id;
            }

            if (imp.name && imp.name.indexOf('orders') > -1) {
                log.audit('ORDER RELATED IMPORT FOUND', JSON.stringify({
                    id: imp._id,
                    name: imp.name,
                    apiIdentifier: imp.apiIdentifier,
                    integrationId: imp._integrationId
                }));
            }
        }

        return '';
    }

function getCeligoErrors(importId) {

    var url = API_BASE_URL + '/imports/' + importId + '/errors';

    log.audit('ERROR API URL', url);

    var response = https.get({
        url: url,
        headers: getHeaders()
    });

    log.audit('ERROR API RESPONSE CODE', response.code);
    log.debug('ERROR API RESPONSE BODY', response.body);

    if (response.code < 200 || response.code >= 300) {
        log.error('FAILED TO GET CELIGO ERRORS', response.body);
        return [];
    }

    var body = JSON.parse(response.body || '{}');

    return body.errors || body.data || body.results || body || [];
}

    function map(context) {
        try {
            var err = JSON.parse(context.value);

            log.audit('PROCESSING ERROR', JSON.stringify(err));

            var message = err.message || err.errorMessage || '';
            var retryDataKey = err.retryDataKey || err.retryDataKeyId || err._retryDataKey || err.id || err._id;
            var importId = err.importId;

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

            var retryResult = retryCeligoError(retryDataKey, importId);

            log.audit('CELIGO RETRY RESULT', JSON.stringify(retryResult));

            if (retryResult.success) {
                closeOnlyOpenedLines(salesOrderId, openedLines);

                log.audit('PROCESS COMPLETE', JSON.stringify({
                    salesOrderId: salesOrderId,
                    shopifyOrderId: shopifyOrderId,
                    openedAndClosedLines: openedLines
                }));
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

    function retryCeligoError(retryDataKey, importId) {
        if (!retryDataKey) {
            return {
                success: false,
                message: 'Missing retryDataKey'
            };
        }

        var url = API_BASE_URL + '/flows/' + FLOW_ID + '/imports/' + importId + '/retry';

        var payload = {
            retryDataKeys: [retryDataKey]
        };

        log.audit('RETRY API URL', url);
        log.audit('RETRY PAYLOAD', JSON.stringify(payload));

        var response = https.post({
            url: url,
            headers: getHeaders(),
            body: JSON.stringify(payload)
        });

        log.audit('RETRY RESPONSE CODE', response.code);
        log.debug('RETRY RESPONSE BODY', response.body);

        return {
            success: response.code >= 200 && response.code < 300,
            code: response.code,
            body: response.body
        };
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

        var result = soSearch.run().getRange({
            start: 0,
            end: 1
        });

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

            if (isClosed === true || isClosed === 'T') {
                openedLines.push(String(lineUniqueKey));

                soRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'isclosed',
                    line: i,
                    value: false
                });

                log.audit('OPENED LINE', lineUniqueKey);
            }
        }

        if (openedLines.length > 0) {
            soRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });
        }

        return openedLines;
    }

    function closeOnlyOpenedLines(salesOrderId, openedLines) {
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

        soRec.save({
            enableSourcing: true,
            ignoreMandatoryFields: true
        });
    }

    function getHeaders() {
        return {
            'Authorization': 'Bearer ' + CELIGO_API_TOKEN,
            'Content-Type': 'application/json'
        };
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