/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Sales Order – push discounts down to line-level discount items.
 *
 * Path A (unchanged): header Discount Item is set -> move it to line-level discount
 *         lines using the search "discountamount" per line, then clear the header.
 * Path B (NEW): header Discount Item is empty but Shopify sent an ORDER-LEVEL discount
 *         (custbody_discount_application entry with target_selection = "all").
 *         Celigo does not create a header or line discount for these, so the order
 *         lands at full price (eTail Discount Total Variance <> 0).
 *         -> compute the discount per line from the application JSON and insert
 *            discount lines under each eligible line.
 */
define(['N/record', 'N/search', 'N/log'], function (record, search, log) {

  var DISCOUNT_ITEM_ID = 911;                 // discount item used for line-level discounts
  var EXCLUDED_ITEMS = ['504', '906', '911'];  // non-merch / discount / shipping items
  var UPDATE_ETAIL_VARIANCE = true;            // re-calc Celigo eTail variance fields after Path B

  // SO statuses where we must NOT add lines (already billed / closed)
  var BLOCKED_STATUSES = ['fullyBilled', 'closed', 'cancelled'];

  function afterSubmit(context) {
    try {
      if (context.type !== context.UserEventType.CREATE &&
          context.type !== context.UserEventType.EDIT) return;

      var soId = context.newRecord.id;
      if (!soId) return;

      var nr = context.newRecord;
      var headerDiscountItemFast = nr.getValue({ fieldId: 'discountitem' });
      var discAppRaw = nr.getValue({ fieldId: 'custbody_discount_application' });

      if (headerDiscountItemFast) {
        moveHeaderDiscountToLines(soId);
        return;
      }

      // ---- Path B: order-level ("all") Shopify discount with no header discount ----
      var orderLevelApps = getOrderLevelApplications(discAppRaw);
      if (orderLevelApps.length === 0) {
        log.debug('Skipped - no header discount and no order-level discount application', soId);
        return;
      }

      applyOrderLevelDiscounts(soId, orderLevelApps);

    } catch (e) {
      log.error('AfterSubmit Error', e);
    }
  }

  // ===================================================================================
  // PATH A – original logic (header discount -> line discounts)
  // ===================================================================================
  function moveHeaderDiscountToLines(soId) {
    var soRec = record.load({ type: record.Type.SALES_ORDER, id: soId, isDynamic: false });

    if (!soRec.getValue({ fieldId: 'discountitem' })) return;

    var lineIdToIndex = buildLineIdToIndex(soRec);

    var discountRows = getDiscountRowsFromSearch(soId);
    if (!discountRows || discountRows.length === 0) {
      log.debug('No discount rows from search, leaving header discount as-is', soId);
      return;
    }

    for (var i = 0; i < discountRows.length; i++) {
      var idx = lineIdToIndex[String(discountRows[i].lineId)];
      discountRows[i].baseIndex = (idx === null || idx === undefined) ? null : idx;
    }

    var inserted = insertDiscountLines(soRec, discountRows);

    if (inserted.count === 0) {
      log.debug('No discount lines inserted, leaving header discount as-is', soId);
      return;
    }

    soRec.setValue({ fieldId: 'discountitem', value: '' });
    try {
      soRec.setValue({ fieldId: 'discountrate', value: '' });
    } catch (eDr) {
      try { soRec.setValue({ fieldId: 'discountrate', value: null }); } catch (_) {}
    }

    var savedId = soRec.save({ enableSourcing: true, ignoreMandatoryFields: true });
    log.audit('Moved header discount to line-level discount items', {
      soId: soId, inserted: inserted.count, total: inserted.total, savedId: savedId
    });
  }

  // ===================================================================================
  // PATH B – order-level Shopify discounts (target_selection = "all")
  // ===================================================================================
  function applyOrderLevelDiscounts(soId, orderLevelApps) {
    var soRec = record.load({ type: record.Type.SALES_ORDER, id: soId, isDynamic: false });

    var status = soRec.getValue({ fieldId: 'statusRef' });
    if (BLOCKED_STATUSES.indexOf(status) !== -1) {
      log.audit('Skipped order-level discount - SO already billed/closed', { soId: soId, status: status });
      return;
    }

    var lineCount = soRec.getLineCount({ sublistId: 'item' });

    // Collect eligible (priced, Shopify, non-discounted) lines
    var candidates = [];
    for (var i = 0; i < lineCount; i++) {
      var itemId = String(soRec.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i }));
      if (EXCLUDED_ITEMS.indexOf(itemId) !== -1) continue;

      var itemType = soRec.getSublistValue({ sublistId: 'item', fieldId: 'itemtype', line: i });
      if (itemType === 'Discount' || itemType === 'Subtotal' || itemType === 'Description' ||
          itemType === 'Markup' || itemType === 'EndGroup') continue;

      var shopifyLineId = soRec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_celigo_etail_order_line_id', line: i });
      if (!shopifyLineId) continue;

      var amount = parseFloat(soRec.getSublistValue({ sublistId: 'item', fieldId: 'amount', line: i })) || 0;
      if (amount <= 0) continue; // e.g. $0 bundle parent

      // Idempotency: already has a discount line directly below it
      if (i + 1 < lineCount) {
        var nextItem = String(soRec.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i + 1 }));
        if (nextItem === String(DISCOUNT_ITEM_ID)) continue;
      }

      candidates.push({
        baseIndex: i,
        amount: amount,
        qty: parseFloat(soRec.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i })) || 1,
        discIdx: parseIndexList(soRec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_discount_index', line: i }))
      });
    }

    if (candidates.length === 0) {
      log.debug('Order-level discount: no eligible lines', soId);
      return;
    }

    // line baseIndex -> accumulated discount
    var perLine = {};

    orderLevelApps.forEach(function (app) {
      // Lines that point at this application via custcol_discount_index.
      // If no line carries the index, the discount applies to every eligible line.
      var targets = candidates.filter(function (c) { return c.discIdx.indexOf(app.index) !== -1; });
      if (targets.length === 0) targets = candidates.slice();

      var value = parseFloat(app.value) || 0;
      if (value <= 0) return;

      if (app.value_type === 'percentage') {
        targets.forEach(function (c) {
          addDisc(perLine, c, round2(c.amount * value / 100));
        });

      } else if (app.value_type === 'fixed_amount' && app.allocation_method === 'each') {
        targets.forEach(function (c) {
          addDisc(perLine, c, round2(value * c.qty));
        });

      } else if (app.value_type === 'fixed_amount') {
        // "across": prorate the fixed amount by line amount, remainder on last line
        var base = targets.reduce(function (s, c) { return s + c.amount; }, 0);
        var total = Math.min(value, base);
        var running = 0;
        targets.forEach(function (c, k) {
          var share = (k === targets.length - 1)
            ? round2(total - running)
            : round2(total * c.amount / base);
          running = round2(running + share);
          addDisc(perLine, c, share);
        });
      }
    });

    var rows = [];
    candidates.forEach(function (c) {
      var d = perLine[c.baseIndex];
      if (!d) return;
      rows.push({ baseIndex: c.baseIndex, discountAmount: Math.min(d, c.amount) }); // never exceed the line
    });

    var inserted = insertDiscountLines(soRec, rows);
    if (inserted.count === 0) {
      log.debug('Order-level discount: nothing inserted', soId);
      return;
    }

    if (UPDATE_ETAIL_VARIANCE) {
      // Celigo: disc var = NS discount - Shopify discount; order var = NS total - Shopify total
      var discVar = parseFloat(soRec.getValue({ fieldId: 'custbody_celigo_etail_disc_total_var' })) || 0;
      var ordVar = parseFloat(soRec.getValue({ fieldId: 'custbody_celigo_etail_order_total_var' })) || 0;
      soRec.setValue({ fieldId: 'custbody_celigo_etail_disc_total_var', value: round2(discVar + inserted.total) });
      soRec.setValue({ fieldId: 'custbody_celigo_etail_order_total_var', value: round2(ordVar - inserted.total) });
    }

    var savedId = soRec.save({ enableSourcing: true, ignoreMandatoryFields: true });
    log.audit('Applied order-level (target_selection=all) discount as line discounts', {
      soId: soId,
      apps: orderLevelApps.map(function (a) { return a.title + ' ' + a.value + ' ' + a.value_type; }),
      inserted: inserted.count,
      total: inserted.total,
      savedId: savedId
    });
  }

  // ===================================================================================
  // Shared helpers
  // ===================================================================================

  /** Inserts discount lines bottom-to-top so indexes stay valid. Returns {count,total}. */
  function insertDiscountLines(soRec, rows) {
    rows.sort(function (a, b) {
      if (a.baseIndex === null && b.baseIndex === null) return 0;
      if (a.baseIndex === null) return 1;
      if (b.baseIndex === null) return -1;
      return b.baseIndex - a.baseIndex;
    });

    var count = 0, total = 0;

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.baseIndex === null || row.baseIndex === undefined) continue;

      var discAmt = Math.abs(parseFloat(row.discountAmount) || 0);
      if (discAmt === 0) continue;

      var insertAt = row.baseIndex + 1;
      var currentCount = soRec.getLineCount({ sublistId: 'item' });
      if (insertAt > currentCount) insertAt = currentCount;

      soRec.insertLine({ sublistId: 'item', line: insertAt });
      soRec.setSublistValue({ sublistId: 'item', fieldId: 'item', line: insertAt, value: DISCOUNT_ITEM_ID });
      try { soRec.setSublistValue({ sublistId: 'item', fieldId: 'quantity', line: insertAt, value: 1 }); } catch (eQty) {}
      try { soRec.setSublistValue({ sublistId: 'item', fieldId: 'price', line: insertAt, value: -1 }); } catch (ePrice) {}
      soRec.setSublistValue({ sublistId: 'item', fieldId: 'rate', line: insertAt, value: -discAmt });
      soRec.setSublistValue({ sublistId: 'item', fieldId: 'custcol_discount_code', line: insertAt, value: 'Discount' });

      count++;
      total = round2(total + discAmt);
    }

    return { count: count, total: total };
  }

  function buildLineIdToIndex(soRec) {
    var map = {};
    var n = soRec.getLineCount({ sublistId: 'item' });
    for (var i = 0; i < n; i++) {
      var v = soRec.getSublistValue({ sublistId: 'item', fieldId: 'line', line: i });
      if (v !== null && v !== '' && v !== undefined) map[String(v)] = i;
    }
    return map;
  }

  /** Returns [{index, value, value_type, allocation_method, title}] for target_selection = "all". */
  function getOrderLevelApplications(raw) {
    if (!raw) return [];
    var apps;
    try {
      apps = JSON.parse(decodeHtml(String(raw)));
    } catch (e) {
      log.error('Could not parse custbody_discount_application', String(raw).slice(0, 300));
      return [];
    }
    if (!Array.isArray(apps)) return [];

    var out = [];
    apps.forEach(function (a, idx) {
      if (a && a.target_type === 'line_item' && a.target_selection === 'all') {
        out.push({
          index: idx,
          value: a.value,
          value_type: a.value_type,
          allocation_method: a.allocation_method,
          title: a.code || a.title || ''
        });
      }
    });
    return out;
  }

  function parseIndexList(v) {
    if (v === null || v === undefined || v === '') return [];
    return String(v).split(/[,\s|]+/).filter(function (s) { return s !== ''; })
      .map(function (s) { return parseInt(s, 10); })
      .filter(function (n) { return !isNaN(n); });
  }

  function addDisc(map, c, amt) {
    if (!amt) return;
    map[c.baseIndex] = round2((map[c.baseIndex] || 0) + amt);
  }

  function decodeHtml(s) {
    return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }

  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  function getDiscountRowsFromSearch(soInternalId) {
    var out = [];
    try {
      search.create({
        type: 'salesorder',
        settings: [{ name: 'consolidationtype', value: 'ACCTTYPE' }],
        filters: [
          ['type', 'anyof', 'SalesOrd'], 'AND',
          ['internalidnumber', 'equalto', String(soInternalId)], 'AND',
          ['mainline', 'is', 'F'], 'AND',
          ['taxline', 'is', 'F'], 'AND',
          ['cogs', 'is', 'F'], 'AND',
          ['item', 'noneof', EXCLUDED_ITEMS]
        ],
        columns: [
          search.createColumn({ name: 'discountamount' }),
          search.createColumn({ name: 'line' })
        ]
      }).run().each(function (r) {
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