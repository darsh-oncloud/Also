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
    var MERCH_ITEM_FIELD = 'custitem_merch_item';

    // list values
    var TYPE_PARENT = '1';
    var TYPE_COMPONENT = '2';
    var TYPE_ADDON = '3';
    var TYPE_MERCH = '4';

    function afterSubmit(context) {
        try {
            if (context.type !== context.UserEventType.CREATE &&
                context.type !== context.UserEventType.EDIT) {
                return;
            }

            var poId = context.newRecord.id;
            var recType = context.newRecord.type;
            if (!poId) return;

            if (recType == 'purchaseorder') {
              log.debug('START', 'PO Id: ' + poId);

            var approvalStatus = context.newRecord.getValue({ fieldId: 'approvalstatus' });
            var vendorId = context.newRecord.getValue({ fieldId: 'entity' });

            log.debug('PO Header', {
                poId: poId,
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
            }
            else if (recType == 'salesorder') {
              log.debug('START', 'SO Id: ' + poId);

            var approvalStatus = context.newRecord.getValue({ fieldId: 'orderstatus' });

            log.debug('PO Header', {
                soId: poId,
                approvalStatus: approvalStatus
            });

            if (String(approvalStatus) != 'A') {
                log.debug('STOP', 'SO is not Pending Approval');
//                return;
            }
            }

            // var poLineItems = getPoLineItems(context.newRecord);
            // if (!poLineItems.length) {
            //     log.debug('STOP', 'No item lines found');
            //     return;
            // }

            // var parentChildJson = getParentChildJson(poLineItems);
            // log.debug('Parent Child JSON', JSON.stringify(parentChildJson));

            // var merchItemJson = getMerchItemJson(poLineItems);
            // log.debug('Merch Item JSON', JSON.stringify(merchItemJson));

            // if (!hasKeys(parentChildJson) && !hasKeys(merchItemJson)) {
            //     log.debug('STOP', 'No parent-child setup found');
            //     return;
            // }

            // var poRec = record.load({
            //     type: recType,
            //     id: poId,
            //     isDynamic: false
            // });

var poRec = record.load({
    type: recType,
    id: poId,
    isDynamic: false
});

var poLineItems = getPoLineItems(poRec);
if (!poLineItems.length) {
    log.debug('STOP', 'No item lines found');
    return;
}

var parentChildJson = getParentChildJson(poLineItems);
log.debug('Parent Child JSON', JSON.stringify(parentChildJson));

var merchItemJson = getMerchItemJson(poLineItems);
log.debug('Merch Item JSON', JSON.stringify(merchItemJson));

if (!hasKeys(parentChildJson) && !hasKeys(merchItemJson)) {
    log.debug('STOP', 'No parent-child setup found');
    return;
}
          
            var lineCount = poRec.getLineCount({ sublistId: ITEM_SUBLIST });
            var currentParent = '';
            var usedChildMap = {};
            var hasChanges = false;
            var i;

            for (i = 0; i < lineCount; i++) {
                var lineItemId = poRec.getSublistValue({
                    sublistId: ITEM_SUBLIST,
                    fieldId: 'item',
                    line: i
                });

                var lineRate = poRec.getSublistValue({
                    sublistId: ITEM_SUBLIST,
                    fieldId: 'rate',
                    line: i
                });

                lineItemId = lineItemId ? String(lineItemId) : '';
                lineRate = toNumber(lineRate);

                log.debug('Line Check', {
                    line: i,
                    itemId: lineItemId,
                    rate: lineRate,
                    currentParent: currentParent,
                    usedChildMap: JSON.stringify(usedChildMap)
                });

                if (!lineItemId) {
                    currentParent = '';
                    usedChildMap = {};
                    continue;
                }

                if (merchItemJson[lineItemId]) {
                    currentParent = '';
                    usedChildMap = {};

                    clearParentField(poRec, i);
                    setTypeField(poRec, i, TYPE_MERCH);
                    hasChanges = true;

                    log.debug('MERCH FOUND', {
                        line: i,
                        itemId: lineItemId
                    });

                    continue;
                }

                // parent line = item exists in json key and rate = 0
                if (parentChildJson[lineItemId] && lineRate === 0) {
                    currentParent = lineItemId;
                    usedChildMap = {};

                    clearParentField(poRec, i);
                    setTypeField(poRec, i, TYPE_PARENT);
                    hasChanges = true;

                    log.debug('PARENT FOUND', {
                        line: i,
                        parentItem: currentParent
                    });

                    continue;
                }

                if (currentParent) {
                    var isValidChild = parentChildJson[currentParent] &&
                        parentChildJson[currentParent][lineItemId] &&
                        lineRate > 0;

                    if (isValidChild) {
                        // same child repeated again = separate addon item
                        if (usedChildMap[lineItemId]) {
                            currentParent = '';
                            usedChildMap = {};

                            clearParentField(poRec, i);
                            setTypeField(poRec, i, TYPE_ADDON);
                            hasChanges = true;

                            log.debug('ADDON FOUND', {
                                line: i,
                                itemId: lineItemId,
                                reason: 'Same child repeated under same parent block'
                            });

                            continue;
                        }

                        poRec.setSublistValue({
                            sublistId: ITEM_SUBLIST,
                            fieldId: PARENT_COLUMN_FIELD,
                            line: i,
                            value: currentParent
                        });

                        setTypeField(poRec, i, TYPE_COMPONENT);

                        usedChildMap[lineItemId] = true;
                        hasChanges = true;

                        log.debug('CHILD UPDATED', {
                            line: i,
                            childItem: lineItemId,
                            parentItem: currentParent
                        });

                        continue;
                    }

                    // not a valid child for current parent = separate/addon
                    currentParent = '';
                    usedChildMap = {};

                    clearParentField(poRec, i);
                    setTypeField(poRec, i, TYPE_ADDON);
                    hasChanges = true;

                    log.debug('SEPARATE ITEM FOUND', {
                        line: i,
                        itemId: lineItemId,
                        reason: 'Not a valid child for current parent'
                    });

                    continue;
                }

                // normal separate/addon item
                clearParentField(poRec, i);
                setTypeField(poRec, i, TYPE_ADDON);
                hasChanges = true;
            }

            if (hasChanges) {
                var savedId = poRec.save({
                    enableSourcing: false,
                    ignoreMandatoryFields: true
                });

                log.audit('PO SAVED', 'PO updated successfully: ' + savedId);
            } else {
                log.debug('NO CHANGES', 'No child line needed update');
            }

        } catch (e) {
            log.error({
                title: 'afterSubmit Error',
                details: e
            });
        }
    }

    function getPoLineItems(poRec) {
        var arr = [];
        var itemMap = {};
        var lineCount = poRec.getLineCount({ sublistId: ITEM_SUBLIST });
        var i;

        for (i = 0; i < lineCount; i++) {
            var itemId = poRec.getSublistValue({
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

        log.debug('PO Unique Items', JSON.stringify(arr));
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

            log.debug('Parent Search Row', {
                parentId: parentId,
                childValue: childValue
            });

            return true;
        });

        return json;
    }

    function getMerchItemJson(itemIds) {
        var json = {};

        search.create({
            type: search.Type.ITEM,
            filters: [
                ['internalid', 'anyof', itemIds],
                'AND',
                [MERCH_ITEM_FIELD, 'is', 'T']
            ],
            columns: [
                'internalid'
            ]
        }).run().each(function(result) {
            var itemId = result.getValue({ name: 'internalid' });
            itemId = itemId ? String(itemId) : '';

            if (itemId) {
                json[itemId] = true;
            }

            return true;
        });

        return json;
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

    function clearParentField(poRec, line) {
        try {
            poRec.setSublistValue({
                sublistId: ITEM_SUBLIST,
                fieldId: PARENT_COLUMN_FIELD,
                line: line,
                value: ''
            });
        } catch (e) {}
    }

    function setTypeField(poRec, line, value) {
        try {
            poRec.setSublistValue({
                sublistId: ITEM_SUBLIST,
                fieldId: TYPE_COLUMN_FIELD,
                line: line,
                value: value
            });
        } catch (e) {}
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

    return {
        afterSubmit: afterSubmit
    };
});