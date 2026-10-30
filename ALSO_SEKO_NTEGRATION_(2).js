/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * Delete RMAs that only have the TM-B-RESERVATION item (internal id 909).
 *
 * For each RMA with a TM-B-RESERVATION line at rate 50 (search built in getInputData):
 *   1. Load the RMA and check it again:
 *        - exactly 1 item line
 *        - that line is item 909
 *        - no related transactions (receipts, credit memos, refunds)
 *   2. Save a full backup of the RMA (all body fields + all sublists) as a
 *      JSON file in File Cabinet folder 27474
 *   3. Delete the RMA (only if the backup was saved)
 * At the end, a summary CSV of everything deleted / skipped / failed is saved
 * to the same folder, and totals are written to the log.
 *
 * DRY_RUN (in Settings below):
 *   true  = test run: backups + logs only, nothing is deleted
 *   false = real run: RMAs are deleted
 */
define(['N/search', 'N/record', 'N/file', 'N/log'],
function (search, record, file, log) {

    // ---------- Settings ----------
    var ITEM_ID = '909';            // TM-B-RESERVATION
    var FOLDER_ID = 27474;          // backups + summary file

    // true  = test run: backups + logs only, nothing is deleted
    // false = real run: RMAs are deleted
    var DRY_RUN = true;

    var STATUS = {
        DELETED: 'DELETED',
        DRY_RUN: 'DRY_RUN',
        SKIPPED: 'SKIPPED',
        ERROR: 'ERROR'
    };

    // ---------- 1. Get the RMAs ----------
    function getInputData() {
        log.audit('RMA Delete - START', {
            item: ITEM_ID,
            dryRun: isDryRun()
        });

        // Same as the saved search, without the summary filters
        // (count(line) / max(rate) caused INVALID_SRCH_SUMMARY_TYP).
        // The "only 1 item line" check is done in reduce() on the loaded RMA.
        return search.create({
            type: search.Type.RETURN_AUTHORIZATION,
            filters: [
                ['type', 'anyof', 'RtnAuth'],
                'AND', ['mainline', 'is', 'F'],
                'AND', ['shipping', 'is', 'F'],
                'AND', ['taxline', 'is', 'F'],
                'AND', ['cogs', 'is', 'F'],
                'AND', ['item.type', 'anyof', 'NonInvtPart'],
                'AND', ['item', 'anyof', ITEM_ID],
                'AND', ['formulanumeric: ABS(NVL({rate}, 0))', 'equalto', '50']
            ],
            columns: [
                search.createColumn({ name: 'internalid' }),
                search.createColumn({ name: 'tranid' })
            ]
        });
    }

    // ---------- 2. One key per RMA (removes duplicate search rows) ----------
    function map(context) {
        var row = JSON.parse(context.value);
        var rmaId = getRmaId(row);

        if (!rmaId) {
            log.error('RMA Delete - No internal id in search row', context.value);
            return;
        }
        context.write({ key: String(rmaId), value: '1' });
    }

    // ---------- 3. Validate, back up, delete ----------
    function reduce(context) {
        var rmaId = context.key;
        var dryRun = isDryRun();
        var tranid = '';

        try {
            var rma = record.load({
                type: record.Type.RETURN_AUTHORIZATION,
                id: rmaId
            });
            tranid = String(rma.getValue('tranid') || '');

            // --- Validate ---
            var reason = validate(rma);
            if (reason) {
                log.audit('RMA SKIPPED - ' + tranid, { rmaId: rmaId, reason: reason });
                writeResult(context, STATUS.SKIPPED, rmaId, tranid, '', reason);
                return;
            }

            // --- Back up (must succeed before we delete) ---
            var backup = snapshot(rma);
            var backupFile = file.create({
                name: 'RMA_' + safeName(tranid) + '_' + rmaId + '_' + stamp() + '.json',
                fileType: file.Type.JSON,
                contents: JSON.stringify(backup, null, 2),
                folder: FOLDER_ID,
                description: 'Backup of RMA ' + tranid + ' before delete'
            });
            var fileId = backupFile.save();

            // --- Delete ---
            if (dryRun) {
                log.audit('RMA DRY RUN (not deleted) - ' + tranid, { rmaId: rmaId, backupFileId: fileId });
                writeResult(context, STATUS.DRY_RUN, rmaId, tranid, fileId, 'Dry run - not deleted');
                return;
            }

            record.delete({
                type: record.Type.RETURN_AUTHORIZATION,
                id: rmaId
            });

            log.audit('RMA DELETED - ' + tranid, { rmaId: rmaId, backupFileId: fileId });
            writeResult(context, STATUS.DELETED, rmaId, tranid, fileId, '');

        } catch (e) {
            log.error('RMA ERROR - ' + (tranid || rmaId), { rmaId: rmaId, message: e.message });
            writeResult(context, STATUS.ERROR, rmaId, tranid, '', e.name + ': ' + e.message);
        }
    }

    // ---------- 4. Totals + summary file ----------
    function summarize(summary) {

        if (summary.inputSummary.error) {
            log.error('RMA Delete - Search failed', summary.inputSummary.error);
        }
        summary.mapSummary.errors.iterator().each(function (key, err) {
            log.error('RMA Delete - Map error ' + key, err);
            return true;
        });
        summary.reduceSummary.errors.iterator().each(function (key, err) {
            log.error('RMA Delete - Reduce error ' + key, err);
            return true;
        });

        var counts = { DELETED: 0, DRY_RUN: 0, SKIPPED: 0, ERROR: 0 };
        var csv = ['Status,RMA Internal ID,RMA Number,Backup File ID,Reason'];

        summary.output.iterator().each(function (status, value) {
            var r = JSON.parse(value);
            counts[status] = (counts[status] || 0) + 1;
            csv.push([status, r.rmaId, r.tranid, r.fileId, r.reason].map(csvCell).join(','));
            return true;
        });

        var summaryFileId = '';
        try {
            summaryFileId = file.create({
                name: 'RMA_Delete_Summary_' + stamp() + '.csv',
                fileType: file.Type.CSV,
                contents: csv.join('\n'),
                folder: FOLDER_ID
            }).save();
        } catch (e) {
            log.error('RMA Delete - Summary file not saved', e.message);
        }

        log.audit('RMA Delete - END', {
            dryRun: isDryRun(),
            deleted: counts.DELETED,
            dryRunWouldDelete: counts.DRY_RUN,
            skipped: counts.SKIPPED,
            errors: counts.ERROR,
            summaryFileId: summaryFileId,
            usage: summary.usage,
            seconds: summary.seconds
        });
    }

    // ---------- Validation ----------
    // Returns a reason to skip, or '' if the RMA is OK to delete
    function validate(rma) {
        var lineCount = rma.getLineCount({ sublistId: 'item' });

        if (lineCount !== 1) {
            return 'RMA has ' + lineCount + ' item lines (only 1 allowed)';
        }

        var itemId = String(rma.getSublistValue({ sublistId: 'item', fieldId: 'item', line: 0 }));
        if (itemId !== ITEM_ID) {
            return 'Only line is item ' + itemId + ', not ' + ITEM_ID;
        }

        // Related records (item receipt, credit memo, refund) - NetSuite would block the delete anyway
        try {
            var links = rma.getLineCount({ sublistId: 'links' });
            if (links > 0) return 'RMA has ' + links + ' related transaction(s)';
        } catch (e) { /* links sublist not available - delete will fail safely if blocked */ }

        return '';
    }

    // ---------- Backup ----------
    // Every body field and every sublist line, with value + display text
    function snapshot(rec) {
        var data = {
            backupDate: new Date().toISOString(),
            recordType: rec.type,
            internalId: rec.id,
            body: {},
            sublists: {}
        };

        rec.getFields().forEach(function (f) {
            data.body[f] = readField(rec, f);
        });

        rec.getSublists().forEach(function (s) {
            var lines = [];
            var count = 0;
            try { count = rec.getLineCount({ sublistId: s }); } catch (e) { return; }
            if (count <= 0) return;

            var fields = [];
            try { fields = rec.getSublistFields({ sublistId: s }); } catch (e2) { return; }

            for (var i = 0; i < count; i++) {
                var line = {};
                fields.forEach(function (f) {
                    line[f] = readSublistField(rec, s, f, i);
                });
                lines.push(line);
            }
            data.sublists[s] = lines;
        });

        return data;
    }

    function readField(rec, f) {
        var v = null, t = null;
        try { v = rec.getValue(f); } catch (e) { /* skip */ }
        try { t = rec.getText(f); } catch (e2) { /* skip */ }
        return pack(v, t);
    }

    function readSublistField(rec, s, f, i) {
        var v = null, t = null;
        try { v = rec.getSublistValue({ sublistId: s, fieldId: f, line: i }); } catch (e) { /* skip */ }
        try { t = rec.getSublistText({ sublistId: s, fieldId: f, line: i }); } catch (e2) { /* skip */ }
        return pack(v, t);
    }

    // Keep the file small: only store text when it differs from the value
    function pack(v, t) {
        if (t !== null && t !== undefined && String(t) !== String(v)) {
            return { value: v, text: t };
        }
        return v;
    }

    // ---------- Helpers ----------
    function isDryRun() {
        return DRY_RUN === true;
    }

    // Works for normal and summary (grouped) saved searches
    function getRmaId(row) {
        if (row.id) return row.id;
        var vals = row.values || {};
        var v = vals.internalid || vals['GROUP(internalid)'];
        if (Array.isArray(v)) v = v[0];
        if (v && typeof v === 'object') return v.value;
        return v || '';
    }

    function writeResult(context, status, rmaId, tranid, fileId, reason) {
        context.write({
            key: status,
            value: JSON.stringify({
                rmaId: rmaId,
                tranid: tranid,
                fileId: fileId ? String(fileId) : '',
                reason: reason || ''
            })
        });
    }

    function stamp() {
        return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
    }

    function safeName(s) {
        return String(s || 'NoNumber').replace(/[^A-Za-z0-9_-]/g, '_');
    }

    function csvCell(v) {
        var s = String(v === null || v === undefined ? '' : v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    return {
        getInputData: getInputData,
        map: map,
        reduce: reduce,
        summarize: summarize
    };
});