/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */
define(['N/search', 'N/log'], function (search, log) {

    var TRANSFER_ORDER_TYPE_CODE = 'TrnfrOrd';

    function beforeLoad(context) {
        log.debug({ title: 'beforeLoad | start', details: 'eventType=' + context.type + ' | recordId=' + context.newRecord.id });

        try {
            if (context.type !== context.UserEventType.VIEW) {
                log.debug({ title: 'beforeLoad | skip', details: 'Not a VIEW event, exiting.' });
                return;
            }

            var createdFromId = context.newRecord.getValue({ fieldId: 'createdfrom' });
            if (!createdFromId) {
                log.debug({ title: 'beforeLoad | skip', details: 'No createdfrom value on this Item Fulfillment.' });
                return;
            }

            var lookup = search.lookupFields({
                type: search.Type.TRANSACTION,
                id: createdFromId,
                columns: ['type']
            });
            var sourceTypeCode = lookup && lookup.type && lookup.type[0] ? lookup.type[0].value : null;
            log.debug({ title: 'beforeLoad | createdfrom type', details: 'createdFromId=' + createdFromId + ' | sourceTypeCode=' + sourceTypeCode });

            if (sourceTypeCode !== TRANSFER_ORDER_TYPE_CODE) {
                log.debug({ title: 'beforeLoad | skip', details: 'Not sourced from a Transfer Order (sourceTypeCode=' + sourceTypeCode + ').' });
                return;
            }

            var ifId = context.newRecord.id;
            var suiteletUrl = '/app/site/hosting/scriptlet.nl'
                + '?script=customscript_also_if_printcomminv_sl'
                + '&deploy=customdeploy_also_if_printcomminv_sl'
                + '&ifid=' + ifId;

            context.form.addButton({
                id:           'custpage_btn_print_comm_invoice',
                label:        'Print Commercial Invoice',
                functionName: "window.open('" + suiteletUrl + "')"
            });

            log.audit({ title: 'beforeLoad | button added', details: 'Print Commercial Invoice button added for IF ' + ifId });

        } catch (e) {
            log.error({ title: 'beforeLoad | ERROR', details: 'name=' + e.name + ' | id=' + e.id + ' | message=' + e.message + ' | stack=' + e.stack });
        }
    }

    return { beforeLoad: beforeLoad };
});
