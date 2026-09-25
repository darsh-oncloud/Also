/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define([
	'N/record',
	'N/runtime',
	'N/log',
	'N/search',
	'./AVA_Library',
	'./AVA_CommonServerFunctions',
	'./AVA_TaxLibrary'
], (record, runtime, log, search, avaLibrary, avaCommonFunction, avaTaxLibrary) => {
	const SCRIPT_VERSION = '2026-08-20-v3-positional-sublist-api';
	const PAGE_PREFIX = 'custpage_ava_';
	const DISABLE_TAX_FIELD = 'custbody_ava_disable_tax_calculation';

	function afterSubmit(context) {
		const newRecord = context.newRecord;
		const script = runtime.getCurrentScript();
		const rawDisableValue = newRecord ? safeGetValue(newRecord, DISABLE_TAX_FIELD) : null;
        const recType = newRecord ? newRecord.type : '';
        const isInvoiceCreate = recType === record.Type.INVOICE || recType === 'invoice';

		log.audit({
			title: 'AVA Celigo SO Tax UE: afterSubmit entered',
			details: {
				eventType: context.type,
				executionContext: runtime.executionContext,
				scriptId: script.id,
				deploymentId: script.deploymentId,
				scriptVersion: SCRIPT_VERSION,
				recordType: newRecord ? newRecord.type : '',
				recordId: newRecord ? newRecord.id : '',
				disableTaxRawValue: rawDisableValue
			}
		});

		if (context.type !== context.UserEventType.CREATE) {
			log.audit({
				title: 'AVA Celigo SO Tax UE: skipped',
				details: {
					reason: 'Not a CREATE event',
					eventType: context.type,
					recordId: newRecord ? newRecord.id : ''
				}
			});
			return;
		}

		if (!isInvoiceCreate && !isChecked(rawDisableValue)) {
			log.audit({
				title: 'AVA Celigo SO Tax UE: skipped',
				details: {
					reason: 'Disable tax calculation checkbox is not checked',
					recordId: newRecord.id,
					disableTaxRawValue: rawDisableValue
				}
			});
			return;
		}

		const salesOrderId = newRecord.id;
		try {
			log.audit({
				title: 'AVA Celigo SO Tax UE: processing started',
				details: {
					salesOrderId,
					executionContext: runtime.executionContext
				}
			});

			const soRecord = record.load({
				type: recType,
				id: salesOrderId,
				isDynamic: false
			});


          if (isInvoiceCreate && !isChecked(safeGetValue(soRecord, DISABLE_TAX_FIELD))) {
	soRecord.setValue({
		fieldId: DISABLE_TAX_FIELD,
		value: true,
		ignoreFieldChange: true
	});

	log.audit({
		title: 'AVA Celigo SO Tax UE: invoice disable tax checkbox set',
		details: {
			recordId: salesOrderId,
			recordType: recType
		}
	});
}
          

			log.debug({
				title: 'AVA Celigo SO Tax UE: Sales Order loaded',
				details: {
					salesOrderId,
					tranId: safeGetValue(soRecord, 'tranid'),
					entity: safeGetValue(soRecord, 'entity'),
					itemLineCount: safeGetLineCount(soRecord, 'item'),
					totalBeforeTaxCall: safeGetValue(soRecord, 'total'),
					taxAmountOverrideBeforeTaxCall: safeGetValue(soRecord, 'taxamountoverride'),
					disableTaxOnLoadedRecord: safeGetValue(soRecord, DISABLE_TAX_FIELD)
				}
			});

			const rawConfig = avaLibrary.AVA_LoadValuesToGlobals();
			if (!rawConfig) {
				throw new Error('AvaTax configuration was not found.');
			}

			const config = asObject(rawConfig);
			const configText = asJsonText(rawConfig);

			log.debug({
				title: 'AVA Celigo SO Tax UE: AvaTax config loaded',
				details: {
					rawConfigType: typeof rawConfig,
					serviceTypes: config.AVA_ServiceTypes,
					calculateOnDemand: config.AVA_CalculateonDemand,
					disableTaxSalesOrder: config.AVA_DisableTaxSalesOrder,
					disableLine: config.AVA_DisableLine,
					taxInclude: config.AVA_TaxInclude,
					enableDiscount: config.AVA_EnableDiscount
				}
			});

			if (!config.AVA_ServiceTypes || config.AVA_ServiceTypes.indexOf('TaxSvc') === -1) {
				throw new Error('AvaTax TaxSvc is not enabled.');
			}

			const subsidiaryText = asJsonText(avaLibrary.AVA_GetSubsidiaryDetails());
			const details = getConnectionDetails(config);
			const pageValues = buildPageValues(soRecord, configText, subsidiaryText, details,recType);
			const proxyRecord = createRecordProxy(soRecord, pageValues);
			const messages = [];

			log.debug({
				title: 'AVA Celigo SO Tax UE: synthetic AvaTax page values prepared',
				details: {
					salesOrderId,
					context: pageValues.custpage_ava_context,
					taxCodeStatus: pageValues.custpage_ava_taxcodestatus,
					taxFieldFlag: pageValues.custpage_ava_taxfieldflag,
					lineLocation: pageValues.custpage_ava_lineloc,
					hasSubsidiaryCache: subsidiaryText.length > 0,
					hasConnectionDetails: details.length > 0,
					disableTaxValuePresentedToAvalara: pageValues.custbody_ava_disable_tax_calculation
				}
			});

			installLegacyClientShims(proxyRecord, messages);

			avaTaxLibrary.AVA_CalculateTaxOnDemand(proxyRecord, new Date());

			log.audit({
				title: 'AVA Celigo SO Tax UE: Avalara on-demand tax function completed',
				details: {
					salesOrderId,
					taxCodeStatus: pageValues.custpage_ava_taxcodestatus,
					documentFlag: pageValues.custpage_ava_document,
					noteMessage: pageValues.custpage_ava_notemsg,
					taxAmountOverrideAfterTaxCall: safeGetValue(soRecord, 'taxamountoverride'),
					taxAmount2OverrideAfterTaxCall: safeGetValue(soRecord, 'taxamount2override'),
					totalAfterTaxCall: safeGetValue(soRecord, 'total'),
					messages
				}
			});

			const savedId = soRecord.save({
				enableSourcing: true,
				ignoreMandatoryFields: false
			});

			log.audit({
				title: 'AVA Celigo SO Tax UE: Sales Order saved after tax calculation',
				details: {
					salesOrderId: savedId,
					taxAmountOverride: safeGetValue(soRecord, 'taxamountoverride'),
					taxAmount2Override: safeGetValue(soRecord, 'taxamount2override'),
					total: safeGetValue(soRecord, 'total')
				}
			});
		}
		catch (error) {
			logError('Celigo Sales Order AvaTax afterSubmit failed', error, salesOrderId);
		}
	}

	function getConnectionDetails(config) {
		if (config.AVA_AdditionalInfo3) {
			return config.AVA_AdditionalInfo3;
		}

		if (config.AVA_AdditionalInfo) {
			return avaCommonFunction.mainFunction(
				'AVA_General',
				config.AVA_AccountValue + '+' +
					config.AVA_AdditionalInfo + '+' +
					config.AVA_AdditionalInfo1 + '+' +
					config.AVA_AdditionalInfo2
			);
		}

		return '';
	}

	function asObject(value) {
		return typeof value === 'string' ? JSON.parse(value) : value;
	}

	function asJsonText(value) {
		if (value == null || value === '') {
			return '';
		}

		return typeof value === 'string' ? value : JSON.stringify(value);
	}

	function isChecked(value) {
		return value === true || value === 'T';
	}

	function buildPageValues(soRecord, configText, subsidiaryText, details,recType) {
		const hasLineLocation = safeGetSublistField(soRecord, 'item', 'location') !== null;
		const shippingCost = toNumber(safeGetValue(soRecord, 'shippingcost'));
		const handlingCost = toNumber(safeGetValue(soRecord, 'handlingcost'));

		return {
			custpage_ava_configobj: configText,
			custpage_ava_details: details || '',
			custpage_ava_context: 'USEREVENT',
			custpage_ava_recordtype: recType,
			custpage_ava_createdfromrecordid: '',
			custpage_ava_createdfromrecordtype: '',
			custpage_ava_taxfieldflag: true,
			custpage_ava_postingperiod: false,
			custpage_ava_delivery_terms: safeGetValue(soRecord, 'custbody_ava_delivery_terms') || '',
			custpage_ava_usecodeusuage: false,
			custpage_ava_exists: 0,
			custpage_ava_lineloc: hasLineLocation,
			custpage_ava_createfromdate: '',
			custpage_ava_deftax: '',
			custpage_ava_deftaxid: '',
			custpage_ava_taxcodestatus: 0,
			custpage_ava_headerid: findAvaHeaderId(soRecord.id),
			custpage_ava_document: false,
			custpage_ava_billcost: isFeatureEnabled('BILLSCOSTS'),
			custpage_ava_notemsg: '',
			custpage_ava_beforeloadconnector: 0,
			custpage_ava_clientlatency: 0,
			custpage_ava_clientconnector: 0,
			custpage_ava_beforesubmitlatency: 0,
			custpage_ava_beforesubmitconnector: 0,
			custpage_ava_expensereport: isFeatureEnabled('EXPREPORTS'),
			custpage_ava_createdfromscis: false,
			custpage_ava_transactionmode: 'edit',
			custpage_ava_shippingaddressid: safeGetValue(soRecord, 'shipaddresslist') || '',
			custpage_ava_defcompcode: '',
			custpage_ava_shipping: shippingCost !== 0 || !!safeGetValue(soRecord, 'shipmethod'),
			custpage_ava_shiptaxcode: '',
			custpage_ava_handling: handlingCost !== 0,
			custpage_ava_handlingtaxcode: '',
			custpage_ava_formtaxcode: safeGetValue(soRecord, 'taxitem') || '',
			custpage_ava_partnerid: '',
			custpage_ava_formdiscountmapping:
				safeGetValue(soRecord, 'custbody_ava_discountmapping') || '',
			custpage_ava_docstatus: '',
			custpage_ava_totaltaxable: 0,
			custpage_ava_totaltax: 0,
			custpage_ava_gsttax: 0,
			custpage_ava_psttax: 0,
			custbody_ava_subsidiaryobj: subsidiaryText || '',
			custbody_ava_disable_tax_calculation: false
		};
	}

	function createRecordProxy(nsRecord, pageValues) {
		const sublistPageValues = {};

		return new Proxy(nsRecord, {
			get(target, property) {
				if (property === 'getValue') {
					return (options) => getValue(target, pageValues, options);
				}

				if (property === 'setValue') {
					return (options) => setValue(target, pageValues, options);
				}

				if (property === 'getText') {
					return (...args) => getText(target, pageValues, args);
				}

				if (property === 'getField') {
					return (...args) => getField(target, pageValues, args);
				}

				if (property === 'getLineCount') {
					return (...args) => getLineCount(target, args);
				}

				if (property === 'getSublistValue') {
					return (...args) => getSublistValue(target, sublistPageValues, normalizeSublistArgs(args));
				}

				if (property === 'getSublistText') {
					return (...args) => getSublistText(target, sublistPageValues, normalizeSublistArgs(args));
				}

				if (property === 'getSublistField') {
					return (...args) => getSublistField(target, sublistPageValues, normalizeSublistArgs(args));
				}

				if (property === 'setSublistValue') {
					return (...args) => setSublistValue(target, sublistPageValues, normalizeSublistArgs(args));
				}

				if (property === 'getCurrentSublistValue') {
					return (options) => getSublistValue(target, sublistPageValues, {
						sublistId: options.sublistId,
						fieldId: options.fieldId,
						line: target.getCurrentSublistIndex({ sublistId: options.sublistId })
					});
				}

				if (property === 'setCurrentSublistValue') {
					return (options) => setSublistValue(target, sublistPageValues, {
						sublistId: options.sublistId,
						fieldId: options.fieldId,
						line: target.getCurrentSublistIndex({ sublistId: options.sublistId }),
						value: options.value
					});
				}

				const value = target[property];
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
	}

	function getValue(nsRecord, pageValues, options) {
		const fieldId = normalizeFieldId(options);

		if (Object.prototype.hasOwnProperty.call(pageValues, fieldId)) {
			return pageValues[fieldId];
		}

		try {
			const value = nsRecord.getValue(toOptions(options, fieldId));
			if ((value === null || value === '') && fieldId === 'custbody_ava_subsidiaryobj') {
				return pageValues.custbody_ava_subsidiaryobj;
			}
			return value;
		}
		catch (error) {
			if (fieldId && fieldId.indexOf(PAGE_PREFIX) === 0) {
				return '';
			}
			log.debug({
				title: 'AVA Celigo SO Tax UE: getValue unavailable',
				details: {
					fieldId,
					message: error.message
				}
			});
			throw error;
		}
	}

	function setValue(nsRecord, pageValues, options) {
		const fieldId = normalizeFieldId(options);

		if (fieldId.indexOf(PAGE_PREFIX) === 0 ||
			Object.prototype.hasOwnProperty.call(pageValues, fieldId)) {
			pageValues[fieldId] = options.value;
			return nsRecord;
		}

		return nsRecord.setValue(options);
	}

	function getText(nsRecord, pageValues, args) {
		const fieldId = normalizeFieldId(args[0]);

		if (Object.prototype.hasOwnProperty.call(pageValues, fieldId)) {
			return pageValues[fieldId] == null ? '' : String(pageValues[fieldId]);
		}

		try {
			return nsRecord.getText(toOptions(args[0], fieldId));
		}
		catch (error) {
			return '';
		}
	}

	function getField(nsRecord, pageValues, args) {
		const fieldId = normalizeFieldId(args[0]);

		if (Object.prototype.hasOwnProperty.call(pageValues, fieldId)) {
			return {
				id: fieldId,
				isDisplay: false,
				isDisabled: true
			};
		}

		try {
			return nsRecord.getField(toOptions(args[0], fieldId));
		}
		catch (error) {
			return null;
		}
	}

	function getLineCount(nsRecord, args) {
		const sublistId = typeof args[0] === 'string' ? args[0] : args[0].sublistId;

		try {
			return nsRecord.getLineCount({ sublistId });
		}
		catch (error) {
			return 0;
		}
	}

	function getSublistValue(nsRecord, sublistPageValues, options) {
		const fieldId = options.fieldId;

		if (fieldId && fieldId.indexOf(PAGE_PREFIX) === 0) {
			return getStoredSublistValue(sublistPageValues, options.sublistId, fieldId, options.line);
		}

		try {
			return nsRecord.getSublistValue(options);
		}
		catch (error) {
			log.debug({
				title: 'AVA Celigo SO Tax UE: getSublistValue unavailable',
				details: {
					sublistId: options.sublistId,
					fieldId,
					line: options.line,
					message: error.message
				}
			});
			return '';
		}
	}

	function getSublistText(nsRecord, sublistPageValues, options) {
		const fieldId = options.fieldId;

		if (fieldId && fieldId.indexOf(PAGE_PREFIX) === 0) {
			const value = getStoredSublistValue(sublistPageValues, options.sublistId, fieldId, options.line);
			return value == null ? '' : String(value);
		}

		try {
			return nsRecord.getSublistText(options);
		}
		catch (error) {
			const value = safeNativeGetSublistValue(nsRecord, options);
			return value == null ? '' : String(value);
		}
	}

	function getSublistField(nsRecord, sublistPageValues, options) {
		const fieldId = options.fieldId;

		if (fieldId && fieldId.indexOf(PAGE_PREFIX) === 0) {
			return {
				id: fieldId,
				isDisplay: false,
				isDisabled: true
			};
		}

		try {
			return nsRecord.getSublistField(options);
		}
		catch (error) {
			return null;
		}
	}

	function setSublistValue(nsRecord, sublistPageValues, options) {
		const fieldId = options.fieldId;

		if (fieldId && fieldId.indexOf(PAGE_PREFIX) === 0) {
			storeSublistValue(sublistPageValues, options.sublistId, fieldId, options.line, options.value);
			return nsRecord;
		}

		try {
			return nsRecord.setSublistValue(options);
		}
		catch (error) {
			log.debug({
				title: 'AVA Celigo SO Tax UE: setSublistValue unavailable',
				details: {
					sublistId: options.sublistId,
					fieldId,
					line: options.line,
					value: options.value,
					message: error.message
				}
			});
			return nsRecord;
		}
	}

	function safeNativeGetSublistValue(nsRecord, options) {
		try {
			return nsRecord.getSublistValue(options);
		}
		catch (error) {
			return '';
		}
	}

	function installLegacyClientShims(proxyRecord, messages) {
		globalThis.alert = (message) => {
			messages.push(String(message));
			log.audit({
				title: 'AvaTax message',
				details: String(message)
			});
		};

		globalThis.nlapiSetFieldValue = (fieldId, value) => {
			proxyRecord.setValue({
				fieldId,
				value,
				ignoreFieldChange: true
			});
		};

		globalThis.nlapiSetLineItemValue = (sublistId, fieldId, line, value) => {
			proxyRecord.setSublistValue({
				sublistId,
				fieldId,
				line: Number(line) - 1,
				value: normalizeLegacyValue(value)
			});
		};
	}

	function findAvaHeaderId(transactionId) {
		try {
			const result = search.create({
				type: 'customrecord_avataxheaderdetails',
				filters: [
					['custrecord_ava_documentinternalid', 'anyof', transactionId]
				],
				columns: ['internalid']
			}).run().getRange({
				start: 0,
				end: 1
			});

			return result && result.length ? result[0].id : '';
		}
		catch (error) {
			return '';
		}
	}

	function safeGetValue(nsRecord, fieldId) {
		try {
			return nsRecord.getValue({ fieldId });
		}
		catch (error) {
			return null;
		}
	}

	function safeGetSublistField(nsRecord, sublistId, fieldId) {
		try {
			return nsRecord.getSublistField({
				sublistId,
				fieldId,
				line: 0
			});
		}
		catch (error) {
			return null;
		}
	}

	function safeGetLineCount(nsRecord, sublistId) {
		try {
			return nsRecord.getLineCount({ sublistId });
		}
		catch (error) {
			return null;
		}
	}

	function safeDelegate(nsRecord, methodName, options) {
		try {
			return nsRecord[methodName](options);
		}
		catch (error) {
			return '';
		}
	}

	function isFeatureEnabled(feature) {
		try {
			return runtime.isFeatureInEffect({ feature });
		}
		catch (error) {
			return false;
		}
	}

	function normalizeFieldId(options) {
		return typeof options === 'string' ? options : options.fieldId;
	}

	function toOptions(options, fieldId) {
		return typeof options === 'string' ? { fieldId } : options;
	}

	function normalizeSublistArgs(args) {
		if (args.length === 1 && typeof args[0] === 'object') {
			return args[0];
		}

		const options = {
			sublistId: args[0],
			fieldId: args[1],
			line: args[2]
		};

		if (args.length > 3) {
			options.value = args[3];
		}

		return options;
	}

	function getStoredSublistValue(store, sublistId, fieldId, line) {
		if (!store[sublistId] || !store[sublistId][fieldId]) {
			return '';
		}

		if (Object.prototype.hasOwnProperty.call(store[sublistId][fieldId], line)) {
			return store[sublistId][fieldId][line];
		}

		return '';
	}

	function storeSublistValue(store, sublistId, fieldId, line, value) {
		store[sublistId] = store[sublistId] || {};
		store[sublistId][fieldId] = store[sublistId][fieldId] || {};
		store[sublistId][fieldId][line] = value;
	}

	function normalizeLegacyValue(value) {
		if (value === 'T') {
			return true;
		}
		if (value === 'F') {
			return false;
		}
		return value;
	}

	function toNumber(value) {
		const numberValue = Number(value);
		return Number.isFinite(numberValue) ? numberValue : 0;
	}

	function logError(title, error, salesOrderId) {
		log.error({
			title,
			details: {
				salesOrderId,
				name: error.name,
				message: error.message,
				stack: error.stack
			}
		});
	}

	return {
		afterSubmit
	};
});
