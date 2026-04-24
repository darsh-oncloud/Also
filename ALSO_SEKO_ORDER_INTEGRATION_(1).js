/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/search', 'N/record', 'N/log'], function (search, record, log) {

    var SAVED_SEARCH_ID = 'customsearch_also_slaes_order_3pl_status'; //new mech logic

    var BODY_STATUS_FIELD = 'custbody_3pl_export_status';
    var LINE_STATUS_FIELD = 'custcol_3pl_export_status';
    var EXPORT_QTY_FIELD = 'custcol_3pl_export_quantity';

    var PARENT_COMP_FIELD = 'custcol_item_parentcomp';
    var COMPONENT_PARENT_FIELD = 'custcol_parent_item';

    var PC_PARENT = '1';
    var PC_COMPONENT = '2';
    var PC_ADDON = '3';
    var PC_MERCH = '4'; // update later with actual custom list value

    var STATUS_READY = '1';              // Ready To Send
    var STATUS_SENT = '2';               // Sent
    var STATUS_ERROR = '3';              // Error
    var STATUS_NOT_RELEASED = '4';       // Not Released
    var STATUS_PARTIAL_READY = '5';      // Partially Ready
    var STATUS_PARTIAL_SENT = '6';       // Partially Sent
    var STATUS_FULFILLED = '7';          // Fulfilled
    var STATUS_PARTIAL_FULFILLED = '8';  // Partially Fulfilled
    var STATUS_HOLD = '9';               // Hold

    var SEKO_LOCATION_ID = '16';
    var IGNORE_ITEM_ID = '907';

    function getInputData() {
        log.audit('getInputData', 'Loading saved search: ' + SAVED_SEARCH_ID);

        return search.load({
            id: SAVED_SEARCH_ID
        });
    }

    function map(context) {
        try {
            var row = JSON.parse(context.value);
            var soId = '';

            if (row.values && row.values['GROUP(internalid)']) {
                soId = String(row.values['GROUP(internalid)'].value || row.values['GROUP(internalid)'] || '');
            } else if (row.values && row.values.internalid) {
                soId = String(row.values.internalid.value || row.values.internalid || '');
            } else if (row.id) {
                soId = String(row.id || '');
            }

            if (!soId) {
                log.error('MAP ERROR', {
                    message: 'Sales Order internal id not found in saved search result',
                    row: context.value
                });
                return;
            }

            context.write({
                key: soId,
                value: soId
            });

        } catch (e) {
            log.error('MAP ERROR', e);
        }
    }

    function reduce(context) {
        try {
            var soId = context.key;

            log.audit('REDUCE START', {
                soId: soId
            });

            var soRec = record.load({
                type: record.Type.SALES_ORDER,
                id: soId,
                isDynamic: false
            });

            var bodyStatus = String(soRec.getValue({
                fieldId: BODY_STATUS_FIELD
            }) || '');

            if (
                bodyStatus === STATUS_SENT ||
                bodyStatus === STATUS_ERROR ||
                bodyStatus === STATUS_HOLD ||
                bodyStatus === STATUS_FULFILLED
            ) {
                return;
            }

            var parentGroups = {};
            var addonLines = [];
            var merchLines = [];
            var targetByLineKey = {};
            var protectedByLineKey = {};
            var minCommittedByParentItem = {};
            var eligibleLineByLineKey = {};
            var countForHeaderByLineKey = {};
            var allowAddonStatusUpdate = false;
            var lineCount = soRec.getLineCount({ sublistId: 'item' });
            var i = 0;

            for (i = 0; i < lineCount; i++) {
                var lineUniqueKey = String(soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'lineuniquekey',
                    line: i
                }) || '');

                var itemId = String(soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: i
                }) || '');

                var locationId = String(soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'location',
                    line: i
                }) || '');

                var qty = Number(soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantity',
                    line: i
                }) || 0);

                var qtyCommitted = Number(soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantitycommitted',
                    line: i
                }) || 0);

                var qtyFulfilled = Number(soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantityfulfilled',
                    line: i
                }) || 0);

                var lineStatus = String(soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: LINE_STATUS_FIELD,
                    line: i
                }) || '');

                var parentComp = String(soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: PARENT_COMP_FIELD,
                    line: i
                }) || '');

                var parentItemId = String(soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: COMPONENT_PARENT_FIELD,
                    line: i
                }) || '');

                var isEligibleLine = isValidForStatus(locationId, itemId);

                if (!isEligibleLine) {
                    continue;
                }

                eligibleLineByLineKey[lineUniqueKey] = true;

                var lineObj = {
                    soId: soId,
                    lineUniqueKey: lineUniqueKey,
                    itemId: itemId,
                    qty: qty,
                    qtyCommitted: qtyCommitted,
                    qtyFulfilled: qtyFulfilled,
                    lineStatus: lineStatus,
                    parentComp: parentComp,
                    parentItemId: parentItemId,
                    locationId: locationId
                };

                if (
                    lineStatus === STATUS_SENT ||
                    lineStatus === STATUS_ERROR ||
                    lineStatus === STATUS_HOLD ||
                    lineStatus === STATUS_FULFILLED
                ) {
                    protectedByLineKey[lineUniqueKey] = true;
                    continue;
                }

                if (!parentComp) {
                    continue;
                }

                if (parentComp === PC_PARENT) {
                    if (!parentGroups[itemId]) {
                        parentGroups[itemId] = {
                            parentLines: [],
                            componentLines: []
                        };
                    }
                    parentGroups[itemId].parentLines.push(lineObj);

                } else if (parentComp === PC_COMPONENT) {
                    if (!parentItemId) {
                        addonLines.push(lineObj);
                    } else {
                        if (!parentGroups[parentItemId]) {
                            parentGroups[parentItemId] = {
                                parentLines: [],
                                componentLines: []
                            };
                        }
                        parentGroups[parentItemId].componentLines.push(lineObj);
                    }

                } else if (parentComp === PC_ADDON) {
                    addonLines.push(lineObj);

                } else if (parentComp === PC_MERCH) {
                    merchLines.push(lineObj);
                }
            }

            var parentItemKey = '';
            for (parentItemKey in parentGroups) {
                if (!parentGroups.hasOwnProperty(parentItemKey)) continue;

                var grp = parentGroups[parentItemKey];
                var c = 0;
                var minAvailable = null;
                var minCommitted = null;
                var groupTarget = '';

                if (grp.componentLines.length > 0 && grp.parentLines.length > 0) {
                    var parentQty = Number(grp.parentLines[0].qty || 0);

                    for (c = 0; c < grp.componentLines.length; c++) {
                        var child = grp.componentLines[c];
                        var childAvailable = Number(child.qtyCommitted || 0) + Number(child.qtyFulfilled || 0);
                        var childCommitted = Number(child.qtyCommitted || 0);

                        if (minAvailable === null || childAvailable < minAvailable) {
                            minAvailable = childAvailable;
                        }

                        if (minCommitted === null || childCommitted < minCommitted) {
                            minCommitted = childCommitted;
                        }
                    }

                    minCommittedByParentItem[parentItemKey] = Number(minCommitted || 0);

                    if (Number(minAvailable || 0) > 0) {
                        if (Number(minAvailable) >= parentQty) {
                            groupTarget = STATUS_READY;
                        } else {
                            groupTarget = STATUS_PARTIAL_READY;
                        }
                    }

                    if (groupTarget === STATUS_READY || groupTarget === STATUS_PARTIAL_READY) {
                        allowAddonStatusUpdate = true;
                    }

                    if (groupTarget) {
                        for (c = 0; c < grp.parentLines.length; c++) {
                            targetByLineKey[String(grp.parentLines[c].lineUniqueKey)] = groupTarget;
                            countForHeaderByLineKey[String(grp.parentLines[c].lineUniqueKey)] = true;
                        }
                        for (c = 0; c < grp.componentLines.length; c++) {
                            targetByLineKey[String(grp.componentLines[c].lineUniqueKey)] = groupTarget;
                            countForHeaderByLineKey[String(grp.componentLines[c].lineUniqueKey)] = true;
                        }
                    } else {
                        for (c = 0; c < grp.parentLines.length; c++) {
                            countForHeaderByLineKey[String(grp.parentLines[c].lineUniqueKey)] = true;

                            if (
                                String(grp.parentLines[c].lineStatus || '') === STATUS_PARTIAL_FULFILLED ||
                                String(grp.parentLines[c].lineStatus || '') === STATUS_PARTIAL_SENT
                            ) {
                                targetByLineKey[String(grp.parentLines[c].lineUniqueKey)] = String(grp.parentLines[c].lineStatus || '');
                            }
                        }

                        for (c = 0; c < grp.componentLines.length; c++) {
                            countForHeaderByLineKey[String(grp.componentLines[c].lineUniqueKey)] = true;

                            if (
                                String(grp.componentLines[c].lineStatus || '') === STATUS_PARTIAL_FULFILLED ||
                                String(grp.componentLines[c].lineStatus || '') === STATUS_PARTIAL_SENT
                            ) {
                                targetByLineKey[String(grp.componentLines[c].lineUniqueKey)] = String(grp.componentLines[c].lineStatus || '');
                            }
                        }
                    }

                } else {
                    if (grp.parentLines.length > 0) {
                        minCommittedByParentItem[parentItemKey] = 0;
                    }

                    for (c = 0; c < grp.parentLines.length; c++) {
                        countForHeaderByLineKey[String(grp.parentLines[c].lineUniqueKey)] = true;

                        var parentLine = grp.parentLines[c];
                        if (
                            String(parentLine.lineStatus || '') === STATUS_PARTIAL_FULFILLED ||
                            String(parentLine.lineStatus || '') === STATUS_PARTIAL_SENT
                        ) {
                            targetByLineKey[String(parentLine.lineUniqueKey)] = String(parentLine.lineStatus || '');
                        }
                    }

                    for (c = 0; c < grp.componentLines.length; c++) {
                        countForHeaderByLineKey[String(grp.componentLines[c].lineUniqueKey)] = true;
                        targetByLineKey[String(grp.componentLines[c].lineUniqueKey)] = getRegularTarget(grp.componentLines[c]);
                    }
                }
            }

            if (allowAddonStatusUpdate) {
                for (i = 0; i < addonLines.length; i++) {
                    var singleAddonLine = addonLines[i];
                    targetByLineKey[String(singleAddonLine.lineUniqueKey)] = getRegularTarget(singleAddonLine);
                    countForHeaderByLineKey[String(singleAddonLine.lineUniqueKey)] = true;
                }
            }

            for (i = 0; i < merchLines.length; i++) {
                var merchLine = merchLines[i];
                targetByLineKey[String(merchLine.lineUniqueKey)] = getRegularTarget(merchLine);
                countForHeaderByLineKey[String(merchLine.lineUniqueKey)] = true;
            }

            var changed = false;
            var hasReady = false;
            var hasPartial = false;
            var hasBlankCounted = false;
            var hasCountedLines = false;
            var lineNum = 0;

            for (lineNum = 0; lineNum < lineCount; lineNum++) {
                var luk = String(soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'lineuniquekey',
                    line: lineNum
                }) || '');

                if (!eligibleLineByLineKey[luk]) {
                    continue;
                }

                var currentLineStatus = String(soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: LINE_STATUS_FIELD,
                    line: lineNum
                }) || '');

                var currentCommittedQty = Number(soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantitycommitted',
                    line: lineNum
                }) || 0);

                var currentParentComp = String(soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: PARENT_COMP_FIELD,
                    line: lineNum
                }) || '');

                if (!currentParentComp) {
                    continue;
                }

                var currentItemId = String(soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: lineNum
                }) || '');

                var currentParentItemId = String(soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: COMPONENT_PARENT_FIELD,
                    line: lineNum
                }) || '');

                var exportQtyToSet = currentCommittedQty;

                if (currentParentComp === PC_PARENT) {
                    exportQtyToSet = Number(minCommittedByParentItem[currentItemId] || 0);
                } else if (currentParentComp === PC_COMPONENT) {
                    exportQtyToSet = Number(minCommittedByParentItem[currentParentItemId] || 0);
                } else {
                    exportQtyToSet = currentCommittedQty;
                }

                var currentExportQty = Number(soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: EXPORT_QTY_FIELD,
                    line: lineNum
                }) || 0);

                if (currentExportQty !== exportQtyToSet) {
                    soRec.setSublistValue({
                        sublistId: 'item',
                        fieldId: EXPORT_QTY_FIELD,
                        line: lineNum,
                        value: exportQtyToSet
                    });
                    changed = true;
                }

                if (protectedByLineKey[luk]) {
                    continue;
                }

                var target = '';
                if (targetByLineKey.hasOwnProperty(luk)) {
                    target = String(targetByLineKey[luk] || '');
                }

                if (currentLineStatus !== target) {
                    soRec.setSublistValue({
                        sublistId: 'item',
                        fieldId: LINE_STATUS_FIELD,
                        line: lineNum,
                        value: target || ''
                    });
                    changed = true;
                }

                if (countForHeaderByLineKey[luk]) {
                    hasCountedLines = true;

                    if (target === STATUS_READY) {
                        hasReady = true;
                    } else if (target === STATUS_PARTIAL_READY) {
                        hasPartial = true;
                    } else {
                        hasBlankCounted = true;
                    }
                }
            }

            var newBodyStatus = '';

            if (!hasCountedLines) {
                newBodyStatus = '';
            } else if (hasReady && !hasPartial && !hasBlankCounted) {
                newBodyStatus = STATUS_READY;
            } else if (hasReady || hasPartial) {
                newBodyStatus = STATUS_PARTIAL_READY;
            } else {
                if (String(bodyStatus) === STATUS_PARTIAL_SENT || String(bodyStatus) === STATUS_PARTIAL_FULFILLED) {
                    newBodyStatus = bodyStatus;
                } else {
                    newBodyStatus = '';
                }
            }

            if (String(bodyStatus) !== String(newBodyStatus || '')) {
                soRec.setValue({
                    fieldId: BODY_STATUS_FIELD,
                    value: newBodyStatus || ''
                });
                changed = true;
            }

            if (changed) {
                var saveId = soRec.save({
                    enableSourcing: false,
                    ignoreMandatoryFields: true
                });

                log.audit('SO SAVED', {
                    soId: soId,
                    saveId: saveId
                });
            }

        } catch (e) {
            log.error('REDUCE ERROR', {
                soId: context.key,
                message: e.message,
                stack: e.stack
            });
        }
    }

    function isValidForStatus(locationId, itemId) {
        if (String(locationId || '') !== SEKO_LOCATION_ID) {
            return false;
        }

        if (String(itemId || '') === IGNORE_ITEM_ID) {
            return false;
        }

        return true;
    }

    function getRegularTarget(lineObj) {
        var qty = Number(lineObj.qty || 0);
        var committed = Number(lineObj.qtyCommitted || 0);
        var fulfilled = Number(lineObj.qtyFulfilled || 0);
        var currentStatus = String(lineObj.lineStatus || '');

        if (committed > 0) {
            return ((committed + fulfilled) >= qty) ? STATUS_READY : STATUS_PARTIAL_READY;
        }

        if (currentStatus === STATUS_PARTIAL_FULFILLED || currentStatus === STATUS_PARTIAL_SENT) {
            return currentStatus;
        }

        return '';
    }

    function summarize(summary) {
        log.audit('SUMMARY', {
            usage: summary.usage,
            concurrency: summary.concurrency,
            yields: summary.yields
        });

        summary.mapSummary.errors.iterator().each(function (key, error) {
            log.error('MAP SUMMARY ERROR', {
                key: key,
                error: error
            });
            return true;
        });

        summary.reduceSummary.errors.iterator().each(function (key, error) {
            log.error('REDUCE SUMMARY ERROR', {
                key: key,
                error: error
            });
            return true;
        });
    }

    return {
        getInputData: getInputData,
        map: map,
        reduce: reduce,
        summarize: summarize
    };
});