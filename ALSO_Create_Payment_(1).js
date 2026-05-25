/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/log', 'N/search'], function (record, log, search) {

    function afterSubmit(context) {
        try {
            if (context.type !== context.UserEventType.CREATE &&
                context.type !== context.UserEventType.EDIT) {
                log.debug('Exit', 'Context type is not CREATE/EDIT');
                return;
            }

            var invoiceId = context.newRecord.id;
            if (!invoiceId) {
                log.debug('Exit', 'Invoice id missing');
                return;
            }

            var salesOrderId = context.newRecord.getValue({ fieldId: 'createdfrom' });
            if (!salesOrderId) {
                log.debug('Exit', 'Created From Sales Order missing on invoice');
                return;
            }

            var soLookup = search.lookupFields({
                type: search.Type.SALES_ORDER,
                id: salesOrderId,
                columns: ['custbody_discount_removed']
            });

            var discountRemoved = (
                soLookup.custbody_discount_removed === true ||
                soLookup.custbody_discount_removed === 'T'
            );

            log.debug('Sales Order Check', {
                invoiceId: invoiceId,
                salesOrderId: salesOrderId,
                discountRemoved: discountRemoved,
                eventType: context.type
            });

            if (!discountRemoved) {
                log.debug('Exit', 'Sales Order checkbox custbody_discount_removed is false');
                return;
            }

            var existingPayment = findExistingCustomerPayment(invoiceId);
            if (existingPayment) {
                log.debug('Exit', {
                    message: 'Customer Payment already exists for this invoice',
                    invoiceId: invoiceId,
                    paymentId: existingPayment
                });
                return;
            }

            var payRec = record.transform({
                fromType: record.Type.INVOICE,
                fromId: invoiceId,
                toType: record.Type.CUSTOMER_PAYMENT,
                isDynamic: true
            });

            log.debug('Customer Payment Created in Memory', {
                invoiceId: invoiceId
            });

            var invoiceApplyAmount = getSelectedInvoiceAmount(payRec, invoiceId);

            log.debug('Invoice Apply Amount', {
                invoiceId: invoiceId,
                invoiceApplyAmount: invoiceApplyAmount
            });

            if (invoiceApplyAmount <= 0) {
                log.debug('Exit', 'Invoice apply amount is 0');
                return;
            }

            var depositCount = payRec.getLineCount({ sublistId: 'deposit' }) || 0;
            if (depositCount <= 0) {
                log.debug('Exit', 'No deposit lines found on Customer Payment');
                return;
            }

            var depositLine = findBestDepositLineByAmount(payRec, invoiceApplyAmount, null);
            if (depositLine === -1) {
                log.debug('Exit', {
                    message: 'No matching remaining deposit found on deposit tab',
                    targetAmount: invoiceApplyAmount
                });
                return;
            }

            applyDepositLine(payRec, depositLine, invoiceApplyAmount);

            log.debug('Remaining Deposit Applied', {
                line: depositLine,
                amountApplied: invoiceApplyAmount
            });

            var payId = payRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            log.audit('Customer Payment Created', {
                paymentId: payId,
                invoiceId: invoiceId,
                invoiceApplyAmount: invoiceApplyAmount,
                eventType: context.type
            });

        } catch (e) {
            log.error('afterSubmit Error', e);
        }
    }

    function findExistingCustomerPayment(invoiceId) {
        var paymentId = '';

        search.create({
            type: search.Type.CUSTOMER_PAYMENT,
            filters: [
                ['type', 'anyof', 'CustPymt'],
                'AND',
                ['mainline', 'is', 'F'],
                'AND',
                ['appliedtotransaction.internalid', 'anyof', invoiceId]
            ],
            columns: [
                search.createColumn({ name: 'internalid', summary: 'GROUP' })
            ]
        }).run().each(function (r) {
            paymentId = r.getValue({ name: 'internalid', summary: 'GROUP' });
            return false;
        });

        return paymentId;
    }

    function getSelectedInvoiceAmount(rec, invoiceId) {
        var applyCount = rec.getLineCount({ sublistId: 'apply' }) || 0;
        var i = 0;

        for (i = 0; i < applyCount; i++) {
            var doc = getSublistSafe(rec, 'apply', 'doc', i);
            var applyVal = getSublistSafe(rec, 'apply', 'apply', i);

            log.debug('Apply Line Check', {
                line: i,
                doc: doc,
                apply: applyVal
            });

            if (String(doc) === String(invoiceId)) {
                if (!(applyVal === true || applyVal === 'T')) {
                    rec.selectLine({
                        sublistId: 'apply',
                        line: i
                    });

                    rec.setCurrentSublistValue({
                        sublistId: 'apply',
                        fieldId: 'apply',
                        value: true
                    });

                    rec.commitLine({
                        sublistId: 'apply'
                    });
                }

                return getApplyLineAmount(rec, i);
            }
        }

        return 0;
    }

    function getApplyLineAmount(rec, line) {
        var amt = 0;

        amt = parseFloat(getSublistSafe(rec, 'apply', 'payment', line)) || 0;
        if (amt > 0) return roundAmount(amt);

        amt = parseFloat(getSublistSafe(rec, 'apply', 'amount', line)) || 0;
        if (amt > 0) return roundAmount(amt);

        amt = parseFloat(getSublistSafe(rec, 'apply', 'due', line)) || 0;
        if (amt > 0) return roundAmount(amt);

        amt = parseFloat(getSublistSafe(rec, 'apply', 'total', line)) || 0;
        if (amt > 0) return roundAmount(amt);

        amt = parseFloat(getSublistSafe(rec, 'apply', 'amountremaining', line)) || 0;
        if (amt > 0) return roundAmount(amt);

        return 0;
    }

    function findBestDepositLineByAmount(rec, targetAmount, excludeLine) {
        var depositCount = rec.getLineCount({ sublistId: 'deposit' }) || 0;
        var matches = [];
        var i = 0;

        for (i = 0; i < depositCount; i++) {
            if (excludeLine !== null && excludeLine !== undefined && i === excludeLine) {
                continue;
            }

            var isApplied = getSublistSafe(rec, 'deposit', 'apply', i);
            if (isApplied === true || isApplied === 'T') {
                continue;
            }

            var depAmt = getDepositLineAmount(rec, i);
            var depDate = getSublistSafe(rec, 'deposit', 'date', i);
            var depDoc = getSublistSafe(rec, 'deposit', 'doc', i);

            log.debug('Deposit Line Check', {
                line: i,
                doc: depDoc,
                amount: depAmt,
                date: depDate,
                targetAmount: targetAmount
            });

            if (roundAmount(depAmt) === roundAmount(targetAmount)) {
                matches.push({
                    line: i,
                    amount: depAmt,
                    date: depDate,
                    doc: depDoc
                });
            }
        }

        if (!matches.length) {
            return -1;
        }

        matches.sort(function (a, b) {
            return parseDateString(b.date) - parseDateString(a.date);
        });

        log.debug('Deposit Match Chosen', matches[0]);

        return matches[0].line;
    }

    function applyDepositLine(rec, line, value) {
        rec.selectLine({
            sublistId: 'deposit',
            line: line
        });

        rec.setCurrentSublistValue({
            sublistId: 'deposit',
            fieldId: 'apply',
            value: true
        });

        setDepositAmount(rec, value);

        rec.commitLine({
            sublistId: 'deposit'
        });
    }

    function getDepositLineAmount(rec, line) {
        var amt = 0;

        amt = parseFloat(getSublistSafe(rec, 'deposit', 'payment', line)) || 0;
        if (amt > 0) return roundAmount(amt);

        amt = parseFloat(getSublistSafe(rec, 'deposit', 'amount', line)) || 0;
        if (amt > 0) return roundAmount(amt);

        amt = parseFloat(getSublistSafe(rec, 'deposit', 'due', line)) || 0;
        if (amt > 0) return roundAmount(amt);

        amt = parseFloat(getSublistSafe(rec, 'deposit', 'total', line)) || 0;
        if (amt > 0) return roundAmount(amt);

        amt = parseFloat(getSublistSafe(rec, 'deposit', 'remaining', line)) || 0;
        if (amt > 0) return roundAmount(amt);

        amt = parseFloat(getSublistSafe(rec, 'deposit', 'amountremaining', line)) || 0;
        if (amt > 0) return roundAmount(amt);

        return 0;
    }

    function setDepositAmount(rec, value) {
        try {
            rec.setCurrentSublistValue({
                sublistId: 'deposit',
                fieldId: 'payment',
                value: value
            });
            return;
        } catch (e1) {}

        try {
            rec.setCurrentSublistValue({
                sublistId: 'deposit',
                fieldId: 'amount',
                value: value
            });
            return;
        } catch (e2) {}

        try {
            rec.setCurrentSublistValue({
                sublistId: 'deposit',
                fieldId: 'due',
                value: value
            });
            return;
        } catch (e3) {}
    }

    function getSublistSafe(rec, sublistId, fieldId, line) {
        try {
            return rec.getSublistValue({
                sublistId: sublistId,
                fieldId: fieldId,
                line: line
            });
        } catch (e) {
            return '';
        }
    }

    function parseDateString(val) {
        if (!val) return new Date(0).getTime();

        var dt = new Date(val);
        if (!isNaN(dt.getTime())) {
            return dt.getTime();
        }

        var parts = String(val).split('/');
        if (parts.length === 3) {
            return new Date(parts[2], parts[0] - 1, parts[1]).getTime();
        }

        return new Date(0).getTime();
    }

    function roundAmount(val) {
        return Math.round((parseFloat(val) || 0) * 100) / 100;
    }

    return {
        afterSubmit: afterSubmit
    };
});
