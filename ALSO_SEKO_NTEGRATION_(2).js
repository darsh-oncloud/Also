/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 *
 * Sales Order vs Invoice variance report (READ ONLY)
 * ---------------------------------------------------------------------------
 * Source : saved search customsearch_shopify_payout_variance_t_2
 * For every search result:
 *   - find the Sales Order (self / created-from chain / applied-to / Celigo eTail order id)
 *   - find all Invoices created from that SO
 *   - compare SO vs Invoice: total, subtotal, discount (header + discount lines),
 *     tax, shipping, and line by line (missing / extra / qty / amount / tax / tax code)
 *   - check the Invoice posting period (closed / AR locked / all locked)
 * Output : one Excel file (.xls) in folder 29050 with sheets
 *   Summary | Line Differences | Periods To Open | Search Rows | Errors
 *
 * Nothing is created/edited except the report file. No script parameters.
 */
define(['N/search', 'N/record', 'N/file', 'N/encode', 'N/runtime', 'N/log'],
    (search, record, file, encode, runtime, log) => {

        // =====================================================================
        // CONFIG
        // =====================================================================
        const CONFIG = {
            SEARCH_ID: 'customsearch_shopify_payout_variance_t_2',
            OUTPUT_FOLDER_ID: 29050,
            NS_FIELD_ORDER_ID: 'custbody_celigo_etail_order_id', // Celigo Shopify order id on SO
            LOG_DETAIL: true
        };

        // =====================================================================
        // HELPERS
        // =====================================================================
        const toCents = (v) => {
            if (v === null || v === undefined || v === '') return 0;
            const n = parseFloat(String(v).replace(/,/g, ''));
            return isNaN(n) ? 0 : Math.round(n * 100);
        };
        const money = (c) => Math.round(Number(c || 0)) / 100;
        const fv = (x) => Array.isArray(x) ? (x[0] ? x[0].value : '') : (x === undefined || x === null ? '' : x);
        const ft = (x) => Array.isArray(x) ? (x[0] ? x[0].text : '') : (x === undefined || x === null ? '' : x);
        const uniq = (a) => [...new Set(a.filter(x => x !== '' && x !== null && x !== undefined))];

        const safeLookup = (type, id, cols) => {
            try { return search.lookupFields({ type, id, columns: cols }); }
            catch (e) {
                const out = {};
                cols.forEach(c => {
                    try { Object.assign(out, search.lookupFields({ type, id, columns: [c] })); } catch (e2) { out[c] = ''; }
                });
                return out;
            }
        };
        const txnLookup = (id, cols) => safeLookup(search.Type.TRANSACTION, id, cols);

        const gv = (rec, f) => { try { return rec.getValue(f); } catch (e) { return ''; } };
        const gt = (rec, f) => { try { return rec.getText(f); } catch (e) { return ''; } };
        const sv = (rec, f, i) => { try { return rec.getSublistValue({ sublistId: 'item', fieldId: f, line: i }); } catch (e) { return ''; } };
        const st = (rec, f, i) => { try { return rec.getSublistText({ sublistId: 'item', fieldId: f, line: i }); } catch (e) { return ''; } };

        // ---------------- find the Sales Order -----------------
        const climbToSO = (id, depth) => {
            if (!id || depth > 4) return '';
            const info = txnLookup(id, ['type', 'createdfrom']);
            const type = fv(info.type);
            if (type === 'SalesOrd') return String(id);
            if (type === 'CustDep') {
                try {
                    const so = record.load({ type: record.Type.CUSTOMER_DEPOSIT, id }).getValue('salesorder');
                    if (so) return String(so);
                } catch (e) { /* ignore */ }
            }
            const cf = fv(info.createdfrom);
            if (cf) return climbToSO(cf, depth + 1);
            return '';
        };

        const getAppliedTo = (id) => {
            const ids = [];
            try {
                search.create({
                    type: search.Type.TRANSACTION,
                    filters: [['internalid', 'anyof', id]],
                    columns: ['appliedtotransaction']
                }).run().getRange({ start: 0, end: 50 }).forEach(r => {
                    const v = r.getValue('appliedtotransaction');
                    if (v && String(v) !== String(id) && ids.indexOf(v) < 0) ids.push(v);
                });
            } catch (e) { /* not a transaction */ }
            return ids;
        };

        const findSOByEtailId = (orderId) => {
            if (!orderId) return '';
            try {
                const r = search.create({
                    type: search.Type.SALES_ORDER,
                    filters: [[CONFIG.NS_FIELD_ORDER_ID, 'is', String(orderId)], 'AND', ['mainline', 'is', 'T']],
                    columns: ['internalid']
                }).run().getRange({ start: 0, end: 1 });
                return r.length ? String(r[0].id) : '';
            } catch (e) { return ''; }
        };

        const resolveSalesOrder = (recordType, id, values) => {
            if (recordType === 'salesorder') return { soId: String(id), via: 'search row is the SO' };

            // 1) the search record itself (created-from chain)
            let so = '';
            try { so = climbToSO(id, 0); } catch (e) { /* custom record etc. */ }
            if (so) return { soId: so, via: `created-from chain of ${recordType} ${id}` };

            // 2) applied-to (refund -> CM / CD, payment -> invoice)
            const applied = getAppliedTo(id);
            for (let i = 0; i < applied.length; i++) {
                so = climbToSO(applied[i], 0);
                if (so) return { soId: so, via: `applied-to ${applied[i]}` };
            }

            // 3) Celigo order id on the record
            try {
                const info = txnLookup(id, [CONFIG.NS_FIELD_ORDER_ID]);
                so = findSOByEtailId(fv(info[CONFIG.NS_FIELD_ORDER_ID]));
                if (so) return { soId: so, via: 'Celigo eTail order id' };
            } catch (e) { /* ignore */ }

            // 4) any select/text column in the search row (works for custom records too)
            const keys = Object.keys(values || {});
            for (let k = 0; k < keys.length; k++) {
                const v = values[keys[k]];
                const sel = Array.isArray(v) ? v : (v && typeof v === 'object' ? [v] : null);
                if (sel) {
                    for (let j = 0; j < sel.length; j++) {
                        const val = sel[j] && sel[j].value;
                        if (val && /^\d+$/.test(String(val))) {
                            try { so = climbToSO(val, 0); } catch (e) { so = ''; }
                            if (so) return { soId: so, via: `search column ${keys[k]}` };
                        }
                    }
                } else if (v && /^\d{9,}$/.test(String(v).trim())) {
                    so = findSOByEtailId(String(v).trim());
                    if (so) return { soId: so, via: `Shopify order id in column ${keys[k]}` };
                }
            }
            return { soId: '', via: 'NOT FOUND' };
        };

        const flatten = (values) => {
            const out = {};
            Object.keys(values || {}).forEach(k => {
                const v = values[k];
                if (Array.isArray(v)) out[k] = v.map(x => x.text || x.value).join(', ');
                else if (v && typeof v === 'object') out[k] = v.text || v.value || '';
                else out[k] = v;
            });
            return out;
        };

        // ---------------- read SO / Invoice -----------------
        const SKIP_ITEM_TYPES = ['Subtotal', 'Description', 'EndGroup'];

        const readTxn = (type, id) => {
            const rec = record.load({ type, id });
            const h = {
                id: String(id),
                tranid: gv(rec, 'tranid'),
                trandate: gt(rec, 'trandate'),
                status: gt(rec, 'status') || gv(rec, 'status'),
                entity: gt(rec, 'entity'),
                otherrefnum: gv(rec, 'otherrefnum'),
                etailId: gv(rec, CONFIG.NS_FIELD_ORDER_ID),
                subtotal: toCents(gv(rec, 'subtotal')),
                headerDiscount: toCents(gv(rec, 'discounttotal')),
                discountItem: gt(rec, 'discountitem'),
                tax: toCents(gv(rec, 'taxtotal')) + toCents(gv(rec, 'tax2total')),
                shipping: toCents(gv(rec, 'shippingcost') || gv(rec, 'altshippingcost')),
                handling: toCents(gv(rec, 'handlingcost') || gv(rec, 'althandlingcost')),
                total: toCents(gv(rec, 'total')),
                amountRemaining: toCents(gv(rec, 'amountremaining')),
                periodId: gv(rec, 'postingperiod'),
                periodName: gt(rec, 'postingperiod')
            };
            const lines = [];
            const n = rec.getLineCount({ sublistId: 'item' });
            for (let i = 0; i < n; i++) {
                const itemType = sv(rec, 'itemtype', i);
                if (SKIP_ITEM_TYPES.indexOf(itemType) >= 0) continue;
                const itemText = st(rec, 'item', i);
                lines.push({
                    line: i + 1,
                    itemId: String(sv(rec, 'item', i)),
                    itemText,
                    itemType,
                    isDiscount: itemType === 'Discount' || /discount/i.test(itemText),
                    description: sv(rec, 'description', i),
                    qty: Number(sv(rec, 'quantity', i)) || 0,
                    rate: sv(rec, 'rate', i),
                    amount: toCents(sv(rec, 'amount', i)),
                    tax: toCents(sv(rec, 'tax1amt', i)) + toCents(sv(rec, 'taxamount', i)),
                    taxCode: st(rec, 'taxcode', i)
                });
            }
            h.discountLines = lines.filter(l => l.isDiscount).reduce((a, l) => a + l.amount, 0);
            h.discountAll = h.headerDiscount + h.discountLines;
            return { h, lines };
        };

        const aggregate = (lines) => {
            const m = {};
            lines.forEach(l => {
                const k = l.itemId + (l.isDiscount ? '|DISC' : '');
                if (!m[k]) m[k] = { itemId: l.itemId, itemText: l.itemText, isDiscount: l.isDiscount, description: l.description, qty: 0, amount: 0, tax: 0, taxCodes: [] };
                m[k].qty += l.qty;
                m[k].amount += l.amount;
                m[k].tax += l.tax;
                if (l.taxCode && m[k].taxCodes.indexOf(l.taxCode) < 0) m[k].taxCodes.push(l.taxCode);
            });
            return m;
        };

        const PERIOD_CACHE = {};
        const getPeriod = (pid) => {
            if (!pid) return { name: '', closed: false, arLocked: false, allLocked: false };
            if (PERIOD_CACHE[pid]) return PERIOD_CACHE[pid];
            const p = safeLookup(search.Type.ACCOUNTING_PERIOD, pid, ['periodname', 'closed', 'arlocked', 'alllocked']);
            const t = (x) => x === true || x === 'T';
            PERIOD_CACHE[pid] = { name: fv(p.periodname), closed: t(p.closed), arLocked: t(p.arlocked), allLocked: t(p.alllocked) };
            return PERIOD_CACHE[pid];
        };

        // ---------------- Excel (SpreadsheetML) -----------------
        const xmlEsc = (s) => String(s === null || s === undefined ? '' : s)
            .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const xCell = (v, style) => {
            const s = style ? ` ss:StyleID="${style}"` : '';
            if (typeof v === 'number' && isFinite(v)) return `<Cell${s}><Data ss:Type="Number">${v}</Data></Cell>`;
            return `<Cell${s}><Data ss:Type="String">${xmlEsc(v)}</Data></Cell>`;
        };
        const xSheet = (name, headers, rows) => {
            let x = `<Worksheet ss:Name="${xmlEsc(name.substring(0, 31))}"><Table>`;
            x += '<Row>' + headers.map(hd => xCell(hd, 'h')).join('') + '</Row>';
            rows.forEach(r => {
                const style = r.__style || '';
                x += '<Row>' + r.cells.map(c => xCell(c, style)).join('') + '</Row>';
            });
            x += '</Table><WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">'
                + '<FreezePanes/><FrozenNoSplit/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane>'
                + '<ActivePane>2</ActivePane></WorksheetOptions><AutoFilter x:Range="R1C1:R1C' + headers.length + '" xmlns="urn:schemas-microsoft-com:office:excel"/></Worksheet>';
            return x;
        };
        const xWorkbook = (sheets) =>
            '<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?>'
            + '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" '
            + 'xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" '
            + 'xmlns:html="http://www.w3.org/TR/REC-html40"><Styles>'
            + '<Style ss:ID="h"><Font ss:Bold="1"/><Interior ss:Color="#D9E1F2" ss:Pattern="Solid"/></Style>'
            + '<Style ss:ID="r"><Interior ss:Color="#FCE4D6" ss:Pattern="Solid"/></Style>'
            + '</Styles>' + sheets.join('') + '</Workbook>';

        // =====================================================================
        // GET INPUT DATA
        // =====================================================================
        const getInputData = () => {
            const s = search.load({ id: CONFIG.SEARCH_ID });
            log.audit('START', `Search ${CONFIG.SEARCH_ID} type=${s.searchType} results=${s.runPaged().count}`);
            log.audit('Search columns', s.columns.map(c => `${c.join ? c.join + '.' : ''}${c.name}${c.label ? ' (' + c.label + ')' : ''}`).join(' | '));
            return s;
        };

        // =====================================================================
        // MAP - search row -> Sales Order
        // =====================================================================
        const map = (ctx) => {
            const r = JSON.parse(ctx.value);
            const res = resolveSalesOrder(r.recordType, r.id, r.values);
            const key = res.soId ? 'SO_' + res.soId : `UNRESOLVED_${r.recordType}_${r.id}`;
            if (CONFIG.LOG_DETAIL) log.debug('Search row -> SO', `${r.recordType} ${r.id} -> ${res.soId || 'NOT FOUND'} (${res.via})`);
            ctx.write({ key, value: JSON.stringify({ srcType: r.recordType, srcId: r.id, via: res.via, raw: flatten(r.values) }) });
        };

        // =====================================================================
        // REDUCE - one Sales Order: compare with its invoice(s)
        // =====================================================================
        const reduce = (ctx) => {
            const src = ctx.values.map(v => JSON.parse(v));
            const srcText = src.map(s => `${s.srcType} ${s.srcId}`).join(' ; ');
            const searchRows = src.map(s => ({ soKey: ctx.key, srcType: s.srcType, srcId: s.srcId, via: s.via, raw: s.raw }));

            if (ctx.key.indexOf('UNRESOLVED_') === 0) {
                ctx.write({
                    key: ctx.key, value: JSON.stringify({
                        summary: { soId: '', issues: 'SALES_ORDER_NOT_FOUND', action: 'Could not trace this search record to a Sales Order - check manually', source: srcText },
                        lines: [], searchRows
                    })
                });
                return;
            }

            const soId = ctx.key.replace('SO_', '');
            const so = readTxn(record.Type.SALES_ORDER, soId);

            const invIds = [];
            search.create({
                type: search.Type.INVOICE,
                filters: [['createdfrom', 'anyof', soId], 'AND', ['mainline', 'is', 'T']],
                columns: ['internalid']
            }).run().each(r => { invIds.push(String(r.id)); return true; });

            const invs = invIds.map(id => readTxn(record.Type.INVOICE, id));
            const invH = {
                subtotal: invs.reduce((a, i) => a + i.h.subtotal, 0),
                discountAll: invs.reduce((a, i) => a + i.h.discountAll, 0),
                tax: invs.reduce((a, i) => a + i.h.tax, 0),
                shipping: invs.reduce((a, i) => a + i.h.shipping, 0),
                total: invs.reduce((a, i) => a + i.h.total, 0),
                amountRemaining: invs.reduce((a, i) => a + i.h.amountRemaining, 0)
            };

            const issues = [];
            const actions = [];
            const lineRows = [];

            // periods
            const periods = invs.map(i => {
                const p = getPeriod(i.h.periodId);
                return { invId: i.h.id, invNo: i.h.tranid, periodId: i.h.periodId, name: i.h.periodName || p.name, ...p };
            });
            const lockedPeriods = periods.filter(p => p.closed || p.arLocked || p.allLocked);

            if (!invs.length) {
                issues.push('NO_INVOICE');
                actions.push('No invoice exists for this SO - bill the SO first, then create Credit Memo / Refund');
            } else {
                const d = {
                    total: invH.total - so.h.total,
                    subtotal: invH.subtotal - so.h.subtotal,
                    discount: invH.discountAll - so.h.discountAll,
                    tax: invH.tax - so.h.tax,
                    shipping: invH.shipping - so.h.shipping
                };
                if (d.total) issues.push('TOTAL_MISMATCH');
                if (d.discount) {
                    issues.push(so.h.discountAll && !invH.discountAll ? 'DISCOUNT_MISSING_ON_INVOICE' : 'DISCOUNT_MISMATCH');
                    actions.push(`Discount: SO ${money(so.h.discountAll)} vs Invoice ${money(invH.discountAll)} -> add/fix discount on invoice by ${money(-d.discount)}`);
                }
                if (d.tax) {
                    issues.push('TAX_MISMATCH');
                    actions.push(`Tax: SO ${money(so.h.tax)} vs Invoice ${money(invH.tax)} -> correct tax code / tax amount on invoice by ${money(-d.tax)}`);
                }
                if (d.shipping) {
                    issues.push('SHIPPING_MISMATCH');
                    actions.push(`Shipping: SO ${money(so.h.shipping)} vs Invoice ${money(invH.shipping)}`);
                }

                // line compare
                const sm = aggregate(so.lines);
                const im = aggregate([].concat(...invs.map(i => i.lines)));
                uniq(Object.keys(sm).concat(Object.keys(im))).forEach(k => {
                    const a = sm[k], b = im[k];
                    const ls = [];
                    if (a && !b) ls.push(a.isDiscount ? 'DISCOUNT_LINE_MISSING_ON_INVOICE' : 'LINE_MISSING_ON_INVOICE');
                    else if (!a && b) ls.push('EXTRA_LINE_ON_INVOICE');
                    else {
                        if (a.qty !== b.qty) ls.push('QTY_DIFF');
                        if (a.amount !== b.amount) ls.push('AMOUNT_DIFF');
                        if (a.tax !== b.tax) ls.push('LINE_TAX_DIFF');
                        if (a.taxCodes.join(',') !== b.taxCodes.join(',')) ls.push('TAX_CODE_DIFF');
                    }
                    if (!ls.length) return;
                    ls.forEach(x => { if (issues.indexOf(x) < 0) issues.push(x); });
                    const ref = a || b;
                    lineRows.push({
                        soId, soNo: so.h.tranid, invNos: invs.map(i => i.h.tranid).join(', '),
                        item: ref.itemText, itemId: ref.itemId, isDiscount: ref.isDiscount ? 'Yes' : 'No', description: ref.description,
                        soQty: a ? a.qty : 0, invQty: b ? b.qty : 0,
                        soAmt: a ? a.amount : 0, invAmt: b ? b.amount : 0, amtDiff: (b ? b.amount : 0) - (a ? a.amount : 0),
                        soTax: a ? a.tax : 0, invTax: b ? b.tax : 0, taxDiff: (b ? b.tax : 0) - (a ? a.tax : 0),
                        soTaxCode: a ? a.taxCodes.join(', ') : '', invTaxCode: b ? b.taxCodes.join(', ') : '',
                        status: ls.join(' '),
                        fix: a && !b ? `Add line "${ref.itemText}" ${money(a.amount)} to invoice`
                            : !a && b ? `Remove/verify line "${ref.itemText}" ${money(b.amount)} on invoice`
                                : `Change invoice line "${ref.itemText}" to qty ${a.qty}, amount ${money(a.amount)}, tax code ${a.taxCodes.join(', ')}`
                    });
                });

                if (d.total && !actions.length && !lineRows.length) actions.push(`Total differs by ${money(d.total)} - check rounding / header fields`);
                if (lockedPeriods.length) {
                    issues.push('INVOICE_PERIOD_LOCKED');
                    actions.unshift('ASK TO OPEN PERIOD: ' + lockedPeriods.map(p => `${p.name} (${[p.closed ? 'Closed' : '', p.arLocked ? 'AR Locked' : '', p.allLocked ? 'All Locked' : ''].filter(Boolean).join('/')}) for ${p.invNo}`).join('; '));
                }
                if (issues.length && invH.amountRemaining === 0) actions.push('Invoice is fully paid - after fixing, re-check payment/deposit application, then create Credit Memo + Refund');
                else if (issues.length) actions.push('After invoice is fixed, create Credit Memo from invoice and then Customer Refund');

                var diffs = d;
            }

            const summary = {
                soId, soNo: so.h.tranid, shopifyOrder: so.h.otherrefnum, etailId: so.h.etailId, customer: so.h.entity,
                soDate: so.h.trandate, soStatus: so.h.status,
                invIds: invIds.join(', '), invNos: invs.map(i => i.h.tranid).join(', '), invDates: invs.map(i => i.h.trandate).join(', '),
                invStatus: invs.map(i => i.h.status).join(', '),
                soTotal: so.h.total, invTotal: invH.total, totalDiff: diffs ? diffs.total : -so.h.total,
                soSubtotal: so.h.subtotal, invSubtotal: invH.subtotal,
                soDiscount: so.h.discountAll, invDiscount: invH.discountAll,
                soTax: so.h.tax, invTax: invH.tax, taxDiff: diffs ? diffs.tax : 0,
                soShipping: so.h.shipping, invShipping: invH.shipping,
                invAmountRemaining: invH.amountRemaining,
                periods: periods.map(p => p.name).join(', '),
                periodStatus: periods.map(p => `${p.name}: ${p.closed ? 'Closed' : 'Open'}${p.arLocked ? ', AR Locked' : ''}${p.allLocked ? ', All Locked' : ''}`).join(' | '),
                needsPeriodOpen: lockedPeriods.length ? 'YES' : 'NO',
                issues: issues.length ? issues.join(' ') : 'NO_DIFFERENCE_FOUND',
                action: actions.join(' | '),
                source: srcText
            };

            if (CONFIG.LOG_DETAIL) log.debug(`SO ${so.h.tranid}`, `${summary.issues} | inv ${summary.invNos} | diff ${money(summary.totalDiff)}`);
            ctx.write({ key: ctx.key, value: JSON.stringify({ summary, lines: lineRows, searchRows, periods: lockedPeriods.map(p => ({ ...p, soNo: so.h.tranid, totalDiff: summary.totalDiff })) }) });
        };

        // =====================================================================
        // SUMMARIZE - build Excel
        // =====================================================================
        const summarize = (summary) => {
            const errors = [];
            if (summary.inputSummary.error) errors.push(['INPUT', '', summary.inputSummary.error]);
            summary.mapSummary.errors.iterator().each((k, e) => { errors.push(['MAP', k, e]); return true; });
            summary.reduceSummary.errors.iterator().each((k, e) => { errors.push(['REDUCE', k, e]); return true; });
            errors.forEach(e => log.error(`${e[0]} error ${e[1]}`, e[2]));

            const sums = [], lines = [], raws = [], periods = [];
            summary.output.iterator().each((k, v) => {
                const o = JSON.parse(v);
                sums.push(o.summary);
                (o.lines || []).forEach(l => lines.push(l));
                (o.searchRows || []).forEach(r => raws.push(r));
                (o.periods || []).forEach(p => periods.push(p));
                return true;
            });

            // --- Summary sheet
            sums.sort((a, b) => (b.needsPeriodOpen === 'YES') - (a.needsPeriodOpen === 'YES') || String(a.soNo).localeCompare(String(b.soNo)));
            const sumHeaders = ['SO #', 'SO Internal ID', 'Shopify Order #', 'Shopify Order ID', 'Customer', 'SO Date', 'SO Status',
                'Invoice #', 'Invoice Internal ID', 'Invoice Date', 'Invoice Status',
                'SO Total', 'Invoice Total', 'Total Diff (Inv - SO)',
                'SO Subtotal', 'Inv Subtotal', 'SO Discount', 'Inv Discount', 'SO Tax', 'Inv Tax', 'Tax Diff',
                'SO Shipping', 'Inv Shipping', 'Inv Amount Remaining',
                'Invoice Posting Period', 'Period Status', 'Needs Period Opened', 'Issues', 'Action Required', 'Source Search Records'];
            const sumRows = sums.map(s => ({
                __style: s.issues !== 'NO_DIFFERENCE_FOUND' ? 'r' : '',
                cells: [s.soNo, s.soId, s.shopifyOrder, s.etailId, s.customer, s.soDate, s.soStatus,
                    s.invNos, s.invIds, s.invDates, s.invStatus,
                    money(s.soTotal), money(s.invTotal), money(s.totalDiff),
                    money(s.soSubtotal), money(s.invSubtotal), money(s.soDiscount), money(s.invDiscount), money(s.soTax), money(s.invTax), money(s.taxDiff),
                    money(s.soShipping), money(s.invShipping), money(s.invAmountRemaining),
                    s.periods, s.periodStatus, s.needsPeriodOpen, s.issues, s.action, s.source]
            }));

            // --- Line differences
            const lineHeaders = ['SO #', 'SO Internal ID', 'Invoice #', 'Item', 'Item ID', 'Discount Line', 'Description',
                'SO Qty', 'Inv Qty', 'SO Amount', 'Inv Amount', 'Amount Diff', 'SO Tax', 'Inv Tax', 'Tax Diff',
                'SO Tax Code', 'Inv Tax Code', 'Difference', 'Fix on Invoice'];
            const lineRows = lines.map(l => ({
                cells: [l.soNo, l.soId, l.invNos, l.item, l.itemId, l.isDiscount, l.description,
                    l.soQty, l.invQty, money(l.soAmt), money(l.invAmt), money(l.amtDiff), money(l.soTax), money(l.invTax), money(l.taxDiff),
                    l.soTaxCode, l.invTaxCode, l.status, l.fix]
            }));

            // --- Periods to open (this is the sheet to send to the team)
            const pm = {};
            periods.forEach(p => {
                if (!pm[p.periodId]) pm[p.periodId] = { ...p, invs: [], sos: [], diff: 0 };
                pm[p.periodId].invs.push(p.invNo);
                pm[p.periodId].sos.push(p.soNo);
                pm[p.periodId].diff += p.totalDiff || 0;
            });
            const perHeaders = ['Posting Period', 'Period Internal ID', 'Closed', 'AR Locked', 'All Locked', 'Invoices To Fix (count)', 'Invoice #s', 'Sales Order #s', 'Total Invoice vs SO Diff'];
            const perRows = Object.keys(pm).map(k => {
                const p = pm[k];
                return { cells: [p.name, p.periodId, p.closed ? 'Yes' : 'No', p.arLocked ? 'Yes' : 'No', p.allLocked ? 'Yes' : 'No', uniq(p.invs).length, uniq(p.invs).join(', '), uniq(p.sos).join(', '), money(p.diff)] };
            });

            // --- Raw search rows
            const rawCols = uniq([].concat(...raws.map(r => Object.keys(r.raw || {}))));
            const rawHeaders = ['Record Type', 'Internal ID', 'Matched SO Key', 'Matched Via'].concat(rawCols);
            const rawRows = raws.map(r => ({ cells: [r.srcType, r.srcId, r.soKey, r.via].concat(rawCols.map(c => (r.raw || {})[c])) }));

            const sheets = [
                xSheet('Summary', sumHeaders, sumRows),
                xSheet('Line Differences', lineHeaders, lineRows),
                xSheet('Periods To Open', perHeaders, perRows),
                xSheet('Search Rows', rawHeaders, rawRows)
            ];
            if (errors.length) sheets.push(xSheet('Errors', ['Stage', 'Key', 'Error'], errors.map(e => ({ cells: e }))));

            const xml = xWorkbook(sheets);
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const fileId = file.create({
                name: `SO_vs_Invoice_Variance_${stamp}.xls`,
                fileType: file.Type.EXCEL,
                contents: encode.convert({ string: xml, inputEncoding: encode.Encoding.UTF_8, outputEncoding: encode.Encoding.BASE_64 }),
                folder: CONFIG.OUTPUT_FOLDER_ID
            }).save();

            const withIssues = sums.filter(s => s.issues !== 'NO_DIFFERENCE_FOUND').length;
            log.audit('RESULT', `Sales Orders=${sums.length} | with issues=${withIssues} | line diffs=${lines.length} | periods to open=${perRows.length} | errors=${errors.length}`);
            perRows.forEach(p => log.audit('PERIOD TO OPEN', p.cells.join(' | ')));
            log.audit('Excel saved', `File ID ${fileId} in folder ${CONFIG.OUTPUT_FOLDER_ID}`);
        };

        return { getInputData, map, reduce, summarize };
    });