/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * DRY RUN ONLY - reads and logs, never creates or updates anything.
 * Deploy on: Shopify Payout Variance Transaction custom record.
 * Trigger: open a variance record, Edit then Save (no changes needed), read the Execution Log.
 */
define(['N/record', 'N/search', 'N/log'], (record, search, log) => {

    const CASHBACK_MEMO  = 'variances';
    const REFUND_ACCOUNT = 122;          // account the live script would create the refund against

    const afterSubmit = (context) => {

        const plan = {
            varianceRecord : null,
            wouldProceed   : false,
            stoppedAt      : null,
            salesOrder     : null,
            customerDeposit: null,
            refundAction   : null,              // REUSE_EXISTING | CREATE_NEW | NOTHING_TO_DO
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

            /* ---------- 1. gates ---------- */
            const varianceType = rec.getText({ fieldId: 'custrecord_celigo_shpf_trans_var_type' }) || rec.getValue('custrecord_celigo_shpf_trans_var_type');
            const payoutType   = rec.getText({ fieldId: 'custrecord_celigo_shpf_payout_tran_type' }) || rec.getValue('custrecord_celigo_shpf_payout_tran_type');
            const alreadyDone  = rec.getValue('custrecord_related_netsuite_transaction');
            const inactive     = rec.getValue('isinactive');

            log.audit('1. Gate values', {
                contextType: context.type,
                varianceType: varianceType,
                payoutType: payoutType,
                isinactive: inactive,
                relatedTransaction: alreadyDone
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
                filters: [
                    ['mainline', 'is', 'T'], 'AND',
                    ['custbody_celigo_etail_order_id', 'is', String(sourceOrderId)]
                ],
                columns: ['internalid', 'tranid', 'entity', 'status']
            }).run().getRange({ start: 0, end: 5 });

            log.audit('3. Sales order search', {
                matches: soResult.length,
                rows: soResult.map(r => ({ id: r.id, tranid: r.getValue('tranid'), customer: r.getText('entity'), status: r.getText('status') }))
            });

            if (!soResult.length) { plan.stoppedAt = 'sales order not found for shopify order ' + sourceOrderId; return; }
            if (soResult.length > 1) plan.problems.push('more than one sales order matched this shopify order id');

            const soId = soResult[0].id;
            plan.salesOrder = soId + ' (' + soResult[0].getValue('tranid') + ')';

            /* ---------- 4. bank deposit header ---------- */
            const depositInfo = search.lookupFields({
                type: search.Type.DEPOSIT,
                id: bankDepositId,
                columns: ['trandate', 'total', 'tranid']
            });

            log.audit('4. Bank deposit', {
                depositId: bankDepositId,
                tranid: depositInfo.tranid,
                trandate: depositInfo.trandate,
                total: depositInfo.total
            });

            /* ---------- 5. customer deposit via applyingtransaction join ---------- */
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

            if (!custDeposits.length) { plan.stoppedAt = 'no customer deposit (status A or B) found on sales order ' + soId; return; }
            if (custDeposits.length > 1) plan.problems.push('more than one customer deposit on this order - dry run picked the first');

            const customerDepositId = custDeposits[0].id;
            plan.customerDeposit = customerDepositId + ' (' + custDeposits[0].tranid + ')';

            /* ---------- 6. refunds from this SO with THIS customer deposit applied ---------- */
            const readRefunds = (label, filters) => {
                try {
                    return search.create({
                        type: 'customerrefund',
                        filters: filters,
                        columns: ['internalid', 'tranid', 'trandate', 'total', 'account']
                    }).run().getRange({ start: 0, end: 20 })
                        .map(r => ({
                            id: String(r.id),
                            tranid: r.getValue('tranid'),
                            date: r.getValue('trandate'),
                            total: r.getValue('total'),
                            account: r.getText('account')
                        }));
                } catch (e) {
                    plan.problems.push('refund search (' + label + ') failed: ' + e.message);
                    return [];
                }
            };

            // strict: created from this SO AND this customer deposit applied
            const matchedRefunds = readRefunds('strict', [
                ['mainline', 'is', 'T'], 'AND',
                ['createdfrom', 'anyof', soId], 'AND',
                ['appliedtotransaction', 'anyof', customerDepositId]
            ]);

            // diagnostic only: everything created from this SO, to see near misses
            const allFromSo = readRefunds('createdfrom only', [
                ['mainline', 'is', 'T'], 'AND',
                ['createdfrom', 'anyof', soId]
            ]);

            log.audit('6. Customer refunds for this order', {
                withThisCustomerDepositApplied: matchedRefunds.length,
                matched: matchedRefunds,
                allCreatedFromThisSo: allFromSo
            });

            if (!matchedRefunds.length && allFromSo.length) {
                plan.problems.push('refunds exist on this SO but none apply customer deposit ' + customerDepositId + ' - review before going live');
            }

            /* ---------- 7. bank deposit payment sublist ---------- */
            const deposit = record.load({
                type: record.Type.DEPOSIT,
                id: bankDepositId,
                isDynamic: false,
                defaultValues: { disablepaymentfilters: true }
            });

            const paymentCount = deposit.getLineCount({ sublistId: 'payment' });
            const candidateIds = matchedRefunds.map(r => r.id);
            const linesForThisOrder = [];
            let matchedLine = -1, matchedRefundId = null, tickedAlready = false;

            for (let i = 0; i < paymentCount; i++) {
                const id     = String(deposit.getSublistValue({ sublistId: 'payment', fieldId: 'id', line: i }));
                if (candidateIds.indexOf(id) < 0) continue;

                const amt    = Math.abs(parseFloat(deposit.getSublistValue({ sublistId: 'payment', fieldId: 'amount', line: i })) || 0);
                const ticked = deposit.getSublistValue({ sublistId: 'payment', fieldId: 'deposit', line: i });
                linesForThisOrder.push({ line: i, transactionId: id, amount: amt, alreadyTicked: ticked });

                if (ticked) { tickedAlready = true; continue; }
                if (Math.abs(amt - refundAmount) < 0.01 && matchedLine === -1) {
                    matchedLine = i;
                    matchedRefundId = id;
                }
            }

            log.audit('7. Deposit payment sublist', {
                totalAvailableLines: paymentCount,
                linesForThisOrder: linesForThisOrder
            });

            /* ---------- 8. cash back line ---------- */
            const cashBackCount = deposit.getLineCount({ sublistId: 'cashback' });
            const cashBackRows = [];
            let varianceLine = -1;

            for (let i = 0; i < cashBackCount; i++) {
                const memo = deposit.getSublistValue({ sublistId: 'cashback', fieldId: 'memo', line: i });
                const amt  = parseFloat(deposit.getSublistValue({ sublistId: 'cashback', fieldId: 'amount', line: i })) || 0;
                cashBackRows.push({ line: i, memo: memo, amount: amt });
                if (String(memo || '').trim().toLowerCase() === CASHBACK_MEMO && varianceLine === -1) varianceLine = i;
            }

            log.audit('8. Deposit cash back sublist', { lines: cashBackRows, varianceLineIndex: varianceLine });

            if (varianceLine === -1) plan.problems.push('no cash back line with memo "' + CASHBACK_MEMO + '" - the live script would fail here');

            /* ---------- 9. the plan ---------- */
            if (matchedLine >= 0) {
                plan.refundAction = 'REUSE_EXISTING';
                plan.refundId = matchedRefundId;
                plan.depositPaymentLine = matchedLine;
            } else if (matchedRefunds.length && tickedAlready) {
                plan.refundAction = 'CREATE_NEW';
                plan.refundId = 'existing refund is already ticked on a deposit - would create a new one from customer deposit ' + customerDepositId;
                plan.problems.push('matching refund found but already deposited - confirm this is not a double refund before going live');
            } else {
                plan.refundAction = 'CREATE_NEW';
                plan.refundId = 'would transform customer deposit ' + customerDepositId +
                    ' into a customer refund of ' + refundAmount + ' dated ' + depositInfo.trandate;
            }

            if (varianceLine >= 0) {
                plan.cashBackBefore = cashBackRows[varianceLine].amount;
                plan.cashBackAfter  = Math.round((plan.cashBackBefore - refundAmount) * 100) / 100;
                if (plan.cashBackAfter < -0.001) plan.problems.push('cash back line is smaller than the refund amount - the live script would fail here');
            }

            /* ---------- 9a-9d. every write the live script would perform ---------- */
            const refundLabel = (plan.refundAction === 'REUSE_EXISTING')
                ? 'existing refund ' + matchedRefundId
                : 'the newly created refund';

            if (plan.refundAction === 'REUSE_EXISTING') {
                log.audit('9a. WOULD NOT CREATE A REFUND - reusing one', {
                    refundId: matchedRefundId,
                    reason: 'already exists, applies customer deposit ' + customerDepositId + ', not yet on any bank deposit'
                });
                plan.plannedActions.push('REUSE customer refund ' + matchedRefundId + ' (no new record created)');
            } else {
                log.audit('9a. WOULD CREATE A CUSTOMER REFUND', {
                    method: 'record.transform customerdeposit -> customerrefund',
                    fromCustomerDeposit: customerDepositId + ' (' + custDeposits[0].tranid + ')',
                    amount: refundAmount,
                    trandate: depositInfo.trandate,
                    account: REFUND_ACCOUNT,
                    customer: soResult[0].getText('entity'),
                    appliesDepositLine: true
                });
                plan.plannedActions.push('CREATE customer refund of ' + refundAmount + ' from customer deposit ' + customerDepositId);
            }

            log.audit('9b. WOULD TICK THE REFUND ON THE BANK DEPOSIT', {
                bankDeposit: bankDepositId + ' (' + depositInfo.tranid + ')',
                refund: refundLabel,
                paymentSublistLine: (matchedLine >= 0) ? matchedLine : 'not known yet - refund does not exist until the live run creates it',
                depositCheckbox: 'false -> true',
                effectOnDepositTotal: 'minus ' + refundAmount
            });
            plan.plannedActions.push('TICK ' + refundLabel + ' on bank deposit ' + depositInfo.tranid);

            if (varianceLine >= 0) {
                log.audit('9c. WOULD REDUCE THE CASH BACK VARIANCE LINE', {
                    bankDeposit: depositInfo.tranid,
                    cashBackLine: varianceLine,
                    memo: cashBackRows[varianceLine].memo,
                    amountBefore: plan.cashBackBefore,
                    amountAfter: plan.cashBackAfter,
                    lineWouldBeRemoved: (Math.abs(plan.cashBackAfter) < 0.001),
                    feesLineTouched: false,
                    depositTotalAfterBothChanges: 'unchanged (' + depositInfo.total + ')'
                });
                plan.plannedActions.push('REDUCE cash back "' + cashBackRows[varianceLine].memo + '" from ' + plan.cashBackBefore + ' to ' + plan.cashBackAfter);
            }

            log.audit('9d. WOULD UPDATE THIS VARIANCE RECORD', {
                varianceRecord: rec.id,
                custrecord_related_netsuite_transaction: refundLabel,
                isinactive: 'false -> true'
            });
            plan.plannedActions.push('STAMP ' + refundLabel + ' on variance record ' + rec.id + ' and set it inactive');

            plan.wouldProceed = true;

        } catch (e) {
            plan.stoppedAt = 'ERROR: ' + e.message;
            log.error('Dry run error', { message: e.message, stack: e.stack });
        } finally {
            log.audit('=== DRY RUN RESULT (nothing was saved) ===', plan);
        }
    };

    return { afterSubmit };
});