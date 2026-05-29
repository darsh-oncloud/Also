/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record','N/log'], function(record, log) {

  var CUST_FIELD_ID = 'custitem_bundled_price';

  var MATCH_BY_ID = true;              // true = use pricelevel internal id; false = use name
  var BUNDLE_PRICELEVEL_ID = '6';      // internal id for "Bundled Price"
  var BUNDLE_PRICELEVEL_NAME = 'Bundled Price';

  function afterSubmit(ctx) {
    // Run on create/edit only
    if (ctx.type !== ctx.UserEventType.CREATE && ctx.type !== ctx.UserEventType.EDIT) return;

    try {
      var itemId = ctx.newRecord.id;
      var type = ctx.newRecord.type;
      if (!itemId) return;

      // Load full record (needed to read pricing sublists reliably)
      var rec = record.load({ type: type, id: itemId, isDynamic: false });

      // We will read ONLY the first currency sublist: "price1"
      var sublistId = 'price1';
      var lineCount = 0;

      try {
        lineCount = rec.getLineCount({ sublistId: sublistId });
      } catch (e) {
        log.error('Sublist not found', 'Sublist "' + sublistId + '" is not available on this record.');
        return;
      }

      var bundledPrice = '';
      for (var i = 0; i < lineCount; i++) {
        var plId   = rec.getSublistValue({ sublistId: sublistId, fieldId: 'pricelevel',     line: i }) + '';
        var plName = rec.getSublistValue({ sublistId: sublistId, fieldId: 'pricelevelname', line: i }) + '';

        var isMatch = MATCH_BY_ID ? (plId === BUNDLE_PRICELEVEL_ID) : (plName === BUNDLE_PRICELEVEL_NAME);
        if (isMatch) {
          // "Price 1" column on the price row
          var p = rec.getSublistValue({ sublistId: sublistId, fieldId: 'price_1_', line: i }) || '';
          bundledPrice = p; // keep as string; NetSuite will coerce if target field is numeric
          break;
        }
      }

      if (bundledPrice === '') {
        log.audit('Bundled Price not found', 'No "' + (MATCH_BY_ID ? ('ID ' + BUNDLE_PRICELEVEL_ID) : BUNDLE_PRICELEVEL_NAME) + '" row in ' + sublistId);
        return;
      }

      // Write to custom field only if changed
      var currentVal = rec.getValue({ fieldId: CUST_FIELD_ID }) || '';
      if (currentVal !== bundledPrice) {
        rec.setValue({ fieldId: CUST_FIELD_ID, value: bundledPrice });
        rec.save({ enableSourcing: false, ignoreMandatoryFields: true });
        log.audit('Bundle price updated', 'Set ' + CUST_FIELD_ID + ' = ' + bundledPrice);
      } else {
        log.audit('No change', CUST_FIELD_ID + ' already = ' + bundledPrice);
      }

    } catch (e) {
      log.error('afterSubmit error', e);
    }
  }

  return { afterSubmit: afterSubmit };
});
