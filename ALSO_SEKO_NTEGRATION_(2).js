/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * Check TrackingURL in JSON files
 * Generate CSV report in same folder.
 */

define(['N/search', 'N/file', 'N/log'],
function (search, file, log) {

    var FOLDER_ID = 27477;

    function getInputData() {

        var files = [];

        var fileSearch = search.create({
            type: 'file',
            filters: [
                ['folder', 'anyof', FOLDER_ID]
            ],
            columns: [
                'internalid',
                'name'
            ]
        });

        var pagedData = fileSearch.runPaged({
            pageSize: 1000
        });

        pagedData.pageRanges.forEach(function (pageRange) {

            var page = pagedData.fetch({
                index: pageRange.index
            });

            page.data.forEach(function (result) {

                var fileName = result.getValue('name');

                // Process JSON files only
                if (!/\.json$/i.test(fileName)) {
                    return;
                }

                files.push({
                    fileId: result.getValue('internalid'),
                    fileName: fileName
                });

            });

        });

        log.audit('JSON Files Found', files.length);

        return files;
    }

    function map(context) {

        var data = JSON.parse(context.value);

        var result = {
            fileName: data.fileName,
            fileId: data.fileId,
            salesOrderId: '',
            trackingURL: '',
            status: 'Not Found'
        };

        try {

            var jsonFile = file.load({
                id: data.fileId
            });

            var jsonData = JSON.parse(
                jsonFile.getContents()
            );

            // Check nested payload
            var payload = jsonData.payload || jsonData;

            // Payload could be a JSON string
            if (typeof payload === 'string') {
                payload = JSON.parse(payload);
            }

            if (payload && typeof payload === 'object') {

                result.salesOrderId =
                    payload.salesOrderId || '';

                if (
                    payload.TrackingURL !== undefined &&
                    payload.TrackingURL !== null &&
                    String(payload.TrackingURL).trim() !== ''
                ) {

                    result.trackingURL = payload.TrackingURL;
                    result.status = 'Found';

                }

            }

        } catch (e) {

            result.status = 'Error: ' + e.message;

            log.error(
                'JSON File Error - ' + data.fileName,
                e.message
            );

        }

        context.write({
            key: data.fileId,
            value: result
        });
    }

    function summarize(summary) {

        var csvRows = [];

        // CSV header
        csvRows.push(
            'File Name,File ID,Sales Order ID,TrackingURL,Status'
        );

        var total = 0;
        var found = 0;
        var notFound = 0;
        var errors = 0;

        summary.output.iterator().each(function (key, value) {

            var row = JSON.parse(value);

            csvRows.push([
                csvValue(row.fileName),
                csvValue(row.fileId),
                csvValue(row.salesOrderId),
                csvValue(row.trackingURL),
                csvValue(row.status)
            ].join(','));

            total++;

            if (row.status === 'Found') {
                found++;
            } else if (row.status === 'Not Found') {
                notFound++;
            } else {
                errors++;
            }

            return true;
        });

        // Check for stage errors
        if (summary.inputSummary.error) {
            log.error('Input Error', summary.inputSummary.error);
        }

        summary.mapSummary.errors.iterator().each(
            function (key, error) {
                log.error('Map Error - ' + key, error);
                return true;
            }
        );

        // Create CSV report in same folder
        var csvFile = file.create({
            name: 'TrackingURL_Report_' +
                new Date().getTime() + '.csv',
            fileType: file.Type.CSV,
            contents: csvRows.join('\n'),
            folder: FOLDER_ID
        });

        var csvFileId = csvFile.save();

        log.audit('TrackingURL Report Created', {
            csvFileId: csvFileId,
            folderId: FOLDER_ID,
            totalFiles: total,
            trackingURLFound: found,
            trackingURLNotFound: notFound,
            errors: errors
        });
    }

    function csvValue(value) {

        if (value === null || value === undefined) {
            value = '';
        }

        return '"' +
            String(value).replace(/"/g, '""') +
            '"';
    }

    return {
        getInputData: getInputData,
        map: map,
        summarize: summarize
    };

});
