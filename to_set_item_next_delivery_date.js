/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @description On TO create/edit, for each item on the TO find the earliest
 *              expected delivery date across all OPEN transfer orders and set
 *              it on the item's custitem_next_delivery_date field.
 */
define(['N/search', 'N/record', 'N/format', 'N/log'], (search, record, format, log) => {

    // Open TO statuses (Pending Receipt, Partially Received, etc.) – same set you used in your searches
    const OPEN_TO_STATUSES = ['TrnfrOrd:B', 'TrnfrOrd:D', 'TrnfrOrd:E', 'TrnfrOrd:F'];

    // Map the item "type" search value to the record type submitFields needs.
    // Use the literal string ids (record.Type.INVENTORY_ITEM === 'inventoryitem')
    // because SuiteScript API modules are NOT available during the define callback,
    // so we can't reference record.Type.* at module load time.
    const ITEM_TYPE_TO_RECORD_TYPE = {
        'InvtPart': 'inventoryitem',
        'Assembly': 'assemblyitem',
        'Kit': 'kititem',
        'NonInvtPart': 'noninventoryitem'
    };

    const afterSubmit = (context) => {
        try {
            // Only on create and edit
            if (context.type !== context.UserEventType.CREATE &&
                context.type !== context.UserEventType.EDIT) {
                return;
            }

            const toRecord = context.newRecord;

            // 1. Collect the distinct item IDs sitting on this TO (no search needed)
            const itemIds = getItemIdsFromRecord(toRecord);
            if (!itemIds.length) {
                log.debug('No items on TO ' + toRecord.id, 'Nothing to do');
                return;
            }

            // 2. One grouped search: earliest delivery date + item type, per item, across all open TOs
            const itemData = getEarliestDeliveryByItem(itemIds);

            // 3. Write the earliest date onto each item record
            updateItems(itemData);

        } catch (e) {
            log.error('afterSubmit failed', e);
        }
    };

    /**
     * Read distinct item internal IDs off the TO's "item" sublist.
     */
    const getItemIdsFromRecord = (toRecord) => {
        const ids = [];
        const lineCount = toRecord.getLineCount({ sublistId: 'item' });
        for (let i = 0; i < lineCount; i++) {
            const itemId = toRecord.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i });
            if (itemId && ids.indexOf(itemId) === -1) {
                ids.push(itemId);
            }
        }
        return ids;
    };

    /**
     * For the given item IDs, find the earliest expected delivery date across all
     * open transfer orders. Returns: { itemId: { date: 'M/D/YYYY', type: 'InvtPart' } }
     */
    const getEarliestDeliveryByItem = (itemIds) => {
        const result = {};

        const s = search.create({
            type: 'transferorder',
            filters: [
                ['type', 'anyof', 'TrnfrOrd'],
                'AND',
                ['mainline', 'is', 'F'],
                'AND',
                ['item', 'anyof', itemIds],
                'AND',
                ['item.type', 'anyof', 'InvtPart', 'Assembly', 'Kit'],
                'AND',
                ['custbody_expecteddeliverydate', 'isnotempty', ''],
                'AND',
                ['transactionlinetype', 'anyof', 'ITEM'],
                'AND',
                ['status', 'anyof', OPEN_TO_STATUSES]
            ],
            columns: [
                search.createColumn({ name: 'item', summary: search.Summary.GROUP }),
                search.createColumn({ name: 'type', join: 'item', summary: search.Summary.GROUP }),
                search.createColumn({ name: 'custbody_expecteddeliverydate', summary: search.Summary.MIN })
            ]
        });

        s.run().each((row) => {
            const itemId = row.getValue({ name: 'item', summary: search.Summary.GROUP });
            const itemType = row.getValue({ name: 'type', join: 'item', summary: search.Summary.GROUP });
            const minDate = row.getValue({ name: 'custbody_expecteddeliverydate', summary: search.Summary.MIN });
            if (itemId && minDate) {
                result[itemId] = { date: minDate, type: itemType };
            }
            return true; // grouped results are well under 4,000
        });

        return result;
    };

    /**
     * submitFields the earliest date onto each item. Date string is parsed to a
     * Date object so submitFields accepts it regardless of company date format.
     */
