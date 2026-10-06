/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/search','N/record','N/log'], (search, record, log) => {

    const SKIP_FIELDS = [
        'item',
        'line',
        'lineuniquekey',

        // NetSuite calculated / system fields
        'amount',
        'grossamt',
        'tax1amt',
        'taxrate1',
        'taxcode_display',
        'quantitycommitted',
        'quantityfulfilled',
        'quantitybilled',
        'quantityshiprecv',
        'quantityavailable',
        'quantityonhand',
        'quantitybackordered',
        'commitinventory',

        // System relationship fields
        'orderdoc',
        'orderline'
    ];

    const getInputData = () => {
        return search.create({
            type: 'salesorder',
            settings: [
                {name:'consolidationtype', value:'ACCTTYPE'}
            ],
            filters: [
                ['type','anyof','SalesOrd'],
                'AND',
                ['mainline','is','F'],
                'AND',
                ['shipping','is','F'],
                'AND',
                ['taxline','is','F'],
                'AND',
                ['status','anyof',
                    'SalesOrd:A',
                    'SalesOrd:D',
                    'SalesOrd:F',
                    'SalesOrd:E',
                    'SalesOrd:B'
                ],
                'AND',
                ['item.type','anyof','InvtPart'],
                'AND',
                ['formulanumeric: CASE WHEN {commit} IS NULL THEN 1 ELSE 0 END','equalto','1'],
                'AND',
                ['internalidnumber','equalto','1049053']
            ],
            columns: [
                search.createColumn({name:'internalid'}),
                search.createColumn({name:'tranid'}),
                search.createColumn({name:'item'}),
                search.createColumn({name:'quantity'}),
                search.createColumn({name:'quantitycommitted'}),
                search.createColumn({name:'quantityshiprecv'}),
                search.createColumn({name:'line'}),
                search.createColumn({name:'lineuniquekey'}),
                search.createColumn({
                    name:'internalid',
                    join:'item'
                })
            ]
        });
    };


    const map = context => {
        try {
            const result = JSON.parse(context.value);

            const soId = result.id;
            const itemId = result.values['internalid.item'].value;
            const lineUniqueKey = result.values.lineuniquekey;
            const lineId = result.values.line;

            log.debug('Processing', {
                soId,
                itemId,
                lineId,
                lineUniqueKey
            });


            const so = record.load({
                type: record.Type.SALES_ORDER,
                id: soId,
                isDynamic: false
            });


            /* ---------------------------------------------------------
             * FIND EXACT OLD LINE
             * --------------------------------------------------------- */

            let targetLine = -1;

            const count = so.getLineCount({
                sublistId:'item'
            });

            for(let i = 0; i < count; i++){

                const key = String(
                    so.getSublistValue({
                        sublistId:'item',
                        fieldId:'lineuniquekey',
                        line:i
                    }) || ''
                );

                if(key === String(lineUniqueKey)){
                    targetLine = i;
                    break;
                }
            }


            if(targetLine === -1){
                log.error('Line Not Found', {
                    soId,
                    itemId,
                    lineUniqueKey
                });
                return;
            }


            /* ---------------------------------------------------------
             * SAFETY CHECKS
             * --------------------------------------------------------- */

            const fulfilled = Number(
                so.getSublistValue({
                    sublistId:'item',
                    fieldId:'quantityfulfilled',
                    line:targetLine
                }) || 0
            );

            const billed = Number(
                so.getSublistValue({
                    sublistId:'item',
                    fieldId:'quantitybilled',
                    line:targetLine
                }) || 0
            );


            if(fulfilled > 0 || billed > 0){
                log.error('Skipped - Fulfilled/Billed Line', {
                    soId,
                    targetLine,
                    fulfilled,
                    billed
                });
                return;
            }


            /* ---------------------------------------------------------
             * GET EVERY FIELD CURRENTLY AVAILABLE ON THE LINE
             * --------------------------------------------------------- */

            const fields = so.getSublistFields({
                sublistId:'item'
            });

            const values = {};


            fields.forEach(fieldId => {

                if(SKIP_FIELDS.includes(fieldId))
                    return;

                try {
                    values[fieldId] = so.getSublistValue({
                        sublistId:'item',
                        fieldId,
                        line:targetLine
                    });
                }
                catch(e){}
            });


            log.debug('Old Line Values', {
                targetLine,
                itemId,
                values
            });


            /* ---------------------------------------------------------
             * REMOVE OLD LINE
             * --------------------------------------------------------- */

            so.removeLine({
                sublistId:'item',
                line:targetLine,
                ignoreRecalc:true
            });


            /* ---------------------------------------------------------
             * INSERT NEW LINE AT SAME POSITION
             * --------------------------------------------------------- */

            so.insertLine({
                sublistId:'item',
                line:targetLine,
                ignoreRecalc:true
            });


            /*
             * VERY IMPORTANT:
             * Item is set first so NetSuite sources it again as the
             * current Inventory Item.
             */
            so.setSublistValue({
                sublistId:'item',
                fieldId:'item',
                line:targetLine,
                value:itemId
            });


            /* ---------------------------------------------------------
             * RESTORE OLD LINE VALUES
             * --------------------------------------------------------- */

            const restored = [];
            const skipped = [];


            Object.keys(values).forEach(fieldId => {

                const value = values[fieldId];

                /*
                 * Do not set undefined values.
                 * Blank values are intentionally allowed.
                 */
                if(value === undefined)
                    return;

                try {

                    so.setSublistValue({
                        sublistId:'item',
                        fieldId,
                        line:targetLine,
                        value:value
                    });

                    restored.push(fieldId);

                }
                catch(e){

                    skipped.push({
                        fieldId,
                        value,
                        error:e.message
                    });
                }

            });


            log.debug('Fields Restored', restored);

            if(skipped.length){
                log.debug('Fields NetSuite Would Not Restore', skipped);
            }


            /* ---------------------------------------------------------
             * SAVE
             * --------------------------------------------------------- */

            const savedId = so.save({
                enableSourcing:true,
                ignoreMandatoryFields:false
            });


            log.audit('Sales Order Updated', {
                soId:savedId,
                itemId,
                oldLineUniqueKey:lineUniqueKey,
                sublistPosition:targetLine,
                restoredFields:restored.length,
                skippedFields:skipped.length
            });


        }
        catch(e){

            log.error('Map Error', {
                error:e.message,
                stack:e.stack
            });
        }
    };


    const summarize = summary => {

        summary.mapSummary.errors.iterator().each((key,error) => {
            log.error(`Map Error ${key}`, error);
            return true;
        });

        log.audit('Complete', {
            usage:summary.usage,
            yields:summary.yields,
            seconds:summary.seconds
        });
    };


    return {
        getInputData,
        map,
        summarize
    };

});