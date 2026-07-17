/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/https', 'N/log'], (https, log) => {

    const CONFIG = {
        SHOP: 'ride-also.myshopify.com',
        TOKEN: 'REPLACE_WITH_SHOPIFY_TOKEN',
        API_VERSION: '2026-07',

        LOCATION_ID:
            'gid://shopify/Location/81988845792', // 630 Hansen Way

        /*
         * 0 = retrieve all matching inventory items.
         * Use 10 for initial testing.
         */
        ITEM_LIMIT: 0
    };


    const INVENTORY_QUERY = `
        query Get630InventoryItems(
            $locationId: ID!,
            $after: String
        ) {
            location(id: $locationId) {
                id
                name

                inventoryLevels(
                    first: 100,
                    after: $after,
                    includeInactive: false
                ) {
                    pageInfo {
                        hasNextPage
                        endCursor
                    }

                    nodes {
                        id
                        isActive

                        quantities(
                            names: [
                                "available",
                                "committed",
                                "on_hand"
                            ]
                        ) {
                            name
                            quantity
                        }

                        item {
                            id
                            sku
                            tracked

                            variants(first: 10) {
                                nodes {
                                    id
                                    title

                                    product {
                                        id
                                        title
                                        status
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    `;


    function getInputData() {

        const items = [];
        let after = null;
        let hasNextPage = true;

        while (hasNextPage) {

            const data = graphql(
                INVENTORY_QUERY,
                {
                    locationId: CONFIG.LOCATION_ID,
                    after: after
                }
            );

            if (!data.location) {
                throw new Error(
                    '630 Hansen Way location was not found.'
                );
            }

            const connection =
                data.location.inventoryLevels;

            const levels =
                connection.nodes || [];

            for (let i = 0; i < levels.length; i++) {

                const level = levels[i];
                const item = level.item;

                /*
                 * Include only:
                 * 1. Active inventory level at 630.
                 * 2. Track quantity enabled.
                 */
                if (
                    !level.isActive ||
                    !item ||
                    !item.tracked
                ) {
                    continue;
                }

                items.push({
                    inventoryLevelId: level.id,
                    inventoryItemId: item.id,
                    sku: item.sku || '',
                    tracked: item.tracked,
                    quantities: level.quantities || [],
                    variants:
                        item.variants &&
                        item.variants.nodes
                            ? item.variants.nodes
                            : []
                });

                if (
                    CONFIG.ITEM_LIMIT > 0 &&
                    items.length >= CONFIG.ITEM_LIMIT
                ) {
                    hasNextPage = false;
                    break;
                }
            }

            if (!hasNextPage) {
                break;
            }

            hasNextPage =
                connection.pageInfo.hasNextPage;

            after =
                connection.pageInfo.endCursor;
        }

        log.audit({
            title: 'ITEMS FOUND AT 630',
            details: {
                count: items.length,
                location: '630 Hansen Way',
                validation:
                    'Track quantity enabled and 630 active',
                message:
                    'Read-only process. Nothing was changed.'
            }
        });

        return items;
    }


    function map(context) {

        const item =
            JSON.parse(context.value);

        const variants =
            item.variants || [];

        const productDetails =
            variants.map(variant => ({
                productId:
                    variant.product
                        ? variant.product.id
                        : '',

                product:
                    variant.product
                        ? variant.product.title
                        : '',

                productStatus:
                    variant.product
                        ? variant.product.status
                        : '',

                variantId:
                    variant.id,

                variant:
                    variant.title
            }));

        log.audit({
            title:
                'ITEM AT 630 - ' +
                (item.sku || item.inventoryItemId),

            details: {
                sku:
                    item.sku,

                inventoryItemId:
                    item.inventoryItemId,

                inventoryLevelId:
                    item.inventoryLevelId,

                location:
                    '630 Hansen Way',

                trackQuantity:
                    item.tracked,

                quantities:
                    item.quantities,

                products:
                    productDetails
            }
        });

        context.write({
            key: item.inventoryItemId,
            value: JSON.stringify({
                status: 'FOUND',
                sku: item.sku
            })
        });
    }


    function summarize(summary) {

        let totalItems = 0;

        summary.output.iterator().each(
            (key, value) => {
                totalItems++;
                return true;
            }
        );

        if (summary.inputSummary.error) {

            log.error({
                title: 'INPUT ERROR',
                details: summary.inputSummary.error
            });
        }

        summary.mapSummary.errors.iterator().each(
            (key, error) => {

                log.error({
                    title: 'MAP ERROR - ' + key,
                    details: error
                });

                return true;
            }
        );

        log.audit({
            title: '630 ITEM SEARCH COMPLETED',
            details: {
                totalInventoryItems:
                    totalItems,

                location:
                    '630 Hansen Way',

                trackQuantity:
                    'Enabled',

                usage:
                    summary.usage,

                concurrency:
                    summary.concurrency,

                yields:
                    summary.yields,

                message:
                    'Read-only process. No Shopify inventory locations were changed.'
            }
        });
    }


    function graphql(query, variables) {

        const response = https.post({
            url:
                `https://${CONFIG.SHOP}` +
                `/admin/api/${CONFIG.API_VERSION}` +
                `/graphql.json`,

            headers: {
                'Content-Type':
                    'application/json',

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

        if (
            body.errors &&
            body.errors.length
        ) {
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