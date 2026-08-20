/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * Flow (per invoice):
 *   1. Find Deposit Applications applied to the invoice  -> delete them
 *   2. Delete the invoice
 *   3. Close the Sales Order line(s) that the invoice was billed from -> save SO
 *
 * DRY_RUN = true  -> NOTHING is deleted / updated, only logs what WOULD happen.
 * DRY_RUN = false -> real deletes + SO update.
 */
define(['N/search', 'N/record', 'N/log'], (search, record, log) => {

    // ----------------------------------------------------------------------
    // CONFIG - change these two only
    // ----------------------------------------------------------------------
    const INVOICE_SEARCH_ID = 'customsearch_transaction_search_invoice_'; // your saved invoice search
    const DRY_RUN = false;                                  // <<< set to false to actually delete
    // ----------------------------------------------------------------------

    /**
     * Finds a column on the loaded saved search (case-insensitive on name/join),
     * so getValue works no matter how NetSuite saved the join casing.
     */
    const getCol = (cols, name, join) => {
        const j = (join || '').toLowerCase();
        for (let i = 0; i < cols.length; i++) {
            if (String(cols[i].name).toLowerCase() === name.toLowerCase() &&
                String(cols[i].join || '').toLowerCase() === j) {
                return cols[i];
            }
        }
        return null;
    };

    // ======================================================================
    // GET INPUT DATA - read the invoice search
    // ======================================================================
    const getInputData = () => {
        log.audit('=== START ===', 'DRY_RUN = ' + DRY_RUN + ' | Search = ' + INVOICE_SEARCH_ID);

        const rows = [];
        const invSearch = search.load({ id: INVOICE_SEARCH_ID });
        const cols = invSearch.columns;

        const colTranId  = getCol(cols, 'tranid');
        const colItem    = getCol(cols, 'item');
        const colSoId    = getCol(cols, 'internalid', 'appliedToTransaction');
        const colSoLine  = getCol(cols, 'line', 'appliedToTransaction');
        const colSoTran  = getCol(cols, 'tranid', 'createdFrom');

        log.debug('COLUMNS FOUND', 'tranid=' + !!colTranId +
            ' | item=' + !!colItem +
            ' | appliedToTransaction.internalid=' + !!colSoId +
            ' | appliedToTransaction.line=' + !!colSoLine);

        if (!colSoId || !colSoLine) {
            log.error('MISSING COLUMNS',
                'Saved search must contain "Applied To Transaction : Internal ID" and "Applied To Transaction : Line ID"');
        }

        const paged = invSearch.runPaged({ pageSize: 1000 });
        log.audit('SEARCH RESULT COUNT (lines)', paged.count);

        paged.pageRanges.forEach((pr) => {
            const page = paged.fetch({ index: pr.index });
            page.data.forEach((result) => {
                const row = {
                    invoiceId:   result.id,
                    invoiceNo:   colTranId ? result.getValue(colTranId) : '',
                    itemId:      colItem   ? result.getValue(colItem)   : '',
                    itemText:    colItem   ? result.getText(colItem)    : '',
                    soId:        colSoId   ? result.getValue(colSoId)   : '',
                    soLineId:    colSoLine ? result.getValue(colSoLine) : '',
                    soTranId:    colSoTran ? result.getValue(colSoTran) : ''
                };
                rows.push(row);
                log.debug('SEARCH ROW', JSON.stringify(row));
            });
        });

        log.audit('TOTAL LINES READ', rows.length);
        return rows;
    };

    // ======================================================================
    // MAP - group everything by invoice
    // ======================================================================
    const map = (context) => {
        const row = JSON.parse(context.value);
        log.debug('MAP', 'Invoice ' + row.invoiceId + ' | SO ' + row.soId + ' | Line ' + row.soLineId);
        context.write({ key: row.invoiceId, value: row });
    };

    // ======================================================================
    // REDUCE - one invoice per execution
    // ======================================================================
    const reduce = (context) => {
        const invoiceId = context.key;
        const rows = context.values.map((v) => JSON.parse(v));
        const invoiceNo = rows[0].invoiceNo;

        log.audit('--- PROCESSING INVOICE ---', 'Invoice ID ' + invoiceId + ' (' + invoiceNo + ') | lines: ' + rows.length);

        const result = {
            invoiceId: invoiceId,
            invoiceNo: invoiceNo,
            depositApplications: [],
            depositApplicationsDeleted: [],
            invoiceDeleted: false,
            soLinesClosed: [],
            errors: []
        };

        // ---------- 1. FIND DEPOSIT APPLICATIONS (your search #2, invoice id passed in) ----------
        try {
            const depositapplicationSearchObj = search.create({
                type: 'depositapplication',
                settings: [{ name: 'consolidationtype', value: 'ACCTTYPE' }],
                filters: [
                    ['type', 'anyof', 'DepAppl'], 'AND',
                    ['mainline', 'is', 'F'], 'AND',
                    ['appliedtotransaction.type', 'anyof', 'CustInvc'], 'AND',
                    ['appliedtotransaction.internalid', 'anyof', invoiceId]   // <<< invoice id from search #1
                ],
                columns: [
                    search.createColumn({ name: 'internalid', label: 'Internal ID' }),
                    search.createColumn({ name: 'appliedtotransaction', label: 'Applied To Transaction' })
                ]
            });

            depositapplicationSearchObj.run().each((r) => {
                log.debug('DEP APP ROW', 'DepApp ID ' + r.id +
                    ' | applied to ' + r.getValue({ name: 'appliedtotransaction' }) +
                    ' | invoice ' + invoiceId);
                if (result.depositApplications.indexOf(r.id) === -1) {
                    result.depositApplications.push(r.id);
                }
                return true;
            });
        } catch (e) {
            result.errors.push('DEP APP SEARCH: ' + e.message);
            log.error('DEP APP SEARCH FAILED - Invoice ' + invoiceId, e);
        }

        log.audit('DEPOSIT APPLICATIONS FOUND',
            'Invoice ' + invoiceId + ' -> ' + result.depositApplications.length + ' : ' + JSON.stringify(result.depositApplications));

        // ---------- 2. DELETE DEPOSIT APPLICATIONS ----------
        result.depositApplications.forEach((depId) => {
            if (DRY_RUN) {
                log.audit('[DRY RUN] WOULD DELETE DEPOSIT APPLICATION', 'ID ' + depId + ' (invoice ' + invoiceId + ')');
            } else {
                try {
                    record.delete({ type: 'depositapplication', id: depId });
                    result.depositApplicationsDeleted.push(depId);
                    log.audit('DELETED DEPOSIT APPLICATION', 'ID ' + depId);
                } catch (e) {
                    result.errors.push('DELETE DEPAPP ' + depId + ': ' + e.message);
                    log.error('DELETE DEPOSIT APPLICATION FAILED - ID ' + depId, e);
                }
            }
        });

        // ---------- 3. DELETE INVOICE ----------
        if (DRY_RUN) {
            log.audit('[DRY RUN] WOULD DELETE INVOICE', 'ID ' + invoiceId + ' (' + invoiceNo + ')');
        } else {
            try {
                record.delete({ type: 'invoice', id: invoiceId });
                result.invoiceDeleted = true;
                log.audit('DELETED INVOICE', 'ID ' + invoiceId + ' (' + invoiceNo + ')');
            } catch (e) {
                result.errors.push('DELETE INVOICE ' + invoiceId + ': ' + e.message);
                log.error('DELETE INVOICE FAILED - ID ' + invoiceId, e);
            }
        }

        // ---------- 4. CLOSE SALES ORDER LINES ----------
        // group line ids per sales order
        const soMap = {};
        rows.forEach((r) => {
            if (!r.soId || !r.soLineId) {
                log.error('MISSING SO / LINE', 'Invoice ' + invoiceId + ' row: ' + JSON.stringify(r));
                return;
            }
            if (!soMap[r.soId]) soMap[r.soId] = [];
            if (soMap[r.soId].indexOf(String(r.soLineId)) === -1) soMap[r.soId].push(String(r.soLineId));
        });

        Object.keys(soMap).forEach((soId) => {
            const lineIds = soMap[soId];
            log.audit('SALES ORDER TO UPDATE', 'SO ' + soId + ' | line ids: ' + JSON.stringify(lineIds));

            if (DRY_RUN) {
                log.audit('[DRY RUN] WOULD CLOSE SO LINES', 'SO ' + soId + ' -> lines ' + JSON.stringify(lineIds));
                result.soLinesClosed.push({ soId: soId, lines: lineIds, dryRun: true });
                return;
            }

            try {
                const so = record.load({ type: 'salesorder', id: soId, isDynamic: true });
                const lineCount = so.getLineCount({ sublistId: 'item' });
                let changed = 0;

                lineIds.forEach((lineId) => {
                    let found = -1;
                    for (let i = 0; i < lineCount; i++) {
                        const thisLine = so.getSublistValue({ sublistId: 'item', fieldId: 'line', line: i });
                        if (String(thisLine) === String(lineId)) { found = i; break; }
                    }

                    if (found === -1) {
                        result.errors.push('SO ' + soId + ' line ' + lineId + ' not found');
                        log.error('SO LINE NOT FOUND', 'SO ' + soId + ' | line id ' + lineId);
                        return;
                    }

                    so.selectLine({ sublistId: 'item', line: found });
                    so.setCurrentSublistValue({ sublistId: 'item', fieldId: 'isclosed', value: true });
                    so.commitLine({ sublistId: 'item' });
                    changed++;
                    log.audit('SO LINE MARKED CLOSED', 'SO ' + soId + ' | line id ' + lineId + ' | index ' + found);
                });

                if (changed > 0) {
                    const savedId = so.save({ ignoreMandatoryFields: true });
                    result.soLinesClosed.push({ soId: savedId, lines: lineIds });
                    log.audit('SALES ORDER SAVED', 'SO ' + savedId + ' | lines closed: ' + changed);
                } else {
                    log.error('SALES ORDER NOT SAVED', 'SO ' + soId + ' - no matching lines found');
                }
            } catch (e) {
                result.errors.push('SO ' + soId + ': ' + e.message);
                log.error('SALES ORDER UPDATE FAILED - SO ' + soId, e);
            }
        });

        log.audit('--- INVOICE DONE ---', JSON.stringify(result));
        context.write({ key: invoiceId, value: result });
    };

    // ======================================================================
    // SUMMARIZE
    // ======================================================================
    const summarize = (summary) => {
        let invoices = 0, depApps = 0, soUpdates = 0, errors = 0;

        summary.output.iterator().each((key, value) => {
            const r = JSON.parse(value);
            invoices++;
            depApps += r.depositApplications.length;
            soUpdates += r.soLinesClosed.length;
            errors += r.errors.length;
            log.audit('RESULT ' + key, value);
            return true;
        });

        summary.mapSummary.errors.iterator().each((k, e) => { log.error('MAP ERROR ' + k, e); errors++; return true; });
        summary.reduceSummary.errors.iterator().each((k, e) => { log.error('REDUCE ERROR ' + k, e); errors++; return true; });

        log.audit('=== SUMMARY ===',
            'DRY_RUN = ' + DRY_RUN +
            ' | Invoices processed: ' + invoices +
            ' | Deposit Applications: ' + depApps +
            ' | Sales Orders touched: ' + soUpdates +
            ' | Errors: ' + errors +
            ' | Usage: ' + summary.usage + ' | Seconds: ' + summary.seconds);
    };

    return { getInputData, map, reduce, summarize };
});