/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * ALSO | Shopify Dispute Deposit -> Customer level JE   [ v10 ]
 *
 * v10 CHANGE - THE CUSTOMER LINE ALWAYS LANDS ON 664 (200300 Customer Deposits)
 *   1. CASH BACK, B_COMBINED (one line = amount + fee, script has to split it)
 *      The deposit line can be on 640509, 640501 or anything else. The credit reversal
 *      still uses that account, but the per-customer DEBIT line is hardcoded to 664.
 *      CASH BACK, A_SPLIT (deposit already split) is unchanged - the dispute line is
 *      already on the right account, so the per-customer line keeps using it.
 *   2. OTHER DEPOSITS - the debit reversal keeps the account off the deposit line, and the
 *      per-customer CREDIT line is hardcoded to 664.
 *   The fee line was already hardcoded to 801 in both flows.
 *
 * THE SUBLIST DECIDES THE DIRECTION - nothing is inferred from Shopify.
 *   "Disputes amount" on CASH BACK      = chargeback opened, money taken out
 *        CR the deposit's account total / DR 664 per customer / DR 801 fee
 *   "Disputes amount" on OTHER DEPOSITS = money came back, chargeback won
 *        DR the deposit's account total / CR 664 per customer / CR 801 fee
 *   Chargeback lost -> nothing comes back, no line, script never fires.
 *
 * PAYPAL - detected on the order TRANSACTION (order.gateway reports shopify_payments even
 *          for the PayPal wallet). Skipped completely: no amount line, no fee, no lookup.
 */
