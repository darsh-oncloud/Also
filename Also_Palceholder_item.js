/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record','N/log','N/https','N/search'], (record, log, https, search) => {

  // ===== CONFIG (hard-coded) =====
  const PLACEHOLDER_ITEM_ID = 907;                         // placeholder
  const REPLACEMENT_ITEM_ID = 908;                         // merchandise item when category matches
  const SKU_FIELD_ID        = 'custcol_shopify_sku';       // line-level SKU
  const ORDER_ID_FIELD      = 'custbody_celigo_etail_order_id'; // Shopify order id or name (e.g., 1234567890 or #1001)

  // Discount fields
  const DISCOUNT_APP_FIELD   = 'custbody_discount_application'; // header (HTML-escaped JSON string)
  const DISCOUNT_INDEX_FIELD = 'custcol_discount_index';        // line index into header array
  const DISCOUNT_CODE_FIELD  = 'custcol_discount_code';         // line store discount code
  const PROMO_DISCOUNT_ITEM_ID = 911;   // Promotional Discount item internalid
  
  const SHOPIFY_TOKEN       = 'KEEP_YOUR_EXISTING_TOKEN_HERE';
  const SHOPIFY_DOMAIN      = 'ride-also.myshopify.com';
  const SHOPIFY_API_VERSION = '2025-10';
  // ===============================

  function beforeSubmit(ctx) {
    if (
      ctx.type !== ctx.UserEventType.CREATE &&
      ctx.type !== ctx.UserEventType.EDIT
    ) return;

    try {
      const so = ctx.newRecord;

      if (so.type !== record.Type.SALES_ORDER && so.type !== 'salesorder') {
        return;
      }

      const duplicateLineFixCount = fixDuplicateInventoryToNonInventoryLines(so);

      log.audit('BEFORE SUBMIT Inventory -> NonInventory Fix Summary', {
        eventType: ctx.type,
        soId: so.id || '',
        duplicateLineFixCount: duplicateLineFixCount
      });

    } catch (e) {
      log.error('beforeSubmit Inventory -> NonInventory Fix Error', e.message || e.toString());
    }
  }

  function afterSubmit(ctx) {
    if (
      ctx.type !== ctx.UserEventType.CREATE &&
      ctx.type !== ctx.UserEventType.EDIT &&
      ctx.type !== ctx.UserEventType.XEDIT
    ) return;

    try {
      const so = record.load({ type: record.Type.SALES_ORDER, id: ctx.newRecord.id, isDynamic: false });

      let discountUpdated = false;

      // =========================================================
      //  DISCOUNT CODE LOGIC (CREATE ONLY) + LOGS
      // - Handles HTML-escaped JSON (&quot;)
      // - If only 1 discount object, apply that code to any line that has an index value
      // =========================================================
      if (ctx.type === ctx.UserEventType.CREATE || ctx.type === ctx.UserEventType.EDIT) {
        try {
          const raw = so.getValue(DISCOUNT_APP_FIELD);
          const decoded = decodeHtmlEntities(raw);

          log.audit('Discount Raw', {
            soId: so.id,
            type: typeof raw,
            len: String(raw || '').length,
            rawHead: String(raw || '').substring(0, 140),
            rawTail: String(raw || '').slice(-140)
          });

          log.audit('Discount Decoded', {
            soId: so.id,
            len: String(decoded || '').length,
            decodedHead: String(decoded || '').substring(0, 140),
            decodedTail: String(decoded || '').slice(-140)
          });

          const discApps = parseHeaderDiscountApps(decoded);

          log.audit('Discount Parsed Result', {
            soId: so.id,
            count: discApps.length,
            codes: discApps.slice(0, 10).map(function(o){ return o && o.code ? o.code : ''; })
          });

          if (discApps && discApps.length >= 1) {
            const lcDisc = so.getLineCount({ sublistId: 'item' });

            for (let i = 0; i < lcDisc; i++) {
              const idxRaw = so.getSublistValue({
                sublistId: 'item',
                fieldId: DISCOUNT_INDEX_FIELD,
                line: i
              });

              // Only act if line has an index value (your requirement)
              if (idxRaw === null || idxRaw === '' || idxRaw === undefined) continue;

              const idx = toNum(idxRaw);

              // If only one discount exists, always use it (ignore index mismatch)
              let obj = null;
              if (discApps.length === 1) {
                obj = discApps[0];
              } else {
                obj = discApps[idx] || null;        // 0-based
                if (!obj && idx > 0) obj = discApps[idx - 1] || null; // 1-based fallback
              }

              if (!obj) {
                log.debug('Discount Index Not Found', { line: i, idxRaw, idx, discAppsLen: discApps.length });
                continue;
              }

              const code = extractDiscountCode(obj);

              const normalizedCode = normalizeDiscountCode(code);

              log.debug('Discount Resolve', {
                line: i,
                idxRaw,
                idx,
                code,
                normalizedCode,
                objSample: JSON.stringify(obj).substring(0, 220)
              });

              if (!code) continue;

              // Optional: don't overwrite if already set
              const existing = so.getSublistValue({
                sublistId: 'item',
                fieldId: DISCOUNT_CODE_FIELD,
                line: i
              });
              if (existing && String(existing).trim()) continue;

              so.setSublistValue({
                sublistId: 'item',
                fieldId: DISCOUNT_CODE_FIELD,
                line: i,
                value: normalizedCode
              });

              discountUpdated = true;
            }
          } else {
            log.audit('Discount Skip', { soId: so.id, reason: 'No discount apps found after parse', length: discApps.length });
          }
        } catch (eDisc) {
          log.error('Discount Code Populate Error', eDisc.message || eDisc.toString());
        }
      }

      //  NEW: after JSON-based population, fill any remaining blank codes (only where index exists)
      const fallbackUpdated = fillMissingDiscountCodes(so);
      if (fallbackUpdated) discountUpdated = true;

      //  NEW: duplicate inventory/non-inventory fix
      const duplicateLineFixCount = fixDuplicateInventoryToNonInventoryLines(so);

      // -------------------------
      // Shopify placeholder logic
      // -------------------------
      const lc = so.getLineCount({ sublistId:'item' });
      let hasPH = false;
      for (let i = 0; i < lc && !hasPH; i++) {
        if (toNum(so.getSublistValue({ sublistId:'item', fieldId:'item', line:i })) === PLACEHOLDER_ITEM_ID) hasPH = true;
      }

     /* if (!hasPH) {
        log.audit('Skip Shopify', { soId: so.id, reason: 'No placeholder lines', discountUpdated });
        if (discountUpdated) {
          try { so.save({ ignoreMandatoryFields: true }); } catch (eSave0) { log.error('Save Error', eSave0); }
        }
        return;
      }*/
      if (!hasPH) {

        //  NEW: push code to all consecutive promo discount lines even if no placeholder exists
        const promoUpdated = pushCodeToAllPromoDiscountLines(so);

        log.audit('Skip Shopify', {
          soId: so.id,
          reason: 'No placeholder lines',
          discountUpdated,
          promoUpdated,
          duplicateLineFixCount
        });

        //  Save if either header discount logic updated OR promo push updated
        if (discountUpdated || promoUpdated || duplicateLineFixCount > 0) {
          try {
            so.save({ ignoreMandatoryFields: true });
          } catch (eSave0) {
            log.error('Save Error', eSave0);
          }
        }

        return;
      }


      const orderIdRaw = String(so.getValue(ORDER_ID_FIELD) || '').trim();
      if (!orderIdRaw) {
        log.audit('Skip Shopify', { soId: so.id, reason: 'Missing ORDER_ID_FIELD', discountUpdated, duplicateLineFixCount });
        if (discountUpdated || duplicateLineFixCount > 0) {
          try { so.save({ ignoreMandatoryFields: true }); } catch (eSave1) { log.error('Save Error', eSave1); }
        }
        return;
      }

      log.audit('Start', { soId: so.id, orderIdRaw, discountUpdated, duplicateLineFixCount });

      const skuToPid = fetchOrderSkuToProductMap(orderIdRaw);
      if (!skuToPid) {
        log.audit('Skip Shopify', { soId: so.id, reason: 'Failed to fetch skuToPid', discountUpdated, duplicateLineFixCount });
        if (discountUpdated || duplicateLineFixCount > 0) {
          try { so.save({ ignoreMandatoryFields: true }); } catch (eSave2) { log.error('Save Error', eSave2); }
        }
        return;
      }

      let replaced = 0;
      const catCache = Object.create(null);
      const dupSkuCache = Object.create(null);

      for (let i = 0; i < lc; i++) {
        const itemId = toNum(so.getSublistValue({ sublistId:'item', fieldId:'item', line:i }));
        if (itemId !== PLACEHOLDER_ITEM_ID) continue;

        const sku = toStr(so.getSublistValue({ sublistId:'item', fieldId: SKU_FIELD_ID, line:i })).trim();
        if (!sku) continue;

        let nonInvItemId = dupSkuCache[sku];
        if (nonInvItemId == null) {
          nonInvItemId = getNonInvItemIdIfDuplicateName(sku);
          dupSkuCache[sku] = nonInvItemId;
        }

        if (nonInvItemId) {
          log.audit('Duplicate SKU -> NonInv Swap', { line: i, sku, nonInvItemId });
          const snap = snapshotLine(so, i);
          so.setSublistValue({ sublistId:'item', fieldId:'item', line:i, value: nonInvItemId });
          restoreLine(so, i, snap);
          replaced++;
          continue;
        }

        let productId = skuToPid[sku] || 0;
        if (!productId) productId = resolveProductIdByVariantSKU(sku);
        if (!productId) continue;

        let category = catCache[productId];
        if (!category) {
          category = fetchProductCategoryGQL(productId);
          if (!category) category = fetchProductCategoryREST(productId);
          catCache[productId] = category || '';
        }

        const match = isApparelAndAccessories(category);
        log.audit('Decision', { line: i, sku, productId, category, decision: match ? 'MATCH' : 'NO MATCH' });

        if (!match) continue;

        const snap = snapshotLine(so, i);
        so.setSublistValue({ sublistId:'item', fieldId:'item', line:i, value: REPLACEMENT_ITEM_ID });
        restoreLine(so, i, snap);
        replaced++;
      }

      // Save at end (covers discount code updates + item swaps)
     /* if (replaced > 0 || discountUpdated) {
        try {
          so.save({ ignoreMandatoryFields: true });
        } catch (eSave) {
          log.error('Save Error', eSave.message || eSave.toString());
        }
      } */

      //  After everything is done, push code to ALL consecutive promo discount lines
      const promoUpdated = pushCodeToAllPromoDiscountLines(so);

      // Save at end (covers discount code updates + item swaps + promo discount push)
      if (replaced > 0 || discountUpdated || promoUpdated || duplicateLineFixCount > 0) {
        try {
          so.save({ ignoreMandatoryFields: true });
        } catch (eSave) {
          log.error('Save Error', eSave.message || eSave.toString());
        }
      }

      log.audit('Finish', { soId: so.id, replacedLines: replaced, discountUpdated, duplicateLineFixCount });

    } catch (e) {
      log.error('afterSubmit Error', e.message || e.toString());
    }
  }

  //  NEW: helper function (added only)
  function fillMissingDiscountCodes(so) {
    try {
      const lc = so.getLineCount({ sublistId: 'item' });
      if (!lc) return false;

      let changed = false;

      for (let i = 0; i < lc; i++) {
        const idxRaw = so.getSublistValue({
          sublistId: 'item',
          fieldId: DISCOUNT_INDEX_FIELD,
          line: i
        });

        // only lines that have an index
        if (idxRaw === null || idxRaw === '' || idxRaw === undefined) continue;

        const existing = toStr(so.getSublistValue({
          sublistId: 'item',
          fieldId: DISCOUNT_CODE_FIELD,
          line: i
        })).trim();

        // if still blank after JSON population, set fallback
        if (!existing) {
          so.setSublistValue({
            sublistId: 'item',
            fieldId: DISCOUNT_CODE_FIELD,
            line: i,
            value: 'Discount'
          });
          changed = true;

          log.audit('Fallback Discount Code Set', {
            soId: so.id,
            line: i,
            idxRaw: idxRaw
          });
        }
      }

      return changed;
    } catch (e) {
      log.error('fillMissingDiscountCodes Error', e.message || e.toString());
      return false;
    }
  }

  // ---------- NetSuite: if itemid=SKU returns 2 items, return Non-Inv internalid ----------
  function getNonInvItemIdIfDuplicateName(nameOrSku) {
    try {
      const s = search.create({
        type: search.Type.ITEM,
        filters: [['itemid', 'is', nameOrSku]],
        columns: [
          search.createColumn({ name: 'internalid' }),
          search.createColumn({ name: 'type' })
        ]
      });

      const paged = s.runPaged({ pageSize: 50 });
      const cnt = paged.count || 0;
      if (cnt !== 2) return 0;

      let nonInvId = 0;
      for (let pr = 0; pr < paged.pageRanges.length && !nonInvId; pr++) {
        const page = paged.fetch({ index: paged.pageRanges[pr].index });
        for (let i = 0; i < page.data.length && !nonInvId; i++) {
          const res = page.data[i];
          const typeVal = toStr(res.getValue({ name: 'type' })).toLowerCase();
          if (typeVal === 'noninvtpart' || typeVal.indexOf('noninvt') !== -1 || typeVal.indexOf('noninv') !== -1) {
            nonInvId = toNum(res.getValue({ name: 'internalid' }));
          }
        }
      }
      return nonInvId || 0;
    } catch (e) {
      log.error('getNonInvItemIdIfDuplicateName Error', e.message || e.toString());
      return 0;
    }
  }

  //  NEW: duplicate inventory/non-inventory line fix
  function fixDuplicateInventoryToNonInventoryLines(so) {
    try {
      const lc = so.getLineCount({ sublistId: 'item' });
      if (!lc) return 0;

      let changedCount = 0;
      const cache = {};

      for (let i = 0; i < lc; i++) {
        const currentItemId = toNum(so.getSublistValue({
          sublistId: 'item',
          fieldId: 'item',
          line: i
        }));
        if (!currentItemId) continue;

        const itemName = getLineItemNameOrId(so, i, currentItemId);
        if (!itemName) continue;

        let pairInfo = cache[itemName];
        if (pairInfo == null) {
          pairInfo = getInventoryNonInventoryDuplicatePair(itemName);
          cache[itemName] = pairInfo;
        }

        if (!pairInfo || !pairInfo.hasPair) continue;

        if (currentItemId === pairInfo.nonInvId) {
          continue;
        }

        if (currentItemId === pairInfo.invId && pairInfo.nonInvId) {
          const snap = snapshotLine(so, i);

          so.setSublistValue({
            sublistId: 'item',
            fieldId: 'item',
            line: i,
            value: pairInfo.nonInvId
          });

          restoreLine(so, i, snap);
          changedCount++;

          log.audit('Inventory -> NonInventory Line Fix', {
            soId: so.id,
            line: i,
            itemName: itemName,
            oldItemId: currentItemId,
            newItemId: pairInfo.nonInvId
          });
        }
      }

      return changedCount;

    } catch (e) {
      log.error('fixDuplicateInventoryToNonInventoryLines Error', e.message || e.toString());
      return 0;
    }
  }

  function getInventoryNonInventoryDuplicatePair(itemName) {
    try {
      const out = {
        hasPair: false,
        invId: 0,
        nonInvId: 0,
        count: 0
      };

      const itemSearchObj = search.create({
        type: search.Type.ITEM,
        filters: [
          ['itemid', 'is', itemName]
        ],
        columns: [
          search.createColumn({ name: 'internalid' }),
          search.createColumn({ name: 'itemid' }),
          search.createColumn({ name: 'displayname' }),
          search.createColumn({ name: 'salesdescription' }),
          search.createColumn({ name: 'type' })
        ]
      });

      const searchResultCount = itemSearchObj.runPaged({ pageSize: 50 }).count;
      out.count = searchResultCount;

      if (searchResultCount !== 2) {
        return out;
      }

      itemSearchObj.run().each(function(result) {
        const internalId = toNum(result.getValue({ name: 'internalid' }));
        const typeVal = toStr(result.getValue({ name: 'type' })).toLowerCase();

        if (typeVal === 'noninvtpart' || typeVal.indexOf('noninvt') !== -1 || typeVal.indexOf('noninv') !== -1) {
          out.nonInvId = internalId;
        } else if (typeVal === 'invtpart' || typeVal.indexOf('inventory') !== -1 || typeVal.indexOf('invt') !== -1) {
          out.invId = internalId;
        }

        return true;
      });

      if (out.invId && out.nonInvId) {
        out.hasPair = true;
      }

      return out;

    } catch (e) {
      log.error('getInventoryNonInventoryDuplicatePair Error', {
        itemName: itemName,
        error: e.message || e.toString()
      });
      return {
        hasPair: false,
        invId: 0,
        nonInvId: 0,
        count: 0
      };
    }
  }

  function getLineItemNameOrId(so, line, currentItemId) {
    try {
      let txt = '';
      try {
        txt = toStr(so.getSublistText({
          sublistId: 'item',
          fieldId: 'item',
          line: line
        })).trim();
      } catch (_e1) {}

      if (txt) {
        const fromLookup = getItemIdByInternalId(currentItemId);
        if (fromLookup) return fromLookup;
        return txt;
      }

      return getItemIdByInternalId(currentItemId);

    } catch (e) {
      log.error('getLineItemNameOrId Error', e.message || e.toString());
      return '';
    }
  }

  function getItemIdByInternalId(itemInternalId) {
    try {
      const f = search.lookupFields({
        type: search.Type.ITEM,
        id: itemInternalId,
        columns: ['itemid']
      });

      return toStr(f && f.itemid).trim();

    } catch (e) {
      log.error('getItemIdByInternalId Error', {
        itemInternalId: itemInternalId,
        error: e.message || e.toString()
      });
      return '';
    }
  }

  // ---------- Shopify: ORDER → { sku: product_id } ----------
  function fetchOrderSkuToProductMap(orderIdRaw) {
    try {
      if (/^\d+$/.test(orderIdRaw)) {
        const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/orders/${orderIdRaw}.json`;
        const res = https.get({ url, headers: headers() });
        if (res.code >= 200 && res.code < 300) {
          const order = (JSON.parse(res.body || '{}').order) || null;
          if (!order || !Array.isArray(order.line_items)) return null;
          const map = {};
          for (const li of order.line_items) {
            const sku = toStr(li && li.sku).trim();
            const pid = toNum(li && li.product_id);
            if (sku && pid) map[sku] = pid;
          }
          return map;
        }
        return null;
      } else {
        const cleanName = orderIdRaw.replace(/^#/, '');
        const url   = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
        const query = `
          query($q: String!) {
            orders(first: 1, query: $q) {
              edges {
                node {
                  id
                  name
                  lineItems(first: 250) {
                    edges { node { sku product { id } } }
                  }
                }
              }
            }
          }
        `;
        const res = https.post({ url, headers: headers(), body: JSON.stringify({ query, variables: { q: 'name:'+cleanName } }) });
        if (res.code >= 200 && res.code < 300) {
          const parsed = JSON.parse(res.body || '{}');
          const edges = (((parsed||{}).data||{}).orders||{}).edges || [];
          if (!edges.length) return null;
          const lineEdges = (((edges[0]||{}).node||{}).lineItems||{}).edges || [];
          const map = {};
          for (const e of lineEdges) {
            const sku = toStr(e && e.node && e.node.sku).trim();
            const gid = e && e.node && e.node.product && e.node.product.id;
            const pid = gidToNumeric(gid);
            if (sku && pid) map[sku] = pid;
          }
          return map;
        }
        return null;
      }
    } catch (_e) { return null; }
  }

  // ---------- Shopify: resolve product by variant SKU (GraphQL) ----------
  function resolveProductIdByVariantSKU(sku) {
    try {
      const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
      const query = `
        query($q: String!) {
          productVariants(first: 1, query: $q) {
            edges { node { id sku product { id } } }
          }
        }
      `;
      const res = https.post({ url, headers: headers(), body: JSON.stringify({ query, variables: { q: 'sku:'+escapeGQL(sku) } }) });
      if (res.code >= 200 && res.code < 300) {
        const parsed = JSON.parse(res.body || '{}');
        const edges = (((parsed||{}).data||{}).productVariants||{}).edges || [];
        if (!edges.length) return 0;
        const gid = edges[0].node && edges[0].node.product && edges[0].node.product.id;
        return gidToNumeric(gid);
      }
    } catch (_e) {}
    return 0;
  }

  // ---------- Shopify: product category (GraphQL) ----------
  function fetchProductCategoryGQL(productId) {
    const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    const gid = `gid://shopify/Product/${productId}`;
    const query = `
      query($id: ID!) {
        product(id: $id) {
          id
          title
          category { fullName name }
        }
      }
    `;
    try {
      const res = https.post({ url, headers: headers(), body: JSON.stringify({ query, variables: { id: gid } }) });
      if (res.code >= 200 && res.code < 300) {
        const parsed = JSON.parse(res.body || '{}');
        const prod = ((parsed||{}).data||{}).product || null;
        const catObj = prod && prod.category ? prod.category : null;
        if (!catObj) return '';
        return String(catObj.fullName || catObj.name || '');
      }
    } catch (_e) {}
    return '';
  }

  // ---------- Shopify: product category (REST fallback) ----------
  function fetchProductCategoryREST(productId) {
    const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/products/${productId}.json`;
    try {
      const res = https.get({ url, headers: headers() });
      if (res.code >= 200 && res.code < 300) {
        const prod = (JSON.parse(res.body || '{}').product) || null;
        const catObj = prod && prod.category ? prod.category : null;
        if (catObj && (catObj.full_name || catObj.fullName || catObj.name)) {
          return String(catObj.full_name || catObj.fullName || catObj.name || '');
        }
        if (prod && prod.product_type) return String(prod.product_type);
      }
    } catch (_e) {}
    return '';
  }

  // ---------- keep/restore line values ----------
  function snapshotLine(so, line) {
    const f = (id) => safeGet(so, line, id);
    return {
      skuFieldId: SKU_FIELD_ID,
      sku: f(SKU_FIELD_ID),
      price: f('price'),
      rate: f('rate'),
      quantity: f('quantity'),
      amount: f('amount'),
      taxcode: f('taxcode'),
      taxrate1: f('taxrate1'),
      location: f('location'),
      department: f('department'),
      class: f('class'),
      description: f('description')
    };
  }

  function restoreLine(so, line, snap) {
    const set = (id, val) => safeSet(so, line, id, val);
    if (snap.skuFieldId && snap.sku != null) set(snap.skuFieldId, snap.sku);
    if (snap.price    != null) set('price',       snap.price);
    if (snap.rate     != null) set('rate',        snap.rate);
    if (snap.quantity != null) set('quantity',    snap.quantity);
    if (snap.amount   != null) set('amount',      snap.amount);
    if (snap.taxcode  != null) set('taxcode',     snap.taxcode);
    if (snap.taxrate1 != null) set('taxrate1',    snap.taxrate1);
    if (snap.location != null) set('location',    snap.location);
    if (snap.department!=null) set('department',  snap.department);
    if (snap.class    != null) set('class',       snap.class);
    if (snap.description!=null)set('description', snap.description);
  }

  function safeGet(so, line, fieldId){ 
    try { 
      return so.getSublistValue({ sublistId:'item', fieldId, line }); 
    } catch(_e){ 
      return null; 
    } 
  }

  function safeSet(so, line, fieldId, value){ 
    try { 
      if (value!==null && value!==undefined && value!=='') {
        so.setSublistValue({ sublistId:'item', fieldId, line, value }); 
      }
    } catch(_e){} 
  }

  // ---------- Discount helpers ----------
  function parseHeaderDiscountApps(decodedStr) {
    try {
      if (!decodedStr) return [];

      // Try valid JSON
      try {
        var parsed = JSON.parse(String(decodedStr).trim());
        if (Array.isArray(parsed)) return parsed;
        if (parsed && typeof parsed === 'object') return [parsed];
      } catch (_e1) {}

      // Fallback: extract codes from text
      var s = String(decodedStr);
      var arr = [];
      var re = /"code"\s*:\s*"([^"]+)"/g;
      var m;
      while ((m = re.exec(s)) !== null) {
        arr.push({ code: m[1] });
      }
      return arr;

    } catch (_e2) {
      return [];
    }
  }

  function pushCodeToAllPromoDiscountLines(so) {
    try {
      const lc = so.getLineCount({ sublistId: 'item' });
      if (!lc) return false;

      let changed = false;

      for (let i = 0; i < lc; i++) {
        // MAIN line discount code
        const mainCode = toStr(so.getSublistValue({
          sublistId: 'item',
          fieldId: DISCOUNT_CODE_FIELD,
          line: i
        })).trim();

        if (!mainCode) continue;

        // Look forward and update ALL consecutive promo discount lines (911)
        let j = i + 1;
        let updatedCount = 0;

        while (j < lc) {
          const nextItemId = toNum(so.getSublistValue({
            sublistId: 'item',
            fieldId: 'item',
            line: j
          }));

          // stop as soon as next line is NOT promo discount item
          if (nextItemId !== PROMO_DISCOUNT_ITEM_ID) break;

          const existing = toStr(so.getSublistValue({
            sublistId: 'item',
            fieldId: DISCOUNT_CODE_FIELD,
            line: j
          })).trim();

          // set only if empty (if you want overwrite always, remove this IF)
          if (!existing) {
            so.setSublistValue({
              sublistId: 'item',
              fieldId: DISCOUNT_CODE_FIELD,
              line: j,
              value: mainCode
            });
            changed = true;
            updatedCount++;
          }

          j++;
        }

        // LOG: when we actually had promo lines after this main line
        if (j > i + 1) {
          log.audit('Promo Discount Code Push', {
            mainLine: i,
            mainCode: mainCode,
            promoLinesFound: (j - (i + 1)),
            promoLinesUpdated: updatedCount
          });
        }

        // Optional optimization:
        // if we just processed promo lines, jump i to the last promo line,
        // so we don't re-process those lines as "main lines"
        if (j > i + 1) {
          i = j - 1;
        }
      }

      log.audit('Promo Discount Push Summary', {
        soId: so.id,
        changed: changed
      });

      return changed;

    } catch (e) {
      log.error('pushCodeToAllPromoDiscountLines Error', e.message || e.toString());
      return false;
    }
  }

  function extractDiscountCode(obj) {
    if (!obj) return '';
    if (obj.code) return String(obj.code).trim();
    if (obj.discount_code) return String(obj.discount_code).trim();
    if (obj.discountCode) return String(obj.discountCode).trim();
    if (obj.title) return String(obj.title).trim();
    return '';
  }

  function normalizeDiscountCode(code) {
    if (!code) return code;
    if (code && code.toLowerCase().indexOf('par') == 0) return 'PAR';

    const parts = String(code).split('-');
    const last = parts[parts.length - 1] || '';
    if (last && last.toLowerCase().indexOf('par') == 0) return 'PAR';
    if (/EMP/i.test(last)) return 'EMP';     

    return code;
  }

  function decodeHtmlEntities(str) {
    return String(str || '')
      .replace(/&quot;/g, '"')
      .replace(/&#34;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }

  // ---------- utils ----------
  function headers(){ 
    return { 
      'X-Shopify-Access-Token': SHOPIFY_TOKEN, 
      'Content-Type': 'application/json' 
    }; 
  }

  function toNum(v){ return Number(v) || 0; }
  function toStr(v){ return v == null ? '' : String(v); }
  function gidToNumeric(gid){ 
    const m = String(gid||'').match(/\/(\d+)$/); 
    return m ? Number(m[1]) : 0; 
  }
  function escapeGQL(s){ 
    return String(s||'').replace(/\\/g,'\\\\').replace(/"/g,'\\"'); 
  }
  function isApparelAndAccessories(s){
    const t = String(s||'').toLowerCase();
    return t.includes('apparel') && t.includes('accessor');
  }

  return {
    beforeSubmit,
    afterSubmit
  };
});