/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * DRY RUN ONLY - searches, reads, classifies and logs. Creates nothing, updates nothing.
 * Deploy on: Shopify Payout Variance Transaction custom record.
 * Trigger: open a variance record, Edit then Save, read the Execution Log bottom to top.
 */
define(['N/record', 'N/search', 'N/log'], (record, search, log) => {

    const CASHBACK_MEMO    = 'variances';
    const REFUND_ACCOUNT   = 122;                // account a new refund would be created against
    const SO_LINK_FIELD    = 'custbody_pcs_netsuite_sales_order';
    const REFERENCE_REFUND = 'CUSTRFND2035';     // known-good refund to inspect; '' to skip

    const afterSubmit = (context) => {

        const plan = {
            varianceRecord : null,
            wouldProceed   : false,
            stoppedAt      : null,
            salesOrder     : null,
            customerDeposit: null,
            decision       : null,   // TICK_ONLY | APPLY_THEN_TICK | ALREADY_DONE | CREATE_NEW | BLOCKED
            reason         : null,
            refundId       : null,
            depositPaymentLine : null,
            cashBackBefore : null,
            cashBackAfter  : null,
            plannedActions : [],
            problems       : []
        };

        try {
            if (context.type === context.UserEventType.DELETE) return;

            const rec = context.newRecord;
            plan.varianceRecord = rec.id;

            /* ---------- 0. how are existing refunds actually linked? ---------- */
            if (REFERENCE_REFUND) {
                try {
                    const ref = search.create({
                        type: 'customerrefund',
                        filters: [['mainline', 'is', 'T'], 'AND', ['tranid', 'is', REFERENCE_REFUND]],
                        columns: ['internalid']
                    }).run().getRange({ start: 0, end: 1 });

                    if (!ref.length) {
                        log.audit('0. Reference refund', 'not found: ' + REFERENCE_REFUND);
                    } else {
                        const rr = record.load({ type: record.Type.CUSTOMER_REFUND, id: ref[0].id });
                        const rows = [];
                        const dc = rr.getLineCount({ sublistId: 'deposit' });
                        for (let i = 0; i < dc; i++) {
                            rows.push({
                                line: i,
                                doc: rr.getSublistValue({ sublistId: 'deposit', fieldId: 'doc', line: i }),
                                refnum: rr.getSublistValue({ sublistId: 'deposit', fieldId: 'refnum', line: i }),
                                apply: rr.getSublistValue({ sublistId: 'deposit', fieldId: 'apply', line: i }),
                                amount: rr.getSublistValue({ sublistId: 'deposit', fieldId: 'amount', line: i })
                            });
                        }
                        let soField = 'FIELD NOT ON CUSTOMER REFUND';
                        try { soField = rr.getValue(SO_LINK_FIELD); } catch (e) { /* not applied to this type */ }

                        log.audit('0. Reference refund ' + REFERENCE_REFUND, {
                            internalId: ref[0].id,
                            createdFrom_value: rr.getValue('createdfrom'),
                            createdFrom_text: rr.getText('createdfrom'),
                            soLinkField: soField,
                            account: rr.getText('account'),
                            total: rr.getValue('total'),
                            depositSublist: rows
                        });
                    }
                } catch (e) {
                    log.audit('0. Reference refund inspection failed', e.message);
                }
            }

            /* ---------- 1. gates ---------- */
            const varianceType = rec.getText({ fieldId: 'custrecord_celigo_shpf_trans_var_type' }) || rec.getValue('custrecord_celigo_shpf_trans_var_type');
            const payoutType   = rec.getText({ fieldId: 'custrecord_celigo_shpf_payout_tran_type' }) || rec.getValue('custrecord_celigo_shpf_payout_tran_type');
            const alreadyDone  = rec.getValue('custrecord_related_netsuite_transaction');
            const inactive     = rec.getValue('isinactive');

            log.audit('1. Gate values', {
                contextType: context.type, varianceType, payoutType,
                isinactive: inactive, relatedTransaction: alreadyDone
            });

            if (inactive)    { plan.stoppedAt = 'record is inactive'; return; }
            if (alreadyDone) { plan.stoppedAt = 'related transaction already set: ' + alreadyDone; return; }
            if (String(varianceType) !== 'Missing Transaction') { plan.stoppedAt = 'variance type is not Missing Transaction'; return; }
            if (String(payoutType).toLowerCase() !== 'refund')  { plan.stoppedAt = 'payout type is not refund'; return; }

            /* ---------- 2. source fields ---------- */
            const sourceOrderId = rec.getValue('custrecord_celigo_shpf_tran_src_ordr_id');
            const bankDepositId = rec.getValue('custrecord_celigo_shpf_trans_deposit_id');
            const refundAmount  = Math.abs(parseFloat(rec.getValue('custrecord_celigo_shpf_trans_var_amnt')) || 0);

            log.audit('2. Source fields', { sourceOrderId, bankDepositId, refundAmount });

            if (!sourceOrderId || !bankDepositId || !refundAmount) {
                plan.stoppedAt = 'missing source order id, deposit id or variance amount';
                return;
            }

            /* ---------- 3. sales order ---------- */
            const soResult = search.create({
                type: 'salesorder',
                filters: [['mainline', 'is', 'T'], 'AND', ['custbody_celigo_etail_order_id', 'is', String(sourceOrderId)]],
                columns: ['internalid', 'tranid', 'entity', 'status']
            }).run().getRange({ start: 0, end: 5 });

            log.audit('3. Sales order search', {
                matches: soResult.length,
                rows: soResult.map(r => ({ id: r.id, tranid: r.getValue('tranid'), customer: r.getText('entity'), status: r.getText('status') }))
            });

            if (!soResult.length) { plan.stoppedAt = 'sales order not found for shopify order ' + sourceOrderId; return; }
            if (soResult.length > 1) plan.problems.push('more than one sales order matched this shopify order id');

            const soId = soResult[0].id;
            const customerId = soResult[0].getValue('entity');
            plan.salesOrder = soId + ' (' + soResult[0].getValue('tranid') + ')';

            /* ---------- 4. bank deposit header ---------- */
            const depositInfo = search.lookupFields({
                type: search.Type.DEPOSIT, id: bankDepositId, columns: ['trandate', 'total', 'tranid']
            });
            log.audit('4. Bank deposit', {
                depositId: bankDepositId, tranid: depositInfo.tranid,
                trandate: depositInfo.trandate, total: depositInfo.total
            });

            /* ---------- 5. customer deposit ---------- */
            const cdRows = search.create({
                type: 'salesorder',
                settings: [{ name: 'consolidationtype', value: 'ACCTTYPE' }],
                filters: [
                    ['type', 'anyof', 'SalesOrd'], 'AND',
                    ['internalidnumber', 'equalto', soId], 'AND',
                    ['applyingtransaction.type', 'anyof', 'CustDep'], 'AND',
                    ['applyingtransaction.status', 'anyof', 'CustDep:A', 'CustDep:B']
                ],
                columns: [
                    search.createColumn({ name: 'internalid', join: 'applyingTransaction' }),
                    search.createColumn({ name: 'tranid',     join: 'applyingTransaction' }),
                    search.createColumn({ name: 'amount',     join: 'applyingTransaction' }),
                    search.createColumn({ name: 'status',     join: 'applyingTransaction' })
                ]
            }).run().getRange({ start: 0, end: 20 });

            const custDeposits = [];
            cdRows.forEach(r => {
                const id = r.getValue({ name: 'internalid', join: 'applyingTransaction' });
                if (id && !custDeposits.filter(d => d.id === String(id))[0]) {
                    custDeposits.push({
                        id: String(id),
                        tranid: r.getValue({ name: 'tranid', join: 'applyingTransaction' }),
                        amount: r.getValue({ name: 'amount', join: 'applyingTransaction' }),
                        status: r.getText({ name: 'status', join: 'applyingTransaction' })
                    });
                }
            });

            log.audit('5. Customer deposits on this SO', { found: custDeposits.length, rows: custDeposits });

            if (!custDeposits.length) { plan.stoppedAt = 'no customer deposit (status A or B) on sales order ' + soId; return; }
            if (custDeposits.length > 1) plan.problems.push('more than one customer deposit on this order - dry run picked the first');

            const customerDepositId = custDeposits[0].id;
            plan.customerDeposit = customerDepositId + ' (' + custDeposits[0].tranid + ')';

            try {
                const cdInfo = search.lookupFields({
                    type: search.Type.CUSTOMER_DEPOSIT, id: customerDepositId,
                    columns: ['amount', 'amountremaining', 'status']
                });
                const remaining = parseFloat(cdInfo.amountremaining) || 0;
                log.audit('5b. Customer deposit balance', {
                    customerDeposit: custDeposits[0].tranid, amount: cdInfo.amount,
                    amountRemaining: cdInfo.amountremaining, refundNeeded: refundAmount,
                    enoughToRefund: remaining >= refundAmount
                });
                if (remaining < refundAmount) {
                    plan.problems.push('customer deposit remaining ' + cdInfo.amountremaining + ' is under the refund amount ' + refundAmount + ' - a new refund may fail or apply nothing');
                }
            } catch (e) {
                log.audit('5b. Customer deposit balance check failed', e.message);
            }

            /* ---------- 6. find EVERY candidate refund for this order ---------- */
            const candidates = [];
            const addCandidates = (label, filters) => {
                try {
                    search.create({
                        type: 'customerrefund', filters: filters,
                        columns: ['internalid', 'tranid', 'trandate', 'total', 'account']
                    }).run().getRange({ start: 0, end: 20 }).forEach(r => {
                        const hit = candidates.filter(c => c.id === String(r.id))[0];
                        if (hit) { hit.foundBy.push(label); return; }
                        candidates.push({
                            id: String(r.id), tranid: r.getValue('tranid'), date: r.getValue('trandate'),
                            total: Math.abs(parseFloat(r.getValue('total')) || 0),
                            account: r.getText('account'), foundBy: [label]
                        });
                    });
                } catch (e) {
                    plan.problems.push('refund search (' + label + ') failed: ' + e.message);
                }
            };

            addCandidates('createdfrom', [['mainline', 'is', 'T'], 'AND', ['createdfrom', 'anyof', soId]]);
            addCandidates(SO_LINK_FIELD, [['mainline', 'is', 'T'], 'AND', [SO_LINK_FIELD, 'anyof', soId]]);

            log.audit('6. Candidate refunds for this order', { found: candidates.length, rows: candidates });

            /* ---------- 7. bank deposit availability ---------- */
            const deposit = record.load({
                type: record.Type.DEPOSIT, id: bankDepositId, isDynamic: false,
                defaultValues: { disablepaymentfilters: true }
            });

            const paymentCount = deposit.getLineCount({ sublistId: 'payment' });
            const availability = {};
            for (let i = 0; i < paymentCount; i++) {
                const id = String(deposit.getSublistValue({ sublistId: 'payment', fieldId: 'id', line: i }));
                if (!candidates.filter(c => c.id === id)[0]) continue;
                availability[id] = {
                    line: i,
                    amount: Math.abs(parseFloat(deposit.getSublistValue({ sublistId: 'payment', fieldId: 'amount', line: i })) || 0),
                    ticked: deposit.getSublistValue({ sublistId: 'payment', fieldId: 'deposit', line: i })
                };
            }

            log.audit('7. Candidate availability on this bank deposit', {
                totalSublistLines: paymentCount,
                candidatesOnSublist: availability
            });

            /* ---------- 8. classify every candidate ---------- */
            const classified = [];
            candidates.forEach(c => {
                const row = {
                    refund: c.tranid + ' (id ' + c.id + ')', total: c.total, foundBy: c.foundBy,
                    amountMatches: Math.abs(c.total - refundAmount) < 0.01,
                    appliedTo: [], appliesOurDeposit: false, appliesOtherDeposit: false, appliesNothing: true,
                    onThisDeposit: false, alreadyTicked: false, verdict: null
                };

                try {
                    const rr = record.load({ type: record.Type.CUSTOMER_REFUND, id: c.id });
                    const dc = rr.getLineCount({ sublistId: 'deposit' });
                    for (let i = 0; i < dc; i++) {
                        if (!rr.getSublistValue({ sublistId: 'deposit', fieldId: 'apply', line: i })) continue;
                        const doc = String(rr.getSublistValue({ sublistId: 'deposit', fieldId: 'doc', line: i }));
                        row.appliedTo.push({
                            customerDeposit: doc,
                            refnum: rr.getSublistValue({ sublistId: 'deposit', fieldId: 'refnum', line: i }),
                            amount: rr.getSublistValue({ sublistId: 'deposit', fieldId: 'amount', line: i })
                        });
                        if (doc === customerDepositId) row.appliesOurDeposit = true; else row.appliesOtherDeposit = true;
                    }
                    row.appliesNothing = row.appliedTo.length === 0;
                } catch (e) {
                    row.verdict = 'COULD NOT LOAD: ' + e.message;
                }

                const avail = availability[c.id];
                row.onThisDeposit = !!avail;
                row.alreadyTicked = avail ? !!avail.ticked : false;
                if (avail) row.depositLine = avail.line;

                if (!row.verdict) {
                    if (!row.amountMatches)                         row.verdict = 'IGNORE - amount ' + c.total + ' does not match variance ' + refundAmount;
                    else if (row.appliesOurDeposit && row.alreadyTicked) row.verdict = 'ALREADY_DONE - applies our deposit and is already on this bank deposit';
                    else if (row.appliesOurDeposit && row.onThisDeposit) row.verdict = 'TICK_ONLY - applies our deposit, sitting undeposited, just select it';
                    else if (row.appliesNothing && row.onThisDeposit)    row.verdict = 'APPLY_THEN_TICK - applied to nothing, apply our deposit then select it';
                    else if (row.appliesOtherDeposit)                row.verdict = 'BLOCKED - applies a different customer deposit ' + JSON.stringify(row.appliedTo);
                    else                                            row.verdict = 'BLOCKED - not on this bank deposit, likely deposited elsewhere or not on undeposited funds';
                }
                classified.push(row);
            });

            log.audit('8. Refund classification', classified.length ? classified : 'no candidate refunds exist for this order');

            /* ---------- 9. decide ---------- */
            const pick = (test) => classified.filter(r => r.amountMatches && test(r))[0];
            const done    = pick(r => r.verdict.indexOf('ALREADY_DONE') === 0);
            const tick    = pick(r => r.verdict.indexOf('TICK_ONLY') === 0);
            const apply   = pick(r => r.verdict.indexOf('APPLY_THEN_TICK') === 0);
            const blocked = pick(r => r.verdict.indexOf('BLOCKED') === 0);

            if (done) {
                plan.decision = 'ALREADY_DONE';
                plan.reason = 'refund is already applied and deposited - only the variance record needs closing';
                plan.refundId = done.refund;
                plan.depositPaymentLine = done.depositLine;
            } else if (tick) {
                plan.decision = 'TICK_ONLY';
                plan.reason = 'existing refund already applies customer deposit ' + customerDepositId;
                plan.refundId = tick.refund;
                plan.depositPaymentLine = tick.depositLine;
            } else if (apply) {
                plan.decision = 'APPLY_THEN_TICK';
                plan.reason = 'existing refund applies nothing - edit it to apply customer deposit ' + customerDepositId;
                plan.refundId = apply.refund;
                plan.depositPaymentLine = apply.depositLine;
            } else if (blocked) {
                plan.decision = 'BLOCKED';
                plan.reason = 'a refund matching ' + refundAmount + ' exists but cannot be used: ' + blocked.verdict;
                plan.refundId = blocked.refund;
                plan.problems.push('NOT creating a new refund - doing so would double refund the customer. Needs a human.');
            } else {
                plan.decision = 'CREATE_NEW';
                plan.reason = classified.length
                    ? 'refunds exist on this order but none match ' + refundAmount
                    : 'no refund exists for this order';
                if (classified.length) plan.problems.push('refunds exist on this order at other amounts - confirm before creating another');
            }

            /* ---------- 10. cash back ---------- */
            const cashBackCount = deposit.getLineCount({ sublistId: 'cashback' });
            const cashBackRows = [];
            let varianceLine = -1;
            for (let i = 0; i < cashBackCount; i++) {
                const memo = deposit.getSublistValue({ sublistId: 'cashback', fieldId: 'memo', line: i });
                const amt  = parseFloat(deposit.getSublistValue({ sublistId: 'cashback', fieldId: 'amount', line: i })) || 0;
                cashBackRows.push({ line: i, memo: memo, amount: amt });
                if (String(memo || '').trim().toLowerCase() === CASHBACK_MEMO && varianceLine === -1) varianceLine = i;
            }
            log.audit('10. Deposit cash back sublist', { lines: cashBackRows, varianceLineIndex: varianceLine });

            if (varianceLine === -1) plan.problems.push('no cash back line with memo "' + CASHBACK_MEMO + '"');

            /* ---------- 11. what the live script would write ---------- */
            if (plan.decision === 'BLOCKED') {
                log.audit('11. WOULD WRITE NOTHING', {
                    decision: 'BLOCKED', reason: plan.reason,
                    varianceRecordStays: 'active, so it stays visible for review'
                });
                plan.plannedActions.push('NOTHING - blocked for human review');
            } else {
                const label = (plan.decision === 'CREATE_NEW') ? 'the newly created refund' : plan.refundId;

                if (plan.decision === 'CREATE_NEW') {
                    log.audit('11a. WOULD CREATE A CUSTOMER REFUND', {
                        method: 'record.transform customerdeposit -> customerrefund',
                        fromCustomerDeposit: customerDepositId + ' (' + custDeposits[0].tranid + ')',
                        customer: customerId + ' ' + soResult[0].getText('entity'),
                        amount: refundAmount, trandate: depositInfo.trandate, account: REFUND_ACCOUNT,
                        wouldAlsoSet: SO_LINK_FIELD + ' = ' + soId,
                        depositSublist: 'apply = true, amount = ' + refundAmount
                    });
                    plan.plannedActions.push('CREATE refund ' + refundAmount + ' from customer deposit ' + customerDepositId + ', stamp ' + SO_LINK_FIELD + ' = ' + soId);
                } else if (plan.decision === 'APPLY_THEN_TICK') {
                    log.audit('11a. WOULD EDIT AN EXISTING REFUND', {
                        refund: label,
                        change: 'Deposits subtab - apply customer deposit ' + customerDepositId + ' for ' + refundAmount,
                        alsoSet: SO_LINK_FIELD + ' = ' + soId + ' (if blank)',
                        noNewRecordCreated: true
                    });
                    plan.plannedActions.push('EDIT refund ' + label + ' to apply customer deposit ' + customerDepositId);
                } else {
                    log.audit('11a. WOULD NOT TOUCH THE REFUND', { refund: label, decision: plan.decision });
                    plan.plannedActions.push('REUSE refund ' + label + ' as is');
                }

                if (plan.decision === 'ALREADY_DONE') {
                    log.audit('11b. WOULD NOT TOUCH THE BANK DEPOSIT', { reason: 'refund is already ticked on line ' + plan.depositPaymentLine });
                } else {
                    log.audit('11b. WOULD TICK THE REFUND ON THE BANK DEPOSIT', {
                        bankDeposit: bankDepositId + ' (' + depositInfo.tranid + ')', refund: label,
                        paymentSublistLine: (plan.depositPaymentLine !== null) ? plan.depositPaymentLine : 'unknown until the refund exists',
                        depositCheckbox: 'false -> true', effectOnDepositTotal: 'minus ' + refundAmount
                    });
                    plan.plannedActions.push('TICK ' + label + ' on ' + depositInfo.tranid);

                    if (varianceLine >= 0) {
                        plan.cashBackBefore = cashBackRows[varianceLine].amount;
                        plan.cashBackAfter  = Math.round((plan.cashBackBefore - refundAmount) * 100) / 100;
                        if (plan.cashBackAfter < -0.001) plan.problems.push('cash back line is smaller than the refund amount - the live script would fail here');

                        log.audit('11c. WOULD REDUCE THE CASH BACK VARIANCE LINE', {
                            bankDeposit: depositInfo.tranid, cashBackLine: varianceLine,
                            memo: cashBackRows[varianceLine].memo,
                            amountBefore: plan.cashBackBefore, amountAfter: plan.cashBackAfter,
                            lineWouldBeRemoved: Math.abs(plan.cashBackAfter) < 0.001,
                            feesLineTouched: false,
                            depositTotalAfterBothChanges: 'unchanged (' + depositInfo.total + ')'
                        });
                        plan.plannedActions.push('REDUCE cash back "' + cashBackRows[varianceLine].memo + '" ' + plan.cashBackBefore + ' -> ' + plan.cashBackAfter);
                    }
                }

                log.audit('11d. WOULD CLOSE THE VARIANCE RECORD', {
                    varianceRecord: rec.id,
                    custrecord_related_netsuite_transaction: label,
                    isinactive: 'false -> true'
                });
                plan.plannedActions.push('STAMP ' + label + ' on variance record ' + rec.id + ' and set inactive');
            }

            plan.wouldProceed = plan.decision !== 'BLOCKED';

        } catch (e) {
            plan.stoppedAt = 'ERROR: ' + e.message;
            log.error('Dry run error', { message: e.message, stack: e.stack });
        } finally {
            log.audit('=== DRY RUN RESULT (nothing was saved) ===', plan);
        }
    };

    return { afterSubmit };
});