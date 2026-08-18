/**
 * Sales Order - Duplicate PO/Check Number Warning
 *
 * Fires the moment a user types or pastes a PO number into the
 * PO/Check Number field (otherrefnum) and leaves the field.
 * If any other Sales Order already carries that PO number, the user
 * gets a popup listing the matching orders.
 *
 * Also re-checks on save as a backstop, because fieldChanged never
 * fires if the value is set by a workflow, a copy, or a browser
 * autofill that does not raise a change event.
 *
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 */
define(['N/search', 'N/ui/dialog', 'N/log'], function (search, dialog, log) {

    const PO_FIELD = 'otherrefnum';

    // Set to false to make the save-time check a warning only
    // (user sees the popup but the record still saves).
    const BLOCK_SAVE_ON_DUPLICATE = true;

    // How many matching orders to list in the popup.
    const MAX_MATCHES = 5;

    // Remembers the last value we already warned about so the user
    // is not re-prompted every time they tab through the field.
    let lastCheckedValue = '';
    let lastCheckedHadDuplicate = false;

    /* ---------------------------------------------------------------- */

    function normalize(value) {
        return String(value === null || value === undefined ? '' : value).trim();
    }

    /*
     * IMPORTANT: otherrefnum is a NUMERIC field in the search schema.
     *
     *   ['otherrefnum', 'equalto', 'PO-4471']  ->  returns nothing, no error
     *
     * Any PO number containing a letter, dash or leading zero silently
     * fails that operator. formulatext forces a text comparison, so
     * 'PO-4471', '004471' and '4471' all behave the way a user expects.
     */
    function findDuplicates(poNumber, currentRecordId) {
        const filters = [
            ['type', 'anyof', 'SalesOrd'],
            'AND',
            ['mainline', 'is', 'T'],
            'AND',
            [
                "formulatext: UPPER(TRIM({otherrefnum}))",
                'is',
                poNumber.toUpperCase()
            ]
        ];

        if (currentRecordId) {
            filters.push('AND', ['internalid', 'noneof', String(currentRecordId)]);
        }

        const searchObj = search.create({
            type: search.Type.SALES_ORDER,
            filters: filters,
            columns: [
                search.createColumn({ name: 'tranid' }),
                search.createColumn({ name: 'trandate' }),
                search.createColumn({ name: 'entity' }),
                search.createColumn({ name: 'statusref' })
            ]
        });

        return searchObj.run().getRange({
            start: 0,
            end: MAX_MATCHES + 1
        });
    }

    function buildMessage(poNumber, results) {
        const shown = results.slice(0, MAX_MATCHES);

        const lines = shown.map(function (result) {
            const tranId = result.getValue({ name: 'tranid' }) || '(no number)';
            const date = result.getValue({ name: 'trandate' }) || '';
            const customer = result.getText({ name: 'entity' }) ||
                result.getValue({ name: 'entity' }) || '';
            const status = result.getText({ name: 'statusref' }) || '';

            return '<li><b>' + tranId + '</b>' +
                (customer ? ' &mdash; ' + customer : '') +
                (date ? ' &mdash; ' + date : '') +
                (status ? ' (' + status + ')' : '') +
                '</li>';
        });

        let message = 'PO# <b>' + poNumber +
            '</b> is already used on ' +
            (results.length > MAX_MATCHES ? MAX_MATCHES + '+' : results.length) +
            ' other sales order' + (results.length === 1 ? '' : 's') +
            ':<ul>' + lines.join('') + '</ul>';

        if (results.length > MAX_MATCHES) {
            message += '<i>More matches exist than are shown here.</i><br><br>';
        }

        return message;
    }

    function runCheck(poNumber, recordId) {
        try {
            return findDuplicates(poNumber, recordId);
        } catch (e) {
            log.error({
                title: 'Duplicate PO check failed',
                details: poNumber + ' | ' + (e.message || e)
            });

            return [];
        }
    }

    /* ---------------------------------------------------------------- */

    function pageInit(context) {
        const rec = context.currentRecord;
        // Treat whatever is already on the record as "seen" so opening an
        // existing order does not fire a popup before the user touches it.
        lastCheckedValue = normalize(rec.getValue({ fieldId: PO_FIELD }));
        lastCheckedHadDuplicate = false;
    }

    function fieldChanged(context) {
        if (context.fieldId !== PO_FIELD) {
            return;
        }

        // Body field only — ignore anything typed on a sublist.
        if (context.sublistId) {
            return;
        }

        const rec = context.currentRecord;
        const poNumber = normalize(rec.getValue({ fieldId: PO_FIELD }));

        if (!poNumber) {
            lastCheckedValue = '';
            lastCheckedHadDuplicate = false;
            return;
        }

        if (poNumber === lastCheckedValue) {
            return;
        }

        lastCheckedValue = poNumber;

        const results = runCheck(poNumber, rec.id);
        lastCheckedHadDuplicate = results.length > 0;

        if (!results.length) {
            return;
        }

        dialog.alert({
            title: 'Duplicate PO Number',
            message: buildMessage(poNumber, results) +
                'Check that this is not a duplicate order before saving.'
        });
    }

    function saveRecord(context) {
        const rec = context.currentRecord;
        const poNumber = normalize(rec.getValue({ fieldId: PO_FIELD }));

        if (!poNumber) {
            return true;
        }

        // fieldChanged already cleared this exact value — nothing to do.
        if (poNumber === lastCheckedValue && !lastCheckedHadDuplicate) {
            return true;
        }

        const results = runCheck(poNumber, rec.id);

        if (!results.length) {
            lastCheckedValue = poNumber;
            lastCheckedHadDuplicate = false;
            return true;
        }

        lastCheckedValue = poNumber;
        lastCheckedHadDuplicate = true;

        if (!BLOCK_SAVE_ON_DUPLICATE) {
            dialog.alert({
                title: 'Duplicate PO Number',
                message: buildMessage(poNumber, results) +
                    'Saving anyway.'
            });

            return true;
        }

        dialog.alert({
            title: 'Duplicate PO Number - Save Blocked',
            message: buildMessage(poNumber, results) +
                'Change the PO number, or clear it, to save this order.'
        });

        return false;
    }

    return {
        pageInit: pageInit,
        fieldChanged: fieldChanged,
        saveRecord: saveRecord
    };
});