define(['N/record', 'N/search', 'N/https'], function (record, search, https) {

  // ==== CONFIG ====
  var DRY_RUN             = false;  // true = log only, no JE
  var SHOP_DOMAIN         = 'ride-also.myshopify.com';
  var SHOP_TOKEN          = 'shpat_xxxxxxxx';
  var SHOP_APIVER         = '2025-10';
  var FEE_ACCOUNT_ID      = 801;   // 640509 Shopify Chargebacks - the fee line
  var CUST_DEP_ACCOUNT_ID = 664;   // 200300 Customer Deposits - the per-customer line
  var RELATED_JE_FIELD    = 'custbody_related_je';
  var CASHBACK_SUBLIST    = 'cashback';
  var OTHER_SUBLIST       = 'other';
  var DISPUTE_MEMO        = 'disputes amount';
  var FEE_MEMO            = 'dispute fee';
  // ================

  function afterSubmit(context) {
    var T = 'DISPUTE_JE';
    try {
      if (context.type !== context.UserEventType.CREATE && context.type !== context.UserEventType.EDIT) return;
      var depositId = context.newRecord.id;
      if (!depositId) return;

      /* ================= 1) LOAD + ENTRY CHECKS ================= */
      var dep = record.load({ type: record.Type.DEPOSIT, id: depositId, isDynamic: false });

      var existingJe = dep.getValue({ fieldId: RELATED_JE_FIELD });
      if (existingJe) { log.audit(T + ' 1 - SKIP', 'Deposit ' + depositId + ' already linked to JE ' + existingJe); return; }

      var headerMemo = dep.getValue({ fieldId: 'memo' }) || '';

      var cbLines = [], cbDisp = -1, cbFee = -1;
      var cbCnt = dep.getLineCount({ sublistId: CASHBACK_SUBLIST }) || 0;
      for (var i = 0; i < cbCnt; i++) {
        var cbRow = {
          line: i,
          account: dep.getSublistValue({ sublistId: CASHBACK_SUBLIST, fieldId: 'account', line: i }),
          accountText: dep.getSublistText({ sublistId: CASHBACK_SUBLIST, fieldId: 'account', line: i }),
          amount: Number(dep.getSublistValue({ sublistId: CASHBACK_SUBLIST, fieldId: 'amount', line: i })) || 0,
          memo: String(dep.getSublistValue({ sublistId: CASHBACK_SUBLIST, fieldId: 'memo', line: i }) || ''),
          department: dep.getSublistValue({ sublistId: CASHBACK_SUBLIST, fieldId: 'department', line: i })
        };
        cbLines.push(cbRow);
        var cm = cbRow.memo.toLowerCase().trim();
        if (cm.indexOf(DISPUTE_MEMO) === 0 && cbDisp === -1) cbDisp = i;
        if (cm.indexOf(FEE_MEMO) === 0 && cbFee === -1) cbFee = i;
      }

      var odLines = [], odDisp = -1, odFee = -1;
      var odCnt = dep.getLineCount({ sublistId: OTHER_SUBLIST }) || 0;
      for (var o = 0; o < odCnt; o++) {
        var odRow = {
          line: o,
          account: dep.getSublistValue({ sublistId: OTHER_SUBLIST, fieldId: 'account', line: o }),
          accountText: dep.getSublistText({ sublistId: OTHER_SUBLIST, fieldId: 'account', line: o }),
          amount: Number(dep.getSublistValue({ sublistId: OTHER_SUBLIST, fieldId: 'amount', line: o })) || 0,
          memo: String(dep.getSublistValue({ sublistId: OTHER_SUBLIST, fieldId: 'memo', line: o }) || ''),
          department: dep.getSublistValue({ sublistId: OTHER_SUBLIST, fieldId: 'department', line: o })
        };
        odLines.push(odRow);
        var om = odRow.memo.toLowerCase().trim();
        if (om.indexOf(DISPUTE_MEMO) === 0 && odDisp === -1) odDisp = o;
        if (om.indexOf(FEE_MEMO) === 0 && odFee === -1) odFee = o;
      }

      log.audit(T + ' 1 - DEPOSIT', {
        depositId: depositId, tranid: dep.getValue({ fieldId: 'tranid' }),
        trandate: dep.getValue({ fieldId: 'trandate' }), subsidiary: dep.getValue({ fieldId: 'subsidiary' }),
        headerMemo: headerMemo, cashbackLines: cbCnt, otherLines: odCnt
      });
      log.debug(T + ' 1 - CASHBACK SUBLIST', JSON.stringify(cbLines));
      log.debug(T + ' 1 - OTHER SUBLIST', JSON.stringify(odLines));

      var onCashback = (cbDisp !== -1);
      var onOther    = (odDisp !== -1);
      if (!onCashback && !onOther) { log.debug(T + ' 1 - EXIT', 'No "Disputes amount" line on either sublist.'); return; }

      /* ================= 2) ACCOUNTS + MODE ================= */
      var cbAcct        = onCashback ? cbLines[cbDisp].account : null;
      var cbLineAmt     = onCashback ? Math.abs(cbLines[cbDisp].amount) : 0;
      var cbMode        = onCashback ? ((cbFee !== -1) ? 'A_SPLIT' : 'B_COMBINED') : '';
      var cbFeeAcct     = (cbFee !== -1) ? cbLines[cbFee].account : null;
      var cbFeeLineAmt  = (cbFee !== -1) ? Math.abs(cbLines[cbFee].amount) : 0;
      var cbFeeMisfiled = (cbFee !== -1 && String(cbFeeAcct) !== String(FEE_ACCOUNT_ID));

      // *** v10 - when the script has to split the line, the customer debit goes to 664.
      //     When the deposit already split it, the dispute line is on the right account already.
      var cbDrAcct      = (cbMode === 'B_COMBINED') ? CUST_DEP_ACCOUNT_ID : cbAcct;

      var odAcct        = onOther ? odLines[odDisp].account : null;
      var odLineAmt     = onOther ? Math.abs(odLines[odDisp].amount) : 0;
      var odMode        = onOther ? ((odFee !== -1) ? 'A_SPLIT' : 'B_COMBINED') : '';
      var odFeeAcct     = (odFee !== -1) ? odLines[odFee].account : null;
      var odFeeLineAmt  = (odFee !== -1) ? Math.abs(odLines[odFee].amount) : 0;
      var odFeeMisfiled = (odFee !== -1 && String(odFeeAcct) !== String(FEE_ACCOUNT_ID));

      // *** v10 - the customer credit on the other-deposits flow is always 664.
      var odCrAcct      = CUST_DEP_ACCOUNT_ID;

      var dept = onCashback ? cbLines[cbDisp].department : odLines[odDisp].department;

      log.audit(T + ' 2 - WHICH SUBLIST', {
        disputeOnCashback: onCashback, CB_mode: cbMode, CB_account: cbAcct,
        CB_accountText: onCashback ? cbLines[cbDisp].accountText : '', CB_lineAmount: cbLineAmt,
        CB_feeAccount: cbFeeAcct, CB_feeLineAmount: cbFeeLineAmt, CB_feeMisfiled: cbFeeMisfiled,
        CB_customerLineAccount: cbDrAcct,
        disputeOnOtherDeposits: onOther, OD_mode: odMode, OD_account: odAcct,
        OD_accountText: onOther ? odLines[odDisp].accountText : '', OD_lineAmount: odLineAmt,
        OD_feeAccount: odFeeAcct, OD_feeLineAmount: odFeeLineAmt, OD_feeMisfiled: odFeeMisfiled,
        OD_customerLineAccount: odCrAcct,
        feeAccount: FEE_ACCOUNT_ID, customerDepositAccount: CUST_DEP_ACCOUNT_ID, department: dept
      });

      /* ================= 3) PAYOUT ID ================= */
      var pm = String(headerMemo).match(/\d{5,}/);
      var payoutId = pm ? pm[0] : '';
      log.audit(T + ' 3 - PAYOUT ID', { headerMemo: headerMemo, payoutId: payoutId });
      if (!payoutId) { log.error(T + ' 3 - ABORT', 'No payout id in header memo.'); return; }

      /* ================= 4) SHOPIFY PAYOUT - DISPUTE LINES ================= */
      var btUrl = 'https://' + SHOP_DOMAIN + '/admin/api/' + SHOP_APIVER +
                  '/shopify_payments/balance/transactions.json?payout_id=' + payoutId + '&limit=250';
      var btRes = https.get({ url: btUrl, headers: { 'X-Shopify-Access-Token': SHOP_TOKEN, 'Content-Type': 'application/json' } });
      log.audit(T + ' 4 - SHOPIFY CALL', { url: btUrl, code: btRes.code });
      if (btRes.code !== 200) { log.error(T + ' 4 - SHOPIFY ERROR', btRes.body); return; }

      var allTxn = JSON.parse(btRes.body).transactions || [], disputes = [];
      for (var d = 0; d < allTxn.length; d++) {
        if (String(allTxn[d].type).toLowerCase() === 'dispute') disputes.push(allTxn[d]);
      }
      log.audit(T + ' 4 - DISPUTES IN PAYOUT', { totalTxns: allTxn.length, disputes: disputes.length });
      log.debug(T + ' 4 - DISPUTE TXNS', JSON.stringify(disputes));
      if (!disputes.length) { log.error(T + ' 4 - ABORT', 'No dispute transactions in payout ' + payoutId); return; }

      /* ================= 5) DISPUTE -> ORDER -> PAYMENT METHOD -> CUSTOMER ================= */
      var bothSublists = (onCashback && onOther);
      log.audit(T + ' 5 - ROUTING', bothSublists
        ? 'Dispute lines on BOTH sublists - splitting the payout disputes by amount sign to separate the two groups.'
        : ('All payout disputes routed to the ' + (onCashback ? 'CASH BACK' : 'OTHER DEPOSITS') + ' flow (the sublist that carries the dispute line).'));

      var rows = [], missing = 0, paypalSkipped = 0, paypalAmt = 0;
      var cbAmt = 0, cbFeeSum = 0, odAmt = 0, odFeeSum = 0;

      for (var k = 0; k < disputes.length; k++) {
        var t = disputes[k];
        var raw = Number(t.amount) || 0;
        var amt = Math.abs(raw);
        var fee = Math.abs(Number(t.fee) || 0);
        var flow = bothSublists ? ((raw < 0) ? 'CASHBACK' : 'OTHER') : (onCashback ? 'CASHBACK' : 'OTHER');

        // 5a - order header
        var orderName = '', orderGateway = '', oCode = '';
        if (t.source_order_id) {
          var oRes = https.get({
            url: 'https://' + SHOP_DOMAIN + '/admin/api/' + SHOP_APIVER + '/orders/' + t.source_order_id +
                 '.json?fields=id,name,gateway,payment_gateway_names',
            headers: { 'X-Shopify-Access-Token': SHOP_TOKEN, 'Content-Type': 'application/json' }
          });
          oCode = oRes.code;
          if (oRes.code === 200) {
            var ord = JSON.parse(oRes.body).order || {};
            orderName = ord.name || '';
            orderGateway = String(ord.gateway || '') + ' ' + String((ord.payment_gateway_names || []).join(' '));
          }
        }

        // 5a2 - THE ACTUAL PAYMENT METHOD.
        // order.gateway says "shopify_payments" even when the buyer used the PayPal wallet,
        // so the wallet has to come off the order TRANSACTION that the dispute points at.
        var methodBlob = orderGateway, paymentMethod = '', txCode = '', txMatched = null;
        if (t.source_order_id) {
          var txRes = https.get({
            url: 'https://' + SHOP_DOMAIN + '/admin/api/' + SHOP_APIVER + '/orders/' + t.source_order_id + '/transactions.json',
            headers: { 'X-Shopify-Access-Token': SHOP_TOKEN, 'Content-Type': 'application/json' }
          });
          txCode = txRes.code;
          if (txRes.code === 200) {
            var txs = JSON.parse(txRes.body).transactions || [];
            for (var x = 0; x < txs.length; x++) {
              if (String(txs[x].id) === String(t.source_order_transaction_id)) { txMatched = txs[x]; break; }
            }
            if (!txMatched) {
              for (var y = 0; y < txs.length; y++) {
                var kind = String(txs[y].kind || '').toLowerCase();
                if (kind === 'sale' || kind === 'capture') { txMatched = txs[y]; break; }
              }
            }
            if (txMatched) {
              methodBlob += ' ' + JSON.stringify(txMatched);
              var pd = txMatched.payment_details || {};
              paymentMethod = pd.payment_method_name || pd.credit_card_company || txMatched.gateway || '';
              log.debug(T + ' 5a - ORDER TRANSACTION ' + orderName, JSON.stringify(txMatched));
            } else {
              log.debug(T + ' 5a - ORDER TRANSACTION ' + orderName, 'No matching transaction found. Raw list: ' + txRes.body);
            }
          }
        }

        var isPaypal = (methodBlob.toLowerCase().indexOf('paypal') > -1);

        // 5b - customer from the NetSuite order (PO # holds the Shopify order name with #)
        var soId = '', soTranid = '', custId = '', custName = '';
        if (orderName && !isPaypal) {
          var res = search.create({
            type: 'transaction',
            filters: [['formulatext: {otherrefnum}', 'is', orderName], 'AND', ['mainline', 'is', 'T']],
            columns: ['internalid', 'tranid', 'entity', 'otherrefnum']
          }).run().getRange({ start: 0, end: 1 });
          if (res.length) {
            soId = res[0].id; soTranid = res[0].getValue('tranid');
            custId = res[0].getValue('entity'); custName = res[0].getText('entity');
          }
        }

        var r = {
          txnId: t.id, flow: flow, rawAmount: t.amount, amount: amt, fee: fee, combined: (amt + fee).toFixed(2),
          sourceOrderId: t.source_order_id, sourceOrderTxnId: t.source_order_transaction_id,
          orderApiCode: oCode, orderTxnApiCode: txCode, orderName: orderName,
          orderGateway: orderGateway.trim(), paymentMethod: paymentMethod, isPaypal: isPaypal,
          nsOrderId: soId, nsOrderTranid: soTranid, customerId: custId, customerName: custName,
          included: (!isPaypal && !!custId)
        };
        rows.push(r);
        log.audit(T + ' 5 - DISPUTE ' + (k + 1) + '/' + disputes.length, JSON.stringify(r));

        if (isPaypal) {
          paypalSkipped++; paypalAmt += amt;
          log.audit(T + ' 5 - PAYPAL SKIPPED', 'Order ' + orderName + ' paid by "' + paymentMethod + '" amount ' + amt + ' - no JE line, no fee.');
          continue;
        }
        if (!custId) { missing++; log.error(T + ' 5 - CUSTOMER NOT FOUND', 'PO # ' + orderName + ' not found on any transaction.'); continue; }

        if (flow === 'CASHBACK') { cbAmt += amt; cbFeeSum += fee; } else { odAmt += amt; odFeeSum += fee; }
      }

      var cbExpected = (cbMode === 'A_SPLIT') ? cbAmt : (cbAmt + cbFeeSum);
      var odExpected = (odMode === 'A_SPLIT') ? odAmt : (odAmt + odFeeSum);

      log.audit(T + ' 5c - RECONCILIATION', {
        disputes: rows.length, paypalSkipped: paypalSkipped, paypalAmount: paypalAmt.toFixed(2), customerNotFound: missing,
        CB_shopifyAmt: cbAmt.toFixed(2), CB_shopifyFee: cbFeeSum.toFixed(2),
        CB_expected: cbExpected.toFixed(2), CB_depositLine: cbLineAmt.toFixed(2),
        CB_variance: (cbLineAmt - cbExpected).toFixed(2),
        OD_shopifyAmt: odAmt.toFixed(2), OD_shopifyFee: odFeeSum.toFixed(2),
        OD_expected: odExpected.toFixed(2), OD_depositLine: odLineAmt.toFixed(2),
        OD_variance: (odLineAmt - odExpected).toFixed(2),
        note: 'variance should equal paypalAmount when PayPal disputes are in the payout'
      });

      /* ================= 6) BUILD JE LINES ================= */
      var jeLines = [];

      // ---------- CASH BACK SUBLIST : money went out ----------
      if (onCashback && cbExpected > 0) {
        // reversal keeps the account the deposit actually posted to
        jeLines.push({
          account: cbAcct, accountText: cbLines[cbDisp].accountText,
          debit: '', credit: cbExpected.toFixed(2), entity: '', entityName: '', department: dept,
          memo: 'Reverse unallocated dispute amount - payout ' + payoutId
        });
        // customer line: 664 when the script split the line, otherwise the deposit's account
        for (var j = 0; j < rows.length; j++) {
          if (!rows[j].included || rows[j].flow !== 'CASHBACK') continue;
          jeLines.push({
            account: cbDrAcct, accountText: (String(cbDrAcct) === String(cbAcct) ? cbLines[cbDisp].accountText : '(200300 Customer Deposits)'),
            debit: rows[j].amount.toFixed(2), credit: '',
            entity: rows[j].customerId, entityName: rows[j].customerName, department: dept,
            memo: 'Chargeback - order ' + rows[j].orderName + ' - payout ' + payoutId
          });
        }
        if (cbMode === 'A_SPLIT') {
          if (cbFeeMisfiled && cbFeeLineAmt > 0) {
            jeLines.push({
              account: FEE_ACCOUNT_ID, accountText: '(640509 Shopify Chargebacks)',
              debit: cbFeeLineAmt.toFixed(2), credit: '', entity: '', entityName: '', department: dept,
              memo: 'Dispute fee to chargeback account - payout ' + payoutId
            });
            jeLines.push({
              account: cbFeeAcct, accountText: cbLines[cbFee].accountText,
              debit: '', credit: cbFeeLineAmt.toFixed(2), entity: '', entityName: '', department: dept,
              memo: 'Reclass dispute fee out - payout ' + payoutId
            });
            log.audit(T + ' 6CB - FEE RECLASS', { from: cbFeeAcct, to: FEE_ACCOUNT_ID, amount: cbFeeLineAmt.toFixed(2) });
          } else {
            log.audit(T + ' 6CB - FEE OK', 'Dispute fee already on account ' + cbFeeAcct + ' - no lines needed.');
          }
        } else if (cbFeeSum > 0) {
          jeLines.push({
            account: FEE_ACCOUNT_ID, accountText: '(640509 Shopify Chargebacks)',
            debit: cbFeeSum.toFixed(2), credit: '', entity: '', entityName: '', department: dept,
            memo: 'Shopify chargeback fee - payout ' + payoutId
          });
          log.audit(T + ' 6CB - FEE FROM COMBINED LINE', { to: FEE_ACCOUNT_ID, amount: cbFeeSum.toFixed(2) });
        }
      }

      // ---------- OTHER DEPOSITS SUBLIST : money came back ----------
      if (onOther && odExpected > 0) {
        // reversal keeps the account the deposit actually posted to
        jeLines.push({
          account: odAcct, accountText: odLines[odDisp].accountText,
          debit: odExpected.toFixed(2), credit: '', entity: '', entityName: '', department: dept,
          memo: 'Reverse unallocated dispute amount returned - payout ' + payoutId
        });
        // customer line: always 664
        for (var w = 0; w < rows.length; w++) {
          if (!rows[w].included || rows[w].flow !== 'OTHER') continue;
          jeLines.push({
            account: odCrAcct, accountText: '(200300 Customer Deposits)',
            debit: '', credit: rows[w].amount.toFixed(2),
            entity: rows[w].customerId, entityName: rows[w].customerName, department: dept,
            memo: 'Chargeback amount returned - order ' + rows[w].orderName + ' - payout ' + payoutId
          });
        }
        if (odMode === 'A_SPLIT') {
          if (odFeeMisfiled && odFeeLineAmt > 0) {
            jeLines.push({
              account: odFeeAcct, accountText: odLines[odFee].accountText,
              debit: odFeeLineAmt.toFixed(2), credit: '', entity: '', entityName: '', department: dept,
              memo: 'Reclass returned dispute fee out - payout ' + payoutId
            });
            jeLines.push({
              account: FEE_ACCOUNT_ID, accountText: '(640509 Shopify Chargebacks)',
              debit: '', credit: odFeeLineAmt.toFixed(2), entity: '', entityName: '', department: dept,
              memo: 'Returned dispute fee to chargeback account - payout ' + payoutId
            });
            log.audit(T + ' 6OD - FEE RECLASS', { from: odFeeAcct, to: FEE_ACCOUNT_ID, amount: odFeeLineAmt.toFixed(2) });
          } else {
            log.audit(T + ' 6OD - FEE OK', 'Returned fee already on account ' + odFeeAcct + ' - no lines needed.');
          }
        } else if (odFeeSum > 0) {
          jeLines.push({
            account: FEE_ACCOUNT_ID, accountText: '(640509 Shopify Chargebacks)',
            debit: '', credit: odFeeSum.toFixed(2), entity: '', entityName: '', department: dept,
            memo: 'Shopify chargeback fee returned - payout ' + payoutId
          });
          log.audit(T + ' 6OD - FEE RETURNED', { to: FEE_ACCOUNT_ID, amount: odFeeSum.toFixed(2) });
        }
      }

      var dr = 0, cr = 0;
      for (var q = 0; q < jeLines.length; q++) { dr += Number(jeLines[q].debit || 0); cr += Number(jeLines[q].credit || 0); }

      log.audit(T + ' 6 - JE LINES', JSON.stringify(jeLines, null, 1));
      log.audit(T + ' 6 - JE TOTALS', {
        fromCashback: onCashback, fromOtherDeposits: onOther, lines: jeLines.length,
        totalDebit: dr.toFixed(2), totalCredit: cr.toFixed(2), balanced: (dr.toFixed(2) === cr.toFixed(2)),
        customerNotFound: missing, paypalSkipped: paypalSkipped
      });

      /* ================= 7) CREATE JE + LINK BACK ================= */
      if (!jeLines.length) { log.audit(T + ' 7 - NOTHING TO POST', 'Every dispute was PayPal or excluded - no JE needed.'); return; }
      if (missing) { log.error(T + ' 7 - NOT CREATING JE', missing + ' dispute(s) have no customer. Fix the order PO #, then edit the deposit to re-run.'); return; }
      if (dr.toFixed(2) !== cr.toFixed(2)) { log.error(T + ' 7 - NOT CREATING JE', 'Out of balance ' + dr.toFixed(2) + ' vs ' + cr.toFixed(2)); return; }
      if (DRY_RUN) { log.audit(T + ' 7 - DRY RUN', 'DRY_RUN is on - no JE created.'); return; }

      var je = record.create({ type: record.Type.JOURNAL_ENTRY, isDynamic: false });
      je.setValue({ fieldId: 'subsidiary', value: dep.getValue({ fieldId: 'subsidiary' }) });
      je.setValue({ fieldId: 'trandate',   value: dep.getValue({ fieldId: 'trandate' }) });
      je.setValue({ fieldId: 'externalid', value: 'SHP_DISPUTE_JE_' + payoutId + '_' + depositId });
      je.setValue({ fieldId: 'memo',       value: 'Shopify chargeback reclass - payout ' + payoutId + ' - deposit ' + dep.getValue({ fieldId: 'tranid' }) });

      for (var z = 0; z < jeLines.length; z++) {
        je.setSublistValue({ sublistId: 'line', fieldId: 'account', line: z, value: jeLines[z].account });
        if (jeLines[z].debit)  je.setSublistValue({ sublistId: 'line', fieldId: 'debit',  line: z, value: jeLines[z].debit });
        if (jeLines[z].credit) je.setSublistValue({ sublistId: 'line', fieldId: 'credit', line: z, value: jeLines[z].credit });
        if (jeLines[z].entity) je.setSublistValue({ sublistId: 'line', fieldId: 'entity', line: z, value: jeLines[z].entity });
        if (jeLines[z].department) je.setSublistValue({ sublistId: 'line', fieldId: 'department', line: z, value: jeLines[z].department });
        je.setSublistValue({ sublistId: 'line', fieldId: 'memo', line: z, value: jeLines[z].memo });
      }

      var jeId = je.save({ ignoreMandatoryFields: true });
      log.audit(T + ' 7 - JE CREATED', { jeId: jeId, payoutId: payoutId, depositId: depositId, lines: jeLines.length, amount: dr.toFixed(2) });

      record.submitFields({
        type: record.Type.DEPOSIT,
        id: depositId,
        values: (function () { var v = {}; v[RELATED_JE_FIELD] = jeId; return v; })(),
        options: { enableSourcing: false, ignoreMandatoryFields: true }
      });
      log.audit(T + ' 8 - LINKED', 'Deposit ' + depositId + ' -> ' + RELATED_JE_FIELD + ' = ' + jeId);

    } catch (e) {
      log.error(T + ' - FAILED', { name: e.name, message: e.message, stack: e.stack });
    }
  }

  return { afterSubmit: afterSubmit };
});