/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/search', 'N/record', 'N/log'], (search, record, log) => {

    // Do NOT copy these fields from old line.
    // NetSuite must recreate/recalculate them.
    const SKIP_FIELDS = [
        'item',
        'line',
        'lineuniquekey',
        'linenumber',
        'sys_id',
        'sys_parentid',
        'id',

        // Old item type/system identity
        'itemtype',
        'itemsubtype',
        'isnoninventory',
        'olditemid',
        'item_display',

        // Calculated amounts
        'amount',
        'grossamt',
        'tax1amt',
        'taxrate1',

        // Inventory/commitment
        'quantitycommitted',
        'quantityfulfilled',
        'quantitybilled',
        'quantityshiprecv',
        'quantityavailable',
        'quantityonhand',
        'quantitybackordered',
        'backordered',
        'commitinventory',
        'commitmentfirm',
        'oldcommitmentfirm',
        'inventorydetailavail',

        // Internal linkage
        'linked',
        'discline',
        'orderdoc',
        'orderline',
        'islinefulfilled',
        'itempicked',
        'itempacked',
        'createdpo',

        // Internal/system sourcing
        'origquantity',
        'initquantity',
        'origlocation',
        'origunits',
        'price_display',
        'pricelevels',
        'unitslist',
        'binitem',
        'locationusesbins',
        'onorder',
        'weightinlb',
        'isposting'
    ];


    const getInputData = () => {

        return search.create({
            type: 'salesorder',
            settings: [
                { name: 'consolidationtype', value: 'ACCTTYPE' }
            ],
            filters: [
                ['type', 'anyof', 'SalesOrd'],
                'AND',
                ['mainline', 'is', 'F'],
                'AND',
                ['shipping', 'is', 'F'],
                'AND',
                ['taxline', 'is', 'F'],
                'AND',
                ['status', 'anyof',
                    'SalesOrd:A',
                    'SalesOrd:D',
                    'SalesOrd:F',
                    'SalesOrd:E',
                    'SalesOrd:B'
                ],
                'AND',
                ['item.type', 'anyof', 'InvtPart'],
                'AND',
                ['formulanumeric: CASE WHEN {commit} IS NULL THEN 1 ELSE 0 END', 'equalto', '1'],
                'AND',

                // TEST ONLY
                ['internalidnumber', 'equalto', '1049053']
            ],
            columns: [
                search.createColumn({ name: 'internalid' }),
                search.createColumn({ name: 'tranid' }),
                search.createColumn({ name: 'item' }),
                search.createColumn({ name: 'line' }),
                search.createColumn({ name: 'lineuniquekey' }),
                search.createColumn({
                    name: 'internalid',
                    join: 'item'
                })
            ]
        });
    };


    const map = context => {

        try {

            const result = JSON.parse(context.value);

            const soId = result.id;

            const itemResult = result.values['internalid.item'];
            const itemId = itemResult && itemResult.value
                ? itemResult.value
                : itemResult;

            const oldLineKey = String(result.values.lineuniquekey || '');


            log.audit('Processing', {
                soId,
                itemId,
                oldLineKey
            });


            // IMPORTANT: STANDARD / NON-DYNAMIC MODE
            const so = record.load({
                type: record.Type.SALES_ORDER,
                id: soId,
                isDynamic: false
            });


            // ----------------------------------------------------
            // FIND EXACT OLD LINE
            // ----------------------------------------------------

            let targetLine = -1;

            const lineCount = so.getLineCount({
                sublistId: 'item'
            });


            for (let i = 0; i < lineCount; i++) {

                const key = String(
                    so.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'lineuniquekey',
                        line: i
                    }) || ''
                );

                if (key === oldLineKey) {
                    targetLine = i;
                    break;
                }
            }


            if (targetLine === -1) {

                log.error('Line Not Found', {
                    soId,
                    itemId,
                    oldLineKey
                });

                return;
            }


            // ----------------------------------------------------
            // SAFETY
            // ----------------------------------------------------

            const fulfilled = Number(
                so.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantityfulfilled',
                    line: targetLine
                }) || 0
            );


            const billed = Number(
                so.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantitybilled',
                    line: targetLine
                }) || 0
            );


            if (fulfilled > 0 || billed > 0) {

                log.error('SKIPPED - Fulfilled/Billed', {
                    soId,
                    targetLine,
                    fulfilled,
                    billed
                });

                return;
            }


            // ----------------------------------------------------
            // CAPTURE OLD LINE VALUES
            // ----------------------------------------------------

            const fields = so.getSublistFields({
                sublistId: 'item'
            });

            const oldValues = {};


            fields.forEach(fieldId => {

                if (SKIP_FIELDS.includes(fieldId))
                    return;

                try {

                    oldValues[fieldId] = so.getSublistValue({
                        sublistId: 'item',
                        fieldId,
                        line: targetLine
                    });

                } catch (e) {}
            });


            log.debug('Old Line Captured', {
                targetLine,
                itemId,
                fieldCount: Object.keys(oldValues).length,
                oldValues
            });


            // ----------------------------------------------------
            // REMOVE OLD LINE
            // ----------------------------------------------------

            so.removeLine({
                sublistId: 'item',
                line: targetLine,
                ignoreRecalc: true
            });


            // ----------------------------------------------------
            // INSERT NEW LINE AT EXACT SAME POSITION
            // ----------------------------------------------------

            so.insertLine({
                sublistId: 'item',
                line: targetLine,
                ignoreRecalc: true
            });


            // ----------------------------------------------------
            // ADD SAME ITEM AGAIN FIRST
            // This makes NetSuite source CURRENT Inventory Item
            // ----------------------------------------------------

            so.setSublistValue({
                sublistId: 'item',
                fieldId: 'item',
                line: targetLine,
                value: Number(itemId)
            });


            log.debug('Item Re-Added', {
                targetLine,
                itemId
            });


            // ----------------------------------------------------
            // RESTORE OLD EDITABLE VALUES
            // ----------------------------------------------------

            const restored = [];
            const skipped = [];


            Object.keys(oldValues).forEach(fieldId => {

                const value = oldValues[fieldId];

                if (value === undefined)
                    return;

                try {

                    so.setSublistValue({
                        sublistId: 'item',
                        fieldId,
                        line: targetLine,
                        value
                    });

                    restored.push(fieldId);

                } catch (e) {

                    skipped.push({
                        fieldId,
                        value,
                        error: e.message
                    });
                }
            });


            log.debug('Fields Restored', restored);


            if (skipped.length) {
                log.debug('Fields Skipped', skipped);
            }


            // ----------------------------------------------------
            // VERIFY BEFORE SAVE
            // ----------------------------------------------------

            log.audit('Before Save', {
                targetLine,

                item: so.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: targetLine
                }),

                itemType: so.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'itemtype',
                    line: targetLine
                }),

                quantity: so.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantity',
                    line: targetLine
                }),

                rate: so.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'rate',
                    line: targetLine
                }),

                location: so.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'location',
                    line: targetLine
                })
            });


            // ----------------------------------------------------
            // SAVE
            // ----------------------------------------------------

            const savedId = so.save({
                enableSourcing: true,
                ignoreMandatoryFields: false
            });


            log.audit('SUCCESS - Sales Order Updated', {
                soId: savedId,
                itemId,
                samePosition: targetLine,
                oldLineUniqueKey: oldLineKey,
                restoredFields: restored.length,
                skippedFields: skipped.length
            });


        } catch (e) {

            log.error('Map Error', {
                name: e.name,
                message: e.message,
                stack: e.stack
            });
        }
    };


    const summarize = summary => {

        summary.mapSummary.errors.iterator().each((key, error) => {
            log.error(`Map Error ${key}`, error);
            return true;
        });


        log.audit('Complete', {
            usage: summary.usage,
            yields: summary.yields,
            seconds: summary.seconds
        });
    };


    return {
        getInputData,
        map,
        summarize
    };

});