/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/search','N/record','N/log'], function(search, record, log) {

  // ==== CONFIG ====
  var CLEARING_ACCOUNT_ID = 659;  // keep same as your search
  var DES_ACCOUNT_ID      = 664; 
  var FEE_ACCOUNT_ID      = 801; // <-- CHANGE: fee account internal id
  var SUBLIST_ID          = 'cashback';
  var DISPUTE_MEMO_TEXT   = 'Disputes amount'; // the cashback line memo
  // ================

  function afterSubmit(context) {
    try {
      if (context.type !== context.UserEventType.CREATE && context.type !== context.UserEventType.EDIT) return;

      var depositId = context.newRecord.id;
      if (!depositId) return;

      // 1) Run your same search and get fee amount
      var feeAmt = getFeeAmountFromSearch(depositId);
      if (feeAmt <= 0) {
        log.debug('Dispute Split', 'No fee found from search. depositId=' + depositId);
        return;
      }

      // 2) Load deposit
      var depRec = record.load({
        type: record.Type.DEPOSIT,
        id: depositId,
        isDynamic: false
      });

      // 3) Stop if fee line already exists (avoid splitting twice)
      if (feeLineExists(depRec, SUBLIST_ID, feeAmt)) {
        log.debug('Dispute Split', 'Fee line already exists. Skipping. depositId=' + depositId);
        return;
      }

      // 4) Find cashback line by memo "Disputes Amount"
      var lineCount = depRec.getLineCount({ sublistId: SUBLIST_ID }) || 0;
      if (!lineCount) return;

      var disputeLine = -1;
      for (var i = 0; i < lineCount; i++) {
        var memo = depRec.getSublistValue({ sublistId: SUBLIST_ID, fieldId: 'memo', line: i }) || '';
        memo = String(memo).trim();

        // if you want contains instead, change to: memo.indexOf(DISPUTE_MEMO_TEXT) !== -1
        if (memo.indexOf(DISPUTE_MEMO_TEXT) === 0) {
          disputeLine = i;
          break;
        }
      }

      if (disputeLine === -1) {
        log.debug('Dispute Split', 'No cashback line with memo "' + DISPUTE_MEMO_TEXT + '". depositId=' + depositId);
        return;
      }

      var origAmt = toNumber(depRec.getSublistValue({ sublistId: SUBLIST_ID, fieldId: 'amount', line: disputeLine }));
      var department = depRec.getSublistValue({ sublistId: SUBLIST_ID, fieldId: 'department', line: disputeLine });

      if (origAmt <= 0) return;

      if (feeAmt > origAmt) {
        log.debug('Dispute Split', 'Fee > original amount. depositId=' + depositId + ' fee=' + feeAmt + ' orig=' + origAmt);
        return;
      }

      // 5) Update original line amount = orig - fee
      var newAmt = round2(origAmt - feeAmt);
      depRec.setSublistValue({
        sublistId: SUBLIST_ID,
        fieldId: 'account',
        line: disputeLine,
        value: DES_ACCOUNT_ID
      });
      depRec.setSublistValue({
        sublistId: SUBLIST_ID,
        fieldId: 'amount',
        line: disputeLine,
        value: newAmt
      });

      // 6) Insert new fee line
      depRec.insertLine({ sublistId: SUBLIST_ID, line: disputeLine + 1 });

      depRec.setSublistValue({ sublistId: SUBLIST_ID, fieldId: 'account', line: disputeLine + 1, value: FEE_ACCOUNT_ID });
      depRec.setSublistValue({ sublistId: SUBLIST_ID, fieldId: 'amount',  line: disputeLine + 1, value: round2(feeAmt) });
      depRec.setSublistValue({ sublistId: SUBLIST_ID, fieldId: 'memo',    line: disputeLine + 1, value: 'Dispute Fee' });
      depRec.setSublistValue({ sublistId: SUBLIST_ID, fieldId: 'department',    line: disputeLine + 1, value: department});


      var savedId = depRec.save({ enableSourcing: false, ignoreMandatoryFields: true });
      log.audit('Dispute Split', 'Saved deposit=' + savedId + ' orig=' + origAmt + ' fee=' + feeAmt + ' new=' + newAmt);

    } catch (e) {
      log.error('afterSubmit error', e);
    }
  }

  function getFeeAmountFromSearch(depositId) {
    var feeAmt = 0;

    var depositSearchObj = search.create({
      type: "deposit",
      settings:[{"name":"consolidationtype","value":"ACCTTYPE"}],
      filters:
      [
        ["type","anyof","Deposit"],
        "AND",
        ["internalidnumber","equalto", String(depositId)],  // only dynamic piece
        "AND",
        ["account","anyof", String(CLEARING_ACCOUNT_ID)],
        "AND",
        ["memo","startswith","Dispute"],
        "AND",
        ["custbody_celigo_shopify_ns_payout_id.custrecord_celigo_shpf_adj_fee_amount","isnotempty",""]
      ],
      columns:
      [
        search.createColumn({
          name: "custrecord_celigo_shpf_adj_fee_amount",
          join: "CUSTBODY_CELIGO_SHOPIFY_NS_PAYOUT_ID"
        })
      ]
    });

    depositSearchObj.run().each(function(result){
      feeAmt = toNumber(result.getValue({
        name: "custrecord_celigo_shpf_adj_fee_amount",
        join: "CUSTBODY_CELIGO_SHOPIFY_NS_PAYOUT_ID"
      }));
      return false; // first one is enough
    });

    return feeAmt;
  }

  function feeLineExists(depRec, sublistId, feeAmt) {
    var cnt = depRec.getLineCount({ sublistId: sublistId }) || 0;
    for (var i = 0; i < cnt; i++) {
      var acct = depRec.getSublistValue({ sublistId: sublistId, fieldId: 'account', line: i });
      if (String(acct) !== String(FEE_ACCOUNT_ID)) continue;

      var amt = toNumber(depRec.getSublistValue({ sublistId: sublistId, fieldId: 'amount', line: i }));
      if (round2(amt) === round2(feeAmt)) return true;
    }
    return false;
  }

  function toNumber(v) {
    if (v === null || v === '' || typeof v === 'undefined') return 0;
    var n = Number(String(v).replace(/,/g, ''));
    return isNaN(n) ? 0 : n;
  }

  function round2(n) {
    n = toNumber(n);
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  return { afterSubmit: afterSubmit };

});
