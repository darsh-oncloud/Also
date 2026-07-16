/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/https', 'N/log'], (https, log) => {

    const CONFIG = {
        SHOP: 'your-store.myshopify.com',
        TOKEN: 'ENTER_SHOPIFY_TOKEN',
        API_VERSION: '2026-07',

        LOCATION_ID: '81988845792',
        LOCATION_GID: 'gid://shopify/Location/81988845792'
    };


    const QUERY = `
        query Get630Orders(
            $after: String,
            $query: String!
        ) {
            fulfillmentOrders(
                first: 100,
                after: $after,
                includeClosed: false,
                query: $query
            ) {
                pageInfo {
                    hasNextPage
                    endCursor
                }

                nodes {
                    id
                    status
                    requestStatus

                    assignedLocation {
                        name
                        location {
                            id
                            name
                        }
                    }

                    order {
                        id
                        name
                        createdAt
                        closed
                        cancelledAt
                        displayFulfillmentStatus
                    }
                }
            }
        }
    `;


    function getInputData() {

        const matchedOrders = {};
        let after = null;
        let hasNextPage = true;

        while (hasNextPage) {

            const data = graphql(QUERY, {
                after: after,
                query:
                    'assigned_location_id:' +
                    CONFIG.LOCATION_ID
            });

            const connection =
                data.fulfillmentOrders;

            const fulfillmentOrders =
                connection.nodes || [];


            fulfillmentOrders.forEach(fo => {

                const order = fo.order;

                const locationId =
                    fo.assignedLocation &&
                    fo.assignedLocation.location
                        ? fo.assignedLocation.location.id
                        : '';


                /*
                 * Only open, non-cancelled orders
                 * currently assigned to 630 Hansen Way.
                 *
                 * No fulfillment-status filter.
                 */
                if (
                    !order ||
                    order.closed ||
                    order.cancelledAt ||
                    locationId !== CONFIG.LOCATION_GID
                ) {
                    return;
                }


                if (!matchedOrders[order.id]) {

                    matchedOrders[order.id] = {
                        orderId: order.id,
                        orderNumber: order.name,
                        createdAt: order.createdAt,

                        fulfillmentStatus:
                            order.displayFulfillmentStatus,

                        location:
                            fo.assignedLocation.name,

                        fulfillmentOrders: []
                    };
                }


                matchedOrders[order.id]
                    .fulfillmentOrders.push({
                        id: fo.id,
                        status: fo.status,
                        requestStatus: fo.requestStatus
                    });
            });


            hasNextPage =
                connection.pageInfo.hasNextPage;

            after =
                connection.pageInfo.endCursor;
        }


        const orders =
            Object.values(matchedOrders);


        log.audit({
            title: 'OPEN ORDERS FOUND AT 630',
            details: {
                count: orders.length
            }
        });


        return orders;
    }


    function map(context) {

        const order =
            JSON.parse(context.value);


        log.audit({
            title:
                'OPEN ORDER AT 630 - ' +
                order.orderNumber,

            details: {
                orderNumber:
                    order.orderNumber,

                orderId:
                    order.orderId,

                createdAt:
                    order.createdAt,

                fulfillmentStatus:
                    order.fulfillmentStatus,

                location:
                    order.location,

                fulfillmentOrders:
                    order.fulfillmentOrders
            }
        });


        context.write({
            key: order.orderId,
            value: order.orderNumber
        });
    }


    function summarize(summary) {

        let totalOrders = 0;


        summary.output.iterator().each(() => {
            totalOrders++;
            return true;
        });


        summary.mapSummary.errors.iterator().each(
            (key, error) => {

                log.error({
                    title: 'MAP ERROR - ' + key,
                    details: error
                });

                return true;
            }
        );


        if (summary.inputSummary.error) {

            log.error({
                title: 'INPUT ERROR',
                details: summary.inputSummary.error
            });
        }


        log.audit({
            title: '630 ORDER SEARCH COMPLETED',
            details: {
                openOrdersFound: totalOrders,
                usage: summary.usage,
                yields: summary.yields,
                message:
                    'Read-only process. No Shopify orders were changed.'
            }
        });
    }


    function graphql(query, variables) {

        const response = https.post({
            url:
                `https://${CONFIG.SHOP}/admin/api/` +
                `${CONFIG.API_VERSION}/graphql.json`,

            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token':
                    CONFIG.TOKEN
            },

            body: JSON.stringify({
                query: query,
                variables: variables
            })
        });


        if (
            Number(response.code) < 200 ||
            Number(response.code) >= 300
        ) {
            throw new Error(
                `Shopify HTTP ${response.code}: ` +
                response.body
            );
        }


        const body =
            JSON.parse(response.body || '{}');


        if (body.errors && body.errors.length) {

            throw new Error(
                body.errors
                    .map(error => error.message)
                    .join(' | ')
            );
        }


        return body.data;
    }


    return {
        getInputData,
        map,
        summarize
    };
});