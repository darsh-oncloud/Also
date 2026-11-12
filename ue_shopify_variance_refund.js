/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Shopify Payout Variance -> Customer Refund -> Bank Deposit
 *
 * Flow (runs after the variance record is saved):
 *   1. Validate variance (active, Missing Transaction, refund)
 *   2. If no refund linked yet: create Customer Refund from the Customer Deposit
 *      and write it to Related NetSuite Transaction
 *      If a refund is already linked (e.g. created by an earlier run): reuse it
 *   3. Bank Deposit: tick the refund on the Payments sublist and reduce the
 *      Cash Back variance line by the same amount (deposit total stays the same)
 *   4. Inactivate the variance (only after the Bank Deposit is saved)
 *
 * Switches:
 *   DRY_RUN              -> refund part only logs, nothing saved
 *   BANK_DEPOSIT_DRY_RUN -> bank deposit part only logs, nothing saved
 *
 * Deploy on: Shopify Payout Variance Transaction
 */
define(['N/record', 'N/search', 'N/log'], (record, search, log) => {

    /* ===================== SWITCHES ===================== */
    const DRY_RUN = false;                 // refund creation
    const BANK_DEPOSIT_DRY_RUN = false;    // set TRUE to preview the bank deposit change without saving
    const INACTIVATE_VARIANCE = true;      // inactivate variance after Bank Deposit is updated
    const LINK_EXISTING_REFUND = false;    // if a same-amount refund already exists, link it and continue
    const LOG_VARIANCE_FIELDS = true;      // logs every custom field on the variance (to find the bank deposit / payout field)

    /* ===================== REFUND SETTINGS ===================== */
    const REFUND_ACCOUNT = 122;            // must be Undeposited Funds for the refund to show on a Bank Deposit
    const SO_LINK_FIELD = 'custbody_pcs_netsuite_sales_order';
    const VARIANCE_LINK_FIELD = 'custrecord_related_netsuite_transaction';

    /* ===================== BANK DEPOSIT SETTINGS (OPTIONAL) =====================
     * Leave blank: the script auto-finds the Bank Deposit from any field on the
     * variance record that points to one (Option C). Fill in A or B only if
     * auto-find fails.
     *
     * Option A - a field on the variance record holds the Bank Deposit internal ID
     */
    const VARIANCE_BANK_DEPOSIT_FIELD = '';   // e.g. 'custrecord_celigo_shpf_xxx_deposit'

    /* Option B - variance -> Shopify Payout record -> Bank Deposit */
    const VARIANCE_PAYOUT_FIELD = '';         // field on variance that points to the payout record
    const PAYOUT_RECORD_TYPE = '';            // e.g. 'customrecord_celigo_shpf_payout'
    const PAYOUT_BANK_DEPOSIT_FIELD = '';     // field on payout record that holds the Bank Deposit

    /* How to find the variance line on the Bank Deposit Cash Back sublist */
    const CASHBACK_VARIANCE_ACCOUNT = '';     // internal ID of the variance account ('' = any account)
    const CASHBACK_MEMO_CONTAINS = '';        // optional text the memo must contain ('' = ignore)
    /* ========================================================================== */

    const afterSubmit = (context) => {

        if (
            context.type !== context.UserEventType.CREATE &&
            context.type !== context.UserEventType.EDIT
        ) return;

        const rec = context.newRecord;

        const result = {
            dryRun: DRY_RUN,
            bankDepositDryRun: BANK_DEPOSIT_DRY_RUN,
            varianceRecord: rec.id,
            refundId: null,
            refundCreatedThisRun: false,
            salesOrder: null,
            customerDeposit: null,
            refundAmount: null,
            existingRefund: null,
            bankDeposit: null,
            bankDepositUpdated: false,
            varianceInactivated: false,
            stoppedAt: null,
            problems: []
        };

        try {

            /* ---------- 1. READ VARIANCE ---------- */
            const inactive = rec.getValue({ fieldId: 'isinactive' });
            const relatedTransaction = rec.getValue({ fieldId: VARIANCE_LINK_FIELD });

            const varianceType =
                rec.getText({ fieldId: 'custrecord_celigo_shpf_trans_var_type' }) ||
                rec.getValue({ fieldId: 'custrecord_celigo_shpf_trans_var_type' });

            const payoutType =
                rec.getText({ fieldId: 'custrecord_celigo_shpf_payout_tran_type' }) ||
                rec.getValue({ fieldId: 'custrecord_celigo_shpf_payout_tran_type' });

            const refundAmount = Math.abs(
                parseFloat(rec.getValue({ fieldId: 'custrecord_celigo_shpf_trans_var_amnt' })) || 0
            );
            result.refundAmount = refundAmount;

            log.audit('1. VARIANCE RECORD', {
                varianceRecord: rec.id, inactive, relatedTransaction, varianceType, payoutType, refundAmount
            });

            if (LOG_VARIANCE_FIELDS) logVarianceFields(rec);

            /* ---------- 2. VALIDATION ---------- */
            if (inactive === true || inactive === 'T') {
                result.stoppedAt = 'Variance record is inactive (already processed)';
                return;
            }
            if (String(varianceType) !== 'Missing Transaction') {
                result.stoppedAt = 'Variance Type is not Missing Transaction';
                return;
            }
            if (String(payoutType).toLowerCase() !== 'refund') {
                result.stoppedAt = 'Payout Type is not refund';
                return;
            }
            if (!refundAmount) {
                result.stoppedAt = 'Refund Amount is empty';
                return;
            }

            /* ---------- 3. GET OR CREATE THE REFUND ---------- */
            let refundId = null;

            if (relatedTransaction) {
                // Refund was created by an earlier run - only the bank deposit step is left
                const lookup = search.lookupFields({
                    type: search.Type.TRANSACTION,
                    id: relatedTransaction,
                    columns: ['type']
                });
                const tranType = (lookup.type && lookup.type[0]) ? lookup.type[0].value : '';

                if (tranType !== 'CustRfnd') {
                    result.stoppedAt =
                        'Related NetSuite Transaction ' + relatedTransaction +
                        ' is not a Customer Refund (' + tranType + ')';
                    return;
                }

                refundId = String(relatedTransaction);
                log.audit('3. REFUND ALREADY LINKED - GOING TO BANK DEPOSIT STEP', { refundId });

            } else {
                refundId = createRefund(rec, refundAmount, result);
                if (!refundId) return;   // stoppedAt already set
            }

            result.refundId = refundId;

            /* ---------- 4. BANK DEPOSIT ---------- */
            const bankOk = updateBankDeposit(rec, refundId, refundAmount, result);
            if (!bankOk) return;        // stoppedAt already set

            /* ---------- 5. INACTIVATE VARIANCE ---------- */
            if (INACTIVATE_VARIANCE) {
                record.submitFields({
                    type: rec.type,
                    id: rec.id,
                    values: { isinactive: true },
                    options: { enableSourcing: false, ignoreMandatoryFields: true }
                });
                result.varianceInactivated = true;
                log.audit('12. VARIANCE INACTIVATED', { varianceRecord: rec.id });
            }

        } catch (e) {
            result.stoppedAt = 'ERROR: ' + e.message;
            log.error('SHOPIFY REFUND ERROR', { varianceRecord: rec.id, message: e.message, stack: e.stack });
        } finally {
            log.audit('=== SHOPIFY REFUND RESULT ===', result);
        }
    };

    /* =====================================================================
     * CREATE CUSTOMER REFUND (returns refund id, or null if stopped)
     * ===================================================================== */
    const createRefund = (rec, refundAmount, result) => {

        const sourceOrderId = rec.getValue({ fieldId: 'custrecord_celigo_shpf_tran_src_ordr_id' });
        log.audit('2. SOURCE DATA', { sourceOrderId, refundAmount });

        if (!sourceOrderId) {
            result.stoppedAt = 'Missing Source Order ID';
            return null;
        }

        /* Sales Order */
        const soResults = search.create({
            type: 'salesorder',
            filters: [
                ['mainline', 'is', 'T'],
                'AND',
                ['custbody_celigo_etail_order_id', 'is', String(sourceOrderId)]
            ],
            columns: ['internalid', 'tranid', 'entity', 'status']
        }).run().getRange({ start: 0, end: 5 });

        log.audit('3. SALES ORDER SEARCH', {
            sourceOrderId,
            matches: soResults.length,
            results: soResults.map(r => ({
                internalId: r.id, tranid: r.getValue('tranid'),
                customer: r.getText('entity'), status: r.getText('status')
            }))
        });

        if (!soResults.length) {
            result.stoppedAt = 'No Sales Order found for Source Order ID ' + sourceOrderId;
            return null;
        }
        if (soResults.length > 1) {
            result.stoppedAt = 'More than one Sales Order found for Source Order ID ' + sourceOrderId;
            return null;
        }

        const soId = String(soResults[0].id);
        const soNumber = soResults[0].getValue('tranid');
        result.salesOrder = { id: soId, tranid: soNumber, customer: soResults[0].getText('entity') };

        /* Customer Deposit */
        const cdRows = search.create({
            type: 'salesorder',
            filters: [
                ['type', 'anyof', 'SalesOrd'],
                'AND', ['internalidnumber', 'equalto', soId],
                'AND', ['applyingtransaction.type', 'anyof', 'CustDep'],
                'AND', ['applyingtransaction.status', 'anyof', 'CustDep:A', 'CustDep:B']
            ],
            columns: [
                search.createColumn({ name: 'internalid', join: 'applyingTransaction' }),
                search.createColumn({ name: 'tranid', join: 'applyingTransaction' }),
                search.createColumn({ name: 'amount', join: 'applyingTransaction' }),
                search.createColumn({ name: 'status', join: 'applyingTransaction' })
            ]
        }).run().getRange({ start: 0, end: 20 });

        const customerDeposits = [];
        cdRows.forEach(row => {
            const id = String(row.getValue({ name: 'internalid', join: 'applyingTransaction' }) || '');
            if (id && !customerDeposits.some(d => d.id === id)) {
                customerDeposits.push({
                    id,
                    tranid: row.getValue({ name: 'tranid', join: 'applyingTransaction' }),
                    amount: row.getValue({ name: 'amount', join: 'applyingTransaction' }),
                    status: row.getText({ name: 'status', join: 'applyingTransaction' })
                });
            }
        });

        log.audit('4. CUSTOMER DEPOSIT SEARCH', { salesOrder: soNumber, found: customerDeposits.length, deposits: customerDeposits });

        if (!customerDeposits.length) {
            result.stoppedAt = 'No Customer Deposit found on Sales Order ' + soNumber;
            return null;
        }
        if (customerDeposits.length > 1) {
            result.stoppedAt = 'More than one Customer Deposit found on Sales Order ' + soNumber;
            return null;
        }

        const customerDeposit = customerDeposits[0];
        result.customerDeposit = customerDeposit;

        /* Duplicate guard */
        const candidates = [];
        const addRefundCandidates = (filters) => {
            search.create({
                type: 'customerrefund',
                filters,
                columns: ['internalid', 'tranid', 'total', 'trandate']
            }).run().getRange({ start: 0, end: 20 }).forEach(row => {
                if (candidates.some(c => c.id === String(row.id))) return;
                candidates.push({
                    id: String(row.id),
                    tranid: row.getValue('tranid'),
                    total: Math.abs(parseFloat(row.getValue('total')) || 0),
                    trandate: row.getValue('trandate')
                });
            });
        };

        addRefundCandidates([
            ['mainline', 'is', 'T'],
            'AND',
            ['createdfrom', 'anyof', [soId, customerDeposit.id]]
        ]);

        try {
            addRefundCandidates([['mainline', 'is', 'T'], 'AND', [SO_LINK_FIELD, 'anyof', soId]]);
        } catch (e) {
            result.problems.push('SO Link Field search failed: ' + e.message);
        }

        log.audit('5. REFUND CANDIDATES', { salesOrder: soNumber, refundAmountRequired: refundAmount, candidates });

        const existingRefund = candidates.find(c => Math.abs(c.total - refundAmount) < 0.01) || null;

        if (existingRefund) {
            result.existingRefund = existingRefund;
            log.audit('6. MATCHING REFUND ALREADY EXISTS - NOT CREATING', existingRefund);

            if (LINK_EXISTING_REFUND && !DRY_RUN) {
                linkRefundToVariance(rec, existingRefund.id);
                return existingRefund.id;   // continue to bank deposit with it
            }
            result.stoppedAt = 'Matching Customer Refund already exists';
            return null;
        }

        /* Transform Customer Deposit -> Customer Refund */
        const refund = record.transform({
            fromType: record.Type.CUSTOMER_DEPOSIT,
            fromId: customerDeposit.id,
            toType: record.Type.CUSTOMER_REFUND,
            isDynamic: false
        });

        refund.setValue({ fieldId: 'account', value: REFUND_ACCOUNT });
        refund.setValue({ fieldId: 'memo', value: 'Shopify refund - order ' + sourceOrderId + ' - variance ' + rec.id });

        try {
            refund.setValue({ fieldId: SO_LINK_FIELD, value: soId });
        } catch (e) {
            result.problems.push('Could not set SO link field on refund: ' + e.message);
        }

        const lineCount = refund.getLineCount({ sublistId: 'deposit' });
        const lines = [];
        let targetLine = -1;

        for (let i = 0; i < lineCount; i++) {
            const doc = String(refund.getSublistValue({ sublistId: 'deposit', fieldId: 'doc', line: i }) || '');
            const remaining = parseFloat(refund.getSublistValue({ sublistId: 'deposit', fieldId: 'remaining', line: i }));
            lines.push({ line: i, doc, remaining });

            if (doc === String(customerDeposit.id)) {
                targetLine = i;
            } else {
                refund.setSublistValue({ sublistId: 'deposit', fieldId: 'apply', line: i, value: false });
            }
        }

        if (targetLine < 0) {
            result.stoppedAt = 'Customer Deposit is not available on transformed Customer Refund';
            return null;
        }

        const remainingOnDeposit = lines[targetLine].remaining;
        if (!isNaN(remainingOnDeposit) && refundAmount - remainingOnDeposit > 0.005) {
            result.stoppedAt = 'Refund amount ' + refundAmount + ' is more than remaining on deposit ' + remainingOnDeposit;
            return null;
        }

        refund.setSublistValue({ sublistId: 'deposit', fieldId: 'apply', line: targetLine, value: true });
        refund.setSublistValue({ sublistId: 'deposit', fieldId: 'amount', line: targetLine, value: refundAmount });

        log.audit('7. REFUND READY', { customerDeposit, lines, targetLine, amountApplied: refundAmount });

        if (DRY_RUN) {
            result.stoppedAt = 'Refund DRY RUN - refund not saved, so bank deposit step skipped';
            return null;
        }

        const refundId = String(refund.save({ enableSourcing: true, ignoreMandatoryFields: false }));
        result.refundCreatedThisRun = true;

        log.audit('8. CUSTOMER REFUND CREATED', { refundId, fromCustomerDeposit: customerDeposit.id, salesOrderId: soId, refundAmount });

        linkRefundToVariance(rec, refundId);
        return refundId;
    };

    /* =====================================================================
     * BANK DEPOSIT: tick refund + reduce cash back variance line
     * returns true when done (or already done)
     * ===================================================================== */
    const updateBankDeposit = (rec, refundId, refundAmount, result) => {

        const bankDepositId = findBankDepositId(rec);
        result.bankDeposit = bankDepositId;

        if (!bankDepositId) {
            result.stoppedAt =
                'Bank Deposit not found - fill in VARIANCE_BANK_DEPOSIT_FIELD (or the payout settings). ' +
                'See the "0. VARIANCE FIELDS" log to find the right field.';
            return false;
        }

        const dep = record.load({ type: record.Type.DEPOSIT, id: bankDepositId, isDynamic: false });
        const totalBefore = parseFloat(dep.getValue({ fieldId: 'total' })) || 0;

        /* --- find the refund on the Payments sublist --- */
        const payCount = dep.getLineCount({ sublistId: 'payment' });
        let payLine = -1;
        let alreadyTicked = false;
        let payAmount = null;

        for (let i = 0; i < payCount; i++) {
            const id = String(dep.getSublistValue({ sublistId: 'payment', fieldId: 'id', line: i }) || '');
            if (id === String(refundId)) {
                payLine = i;
                const ticked = dep.getSublistValue({ sublistId: 'payment', fieldId: 'deposit', line: i });
                alreadyTicked = (ticked === true || ticked === 'T');
                payAmount = dep.getSublistValue({ sublistId: 'payment', fieldId: 'paymentamount', line: i });
                break;
            }
        }

        if (payLine < 0) {
            result.stoppedAt =
                'Customer Refund ' + refundId + ' is not available on Bank Deposit ' + bankDepositId +
                ' (payment lines: ' + payCount + '). Check account ' + REFUND_ACCOUNT +
                ' is Undeposited Funds and the refund is the same subsidiary/currency.';
            return false;
        }

        if (alreadyTicked) {
            log.audit('9. REFUND ALREADY TICKED ON BANK DEPOSIT - NO CHANGE', { bankDepositId, refundId });
            result.bankDepositUpdated = true;
            return true;
        }

        /* --- find the variance line on Cash Back --- */
        const cbCount = dep.getLineCount({ sublistId: 'cashback' });
        const cbLines = [];

        for (let i = 0; i < cbCount; i++) {
            cbLines.push({
                line: i,
                account: String(dep.getSublistValue({ sublistId: 'cashback', fieldId: 'account', line: i }) || ''),
                amount: parseFloat(dep.getSublistValue({ sublistId: 'cashback', fieldId: 'amount', line: i })) || 0,
                memo: String(dep.getSublistValue({ sublistId: 'cashback', fieldId: 'memo', line: i }) || '')
            });
        }

        const matches = cbLines.filter(l =>
            (!CASHBACK_VARIANCE_ACCOUNT || l.account === String(CASHBACK_VARIANCE_ACCOUNT)) &&
            (!CASHBACK_MEMO_CONTAINS || l.memo.toLowerCase().indexOf(CASHBACK_MEMO_CONTAINS.toLowerCase()) > -1) &&
            l.amount - refundAmount > -0.005
        );

        // prefer a line with exactly the refund amount
        const cbLine = matches.find(l => Math.abs(l.amount - refundAmount) < 0.005) || matches[0] || null;

        log.audit('9. BANK DEPOSIT PREVIEW', {
            bankDepositId,
            totalBefore,
            refundPaymentLine: { line: payLine, refundId, paymentAmount: payAmount },
            cashbackLines: cbLines,
            chosenCashbackLine: cbLine,
            filters: { CASHBACK_VARIANCE_ACCOUNT, CASHBACK_MEMO_CONTAINS }
        });

        if (!cbLine) {
            result.stoppedAt =
                'No Cash Back line found with amount >= ' + refundAmount +
                ' (check CASHBACK_VARIANCE_ACCOUNT / CASHBACK_MEMO_CONTAINS)';
            return false;
        }

        if (matches.length > 1 && !matches.some(l => Math.abs(l.amount - refundAmount) < 0.005)) {
            result.problems.push('More than one possible Cash Back line - used line ' + cbLine.line);
        }

        const newCashback = Math.round((cbLine.amount - refundAmount) * 100) / 100;

        if (BANK_DEPOSIT_DRY_RUN) {
            log.audit('10. BANK DEPOSIT DRY RUN - WOULD UPDATE', {
                bankDepositId,
                tickRefundLine: payLine,
                cashbackLine: cbLine.line,
                cashbackBefore: cbLine.amount,
                cashbackAfter: newCashback,
                removeCashbackLine: newCashback < 0.005,
                saved: false
            });
            result.stoppedAt = 'Bank Deposit DRY RUN - nothing saved on Bank Deposit';
            return false;
        }

        /* --- apply changes --- */
        dep.setSublistValue({ sublistId: 'payment', fieldId: 'deposit', line: payLine, value: true });

        if (newCashback < 0.005) {
            dep.removeLine({ sublistId: 'cashback', line: cbLine.line });
        } else {
            dep.setSublistValue({ sublistId: 'cashback', fieldId: 'amount', line: cbLine.line, value: newCashback });
        }

        dep.save({ enableSourcing: true, ignoreMandatoryFields: true });

        const totalAfter = parseFloat(
            search.lookupFields({ type: search.Type.DEPOSIT, id: bankDepositId, columns: ['total'] }).total
        ) || 0;

        if (Math.abs(Math.abs(totalAfter) - Math.abs(totalBefore)) > 0.01) {
            result.problems.push('Bank Deposit total changed from ' + totalBefore + ' to ' + totalAfter + ' - please review');
        }

        log.audit('11. BANK DEPOSIT UPDATED', {
            bankDepositId,
            refundTicked: refundId,
            cashbackBefore: cbLine.amount,
            cashbackAfter: newCashback,
            totalBefore,
            totalAfter
        });

        result.bankDepositUpdated = true;
        return true;
    };

    /* =====================================================================
     * HELPERS
     * ===================================================================== */
    const findBankDepositId = (rec) => {

        if (VARIANCE_BANK_DEPOSIT_FIELD) {
            return rec.getValue({ fieldId: VARIANCE_BANK_DEPOSIT_FIELD }) || null;
        }

        if (VARIANCE_PAYOUT_FIELD && PAYOUT_RECORD_TYPE && PAYOUT_BANK_DEPOSIT_FIELD) {
            const payoutId = rec.getValue({ fieldId: VARIANCE_PAYOUT_FIELD });
            if (!payoutId) return null;

            const v = search.lookupFields({
                type: PAYOUT_RECORD_TYPE,
                id: payoutId,
                columns: [PAYOUT_BANK_DEPOSIT_FIELD]
            })[PAYOUT_BANK_DEPOSIT_FIELD];

            if (Array.isArray(v)) return v.length ? v[0].value : null;
            return v || null;
        }

        /* Option C (auto): any custom field on the variance that holds a Bank Deposit */
        const fields = rec.getFields().filter(f =>
            f.indexOf('custrecord') === 0 && f !== VARIANCE_LINK_FIELD
        );

        for (let i = 0; i < fields.length; i++) {
            const v = rec.getValue({ fieldId: fields[i] });
            if (!v || Array.isArray(v) || !/^\d{1,10}$/.test(String(v))) continue;

            try {
                const t = search.lookupFields({
                    type: search.Type.TRANSACTION,
                    id: v,
                    columns: ['type']
                }).type;

                if (t && t[0] && t[0].value === 'Deposit') {
                    log.audit('BANK DEPOSIT AUTO-FOUND', { field: fields[i], bankDepositId: v });
                    return String(v);
                }
            } catch (e) { /* not a transaction id */ }
        }

        return null;
    };

    const linkRefundToVariance = (rec, refundId) => {
        const values = {};
        values[VARIANCE_LINK_FIELD] = refundId;
        record.submitFields({
            type: rec.type,
            id: rec.id,
            values,
            options: { enableSourcing: false, ignoreMandatoryFields: true }
        });
        log.audit('8b. REFUND LINKED TO VARIANCE', { varianceRecord: rec.id, refundId });
    };

    const logVarianceFields = (rec) => {
        const out = {};
        rec.getFields()
            .filter(f => f.indexOf('custrecord') === 0)
            .forEach(f => {
                let text = null;
                try { text = rec.getText({ fieldId: f }); } catch (e) { /* not a select field */ }
                const value = rec.getValue({ fieldId: f });
                if (value !== '' && value !== null) {
                    out[f] = (text && text !== String(value)) ? { value, text } : value;
                }
            });
        log.audit('0. VARIANCE FIELDS (find the Bank Deposit / Payout field here)', { recordType: rec.type, fields: out });
    };

    return { afterSubmit };
});