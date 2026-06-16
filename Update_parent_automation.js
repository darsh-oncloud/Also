/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/search', 'N/log'], function (record, search, log) {

    var ITEM_SUBLIST = 'item';

    var PARENT_COLUMN_FIELD = 'custcol_parent_item';
    var TYPE_COLUMN_FIELD = 'custcol_item_parentcomp';
    var RELATED_COMPONENT_FIELD = 'custitem_related_components';

    var TYPE_PARENT = '1';
    var TYPE_COMPONENT = '2';

    function afterSubmit(context) {
        try {
            if (context.type !== context.UserEventType.EDIT) {
                return;
            }

            if (context.newRecord.type !== 'salesorder') {
                return;
            }

            var oldRec = context.oldRecord;
            var newRec = context.newRecord;
            var soId = newRec.id;

            var changedParentId = '';

            var oldLineCount = oldRec.getLineCount({
                sublistId: ITEM_SUBLIST
            });

            /*
             * STEP 1:
             * Find changed component line.
             */
            for (var i = 0; i < oldLineCount; i++) {

                var oldType = String(oldRec.getSublistValue({
                    sublistId: ITEM_SUBLIST,
                    fieldId: TYPE_COLUMN_FIELD,
                    line: i
                }) || '');

                if (oldType !== TYPE_COMPONENT) {
                    continue;
                }

                var newLine = findNewLine(newRec, oldRec, i);

                if (newLine === -1) {
                    continue;
                }

                var oldItem = String(oldRec.getSublistValue({
                    sublistId: ITEM_SUBLIST,
                    fieldId: 'item',
                    line: i
                }) || '');

                var newItem = String(newRec.getSublistValue({
                    sublistId: ITEM_SUBLIST,
                    fieldId: 'item',
                    line: newLine
                }) || '');

                if (oldItem && newItem && oldItem !== newItem) {
                    changedParentId = String(oldRec.getSublistValue({
                        sublistId: ITEM_SUBLIST,
                        fieldId: PARENT_COLUMN_FIELD,
                        line: i
                    }) || '');

                    break;
                }
            }

            if (!changedParentId) {
                log.debug('STOP', 'No component item change found');
                return;
            }

            /*
             * STEP 2:
             * Build new component combination for that old parent.
             */
            var newComponentIds = [];

            for (var c = 0; c < oldLineCount; c++) {

                var oldCompType = String(oldRec.getSublistValue({
                    sublistId: ITEM_SUBLIST,
                    fieldId: TYPE_COLUMN_FIELD,
                    line: c
                }) || '');

                var oldParent = String(oldRec.getSublistValue({
                    sublistId: ITEM_SUBLIST,
                    fieldId: PARENT_COLUMN_FIELD,
                    line: c
                }) || '');

                if (oldCompType !== TYPE_COMPONENT || oldParent !== changedParentId) {
                    continue;
                }

                var currentLine = findNewLine(newRec, oldRec, c);

                if (currentLine === -1) {
                    continue;
                }

                var currentItem = String(newRec.getSublistValue({
                    sublistId: ITEM_SUBLIST,
                    fieldId: 'item',
                    line: currentLine
                }) || '');

                if (currentItem && newComponentIds.indexOf(currentItem) === -1) {
                    newComponentIds.push(currentItem);
                }
            }

            if (!newComponentIds.length) {
                log.debug('STOP', 'No new component group found');
                return;
            }

            /*
             * STEP 3:
             * Find new Non-Inventory parent item.
             */
            var newParentId = findParentByComponents(newComponentIds, changedParentId);

            if (!newParentId) {
                log.debug('STOP', {
                    message: 'No new parent found for component group',
                    oldParent: changedParentId,
                    components: newComponentIds
                });
                return;
            }

            /*
             * STEP 4:
             * Load SO and replace only the parent item line.
             */
            var soRec = record.load({
                type: record.Type.SALES_ORDER,
                id: soId,
                isDynamic: false
            });

            var parentLine = findParentLineToReplace(soRec, changedParentId);

            if (parentLine === -1) {
                log.debug('STOP', 'Old parent line not found on SO');
                return;
            }

            soRec.setSublistValue({
                sublistId: ITEM_SUBLIST,
                fieldId: 'item',
                line: parentLine,
                value: newParentId
            });

            var savedId = soRec.save({
                enableSourcing: false,
                ignoreMandatoryFields: true
            });

            log.audit('PARENT REPLACED SUCCESSFULLY', {
                salesOrder: savedId,
                oldParent: changedParentId,
                newParent: newParentId,
                components: newComponentIds
            });

        } catch (e) {
            log.error('afterSubmit Error', e);
        }
    }

    function findParentByComponents(componentIds, oldParentId) {
        var filters = [
            ['type', 'anyof', 'NonInvtPart']
        ];

        /*
         * Same search logic, but adding each component with AND.
         * This means parent should contain all current components.
         */
        for (var i = 0; i < componentIds.length; i++) {
            filters.push('AND');
            filters.push([RELATED_COMPONENT_FIELD, 'allof', componentIds[i]]);
        }

        var results = search.create({
            type: 'noninventoryitem',
            filters: filters,
            columns: [
                search.createColumn({
                    name: 'internalid'
                })
            ]
        }).run().getRange({
            start: 0,
            end: 1
        });

        if (results && results.length) {
            var parentId = String(results[0].getValue({
                name: 'internalid'
            }) || '');

            if (parentId && parentId !== String(oldParentId)) {
                return parentId;
            }
        }

        return '';
    }

    function findParentLineToReplace(soRec, oldParentId) {
        var lineCount = soRec.getLineCount({
            sublistId: ITEM_SUBLIST
        });

        for (var i = 0; i < lineCount; i++) {
            var itemId = String(soRec.getSublistValue({
                sublistId: ITEM_SUBLIST,
                fieldId: 'item',
                line: i
            }) || '');

            var typeVal = String(soRec.getSublistValue({
                sublistId: ITEM_SUBLIST,
                fieldId: TYPE_COLUMN_FIELD,
                line: i
            }) || '');

            if (itemId === String(oldParentId) && typeVal === TYPE_PARENT) {
                return i;
            }
        }

        return -1;
    }

    function findNewLine(newRec, oldRec, oldLine) {
        var oldKey = String(oldRec.getSublistValue({
            sublistId: ITEM_SUBLIST,
            fieldId: 'lineuniquekey',
            line: oldLine
        }) || '');

        var newLineCount = newRec.getLineCount({
            sublistId: ITEM_SUBLIST
        });

        if (oldKey) {
            for (var i = 0; i < newLineCount; i++) {
                var newKey = String(newRec.getSublistValue({
                    sublistId: ITEM_SUBLIST,
                    fieldId: 'lineuniquekey',
                    line: i
                }) || '');

                if (newKey === oldKey) {
                    return i;
                }
            }
        }

        /*
         * Simple fallback if line unique key is not available.
         */
        if (oldLine < newLineCount) {
            return oldLine;
        }

        return -1;
    }

    return {
        afterSubmit: afterSubmit
    };
});
