/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/search', 'N/log'], function (record, search, log) {

  var DISCOUNT_ITEM_ID = 911; // internal id of discount item

  function afterSubmit(context) {
    try {
      if (context.type === context.UserEventType.DELETE) return;

      var soId = context.newRecord.id;
      if (!soId) return;

      
      var headerDiscountItemFast = context.newRecord.getValue({ fieldId: 'discountitem' });
      if (!headerDiscountItemFast) {
        log.debug('Skipped - header discountitem is empty', {
         soId: soId,
         eventType: context.type
        });
        return; // discountitem empty -> exit early
      }

      // Load Sales Order only if header discount item exists
      var soRec = record.load({
        type: record.Type.SALES_ORDER,
        id: soId,
        isDynamic: false
      });

      // (Optional safety) check again after load
      var headerDiscountItem = soRec.getValue({ fieldId: 'discountitem' });
      if (!headerDiscountItem) return;
      if (String(headerDiscountItem) === '911') {
  soRec.setValue({ fieldId: 'discountitem', value: '' });
  soRec.setValue({ fieldId: 'custbody_discount_removed', value: true });
  soRec.save({ enableSourcing: true, ignoreMandatoryFields: true });
  return;
}

      // Build map: sublist "line" field value => 0-based line index
      var lineIdToIndex = {};
      var itemLineCount = soRec.getLineCount({ sublistId: 'item' });

      var i;
      for (i = 0; i < itemLineCount; i++) {
        var lineFieldVal = soRec.getSublistValue({
          sublistId: 'item',
          fieldId: 'line',
          line: i
        });
        if (lineFieldVal !== null && lineFieldVal !== '' && lineFieldVal !== undefined) {
          lineIdToIndex[String(lineFieldVal)] = i;
        }
      }

      // Run the search to get {lineId, discountAmount}
      var discountRows = getDiscountRowsFromSearch(soId);
      if (!discountRows || discountRows.length === 0) {
        log.debug('No discount rows from search, leaving header discount as-is', soId);
        return;
      }

      // Add baseIndex + sort bottom-to-top
      for (i = 0; i < discountRows.length; i++) {
        var lid = discountRows[i].lineId;
        var idx = lineIdToIndex[String(lid)];
        discountRows[i].baseIndex = (idx === null || idx === undefined) ? null : idx;
      }

      discountRows.sort(function (a, b) {
        if (a.baseIndex === null && b.baseIndex === null) return 0;
        if (a.baseIndex === null) return 1;
        if (b.baseIndex === null) return -1;
        return b.baseIndex - a.baseIndex;
      });

      // Insert discount lines
      var inserted = 0;

      for (i = 0; i < discountRows.length; i++) {
        var row = discountRows[i];
        if (row.baseIndex === null || row.baseIndex === undefined) continue;

        var discAmt = parseFloat(row.discountAmount) || 0;
        if (discAmt === 0) continue;

        var insertAt = row.baseIndex + 1;

        var currentCount = soRec.getLineCount({ sublistId: 'item' });
        if (insertAt > currentCount) insertAt = currentCount;

        soRec.insertLine({ sublistId: 'item', line: insertAt });

        soRec.setSublistValue({
          sublistId: 'item',
          fieldId: 'item',
          line: insertAt,
          value: DISCOUNT_ITEM_ID
        });

        try {
          soRec.setSublistValue({
            sublistId: 'item',
            fieldId: 'quantity',
            line: insertAt,
            value: 1
          });
        } catch (eQty) {}

        try {
          soRec.setSublistValue({
            sublistId: 'item',
            fieldId: 'price',
            line: insertAt,
            value: -1 // Custom
          });
        } catch (ePrice) {}

        var negRate = 0 - Math.abs(discAmt);

        soRec.setSublistValue({
          sublistId: 'item',
          fieldId: 'rate',
          line: insertAt,
          value: negRate
        });

        soRec.setSublistValue({
          sublistId: 'item',
          fieldId: 'custcol_discount_code',
          line: insertAt,
          value: 'Discount'
        });        

        inserted++;
      }

      if (inserted === 0) {
        log.debug('No discount lines inserted, leaving header discount as-is', soId);
        return;
      }

      // Clear header discount fields
      soRec.setValue({ fieldId: 'discountitem', value: '' });
      try {
        soRec.setValue({ fieldId: 'discountrate', value: '' });
      } catch (eDr) {
        try { soRec.setValue({ fieldId: 'discountrate', value: null }); } catch (_) {}
      }

      var savedId = soRec.save({ enableSourcing: true, ignoreMandatoryFields: true });

      log.audit('Moved header discount to line-level discount items', {
        soId: soId,
        inserted: inserted,
        savedId: savedId
      });

    } catch (e) {
      log.error('AfterSubmit Error', e);
    }
  }

  function getDiscountRowsFromSearch(soInternalId) {
    var out = [];

    try {
      var sObj = search.create({
        type: "salesorder",
        settings: [{ name: "consolidationtype", value: "ACCTTYPE" }],
        filters: [
          ["type", "anyof", "SalesOrd"],
          "AND",
          ["internalidnumber", "equalto", String(soInternalId)],
          "AND",
          ["mainline", "is", "F"],
          "AND",
          ["taxline", "is", "F"],
          "AND",
          ["cogs", "is", "F"],
          "AND",
          ["item", "noneof", String(DISCOUNT_ITEM_ID)]
        ],
        columns: [
          search.createColumn({ name: "discountamount" }),
          search.createColumn({ name: "line" })
        ]
      });

      sObj.run().each(function (r) {
        out.push({
          lineId: r.getValue({ name: 'line' }),
          discountAmount: parseFloat(r.getValue({ name: 'discountamount' })) || 0
        });
        return true;
      });

    } catch (e) {
      log.error('getDiscountRowsFromSearch error', e);
    }

    return out;
  }

  return { afterSubmit: afterSubmit };
});
