/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/search', 'N/runtime', 'N/record', 'N/https', 'N/log'], function (search, runtime, record, https, log) {

    function getInputData() {
        var searchId = runtime.getCurrentScript().getParameter({
            name: 'custscript_rmasearch'
        });

        if (!searchId) {
            throw Error('Missing script parameter: custscript_rmasearch');
        }

        log.debug('Using Search ID', searchId);

        var rmaSearch = search.load({
            id: searchId
        });

        var resultCount = rmaSearch.runPaged().count;
        log.debug('Search Result Count', resultCount);

        var results = [];
        var start = 0;
        var end = 1000;
        var batch;
        var columns = rmaSearch.columns;

        do {
            batch = rmaSearch.run().getRange({
                start: start,
                end: end
            });

            for (var i = 0; i < batch.length; i++) {
                var result = batch[i];

                results.push({
                    rma_internalid: result.getValue(columns[0]) || '',
                    rma_tranid: result.getValue(columns[1]) || '',
                    rma_memo: result.getValue(columns[2]) || '',
                    rma_location: result.getValue(columns[3]) || '',
                    channel: result.getValue(columns[4]) || '',
                    so_tranid: result.getValue(columns[5]) || '',
                    item_name: result.getText(columns[6]) || result.getValue(columns[6]) || '',
                    item_qty: result.getValue(columns[7]) || '',
                    item_desc: result.getValue(columns[8]) || '',
                    reason_code: result.getValue(columns[9]) || '',
                    item_linenumber: result.getValue(columns[10]) || ''
                });
            }

            start += 1000;
            end += 1000;

        } while (batch && batch.length === 1000);

        log.debug('Prepared Input Rows', results.length);

        return results;
    }

    function map(context) {
        try {
            var row = JSON.parse(context.value);

            if (!row.rma_internalid) {
                log.error('MAP SKIPPED', 'Missing rma_internalid in row: ' + context.value);
                return;
            }

            log.debug('MAP ROW', JSON.stringify(row));

            context.write({
                key: String(row.rma_internalid),
                value: JSON.stringify(row)
            });

        } catch (e) {
            log.error('Map Error', e);
        }
    }

    function reduce(context) {
        try {
            var rmaId = context.key;
            var rows = context.values || [];

            if (!rows.length) {
                log.error('REDUCE SKIPPED', 'No rows found for key: ' + rmaId);
                return;
            }

            log.debug('REDUCE RMA ID', rmaId);
            log.debug('REDUCE ROW COUNT', rows.length);

            var firstRow = JSON.parse(rows[0]);
            var payloadDetails = [];

            for (var i = 0; i < rows.length; i++) {
                var row = JSON.parse(rows[i]);

                payloadDetails.push({
                    lineNumber: parseInt(row.item_linenumber, 10) || 0,
                    quantity: parseFloat(row.item_qty) || 0,
                    supplierCompanyCode: 'DEFSUPALSOINC01',
                    product: row.item_name || '',
                    unitOfMeasureCode: 'EACH',
                    unitOfMeasureQty: 1,
                    lot: '',
                    action: 'INSERT',
                    reasonCode: row.reason_code || '',
                    countryOfOrigin: row.rma_location || '',
                    channel: row.channel || ''
                });
            }

            var payload = {
                tenantId: 'uB1$xT2$yF2)uS7@hE5wB1pC3mO5pU2sIeXw',
                companyId: 'ALSO',
                fulfillmentCenterId: 'SEKOLAX2',
                returnAuthorization: firstRow.rma_tranid || '',
                salesOrderId: firstRow.so_tranid || '',
                shipmentId: '',
                notes: firstRow.rma_memo || '',
                action: 'INSERT',
                details: payloadDetails
            };

            log.audit('SEKO PAYLOAD', JSON.stringify(payload));

            var response = https.post({
                url: 'https://devapi.sekologistics.com/wms/v2/return',
                body: JSON.stringify(payload),
                headers: {
                    'Content-Type': 'application/json',
                    'Ocp-Apim-Subscription-Key': '24317d6663034ad4a19f5fce71b1cbe7'
                }
            });

            log.audit('SEKO RESPONSE CODE', response.code);
            log.audit('SEKO RESPONSE BODY', response.body);

            if (String(response.code) === '200') {
                record.submitFields({
                    type: record.Type.RETURN_AUTHORIZATION,
                    id: parseInt(rmaId, 10),
                    values: {
                        custbody_sekotransactioncheck: true
                    },
                    options: {
                        enableSourcing: false,
                        ignoreMandatoryFields: true
                    }
                });

                log.audit('RMA UPDATED SUCCESS', 'custbody_sekotransactioncheck = true for RMA ID ' + rmaId);
            } else {
                log.error('SEKO SEND FAILED', 'RMA ID ' + rmaId + ' | Code: ' + response.code + ' | Body: ' + response.body);
            }

        } catch (e) {
            log.error('Reduce Error for RMA ID ' + context.key, e);
        }
    }

    function summarize(summary) {
        log.audit('Usage', summary.usage);
        log.audit('Concurrency', summary.concurrency);
        log.audit('Yields', summary.yields);

        if (summary.inputSummary && summary.inputSummary.error) {
            log.error('Input Error', summary.inputSummary.error);
        }

        if (summary.mapSummary) {
            summary.mapSummary.errors.iterator().each(function (key, error) {
                log.error('Map Error for key: ' + key, error);
                return true;
            });
        }

        if (summary.reduceSummary) {
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