//     const updateItems = (itemData) => {
//         Object.keys(itemData).forEach((itemId) => {
//             const { date, type } = itemData[itemId];
//             const recordType = ITEM_TYPE_TO_RECORD_TYPE[type];

//             if (!recordType) {
//                 log.error('Unmapped item type', 'Item ' + itemId + ' has type "' + type + '" — skipped');
//                 return;
//             }

//             try {
//                 // const parsedDate = format.parse({ value: date, type: format.Type.DATE });
//                 // record.submitFields({
//                 //     type: recordType,
//                 //     id: itemId,
//                 //     values: { custitem_next_delivery_date: parsedDate },
//                 //     options: { enableSourcing: false, ignoreMandatoryFields: true }
//                 // });

// const parsedDate = format.parse({
//     value: date,
//     type: format.Type.DATE
// });

// // Create UTC/GMT DateTime.
// // Using 12:00 PM UTC so the date does not move back one day in NetSuite UI.
// const utcDateTime = new Date(Date.UTC(
//     parsedDate.getFullYear(),
//     parsedDate.getMonth(),
//     parsedDate.getDate(),
//     12,
//     0,
//     0
// ));

// // UTC formatted string for logs / Celigo / Shopify metafield
// const utcDateTimeString = utcDateTime.toISOString().replace('.000Z', 'Z');

// record.submitFields({
//     type: recordType,
//     id: itemId,
//     values: {
//         custitem_next_delivery_date: utcDateTime
//     },
//     options: {
//         enableSourcing: false,
//         ignoreMandatoryFields: true
//     }
// });


// log.debug('Updated item ' + itemId, {
//     nextDeliveryDateFromTO: date,
//     gmtDateTime: gmtDateTime.toISOString()
// });
//                 log.debug('Updated item ' + itemId, 'Next delivery date -> ' + date);
//             } catch (e) {
//                 log.error('Failed to update item ' + itemId, e);
//             }
//         });
//     };
    const updateItems = (itemData) => {
        Object.keys(itemData).forEach((itemId) => {
            const { date, type } = itemData[itemId];
            const recordType = ITEM_TYPE_TO_RECORD_TYPE[type];

            if (!recordType) {
                log.error('Unmapped item type', 'Item ' + itemId + ' has type "' + type + '" — skipped');
                return;
            }

            try {
                const parsedDate = format.parse({
                    value: date,
                    type: format.Type.DATE
                });

                const utcDateTimeString = buildUtcDateTimeString(parsedDate);

                record.submitFields({
                    type: recordType,
                    id: itemId,
                    values: {
                        custitem_next_delivery_date: utcDateTimeString
                    },
                    options: {
                        enableSourcing: false,
                        ignoreMandatoryFields: true
                    }
                });

                log.debug('Updated item ' + itemId, {
                    nextDeliveryDateFromTO: date,
                    utcDateTimeString: utcDateTimeString
                });

            } catch (e) {
                log.error('Failed to update item ' + itemId, e);
            }
        });
    };

    /**
     * Returns UTC format like:
     * 2026-06-24T15:26:55Z
     *
     * Because TO expected delivery date is only a date, this script sets time as:
     * 00:00:00Z
     */
    const buildUtcDateTimeString = (dateObj) => {
        const year = dateObj.getFullYear();
        const month = pad2(dateObj.getMonth() + 1);
        const day = pad2(dateObj.getDate());

        return year + '-' + month + '-' + day + 'T00:00:00Z';
    };

    const pad2 = (num) => {
        return String(num).padStart(2, '0');
    };
    return { afterSubmit };
});
