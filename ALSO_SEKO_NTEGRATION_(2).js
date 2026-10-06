/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/search','N/record','N/log'], (search, record, log) => {

    const SKIP = [
        'item',
        'line',
        'lineuniquekey',
        'linenumber',
        'id',
        'sys_id',
        'sys_parentid',

        // Old item/system type values - DO NOT restore
        'itemtype',
        'itemsubtype',
        'isnoninventory',
        'olditemid',
        'item_display',

        // Calculated values
        'amount',
        'grossamt',
        'tax1amt',
        'taxrate1',

        // Inventory / commitment calculated values
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

        // Internal relationship/system values
        'linked',
        'discline',
        'orderdoc',
        'orderline',
        'islinefulfilled',
        'itempicked',
        'itempacked',
        'createdpo',

        // Internal sourced values
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


    const getInputData = () => search.create({
        type: 'salesorder',

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

            // TEST ORDER ONLY
            ['internalidnumber','equalto','1049053']
        ],

        columns: [
            search.createColumn({name:'internalid'}),
            search.createColumn({name:'tranid'}),
            search.createColumn({name:'item'}),
            search.createColumn({name:'line'}),
            search.createColumn({name:'lineuniquekey'}),
            search.createColumn({
                name:'internalid',
                join:'item'
            })
        ]
    });


    const map = context => {

        try {

            const r = JSON.parse(context.value);

            const soId = r.id;

            const itemResult = r.values['internalid.item'];
            const itemId = itemResult?.value || itemResult;

            const lineKey = String(r.values.lineuniquekey || '');


            log.audit('Processing', {
                soId,
                itemId,
                lineKey
            });


            // STANDARD MODE / DYNAMIC FALSE
            const so = record.load({
                type: record.Type.SALES_ORDER,
                id: soId,
                isDynamic: false
            });


            // --------------------------------------------------
            // FIND EXACT EXISTING LINE
            // --------------------------------------------------

            let line = -1;

            const count = so.getLineCount({
                sublistId: 'item'
            });


            for(let i = 0; i < count; i++){

                const key = String(
                    so.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'lineuniquekey',
                        line: i
                    }) || ''
                );

                if(key === lineKey){
                    line = i;
                    break;
                }
            }


            if(line === -1){

                log.error('Line Not Found', {
                    soId,
                    itemId,
                    lineKey
                });

                return;
            }


            // --------------------------------------------------
            // SAFETY CHECK
            // --------------------------------------------------

            const fulfilled = Number(
                so.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantityfulfilled',
                    line
                }) || 0
            );

            const billed = Number(
                so.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantitybilled',
                    line
                }) || 0
            );


            if(fulfilled > 0 || billed > 0){

                log.error('Skipped - Fulfilled/Billed', {
                    soId,
                    line,
                    fulfilled,
                    billed
                });

                return;
            }


            // --------------------------------------------------
            // CAPTURE ALL OLD EDITABLE VALUES
            // --------------------------------------------------

            const values = {};

            so.getSublistFields({
                sublistId: 'item'
            }).forEach(field => {

                if(SKIP.includes(field))
                    return;

                try {

                    values[field] = so.getSublistValue({
                        sublistId: 'item',
                        fieldId: field,
                        line
                    });

                } catch(e){}
            });


            log.debug('Old Values Captured', {
                line,
                fieldCount: Object.keys(values).length,
                values
            });


            // --------------------------------------------------
            // SET SAME ITEM AGAIN ON SAME EXISTING LINE
            // NO REMOVE
            // NO INSERT
            // --------------------------------------------------

            so.setSublistValue({
                sublistId: 'item',
                fieldId: 'item',
                line,
                value: Number(itemId)
            });


            log.debug('Same Item Reset', {
                line,
                itemId
            });


            // --------------------------------------------------
            // RESTORE OLD EDITABLE VALUES ON SAME LINE
            // --------------------------------------------------

            const restored = [];
            const skipped = [];


            Object.keys(values).forEach(field => {

                try {

                    so.setSublistValue({
                        sublistId: 'item',
                        fieldId: field,
                        line,
                        value: values[field]
                    });

                    restored.push(field);

                } catch(e){

                    skipped.push({
                        field,
                        value: values[field],
                        error: e.message
                    });
                }
            });


            log.debug('Fields Restored', restored);


            if(skipped.length){
                log.debug('Fields Skipped', skipped);
            }


            // --------------------------------------------------
            // CHECK BEFORE SAVE
            // --------------------------------------------------

            log.audit('Before Save', {

                line,

                item: so.getSublistValue({
                    sublistId:'item',
                    fieldId:'item',
                    line
                }),

                itemType: so.getSublistValue({
                    sublistId:'item',
                    fieldId:'itemtype',
                    line
                }),

                quantity: so.getSublistValue({
                    sublistId:'item',
                    fieldId:'quantity',
                    line
                }),

                rate: so.getSublistValue({
                    sublistId:'item',
                    fieldId:'rate',
                    line
                }),

                location: so.getSublistValue({
                    sublistId:'item',
                    fieldId:'location',
                    line
                }),

                lineUniqueKey: so.getSublistValue({
                    sublistId:'item',
                    fieldId:'lineuniquekey',
                    line
                })
            });


            // --------------------------------------------------
            // SAVE
            // --------------------------------------------------

            const savedId = so.save({
                enableSourcing: true,
                ignoreMandatoryFields: false
            });


            log.audit('SUCCESS', {
                soId: savedId,
                line,
                itemId,
                lineUniqueKey: lineKey,
                restoredFields: restored.length,
                skippedFields: skipped.length
            });


        } catch(e){

            log.error('Map Error', {
                name: e.name,
                message: e.message,
                stack: e.stack
            });
        }
    };


    const summarize = summary => {

        summary.mapSummary.errors.iterator().each((key,error) => {
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