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

    // merch list values
    var MERCH_ON_BIKE_VALUE = '1';
    var MERCH_OFF_BIKE_VALUE = '2';

    function afterSubmit(context) {
        try {
            if (context.type !== context.UserEventType.CREATE &&
                context.type !== context.UserEventType.EDIT) {
                return;
            }

            var tranId = context.newRecord.id;
            var recType = context.newRecord.type;
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
                    log.debug('STOP', 'SO is not Pending Approval');
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
            log.debug('Parent Child JSON', JSON.stringify(parentChildJson));

            var itemMerchJson = getItemMerchJson(lineItems);
            log.debug('Item Merch JSON', JSON.stringify(itemMerchJson));

            if (!hasKeys(parentChildJson) && !hasKeys(itemMerchJson)) {
                log.debug('STOP', 'No parent-child setup and no merch/onbike-offbike items found');
                return;
            }

            var lineCount = tranRec.getLineCount({ sublistId: ITEM_SUBLIST });
            var currentParent = '';
            var usedChildMap = {};
            var hasChanges = false;
            var i;

            for (i = 0; i < lineCount; i++) {
                var lineItemId = tranRec.getSublistValue({
                    sublistId: ITEM_SUBLIST,
                    fieldId: 'item',
                    line: i
                });

                var lineRate = tranRec.getSublistValue({
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

                // parent line = item exists in json key and rate = 0
                if (parentChildJson[lineItemId] && lineRate === 0) {
                    currentParent = lineItemId;
                    usedChildMap = {};

                    clearParentField(tranRec, i);
                    setTypeField(tranRec, i, TYPE_PARENT);
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
                        // same child repeated again = no longer component, classify by merch field
                        if (usedChildMap[lineItemId]) {
                            currentParent = '';
                            usedChildMap = {};

                            clearParentField(tranRec, i);
                            setTypeByMerchField(tranRec, i, lineItemId, itemMerchJson);
                            hasChanges = true;

                            log.debug('REPEATED CHILD CLASSIFIED', {
                                line: i,
                                itemId: lineItemId,
                                merchValue: itemMerchJson[lineItemId] || ''
                            });

                            continue;
                        }

                        tranRec.setSublistValue({
                            sublistId: ITEM_SUBLIST,
                            fieldId: PARENT_COLUMN_FIELD,
                            line: i,
                            value: currentParent
                        });

                        setTypeField(tranRec, i, TYPE_COMPONENT);

                        usedChildMap[lineItemId] = true;
                        hasChanges = true;

                        log.debug('CHILD UPDATED', {
                            line: i,
                            childItem: lineItemId,
                            parentItem: currentParent
                        });

                        continue;
                    }

                    // not a valid child for current parent
                    currentParent = '';
                    usedChildMap = {};

                    clearParentField(tranRec, i);
                    setTypeByMerchField(tranRec, i, lineItemId, itemMerchJson);
                    hasChanges = true;

                    log.debug('SEPARATE ITEM CLASSIFIED', {
                        line: i,
                        itemId: lineItemId,
                        merchValue: itemMerchJson[lineItemId] || ''
                    });

                    continue;
                }

                // normal separate line
                clearParentField(tranRec, i);
                setTypeByMerchField(tranRec, i, lineItemId, itemMerchJson);
                hasChanges = true;
            }

            if (hasChanges) {
                var savedId = tranRec.save({
                    enableSourcing: false,
                    ignoreMandatoryFields: true
                });

                log.audit('TRANSACTION SAVED', recType + ' updated successfully: ' + savedId);
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

        log.debug('Unique Items', JSON.stringify(arr));
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
        } catch (e) {}
    }

    function clearTypeField(tranRec, line) {
        try {
            tranRec.setSublistValue({
                sublistId: ITEM_SUBLIST,
                fieldId: TYPE_COLUMN_FIELD,
                line: line,
                value: ''
            });
        } catch (e) {}
    }

    function setTypeField(tranRec, line, value) {
        try {
            tranRec.setSublistValue({
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