/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/https', 'N/log'], (https, log) => {

    // =========================================================
    // CONFIG
    // =========================================================
    const SHOPIFY_STORE = 'ride-also-sandbox.myshopify.com';
    const SHOPIFY_TOKEN = 'PASTE_SHOPIFY_ACCESS_TOKEN_HERE';
    const API_VERSION   = '2026-07';

    // Change this if you create the field with a different ID
    const SHOPIFY_RETURN_FIELD = 'custbody_celigo_etail_returns_id';

    // Existing Celigo field - only used for logging
    const SHOPIFY_ORDER_FIELD = 'custbody_celigo_etail_order_id';

    // NetSuite fee items
    const SHIPPING_FEE_ITEM   = 6360;
    const RESTOCKING_FEE_ITEM = 6361;


    const beforeSubmit = (context) => {

        // Only when Celigo creates the RMA
        if (context.type !== context.UserEventType.CREATE) {
            return;
        }

        try {
            const rma = context.newRecord;

            // No record.load - get values directly from newRecord
            const returnId = String(
                rma.getValue({
                    fieldId: SHOPIFY_RETURN_FIELD
                }) || ''
            ).trim();

            const orderId = String(
                rma.getValue({
                    fieldId: SHOPIFY_ORDER_FIELD
                }) || ''
            ).trim();

            log.audit('Shopify Return Fee - Start', {
                rmaId: rma.id || 'New RMA',
                shopifyOrderId: orderId,
                shopifyReturnId: returnId
            });


            // Cannot do anything without Shopify Return ID
            if (!returnId) {
                log.audit(
                    'Shopify Return Fee - Skipped',
                    'Shopify Return ID is blank'
                );
                return;
            }


            // Celigo may send:
            // 42912186431
            //
            // or:
            // gid://shopify/Return/42912186431

            const returnGid = returnId.indexOf('gid://') === 0
                ? returnId
                : 'gid://shopify/Return/' + returnId;


            // =====================================================
            // SHOPIFY GRAPHQL
            // =====================================================

            const query = `
                query GetReturnFees($id: ID!) {
                    return(id: $id) {
                        id
                        name

                        returnShippingFees {
                            id
                            amountSet {
                                presentmentMoney {
                                    amount
                                    currencyCode
                                }
                            }
                        }

                        returnLineItems(first: 250) {
                            nodes {
                                ... on ReturnLineItem {
                                    id
                                    restockingFee {
                                        id
                                        percentage
                                        amountSet {
                                            presentmentMoney {
                                                amount
                                                currencyCode
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            `;


            const response = https.post({
                url:
                    'https://' +
                    SHOPIFY_STORE +
                    '/admin/api/' +
                    API_VERSION +
                    '/graphql.json',

                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Access-Token': SHOPIFY_TOKEN
                },

                body: JSON.stringify({
                    query: query,
                    variables: {
                        id: returnGid
                    }
                })
            });


            log.debug('Shopify HTTP Response', {
                code: response.code,
                body: response.body
            });


            if (Number(response.code) < 200 ||
                Number(response.code) >= 300) {

                log.error(
                    'Shopify HTTP Error',
                    response.body
                );

                return;
            }


            const json = JSON.parse(response.body);


            if (json.errors && json.errors.length) {
                log.error(
                    'Shopify GraphQL Error',
                    JSON.stringify(json.errors)
                );
                return;
            }


            const returnData =
                json &&
                json.data &&
                json.data.return;


            if (!returnData) {
                log.error(
                    'Shopify Return Not Found',
                    returnGid
                );
                return;
            }


            log.audit('Shopify Return Found', {
                id: returnData.id,
                name: returnData.name
            });


            // =====================================================
            // SHIPPING FEE TOTAL
            // =====================================================

            let shippingFee = 0;

            (returnData.returnShippingFees || []).forEach(fee => {

                const money =
                    fee &&
                    fee.amountSet &&
                    fee.amountSet.presentmentMoney;

                if (money) {
                    shippingFee += Number(money.amount || 0);
                }
            });


            // =====================================================
            // RESTOCKING FEE TOTAL
            // Sum restocking fees from ALL returned items
            // =====================================================

            let restockingFee = 0;

            const returnLines =
                returnData.returnLineItems &&
                returnData.returnLineItems.nodes
                    ? returnData.returnLineItems.nodes
                    : [];


            returnLines.forEach(line => {

                const money =
                    line &&
                    line.restockingFee &&
                    line.restockingFee.amountSet &&
                    line.restockingFee.amountSet.presentmentMoney;

                if (money) {
                    restockingFee += Number(money.amount || 0);
                }
            });


            shippingFee =
                Math.round((shippingFee + Number.EPSILON) * 100) / 100;

            restockingFee =
                Math.round((restockingFee + Number.EPSILON) * 100) / 100;


            log.audit('Shopify Return Fees', {
                returnId: returnData.id,
                returnName: returnData.name,
                shippingFee: shippingFee,
                restockingFee: restockingFee
            });


            // =====================================================
            // ADD SHIPPING FEE ITEM - 6360
            // =====================================================

            if (shippingFee > 0) {

                let line = rma.getLineCount({
                    sublistId: 'item'
                });


                rma.insertLine({
                    sublistId: 'item',
                    line: line
                });


                rma.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: line,
                    value: SHIPPING_FEE_ITEM
                });


                rma.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantity',
                    line: line,
                    value: 1
                });


                // Custom price level
                rma.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'price',
                    line: line,
                    value: -1
                });


                // Negative because fee reduces customer refund
                rma.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'rate',
                    line: line,
                    value: -Math.abs(shippingFee)
                });


                log.audit(
                    'Shipping Fee Added',
                    'Item 6360 | Amount: -' + shippingFee
                );
            }


            // =====================================================
            // ADD RESTOCKING FEE ITEM - 6361
            // =====================================================

            if (restockingFee > 0) {

                let line = rma.getLineCount({
                    sublistId: 'item'
                });


                rma.insertLine({
                    sublistId: 'item',
                    line: line
                });


                rma.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: line,
                    value: RESTOCKING_FEE_ITEM
                });


                rma.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantity',
                    line: line,
                    value: 1
                });


                // Custom price level
                rma.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'price',
                    line: line,
                    value: -1
                });


                // Negative because fee reduces customer refund
                rma.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'rate',
                    line: line,
                    value: -Math.abs(restockingFee)
                });


                log.audit(
                    'Restocking Fee Added',
                    'Item 6361 | Amount: -' + restockingFee
                );
            }


            log.audit('Shopify Return Fee - Complete', {
                shippingAdded: shippingFee,
                restockingAdded: restockingFee
            });


        } catch (e) {

            // Do not stop Celigo from creating the RMA
            log.error('Shopify Return Fee Error', {
                name: e.name,
                message: e.message,
                stack: e.stack
            });
        }
    };


    return {
        beforeSubmit
    };

});
