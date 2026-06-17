/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * EDIT ONLY SCRIPT
 * Purpose:
 * If Shopify replaces one component item on an existing SO,
 * find the new Non-Inventory parent by new component group
 * and replace only the old parent item line.
 *
 * New Logic:
 * - Do NOT touch filler lines.
 * - Only replace old parent with new parent.
 * - Main afterSubmit script will reassign correct parent/component after this save.
 */
define(['N/record', 'N/search', 'N/log', 'N/runtime'], function (record, search, log, runtime) {

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

            log.audit('SCRIPT START', {
                salesOrderId: soId,
                contextType: context.type,
                executionContext: runtime.executionContext
            });

            var oldLineCount = oldRec.getLineCount({
                sublistId: ITEM_SUBLIST
            });

            var parentToFix = {};
            var allChangedLines = [];

            /*
             * STEP 1:
             * Find the item line which changed from old component item
             * to any new item.
             */
            for (var i = 0; i < oldLineCount; i++) {
                var newLine = findNewLine(newRec, oldRec, i);

                if (newLine === -1) {
                    log.debug('LINE NOT FOUND IN NEW RECORD', {
                        oldLine: i
                    });
                    continue;
                }

                var oldItem = getLineValue(oldRec, 'item', i);
                var newItem = getLineValue(newRec, 'item', newLine);

                if (!oldItem || !newItem || oldItem === newItem) {
                    continue;
                }

                var oldType = getLineValue(oldRec, TYPE_COLUMN_FIELD, i);
                var newType = getLineValue(newRec, TYPE_COLUMN_FIELD, newLine);

                /*
                 * Only care about line which was Component before edit.
                 * We do not process parent/filler/merch/add-on changes here.
                 */
                if (oldType !== TYPE_COMPONENT) {
                    log.debug('SKIP CHANGED LINE - OLD LINE WAS NOT COMPONENT', {
                        oldLine: i,
                        newLine: newLine,
                        oldItem: oldItem,
                        newItem: newItem,
                        oldType: oldType,
                        newType: newType
                    });
                    continue;
                }

                var oldParent = getLineValue(oldRec, PARENT_COLUMN_FIELD, i);
                var newParent = getLineValue(newRec, PARENT_COLUMN_FIELD, newLine);

                if (!oldParent) {
                    oldParent = findNearestParentAbove(oldRec, i);
                }

                var changedObj = {
                    oldLine: i,
                    newLine: newLine,
                    oldItem: oldItem,
                    newItem: newItem,
                    oldType: oldType,
                    newType: newType,
                    oldParent: oldParent,
                    newParent: newParent
                };

                allChangedLines.push(changedObj);

                log.debug('COMPONENT ITEM CHANGE FOUND', changedObj);

                if (oldParent) {
                    parentToFix[oldParent] = true;
                }
            }

            log.audit('ALL CHANGED COMPONENT LINES', allChangedLines);

            if (!hasKeys(parentToFix)) {
                log.audit('STOP', 'No changed component line found with parent group');
                return;
            }

            log.audit('PARENT GROUPS TO FIX', Object.keys(parentToFix));

            var soRec = record.load({
                type: record.Type.SALES_ORDER,
                id: soId,
                isDynamic: false
            });

            var hasChanges = false;

            /*
             * STEP 2:
             * For each old parent, build latest component group
             * using current order component items.
             */
            for (var oldParentId in parentToFix) {
                var componentIds = [];

                log.audit('BUILD COMPONENT GROUP START', {
                    oldParentId: oldParentId
                });

                for (var c = 0; c < oldLineCount; c++) {
                    var oldLineType = getLineValue(oldRec, TYPE_COLUMN_FIELD, c);
                    var oldLineParent = getLineValue(oldRec, PARENT_COLUMN_FIELD, c);

                    if (oldLineType !== TYPE_COMPONENT || oldLineParent !== oldParentId) {
                        continue;
                    }

                    var currentLine = findNewLine(newRec, oldRec, c);

                    if (currentLine === -1) {
                        log.debug('COMPONENT LINE NOT FOUND IN NEW RECORD', {
                            oldParentId: oldParentId,
                            oldLine: c
                        });
                        continue;
                    }

                    /*
                     * This takes current item from new record.
                     * Example:
                     * Old group: 606, 612, 621
                     * New group after Shopify edit: 606, 612, 618
                     */
                    var oldComponentItem = getLineValue(oldRec, 'item', c);
                    var currentComponentItem = getLineValue(newRec, 'item', currentLine);

                    log.debug('COMPONENT GROUP LINE', {
                        oldParentId: oldParentId,
                        oldLine: c,
                        newLine: currentLine,
                        oldComponentItem: oldComponentItem,
                        currentComponentItem: currentComponentItem
                    });

                    if (currentComponentItem && componentIds.indexOf(currentComponentItem) === -1) {
                        componentIds.push(currentComponentItem);
                    }
                }

                log.audit('FINAL COMPONENT GROUP CREATED', {
                    oldParentId: oldParentId,
                    componentIds: componentIds
                });

                if (!componentIds.length) {
                    log.audit('SKIP', {
                        reason: 'No component ids found',
                        oldParentId: oldParentId
                    });
                    continue;
                }

                /*
                 * STEP 3:
                 * Find new parent item by latest component group.
                 */
                var newParentId = findNewParentItem(componentIds, oldParentId);

                if (!newParentId) {
                    log.audit('SKIP', {
                        reason: 'No new parent found from search',
                        oldParentId: oldParentId,
                        componentIds: componentIds
                    });
                    continue;
                }

                /*
                 * STEP 4:
                 * Find old parent line on loaded SO.
                 */
                var parentLine = findParentLine(soRec, oldParentId);

                if (parentLine === -1) {
                    log.audit('SKIP', {
                        reason: 'Old parent line not found on SO',
                        oldParentId: oldParentId,
                        newParentId: newParentId
                    });
                    continue;
                }

                /*
                 * IMPORTANT:
                 * Do NOT remove filler.
                 * Do NOT add filler.
                 * Only replace parent item.
                 */

                log.audit('REPLACING PARENT ITEM LINE', {
                    line: parentLine,
                    oldParentId: oldParentId,
                    newParentId: newParentId
                });

                /*
                 * Keep line details same.
                 * Only item changes, price level custom, rate/amount zero.
                 */
                setLine(soRec, parentLine, 'item', newParentId);
                setLine(soRec, parentLine, 'price', -1);
                setLine(soRec, parentLine, 'rate', 0);
                setLine(soRec, parentLine, 'amount', 0);

                log.audit('PARENT ITEM REPLACED AND ZEROED', {
                    line: parentLine,
                    oldParentId: oldParentId,
                    newParentId: newParentId,
                    price: -1,
                    rate: 0,
                    amount: 0,
                    fillerTouched: false
                });

                hasChanges = true;
            }

            /*
             * STEP 5:
             * Save SO.
             * After this save, the main parent/component afterSubmit script
             * will run again and assign correct parent/component values.
             */
            if (hasChanges) {
                var savedId = soRec.save({
                    enableSourcing: false,
                    ignoreMandatoryFields: true
                });

                log.audit('SO SAVED SUCCESSFULLY', {
                    salesOrderId: savedId,
                    note: 'Parent changed only. Main afterSubmit should reassign parent/component.'
                });
            } else {
                log.audit('NO SAVE', 'No parent item replacement needed');
            }

        } catch (e) {
            log.error('afterSubmit Error', e);
        }
    }

    function findNewParentItem(componentIds, oldParentId) {
        /*
         * Search Non-Inventory parent item where related components
         * match the latest component group.
         */
        var filters = [
            ['type', 'anyof', 'NonInvtPart'],
            'AND',
            ['internalid', 'noneof', oldParentId],
            'AND',
            [RELATED_COMPONENT_FIELD, 'allof'].concat(componentIds)
        ];

        log.audit('NON INVENTORY PARENT SEARCH FILTERS', {
            filters: JSON.stringify(filters)
        });

        var noninventoryitemSearchObj = search.create({
            type: 'noninventoryitem',
            filters: filters,
            columns: [
                search.createColumn({
                    name: 'internalid',
                    label: 'Internal ID'
                }),
                search.createColumn({
                    name: 'itemid',
                    label: 'Name'
                }),
                search.createColumn({
                    name: RELATED_COMPONENT_FIELD,
                    label: 'Related Components'
                })
            ]
        });

        var count = noninventoryitemSearchObj.runPaged().count;

        log.audit('NON INVENTORY PARENT SEARCH COUNT', {
            count: count,
            oldParentId: oldParentId,
            componentIds: componentIds
        });

        var results = noninventoryitemSearchObj.run().getRange({
            start: 0,
            end: 5
        });

        if (!results || !results.length) {
            return '';
        }

        for (var i = 0; i < results.length; i++) {
            log.debug('PARENT SEARCH RESULT', {
                index: i,
                internalId: results[i].getValue({
                    name: 'internalid'
                }),
                itemName: results[i].getValue({
                    name: 'itemid'
                }),
                relatedComponents: results[i].getValue({
                    name: RELATED_COMPONENT_FIELD
                })
            });
        }

        /*
         * Take first match.
         */
        var firstParentId = String(results[0].getValue({
            name: 'internalid'
        }) || '');

        log.audit('FIRST MATCHING NEW PARENT SELECTED', {
            newParentId: firstParentId
        });

        return firstParentId;
    }

    function findParentLine(soRec, oldParentId) {
        var lineCount = soRec.getLineCount({
            sublistId: ITEM_SUBLIST
        });

        for (var i = 0; i < lineCount; i++) {
            var itemId = getLineValue(soRec, 'item', i);
            var typeVal = getLineValue(soRec, TYPE_COLUMN_FIELD, i);

            if (itemId === oldParentId && typeVal === TYPE_PARENT) {
                return i;
            }
        }

        /*
         * Fallback:
         * If type field changed/blank, still find the item line.
         */
        for (var j = 0; j < lineCount; j++) {
            var fallbackItemId = getLineValue(soRec, 'item', j);

            if (fallbackItemId === oldParentId) {
                return j;
            }
        }

        return -1;
    }

    function findNewLine(newRec, oldRec, oldLine) {
        var oldKey = getLineValue(oldRec, 'lineuniquekey', oldLine);

        var newLineCount = newRec.getLineCount({
            sublistId: ITEM_SUBLIST
        });

        if (oldKey) {
            for (var i = 0; i < newLineCount; i++) {
                var newKey = getLineValue(newRec, 'lineuniquekey', i);

                if (newKey === oldKey) {
                    return i;
                }
            }
        }

        /*
         * Fallback if lineuniquekey is not available.
         */
        if (oldLine < newLineCount) {
            return oldLine;
        }

        return -1;
    }

    function findNearestParentAbove(rec, fromLine) {
        for (var i = fromLine - 1; i >= 0; i--) {
            var typeVal = getLineValue(rec, TYPE_COLUMN_FIELD, i);

            if (typeVal === TYPE_PARENT) {
                return getLineValue(rec, 'item', i);
            }
        }

        return '';
    }

    function setLine(rec, line, fieldId, value) {
        rec.setSublistValue({
            sublistId: ITEM_SUBLIST,
            fieldId: fieldId,
            line: line,
            value: value
        });
    }

    function getLineValue(rec, fieldId, line) {
        try {
            return String(rec.getSublistValue({
                sublistId: ITEM_SUBLIST,
                fieldId: fieldId,
                line: line
            }) || '');
        } catch (e) {
            return '';
        }
    }

    function hasKeys(obj) {
        for (var key in obj) {
            return true;
        }

        return false;
    }

    return {
        afterSubmit: afterSubmit
    };
});