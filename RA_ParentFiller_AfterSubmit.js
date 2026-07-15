/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Return Authorization - Auto add Parent + Filler lines
 * -----------------------------------------------------
 * When a Return Authorization is created/edited (usually via transform
 * from a Sales Order), each returned component line carries over:
 *   - custcol_parent_item     (the parent item this line belongs to)
 *   - custcol_item_parentcomp (1=Parent, 2=Component, 5=Filler)
 *
 * For every parent found among the returned COMPONENT lines:
 *   1. Look up that parent's custitem_related_components (required set).
 *   2. If ALL required components are present on the RA, the customer
 *      returned the full kit -> add the Parent line back, using the
 *      MINIMUM quantity among the returned components.
 *   3. Also add the parent's packaging filler item(s) at that same qty.
 *   4. If even one required component is missing, do nothing for that
 *      parent (partial return).
 */
define(['N/record', 'N/search', 'N/log'], function (record, search, log) {

    var ITEM_SUBLIST = 'item';

    var PARENT_COLUMN_FIELD = 'custcol_parent_item';
    var TYPE_COLUMN_FIELD = 'custcol_item_parentcomp';
    var RELATED_COMPONENT_FIELD = 'custitem_related_components';
    var PACKAGING_FILLER_FIELD = 'custitem_pcs_pckg_fill';

    var TYPE_PARENT = '1';
    var TYPE_COMPONENT = '2';
    var TYPE_FILLER = '5';

    function afterSubmit(context) {
        try {
            if (context.type !== context.UserEventType.CREATE &&
                context.type !== context.UserEventType.EDIT) {
                return;
            }

            if (context.newRecord.type !== 'returnauthorization') {
                return;
            }

            var raId = context.newRecord.id;
            if (!raId) return;

            var raRec = record.load({
                type: 'returnauthorization',
                id: raId,
                isDynamic: false
            });

            var lineCount = raRec.getLineCount({ sublistId: ITEM_SUBLIST });
            if (!lineCount) {
                log.debug('RA STOP', 'No item lines found');
                return;
            }

            // STEP 1: group returned COMPONENT lines by parent (sum qty per item),
            // and note which parents/fillers already exist on this RA.
            var componentGroups = {};   // { parentId: { itemId: qty } }
            var existingParents = {};   // { parentId: true }
            var existingFillers = {};   // { "parentId|itemId": true }
            var i;

            for (i = 0; i < lineCount; i++) {
                var itemId = String(raRec.getSublistValue({ sublistId: ITEM_SUBLIST, fieldId: 'item', line: i }) || '');
                var parentId = String(raRec.getSublistValue({ sublistId: ITEM_SUBLIST, fieldId: PARENT_COLUMN_FIELD, line: i }) || '');
                var type = String(raRec.getSublistValue({ sublistId: ITEM_SUBLIST, fieldId: TYPE_COLUMN_FIELD, line: i }) || '');
                var qty = Number(raRec.getSublistValue({ sublistId: ITEM_SUBLIST, fieldId: 'quantity', line: i }) || 0);

                if (type === TYPE_PARENT && itemId) {
                    existingParents[itemId] = true;
                    continue;
                }

                if (type === TYPE_FILLER && parentId && itemId) {
                    existingFillers[parentId + '|' + itemId] = true;
                    continue;
                }

                if (type === TYPE_COMPONENT && parentId && itemId && qty > 0) {
                    if (!componentGroups[parentId]) componentGroups[parentId] = {};
                    componentGroups[parentId][itemId] = (componentGroups[parentId][itemId] || 0) + qty;
                }
            }

            var parentIds = Object.keys(componentGroups);
            if (!parentIds.length) {
                log.debug('RA STOP', 'No component lines with a parent item found');
                return;
            }

            // STEP 2: one search each for required components + filler items, for ALL parents at once.
            var requiredComponents = getRelatedComponentsJson(parentIds);
            var packagingFillers = getPackagingFillerJson(parentIds);

            var hasChanges = false;
            var addedParents = [];

            for (i = 0; i < parentIds.length; i++) {
                var pId = parentIds[i];
                var requiredIds = requiredComponents[pId];

                if (!requiredIds || !requiredIds.length) {
                    log.debug('SKIP - NO CONFIG', 'Parent ' + pId + ' has no related components set up');
                    continue;
                }

                if (existingParents[pId]) {
                    log.debug('SKIP - ALREADY ON RA', 'Parent ' + pId + ' already present');
                    continue;
                }

                var returnedItems = componentGroups[pId];
                var allReturned = true;
                var minQty = null;
                var r, reqId;

                for (r = 0; r < requiredIds.length; r++) {
                    reqId = requiredIds[r];
                    if (!returnedItems.hasOwnProperty(reqId)) {
                        allReturned = false;
                        break;
                    }
                    if (minQty === null || returnedItems[reqId] < minQty) {
                        minQty = returnedItems[reqId];
                    }
                }

                if (!allReturned || !minQty) {
                    log.debug('SKIP - INCOMPLETE RETURN', {
                        parentId: pId,
                        required: requiredIds,
                        returned: returnedItems
                    });
                    continue;
                }

                // All required components returned -> add Parent line
                addLine(raRec, pId, minQty, '', TYPE_PARENT);
                existingParents[pId] = true;
                hasChanges = true;

                // Add filler(s) for this parent, same quantity
                var fillerIds = packagingFillers[pId] || [];
                for (r = 0; r < fillerIds.length; r++) {
                    var fillerId = String(fillerIds[r]).replace(/\s+/g, '');
                    if (!fillerId) continue;
                    if (existingFillers[pId + '|' + fillerId]) continue;

                    addLine(raRec, fillerId, minQty, pId, TYPE_FILLER);
                    existingFillers[pId + '|' + fillerId] = true;
                    hasChanges = true;
                }

                addedParents.push({ parentId: pId, quantity: minQty });
            }

            log.audit('RA SUMMARY', {
                raId: raId,
                parentsChecked: parentIds.length,
                parentsAdded: addedParents,
                updated: hasChanges
            });

            if (hasChanges) {
                var savedId = raRec.save({ enableSourcing: false, ignoreMandatoryFields: true });
                log.audit('RA SAVED', 'Return Authorization updated successfully: ' + savedId);
            }

        } catch (e) {
            log.error({ title: 'RA afterSubmit Error', details: e });
        }
    }

    function addLine(rec, itemId, qty, parentId, type) {
        var newLine = rec.getLineCount({ sublistId: ITEM_SUBLIST });

        rec.insertLine({ sublistId: ITEM_SUBLIST, line: newLine });
        rec.setSublistValue({ sublistId: ITEM_SUBLIST, fieldId: 'item', line: newLine, value: itemId });
        rec.setSublistValue({ sublistId: ITEM_SUBLIST, fieldId: 'quantity', line: newLine, value: qty });
        rec.setSublistValue({ sublistId: ITEM_SUBLIST, fieldId: 'rate', line: newLine, value: 0 });

        if (parentId) {
            rec.setSublistValue({ sublistId: ITEM_SUBLIST, fieldId: PARENT_COLUMN_FIELD, line: newLine, value: parentId });
        }

        rec.setSublistValue({ sublistId: ITEM_SUBLIST, fieldId: TYPE_COLUMN_FIELD, line: newLine, value: type });
    }

    function getRelatedComponentsJson(parentIds) {
        var json = {};

        search.create({
            type: search.Type.ITEM,
            filters: [
                ['internalid', 'anyof', parentIds],
                'AND',
                [RELATED_COMPONENT_FIELD, 'isnotempty', '']
            ],
            columns: ['internalid', RELATED_COMPONENT_FIELD]
        }).run().each(function (result) {
            var parentId = String(result.getValue({ name: 'internalid' }));
            var value = result.getValue({ name: RELATED_COMPONENT_FIELD });

            json[parentId] = value
                ? String(value).split(',').map(function (id) { return id.replace(/\s+/g, ''); })
                : [];

            return true;
        });

        return json;
    }

    function getPackagingFillerJson(parentIds) {
        var json = {};

        search.create({
            type: 'noninventoryitem',
            filters: [
                ['type', 'anyof', 'NonInvtPart'],
                'AND',
                ['internalid', 'anyof', parentIds]
            ],
            columns: [search.createColumn({ name: PACKAGING_FILLER_FIELD })]
        }).run().each(function (result) {
            var value = result.getValue({ name: PACKAGING_FILLER_FIELD });
            if (result.id && value) {
                json[String(result.id)] = String(value).split(',');
            }
            return true;
        });

        return json;
    }

    return {
        afterSubmit: afterSubmit
    };
});
