/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/search', 'N/log'], function(record, search, log) {

    var ITEM_SUBLIST = 'item';

    // update these ids if needed
    var PARENT_COLUMN_FIELD = 'custcol_parent_item';
    var RELATED_COMPONENT_FIELD = 'custitem_related_components';
    var SPECIAL_VENDOR_FIELD = 'custentity_special_order_vendor';
    var TYPE_COLUMN_FIELD = 'custcol_item_parentcomp';
    var MERCH_ITEM_FIELD = 'custitem_item_category';
    var FULFILLMENT_KEY_FIELD = 'custcol_3pl_fulfillment_key';
    var PACKAGING_FILLER_FIELD = 'custitem_packaging_filler';

    // allocation strategy update based on item ALSO category
    var ALSO_CATEGORY_FIELD = 'custitem_also_category';
    var ALLOCATION_STRATEGY_FIELD = 'orderallocationstrategy';
    var ALSO_CATEGORY_ALLOCATE_VALUE = '8';
    var MERCH_ALLOCATION_STRATEGY_VALUE = '-2';
    var DO_NOT_ALLOCATE_VALUE = '-1';

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

            var lineItems = getLineItems(tranRec);
            if (!lineItems.length) {
                log.debug('BEFORE SUBMIT STOP', 'No item lines found');
                return;
            }

            var parentChildJson = getParentChildJson(lineItems);
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
                    continue;
                }

                for (var f = 0; f < fillerItems.length; f++) {

                    var fillerItemId = String(fillerItems[f]).replace(/\s+/g, '');

                    if (!fillerItemId) {
                        continue;
                    }

                    if (isFillerAlreadyAdded(tranRec, fillerParentObj.parentItemId, fillerItemId, fillerParentObj.quantity)) {
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
            if (!tranId) return;

          // var giftCardId = context.newRecord.getValue({
          //     fieldId: 'custbody_celigo_shopify_giftcard_id'
          // });

          // if (giftCardId) {
          //     record.submitFields({
          //         type: record.Type.SALES_ORDER,
          //         id: tranId,
          //         values: {
          //            custbody_discount_removed: true
          //         }
          //     });
          //  }

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
                    log.debug('STOP', 'SO is not Pending Approval');
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

            var lineItems = getLineItems(tranRec);
            if (!lineItems.length) {
                log.debug('STOP', 'No item lines found');
                return;
            }

            var parentChildJson = getParentChildJson(lineItems);
            var itemMerchJson = getItemMerchJson(lineItems);
            var itemAlsoCategoryJson = {};

            if (recType === 'salesorder') {
                itemAlsoCategoryJson = getItemAlsoCategoryJson(lineItems);
            }

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
             * NEW LOGIC - PASS 1:
             * Find all parent lines on the order.
             * Parent line condition:
             * 1. Item has custitem_related_components
             * 2. Line rate is 0
             *
             * Parent can be first, middle, or last line.
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
             * - If neither, clear parent/type fields
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
                    continue;
                }

                if (!isAllowedItemType(tranRec, i)) {
                    continue;
                }

                // Already handled as parent
                if (isParentLine(i, parentLines)) {
                    continue;
                }

                // Already handled as component
                if (usedComponentLines[i]) {
                    continue;
                }

                if (String(tranRec.getSublistValue({
                    sublistId: ITEM_SUBLIST,
                    fieldId: TYPE_COLUMN_FIELD,
                    line: i
                }) || '') === TYPE_FILLER) {
                    setFulfillmentKeyFromLineUniqueKey(tranRec, i);
                    hasChanges = true;

                    continue;
                }

                clearParentField(tranRec, i);

                if (itemMerchJson[lineItemId] === MERCH_ON_BIKE_VALUE) {
                    setTypeField(tranRec, i, TYPE_ADDON);
                    setFulfillmentKeyFromLineUniqueKey(tranRec, i);
                    hasChanges = true;

                    continue;
                }

                if (itemMerchJson[lineItemId] === MERCH_OFF_BIKE_VALUE) {
                    setTypeField(tranRec, i, TYPE_MERCH);
                    setFulfillmentKeyFromLineUniqueKey(tranRec, i);
                    hasChanges = true;

                    continue;
                }

                setTypeField(tranRec, i, TYPE_MERCH);
                setFulfillmentKeyFromLineUniqueKey(tranRec, i);
                hasChanges = true;
            }

            if (recType === 'salesorder') {
                if (setAllocationStrategyByAlsoCategory(tranRec, lineCount, itemAlsoCategoryJson)) {
                    hasChanges = true;
                }
            }

            log.audit('SUMMARY', {
                transactionId: tranId,
                recordType: recType,
                parentCount: parentLines.length,
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

        for (i = 0; i < lineCount; i++) {
            var itemId = tranRec.getSublistValue({
                sublistId: ITEM_SUBLIST,
                fieldId: 'item',
                line: i
            });

            if (itemId) {
                itemMap[String(itemId)] = true;
            }
        }

        for (var key in itemMap) {
            arr.push(key);
        }
        return arr;
    }

    function getParentChildJson(itemIds) {
        var json = {};

        search.create({
            type: search.Type.ITEM,
            filters: [
                ['internalid', 'anyof', itemIds],
                'AND',
                [RELATED_COMPONENT_FIELD, 'isnotempty', '']
            ],
            columns: [
                'internalid',
                RELATED_COMPONENT_FIELD
            ]
        }).run().each(function(result) {
            var parentId = result.getValue({ name: 'internalid' });
            var childValue = result.getValue({ name: RELATED_COMPONENT_FIELD });

            parentId = parentId ? String(parentId) : '';

            if (parentId && childValue) {
                json[parentId] = buildChildObject(childValue);
            }
            return true;
        });

        return json;
    }

    function getItemMerchJson(itemIds) {
        var json = {};

        search.create({
            type: search.Type.ITEM,
            filters: [
                ['internalid', 'anyof', itemIds]
            ],
            columns: [
                'internalid',
                MERCH_ITEM_FIELD
            ]
        }).run().each(function(result) {
            var itemId = result.getValue({ name: 'internalid' });
            var merchValue = result.getValue({ name: MERCH_ITEM_FIELD });

            itemId = itemId ? String(itemId) : '';
            merchValue = merchValue ? String(merchValue) : '';

            if (itemId) {
                json[itemId] = merchValue;
            }

            return true;
        });

        return json;
    }

    function getItemAlsoCategoryJson(itemIds) {
        var json = {};

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
                ALSO_CATEGORY_FIELD
            ]
        }).run().each(function(result) {
            var itemId = result.getValue({ name: 'internalid' });
            var alsoCategory = result.getValue({ name: ALSO_CATEGORY_FIELD });

            itemId = itemId ? String(itemId) : '';
            alsoCategory = alsoCategory ? String(alsoCategory) : '';

            if (itemId) {
                json[itemId] = alsoCategory;
            }

            return true;
        });

        return json;
    }

    function setAllocationStrategyByAlsoCategory(tranRec, lineCount, itemAlsoCategoryJson) {
        var changed = false;

        for (var i = 0; i < lineCount; i++) {
            var itemId = tranRec.getSublistValue({
                sublistId: ITEM_SUBLIST,
                fieldId: 'item',
                line: i
            });

            itemId = itemId ? String(itemId) : '';

            if (!itemId) {
                continue;
            }

            if (!isAllowedItemType(tranRec, i)) {
                continue;
            }

            var alsoCategoryValue = itemAlsoCategoryJson[itemId] || '';

            var newStrategy = String(alsoCategoryValue) === ALSO_CATEGORY_ALLOCATE_VALUE
                ? MERCH_ALLOCATION_STRATEGY_VALUE
                : DO_NOT_ALLOCATE_VALUE;

            var currentStrategy = tranRec.getSublistValue({
                sublistId: ITEM_SUBLIST,
                fieldId: ALLOCATION_STRATEGY_FIELD,
                line: i
            });

            currentStrategy = currentStrategy ? String(currentStrategy) : '';

            if (currentStrategy !== String(newStrategy)) {
                tranRec.setSublistValue({
                    sublistId: ITEM_SUBLIST,
                    fieldId: ALLOCATION_STRATEGY_FIELD,
                    line: i,
                    value: newStrategy
                });

                log.debug('ALLOCATION STRATEGY UPDATED BY ALSO CATEGORY', {
                    line: i,
                    itemId: itemId,
                    alsoCategoryValue: alsoCategoryValue,
                    oldStrategy: currentStrategy,
                    newStrategy: newStrategy
                });

                changed = true;
            }
        }

        return changed;
    }

    function getPackagingFillerJson(itemIds) {
        var json = {};

        if (!itemIds || !itemIds.length) {
            return json;
        }

        search.create({
            type: "noninventoryitem",
            filters:
            [
               ["type","anyof","NonInvtPart"],
               "AND",
               ["internalid","anyof", itemIds]
            ],
            columns:
            [
               search.createColumn({name: PACKAGING_FILLER_FIELD})
            ]
        }).run().each(function(result){

            var fillerValues = result.getValue({
                name: PACKAGING_FILLER_FIELD
            });

            var itemId = result.id;

            if (itemId && fillerValues) {
                json[String(itemId)] = String(fillerValues).split(',');
            }
            return true;
        });

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

        return obj;
    }

    function findMatchingComponentLine(tranRec, lineCount, childId, parentQty, usedComponentLines, parentLines) {
        var i;

        for (i = 0; i < lineCount; i++) {
            if (usedComponentLines[i]) {
                continue;
            }

            if (isParentLine(i, parentLines)) {
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

            if (lineItemId === String(childId) && sameNumber(lineQty, parentQty)) {
                return i;
            }
        }

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
    }
}

    function isAllowedItemType(tranRec, line) {
        var lineItemType = tranRec.getSublistValue({
            sublistId: ITEM_SUBLIST,
            fieldId: 'itemtype',
            line: line
        });

        lineItemType = lineItemType ? String(lineItemType) : '';

        return lineItemType === 'InvtPart' || lineItemType === 'NonInvtPart' || lineItemType === 'Assembly';
    }

    return {
        beforeSubmit: beforeSubmit,
        afterSubmit: afterSubmit
    };
});