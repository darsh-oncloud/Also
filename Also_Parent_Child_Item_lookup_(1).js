/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/search', 'N/log', 'N/runtime'], function(record, search, log, runtime) {

    var ITEM_SUBLIST = 'item';

    // update these ids if needed
    var PARENT_COLUMN_FIELD = 'custcol_parent_item';
    var RELATED_COMPONENT_FIELD = 'custitem_related_components';
    var SPECIAL_VENDOR_FIELD = 'custentity_special_order_vendor';
    var TYPE_COLUMN_FIELD = 'custcol_item_parentcomp';
    var MERCH_ITEM_FIELD = 'custitem_merch_item';
    var FULFILLMENT_KEY_FIELD = 'custcol_3pl_fulfillment_key';
    var PACKAGING_FILLER_FIELD = 'custitem_pcs_pckg_fill';

    // list values
    var TYPE_PARENT = '1';
    var TYPE_COMPONENT = '2';
    var TYPE_ADDON = '3';
    var TYPE_MERCH = '4';
    var TYPE_FILLER = '5';

    // merch list values
    var MERCH_ON_BIKE_VALUE = '1';
    var MERCH_OFF_BIKE_VALUE = '2';

    function beforeSubmit(context) {
        try {
            if (context.type !== context.UserEventType.CREATE &&
                context.type !== context.UserEventType.EDIT) {
                return;
            }

            var tranRec = context.newRecord;
            var recType = tranRec.type;

            if (recType !== 'salesorder') {
                return;
            }

            logHeader('BEFORE SUBMIT', context, tranRec);
            logLineSnapshot('BEFORE SUBMIT - START', tranRec, {}, {});

            var lineItems = getLineItems(tranRec);

            log.audit('BEFORE SUBMIT LINE ITEMS ARRAY', JSON.stringify(lineItems));

            if (!lineItems.length) {
                log.debug('BEFORE SUBMIT STOP', 'No item lines found');
                return;
            }

            var parentChildJson = getParentChildJson(lineItems);

            log.audit('BEFORE SUBMIT PARENT CHILD JSON', JSON.stringify(parentChildJson));
            logLineSnapshot('BEFORE SUBMIT - AFTER PARENT SEARCH', tranRec, parentChildJson, {});

            if (!hasKeys(parentChildJson)) {
                log.debug('BEFORE SUBMIT STOP', 'No parent-child setup found');
                return;
            }

            var lineCount = tranRec.getLineCount({ sublistId: ITEM_SUBLIST });
            var parentLines = [];
            var i;

            for (i = 0; i < lineCount; i++) {
                var parentItemId = tranRec.getSublistValue({
                    sublistId: ITEM_SUBLIST,
                    fieldId: 'item',
                    line: i
                });

                var parentRate = tranRec.getSublistValue({
                    sublistId: ITEM_SUBLIST,
                    fieldId: 'rate',
                    line: i
                });

                var parentQty = tranRec.getSublistValue({
                    sublistId: ITEM_SUBLIST,
                    fieldId: 'quantity',
                    line: i
                });

                parentItemId = parentItemId ? String(parentItemId) : '';
                parentRate = toNumber(parentRate);
                parentQty = toNumber(parentQty);

                logParentCandidate('BEFORE SUBMIT', i, parentItemId, parentQty, parentRate, parentChildJson);

                if (parentItemId && parentChildJson[parentItemId] && sameNumber(parentRate, 0)) {
                    parentLines.push({
                        line: i,
                        parentItemId: parentItemId,
                        quantity: parentQty
                    });

                    log.debug('BEFORE SUBMIT ORDER PARENT FOUND', {
                        line: i,
                        parentItemId: parentItemId,
                        quantity: parentQty,
                        rate: parentRate
                    });
                }
            }

            log.debug('Before Submit Parent Lines', JSON.stringify(parentLines));

            var parentItemIdsForFiller = [];

            for (i = 0; i < parentLines.length; i++) {
                parentItemIdsForFiller.push(parentLines[i].parentItemId);
            }

            var packagingFillerJson = getPackagingFillerJson(parentItemIdsForFiller);
            log.debug('Before Submit Packaging Filler JSON', JSON.stringify(packagingFillerJson));

            for (i = 0; i < parentLines.length; i++) {

                var fillerParentObj = parentLines[i];
                var fillerItems = packagingFillerJson[fillerParentObj.parentItemId];

                if (!fillerItems || !fillerItems.length) {
                    log.debug('BEFORE SUBMIT NO FILLER ITEMS FOR PARENT', {
                        parentItemId: fillerParentObj.parentItemId,
                        parentLine: fillerParentObj.line
                    });
                    continue;
                }

                for (var f = 0; f < fillerItems.length; f++) {

                    var fillerItemId = String(fillerItems[f]).replace(/\s+/g, '');

                    if (!fillerItemId) {
                        continue;
                    }

                    if (isFillerAlreadyAdded(tranRec, fillerParentObj.parentItemId, fillerItemId, fillerParentObj.quantity)) {
                        log.debug('BEFORE SUBMIT FILLER ALREADY EXISTS', {
                            parentItem: fillerParentObj.parentItemId,
                            fillerItem: fillerItemId,
                            quantity: fillerParentObj.quantity
                        });
                        continue;
                    }

                    var newLine = tranRec.getLineCount({
                        sublistId: ITEM_SUBLIST
                    });

                    tranRec.insertLine({
                        sublistId: ITEM_SUBLIST,
                        line: newLine
                    });

                    tranRec.setSublistValue({
                        sublistId: ITEM_SUBLIST,
                        fieldId: 'item',
                        line: newLine,
                        value: fillerItemId
                    });

                    tranRec.setSublistValue({
                        sublistId: ITEM_SUBLIST,
                        fieldId: 'quantity',
                        line: newLine,
                        value: fillerParentObj.quantity
                    });

                    tranRec.setSublistValue({
                        sublistId: ITEM_SUBLIST,
                        fieldId: 'location',
                        line: newLine,
                        value: 7
                    });

                    tranRec.setSublistValue({
                        sublistId: ITEM_SUBLIST,
                        fieldId: 'price',
                        line: newLine,
                        value: -1
                    });

                    tranRec.setSublistValue({
                        sublistId: ITEM_SUBLIST,
                        fieldId: 'rate',
                        line: newLine,
                        value: 0
                    });

                    tranRec.setSublistValue({
                        sublistId: ITEM_SUBLIST,
                        fieldId: PARENT_COLUMN_FIELD,
                        line: newLine,
                        value: fillerParentObj.parentItemId
                    });

                    setTypeField(tranRec, newLine, TYPE_FILLER);

                    log.debug('BEFORE SUBMIT FILLER ITEM ADDED', {
                        parentItem: fillerParentObj.parentItemId,
                        fillerItem: fillerItemId,
                        quantity: fillerParentObj.quantity,
                        line: newLine
                    });
                }
            }

            logLineSnapshot('BEFORE SUBMIT - END', tranRec, parentChildJson, {});

        } catch (e) {
            log.error({
                title: 'beforeSubmit Error',
                details: e
            });
        }
    }

    function afterSubmit(context) {
        try {
            if (context.type !== context.UserEventType.CREATE &&
                context.type !== context.UserEventType.EDIT) {
                return;
            }

            var tranId = context.newRecord.id;
            var recType = context.newRecord.type;

            logHeader('AFTER SUBMIT NEW RECORD', context, context.newRecord);

            if (!tranId) return;

            if (recType === 'purchaseorder') {
                log.debug('START', 'PO Id: ' + tranId);

                var approvalStatus = context.newRecord.getValue({ fieldId: 'approvalstatus' });
                var vendorId = context.newRecord.getValue({ fieldId: 'entity' });

                log.debug('PO Header', {
                    poId: tranId,
                    approvalStatus: approvalStatus,
                    vendorId: vendorId
                });

                if (String(approvalStatus) !== '1') {
                    log.debug('STOP', 'PO is not Pending Approval');
                    return;
                }

                if (!vendorId) {
                    log.debug('STOP', 'Vendor not found');
                    return;
                }

                var vendorLookup = search.lookupFields({
                    type: search.Type.VENDOR,
                    id: vendorId,
                    columns: [SPECIAL_VENDOR_FIELD]
                });

                var isSpecialVendor = vendorLookup[SPECIAL_VENDOR_FIELD] === true;

                log.debug('Vendor Check', {
                    vendorId: vendorId,
                    isSpecialVendor: isSpecialVendor
                });

                if (!isSpecialVendor) {
                    log.debug('STOP', 'Vendor special order checkbox is not checked');
                    return;
                }

            } else if (recType === 'salesorder') {
                log.debug('START', 'SO Id: ' + tranId);

                var soStatus = context.newRecord.getValue({ fieldId: 'orderstatus' });

                log.debug('SO Header', {
                    soId: tranId,
                    approvalStatus: soStatus
                });

                if (String(soStatus) !== 'A') {
                    log.debug('STOP MESSAGE ONLY', 'SO is not Pending Approval, but script is continuing because return is commented');
                    // kept as it was in your working script
                    // return;
                }

            } else {
                return;
            }

            var tranRec = record.load({
                type: recType,
                id: tranId,
                isDynamic: false
            });

            logHeader('AFTER SUBMIT LOADED RECORD', context, tranRec);
            logLineSnapshot('AFTER SUBMIT - LOADED START', tranRec, {}, {});

            var lineItems = getLineItems(tranRec);

            log.audit('AFTER SUBMIT LINE ITEMS ARRAY', JSON.stringify(lineItems));

            if (!lineItems.length) {
                log.debug('STOP', 'No item lines found');
                return;
            }

            var parentChildJson = getParentChildJson(lineItems);
            var itemMerchJson = getItemMerchJson(lineItems);

            log.audit('AFTER SUBMIT PARENT CHILD JSON', JSON.stringify(parentChildJson));
            log.audit('AFTER SUBMIT ITEM MERCH JSON', JSON.stringify(itemMerchJson));

            logLineSnapshot('AFTER SUBMIT - AFTER SEARCHES', tranRec, parentChildJson, itemMerchJson);

            if (!hasKeys(parentChildJson) && !hasKeys(itemMerchJson)) {
                log.debug('STOP', 'No parent-child setup and no merch/onbike-offbike items found');
                return;
            }

            var lineCount = tranRec.getLineCount({ sublistId: ITEM_SUBLIST });
            var parentLines = [];
            var usedComponentLines = {};
            var hasChanges = false;
            var i;

            /*
             * PASS 1:
             * Find all parent lines on the order.
             */
            for (i = 0; i < lineCount; i++) {
                var parentItemId = tranRec.getSublistValue({
                    sublistId: ITEM_SUBLIST,
                    fieldId: 'item',
                    line: i
                });

                var parentRate = tranRec.getSublistValue({
                    sublistId: ITEM_SUBLIST,
                    fieldId: 'rate',
                    line: i
                });

                var parentQty = tranRec.getSublistValue({
                    sublistId: ITEM_SUBLIST,
                    fieldId: 'quantity',
                    line: i
                });

                parentItemId = parentItemId ? String(parentItemId) : '';
                parentRate = toNumber(parentRate);
                parentQty = toNumber(parentQty);

                logParentCandidate('AFTER SUBMIT', i, parentItemId, parentQty, parentRate, parentChildJson);

                if (parentItemId && parentChildJson[parentItemId] && sameNumber(parentRate, 0)) {
                    parentLines.push({
                        line: i,
                        parentItemId: parentItemId,
                        quantity: parentQty
                    });
                }
            }

            log.debug('Parent Lines', JSON.stringify(parentLines));

            /*
             * PASS 2:
             * Mark all parent lines as Parent.
             */
            for (i = 0; i < parentLines.length; i++) {
                if (!isAllowedItemType(tranRec, parentLines[i].line)) {
                    log.debug('SKIP PARENT - ITEM TYPE NOT ALLOWED', {
                        line: parentLines[i].line
                    });
                    continue;
                }

                clearParentField(tranRec, parentLines[i].line);
                setTypeField(tranRec, parentLines[i].line, TYPE_PARENT);
                setFulfillmentKeyFromLineUniqueKey(tranRec, parentLines[i].line);

                log.debug('AFTER SUBMIT PARENT UPDATED', {
                    line: parentLines[i].line,
                    parentItemId: parentLines[i].parentItemId
                });

                hasChanges = true;
            }

            /*
             * PASS 3:
             * Assign component lines.
             */
            for (i = 0; i < parentLines.length; i++) {
                var parentObj = parentLines[i];
                var childObj = parentChildJson[parentObj.parentItemId];

                if (!childObj) {
                    continue;
                }

                for (var childId in childObj) {
                    var matchedLine = findMatchingComponentLine(
                        tranRec,
                        lineCount,
                        childId,
                        parentObj.quantity,
                        usedComponentLines,
                        parentLines
                    );

                    if (matchedLine !== -1) {
                        if (!isAllowedItemType(tranRec, matchedLine)) {
                            log.debug('SKIP COMPONENT - ITEM TYPE NOT ALLOWED', {
                                matchedLine: matchedLine,
                                childId: childId
                            });
                            continue;
                        }

                        tranRec.setSublistValue({
                            sublistId: ITEM_SUBLIST,
                            fieldId: PARENT_COLUMN_FIELD,
                            line: matchedLine,
                            value: parentObj.parentItemId
                        });

                        setTypeField(tranRec, matchedLine, TYPE_COMPONENT);
                        setFulfillmentKeyFromLineUniqueKey(tranRec, matchedLine);

                        log.debug('AFTER SUBMIT COMPONENT UPDATED', {
                            componentLine: matchedLine,
                            componentItem: childId,
                            parentItem: parentObj.parentItemId,
                            parentLine: parentObj.line,
                            quantity: parentObj.quantity
                        });

                        usedComponentLines[matchedLine] = true;
                        hasChanges = true;
                    } else {
                        log.debug('COMPONENT MATCH NOT FOUND', {
                            childItemId: childId,
                            expectedQuantity: parentObj.quantity,
                            parentItemId: parentObj.parentItemId,
                            parentLine: parentObj.line
                        });
                    }
                }
            }

            /*
             * PASS 4:
             * For all remaining lines:
             * - If On Bike, mark Add-On
             * - If Off Bike, mark Merch
             * - If neither, set Merch as existing logic
             */
            for (i = 0; i < lineCount; i++) {
                var lineItemId = tranRec.getSublistValue({
                    sublistId: ITEM_SUBLIST,
                    fieldId: 'item',
                    line: i
                });

                var lineQty = tranRec.getSublistValue({
                    sublistId: ITEM_SUBLIST,
                    fieldId: 'quantity',
                    line: i
                });

                lineItemId = lineItemId ? String(lineItemId) : '';
                lineQty = toNumber(lineQty);

                if (!lineItemId) {
                    log.debug('PASS 4 SKIP - NO ITEM', {
                        line: i
                    });
                    continue;
                }

                if (!isAllowedItemType(tranRec, i)) {
                    log.debug('PASS 4 SKIP - ITEM TYPE NOT ALLOWED', {
                        line: i,
                        itemId: lineItemId,
                        itemType: safeGetSublistValue(tranRec, ITEM_SUBLIST, 'itemtype', i)
                    });
                    continue;
                }

                if (isParentLine(i, parentLines)) {
                    log.debug('PASS 4 SKIP - ALREADY PARENT', {
                        line: i,
                        itemId: lineItemId
                    });
                    continue;
                }

                if (usedComponentLines[i]) {
                    log.debug('PASS 4 SKIP - ALREADY COMPONENT', {
                        line: i,
                        itemId: lineItemId
                    });
                    continue;
                }

                if (String(tranRec.getSublistValue({
                    sublistId: ITEM_SUBLIST,
                    fieldId: TYPE_COLUMN_FIELD,
                    line: i
                }) || '') === TYPE_FILLER) {
                    setFulfillmentKeyFromLineUniqueKey(tranRec, i);
                    hasChanges = true;

                    log.debug('PASS 4 FILLER LINE UPDATED', {
                        line: i,
                        itemId: lineItemId
                    });

                    continue;
                }

                clearParentField(tranRec, i);

                if (itemMerchJson[lineItemId] === MERCH_ON_BIKE_VALUE) {
                    setTypeField(tranRec, i, TYPE_ADDON);
                    setFulfillmentKeyFromLineUniqueKey(tranRec, i);
                    hasChanges = true;

                    log.debug('PASS 4 ADD-ON UPDATED', {
                        line: i,
                        itemId: lineItemId,
                        merchValue: itemMerchJson[lineItemId]
                    });

                    continue;
                }

                if (itemMerchJson[lineItemId] === MERCH_OFF_BIKE_VALUE) {
                    setTypeField(tranRec, i, TYPE_MERCH);
                    setFulfillmentKeyFromLineUniqueKey(tranRec, i);
                    hasChanges = true;

                    log.debug('PASS 4 MERCH UPDATED - OFF BIKE', {
                        line: i,
                        itemId: lineItemId,
                        merchValue: itemMerchJson[lineItemId]
                    });

                    continue;
                }

                setTypeField(tranRec, i, TYPE_MERCH);
                setFulfillmentKeyFromLineUniqueKey(tranRec, i);
                hasChanges = true;

                log.debug('PASS 4 DEFAULT MERCH UPDATED', {
                    line: i,
                    itemId: lineItemId,
                    merchValue: itemMerchJson[lineItemId] || '',
                    reason: 'Item was not parent, component, filler, on-bike, or off-bike'
                });
            }

            logLineSnapshot('AFTER SUBMIT - BEFORE SAVE', tranRec, parentChildJson, itemMerchJson);

            log.audit('SUMMARY', {
                transactionId: tranId,
                recordType: recType,
                parentCount: parentLines.length,
                usedComponentLines: usedComponentLines,
                updated: hasChanges
            });

            if (hasChanges) {
                var savedId = tranRec.save({
                    enableSourcing: false,
                    ignoreMandatoryFields: true
                });

                log.audit('TRANSACTION SAVED', recType + ' updated successfully: ' + savedId);

            } else {
                log.debug('NO CHANGES', 'No line needed update');
            }

        } catch (e) {
            log.error({
                title: 'afterSubmit Error',
                details: e
            });
        }
    }

    function getLineItems(tranRec) {
        var arr = [];
        var itemMap = {};
        var lineCount = tranRec.getLineCount({ sublistId: ITEM_SUBLIST });
        var i;

        log.audit('GET LINE ITEMS START', {
            recordType: tranRec.type,
            recordId: tranRec.id || '',
            lineCount: lineCount
        });

        for (i = 0; i < lineCount; i++) {
            var itemId = tranRec.getSublistValue({
                sublistId: ITEM_SUBLIST,
                fieldId: 'item',
                line: i
            });

            log.debug('GET LINE ITEMS LINE CHECK', {
                line: i,
                itemId: itemId,
                itemText: safeGetSublistText(tranRec, ITEM_SUBLIST, 'item', i),
                itemType: safeGetSublistValue(tranRec, ITEM_SUBLIST, 'itemtype', i),
                quantity: safeGetSublistValue(tranRec, ITEM_SUBLIST, 'quantity', i),
                rate: safeGetSublistValue(tranRec, ITEM_SUBLIST, 'rate', i)
            });

            if (itemId) {
                itemMap[String(itemId)] = true;
            }
        }

        for (var key in itemMap) {
            arr.push(key);
        }

        log.audit('GET LINE ITEMS FINAL ARRAY', JSON.stringify(arr));

        return arr;
    }

    function getParentChildJson(itemIds) {
        var json = {};
        var resultCount = 0;

        log.audit('GET PARENT CHILD JSON - INPUT ITEM IDS', JSON.stringify(itemIds));

        if (!itemIds || !itemIds.length) {
            log.audit('GET PARENT CHILD JSON - STOP', 'No item ids received');
            return json;
        }

        search.create({
            type: search.Type.ITEM,
            filters: [
                ['internalid', 'anyof', itemIds],
                'AND',
                [RELATED_COMPONENT_FIELD, 'isnotempty', '']
            ],
            columns: [
                'internalid',
                'itemid',
                RELATED_COMPONENT_FIELD
            ]
        }).run().each(function(result) {
            resultCount++;

            var parentId = result.getValue({ name: 'internalid' });
            var itemName = result.getValue({ name: 'itemid' });
            var childValue = result.getValue({ name: RELATED_COMPONENT_FIELD });

            parentId = parentId ? String(parentId) : '';

            log.audit('GET PARENT CHILD JSON - SEARCH RESULT', {
                parentId: parentId,
                itemName: itemName,
                relatedComponentRawValue: childValue
            });

            if (parentId && childValue) {
                json[parentId] = buildChildObject(childValue);
            }

            return true;
        });

        log.audit('GET PARENT CHILD JSON - FINAL', {
            inputItemIds: itemIds,
            resultCount: resultCount,
            parentChildJson: json
        });

        return json;
    }

    function getItemMerchJson(itemIds) {
        var json = {};
        var resultCount = 0;

        log.audit('GET ITEM MERCH JSON - INPUT ITEM IDS', JSON.stringify(itemIds));

        if (!itemIds || !itemIds.length) {
            return json;
        }

        search.create({
            type: search.Type.ITEM,
            filters: [
                ['internalid', 'anyof', itemIds]
            ],
            columns: [
                'internalid',
                'itemid',
                MERCH_ITEM_FIELD
            ]
        }).run().each(function(result) {
            resultCount++;

            var itemId = result.getValue({ name: 'internalid' });
            var itemName = result.getValue({ name: 'itemid' });
            var merchValue = result.getValue({ name: MERCH_ITEM_FIELD });

            itemId = itemId ? String(itemId) : '';
            merchValue = merchValue ? String(merchValue) : '';

            log.debug('GET ITEM MERCH JSON - SEARCH RESULT', {
                itemId: itemId,
                itemName: itemName,
                merchValue: merchValue
            });

            if (itemId) {
                json[itemId] = merchValue;
            }

            return true;
        });

        log.audit('GET ITEM MERCH JSON - FINAL', {
            inputItemIds: itemIds,
            resultCount: resultCount,
            itemMerchJson: json
        });

        return json;
    }

    function getPackagingFillerJson(itemIds) {
        var json = {};

        log.audit('GET PACKAGING FILLER JSON - INPUT PARENT ITEM IDS', JSON.stringify(itemIds));

        if (!itemIds || !itemIds.length) {
            log.audit('GET PACKAGING FILLER JSON - STOP', 'No parent item ids received');
            return json;
        }

        search.create({
            type: 'noninventoryitem',
            filters: [
                ['type', 'anyof', 'NonInvtPart'],
                'AND',
                ['internalid', 'anyof', itemIds]
            ],
            columns: [
                search.createColumn({ name: PACKAGING_FILLER_FIELD }),
                search.createColumn({ name: 'itemid' })
            ]
        }).run().each(function(result) {

            var fillerValues = result.getValue({
                name: PACKAGING_FILLER_FIELD
            });

            var itemName = result.getValue({
                name: 'itemid'
            });

            var itemId = result.id;

            log.audit('GET PACKAGING FILLER JSON - SEARCH RESULT', {
                parentItemId: itemId,
                parentItemName: itemName,
                fillerRawValue: fillerValues
            });

            if (itemId && fillerValues) {
                json[String(itemId)] = String(fillerValues).split(',');
            }

            return true;
        });

        log.audit('GET PACKAGING FILLER JSON - FINAL', JSON.stringify(json));

        return json;
    }

    function isFillerAlreadyAdded(tranRec, parentItemId, fillerItemId, parentQty) {
        var lineCount = tranRec.getLineCount({ sublistId: ITEM_SUBLIST });

        for (var i = 0; i < lineCount; i++) {
            var lineItemId = String(tranRec.getSublistValue({
                sublistId: ITEM_SUBLIST,
                fieldId: 'item',
                line: i
            }) || '');

            var lineParentItemId = String(tranRec.getSublistValue({
                sublistId: ITEM_SUBLIST,
                fieldId: PARENT_COLUMN_FIELD,
                line: i
            }) || '');

            var lineType = String(tranRec.getSublistValue({
                sublistId: ITEM_SUBLIST,
                fieldId: TYPE_COLUMN_FIELD,
                line: i
            }) || '');

            var lineQty = Number(tranRec.getSublistValue({
                sublistId: ITEM_SUBLIST,
                fieldId: 'quantity',
                line: i
            }) || 0);

            if (
                lineItemId === String(fillerItemId) &&
                lineParentItemId === String(parentItemId) &&
                lineType === String(TYPE_FILLER) &&
                sameNumber(lineQty, parentQty)
            ) {
                return true;
            }
        }

        return false;
    }

    function buildChildObject(value) {
        var obj = {};
        if (!value) return obj;

        var arr = String(value).split(',');
        var i;

        for (i = 0; i < arr.length; i++) {
            var childId = String(arr[i]).replace(/\s+/g, '');
            if (childId) {
                obj[childId] = true;
            }
        }

        log.debug('BUILD CHILD OBJECT', {
            rawValue: value,
            childObject: obj
        });

        return obj;
    }

    function findMatchingComponentLine(tranRec, lineCount, childId, parentQty, usedComponentLines, parentLines) {
        var i;

        log.debug('FIND MATCHING COMPONENT START', {
            childId: childId,
            parentQty: parentQty,
            lineCount: lineCount
        });

        for (i = 0; i < lineCount; i++) {
            if (usedComponentLines[i]) {
                log.debug('FIND MATCHING COMPONENT SKIP - USED LINE', {
                    line: i,
                    childId: childId
                });
                continue;
            }

            if (isParentLine(i, parentLines)) {
                log.debug('FIND MATCHING COMPONENT SKIP - PARENT LINE', {
                    line: i,
                    childId: childId
                });
                continue;
            }

            var lineItemId = tranRec.getSublistValue({
                sublistId: ITEM_SUBLIST,
                fieldId: 'item',
                line: i
            });

            var lineQty = tranRec.getSublistValue({
                sublistId: ITEM_SUBLIST,
                fieldId: 'quantity',
                line: i
            });

            lineItemId = lineItemId ? String(lineItemId) : '';
            lineQty = toNumber(lineQty);

            log.debug('FIND MATCHING COMPONENT LINE CHECK', {
                line: i,
                childIdExpected: String(childId),
                lineItemId: lineItemId,
                expectedQty: parentQty,
                lineQty: lineQty,
                itemMatches: lineItemId === String(childId) ? 'YES' : 'NO',
                qtyMatches: sameNumber(lineQty, parentQty) ? 'YES' : 'NO'
            });

            if (lineItemId === String(childId) && sameNumber(lineQty, parentQty)) {
                log.debug('FIND MATCHING COMPONENT FOUND', {
                    childId: childId,
                    matchedLine: i
                });
                return i;
            }
        }

        log.debug('FIND MATCHING COMPONENT NOT FOUND', {
            childId: childId,
            parentQty: parentQty
        });

        return -1;
    }

    function isParentLine(lineNo, parentLines) {
        var i;

        for (i = 0; i < parentLines.length; i++) {
            if (Number(parentLines[i].line) === Number(lineNo)) {
                return true;
            }
        }

        return false;
    }

    function sameNumber(num1, num2) {
        num1 = toNumber(num1);
        num2 = toNumber(num2);

        return Math.abs(num1 - num2) < 0.00001;
    }

    function setTypeByMerchField(tranRec, line, itemId, itemMerchJson) {
        var merchValue = itemMerchJson[itemId] || '';

        if (merchValue === MERCH_ON_BIKE_VALUE) {
            setTypeField(tranRec, line, TYPE_ADDON);
        } else if (merchValue === MERCH_OFF_BIKE_VALUE) {
            setTypeField(tranRec, line, TYPE_MERCH);
        } else {
            clearTypeField(tranRec, line);
        }
    }

    function clearParentField(tranRec, line) {
        try {
            tranRec.setSublistValue({
                sublistId: ITEM_SUBLIST,
                fieldId: PARENT_COLUMN_FIELD,
                line: line,
                value: ''
            });
        } catch (e) {
            log.debug('clearParentField Error', {
                line: line,
                error: e.message
            });
        }
    }

    function clearTypeField(tranRec, line) {
        try {
            tranRec.setSublistValue({
                sublistId: ITEM_SUBLIST,
                fieldId: TYPE_COLUMN_FIELD,
                line: line,
                value: ''
            });
        } catch (e) {
            log.debug('clearTypeField Error', {
                line: line,
                error: e.message
            });
        }
    }

    function setTypeField(tranRec, line, value) {
        try {
            tranRec.setSublistValue({
                sublistId: ITEM_SUBLIST,
                fieldId: TYPE_COLUMN_FIELD,
                line: line,
                value: value
            });
        } catch (e) {
            log.debug('setTypeField Error', {
                line: line,
                value: value,
                error: e.message
            });
        }
    }

    function toNumber(val) {
        var num = parseFloat(val);
        return isNaN(num) ? 0 : num;
    }

    function hasKeys(obj) {
        for (var key in obj) {
            return true;
        }
        return false;
    }

    function setFulfillmentKeyFromLineUniqueKey(tranRec, line) {
        var lineUniqueKey = tranRec.getSublistValue({
            sublistId: ITEM_SUBLIST,
            fieldId: 'lineuniquekey',
            line: line
        });

        if (lineUniqueKey) {
            tranRec.setSublistValue({
                sublistId: ITEM_SUBLIST,
                fieldId: FULFILLMENT_KEY_FIELD,
                line: line,
                value: String(lineUniqueKey)
            });

            log.debug('FULFILLMENT KEY SET', {
                line: line,
                lineUniqueKey: lineUniqueKey,
                fulfillmentKeyField: FULFILLMENT_KEY_FIELD
            });
        } else {
            log.debug('FULFILLMENT KEY NOT SET - LINE UNIQUE KEY EMPTY', {
                line: line
            });
        }
    }

    function isAllowedItemType(tranRec, line) {
        var lineItemType = tranRec.getSublistValue({
            sublistId: ITEM_SUBLIST,
            fieldId: 'itemtype',
            line: line
        });

        lineItemType = lineItemType ? String(lineItemType) : '';

        var allowed = lineItemType === 'InvtPart' || lineItemType === 'NonInvtPart' || lineItemType === 'Assembly';

        log.debug('IS ALLOWED ITEM TYPE CHECK', {
            line: line,
            itemType: lineItemType,
            allowed: allowed
        });

        return allowed;
    }

    function logHeader(stage, context, tranRec) {
        try {
            log.audit(stage + ' HEADER CHECK', {
                eventType: context.type,
                recordType: tranRec.type,
                recordId: tranRec.id || '',
                executionContext: runtime.executionContext,
                userId: runtime.getCurrentUser().id,
                tranid: safeGetValue(tranRec, 'tranid'),
                orderstatus: safeGetValue(tranRec, 'orderstatus'),
                entity: safeGetValue(tranRec, 'entity'),
                createdFrom: safeGetValue(tranRec, 'createdfrom'),
                lineCount: tranRec.getLineCount({ sublistId: ITEM_SUBLIST })
            });
        } catch (e) {
            log.error(stage + ' HEADER LOG ERROR', e);
        }
    }

    function logLineSnapshot(stage, tranRec, parentChildJson, itemMerchJson) {
        try {
            var lineCount = tranRec.getLineCount({ sublistId: ITEM_SUBLIST });
            var lines = [];

            for (var i = 0; i < lineCount; i++) {
                var itemId = safeGetSublistValue(tranRec, ITEM_SUBLIST, 'item', i);
                itemId = itemId ? String(itemId) : '';

                lines.push({
                    line: i,
                    item: itemId,
                    itemText: safeGetSublistText(tranRec, ITEM_SUBLIST, 'item', i),
                    itemType: safeGetSublistValue(tranRec, ITEM_SUBLIST, 'itemtype', i),
                    quantity: safeGetSublistValue(tranRec, ITEM_SUBLIST, 'quantity', i),
                    rate: safeGetSublistValue(tranRec, ITEM_SUBLIST, 'rate', i),
                    price: safeGetSublistValue(tranRec, ITEM_SUBLIST, 'price', i),
                    amount: safeGetSublistValue(tranRec, ITEM_SUBLIST, 'amount', i),
                    location: safeGetSublistValue(tranRec, ITEM_SUBLIST, 'location', i),
                    parentCol: safeGetSublistValue(tranRec, ITEM_SUBLIST, PARENT_COLUMN_FIELD, i),
                    typeCol: safeGetSublistValue(tranRec, ITEM_SUBLIST, TYPE_COLUMN_FIELD, i),
                    fulfillmentKey: safeGetSublistValue(tranRec, ITEM_SUBLIST, FULFILLMENT_KEY_FIELD, i),
                    lineUniqueKey: safeGetSublistValue(tranRec, ITEM_SUBLIST, 'lineuniquekey', i),
                    foundInParentChildJson: itemId && parentChildJson && parentChildJson[itemId] ? 'YES' : 'NO',
                    merchValue: itemId && itemMerchJson ? itemMerchJson[itemId] || '' : ''
                });
            }

            log.audit(stage + ' LINE SNAPSHOT', JSON.stringify(lines));

        } catch (e) {
            log.error(stage + ' LINE SNAPSHOT ERROR', e);
        }
    }

    function logParentCandidate(stage, line, itemId, qty, rate, parentChildJson) {
        try {
            log.debug(stage + ' PARENT CANDIDATE CHECK', {
                line: line,
                itemId: itemId,
                quantity: qty,
                rateRaw: rate,
                rateNumber: toNumber(rate),
                hasRelatedComponents: itemId && parentChildJson && parentChildJson[String(itemId)] ? 'YES' : 'NO',
                rateIsZero: sameNumber(rate, 0) ? 'YES' : 'NO',
                finalParentCondition: itemId && parentChildJson && parentChildJson[String(itemId)] && sameNumber(rate, 0) ? 'YES' : 'NO'
            });
        } catch (e) {
            log.error(stage + ' PARENT CANDIDATE LOG ERROR', e);
        }
    }

    function safeGetValue(rec, fieldId) {
        try {
            return rec.getValue({ fieldId: fieldId });
        } catch (e) {
            return 'ERROR: ' + e.message;
        }
    }

    function safeGetSublistValue(rec, sublistId, fieldId, line) {
        try {
            return rec.getSublistValue({
                sublistId: sublistId,
                fieldId: fieldId,
                line: line
            });
        } catch (e) {
            return 'ERROR: ' + e.message;
        }
    }

    function safeGetSublistText(rec, sublistId, fieldId, line) {
        try {
            return rec.getSublistText({
                sublistId: sublistId,
                fieldId: fieldId,
                line: line
            });
        } catch (e) {
            return '';
        }
    }

    return {
        beforeSubmit: beforeSubmit,
        afterSubmit: afterSubmit
    };
});