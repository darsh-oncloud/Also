/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/https', 'N/log'], function (https, log) {

    const SHOPIFY_STORE = 'ride-also.myshopify.com';
    const SHOPIFY_ACCESS_TOKEN = 'PASTE_YOUR_SHOPIFY_ACCESS_TOKEN_HERE';
    const SHOPIFY_API_VERSION = '2025-01';

    // Parent Product ID from Shopify URL:
    // https://admin.shopify.com/store/ride-also/products/9819779596512
    const SHOPIFY_PRODUCT_ID = 9025910178016;

    // SEKO Shopify location ID
    const SEKO_LOCATION_ID = 90386039008;

    const TEST_MODE = false;
    const BODY_LOG_LIMIT = 3000;

    const BASE_URL = 'https://' + SHOPIFY_STORE + '/admin/api/' + SHOPIFY_API_VERSION;

    function getInputData() {
        var variantsToProcess = [];

        try {
            log.audit('SCRIPT START - SINGLE PRODUCT MODE', {
                store: SHOPIFY_STORE,
                productId: SHOPIFY_PRODUCT_ID,
                sekoLocationId: SEKO_LOCATION_ID,
                testMode: TEST_MODE,
                tokenPresent: !!SHOPIFY_ACCESS_TOKEN,
                tokenPreview: maskToken(SHOPIFY_ACCESS_TOKEN)
            });

            // Product check log
            var productUrl = BASE_URL + '/products/' + SHOPIFY_PRODUCT_ID + '.json?fields=id,title,status';
            var productResp = shopifyRequest('GET', productUrl, null, 'GET_PARENT_PRODUCT');

            log.audit('Parent Product Response', {
                code: productResp ? productResp.code : 'NO_RESPONSE',
                headers: summarizeHeaders(productResp ? productResp.headers : null),
                bodyPreview: previewBody(productResp ? productResp.body : '')
            });

            if (!productResp || !isSuccess(productResp.code)) {
                log.error('Parent Product Not Found / Not Accessible', {
                    productId: SHOPIFY_PRODUCT_ID,
                    code: productResp ? productResp.code : 'NO_RESPONSE',
                    body: productResp ? productResp.body : ''
                });
                return variantsToProcess;
            }

            // Get all variants for this parent product.
            // Product variant list endpoint uses pagination from Link header.
            var url = BASE_URL + '/products/' + SHOPIFY_PRODUCT_ID + '/variants.json?limit=250';
            var pageNo = 0;
            var seenVariantIds = {};

            while (url) {
                pageNo++;

                log.audit('Fetching Parent Product Variants', {
                    productId: SHOPIFY_PRODUCT_ID,
                    pageNo: pageNo,
                    url: url
                });

                var response = shopifyRequest('GET', url, null, 'GET_PRODUCT_VARIANTS_PAGE_' + pageNo);

                log.audit('Product Variants Response', {
                    productId: SHOPIFY_PRODUCT_ID,
                    pageNo: pageNo,
                    code: response ? response.code : 'NO_RESPONSE',
                    headers: summarizeHeaders(response ? response.headers : null),
                    bodyPreview: previewBody(response ? response.body : '')
                });

                if (!response || !isSuccess(response.code)) {
                    log.error('Failed To Fetch Product Variants', {
                        productId: SHOPIFY_PRODUCT_ID,
                        pageNo: pageNo,
                        code: response ? response.code : 'NO_RESPONSE',
                        body: response ? response.body : ''
                    });
                    break;
                }

                var body = safeParse(response.body);
                var variants = body.variants || [];

                log.audit('Variants Found In Page', {
                    productId: SHOPIFY_PRODUCT_ID,
                    pageNo: pageNo,
                    variantCount: variants.length
                });

                for (var i = 0; i < variants.length; i++) {
                    var variant = variants[i];

                    if (!variant.id) {
                        log.debug('Skip Variant - Missing Variant ID', variant);
                        continue;
                    }

                    if (seenVariantIds[String(variant.id)]) {
                        log.debug('Skip Duplicate Variant', {
                            variantId: variant.id,
                            sku: variant.sku
                        });
                        continue;
                    }

                    seenVariantIds[String(variant.id)] = true;

                    if (!variant.inventory_item_id) {
                        log.error('Skip Variant - Missing inventory_item_id', {
                            productId: SHOPIFY_PRODUCT_ID,
                            variantId: variant.id,
                            sku: variant.sku,
                            title: variant.title,
                            inventoryManagement: variant.inventory_management
                        });
                        continue;
                    }

                    variantsToProcess.push({
                        productId: SHOPIFY_PRODUCT_ID,
                        variantId: variant.id,
                        variantTitle: variant.title,
                        sku: variant.sku,
                        inventoryItemId: variant.inventory_item_id,
                        inventoryManagement: variant.inventory_management
                    });

                    log.audit('Variant Added For Processing', {
                        productId: SHOPIFY_PRODUCT_ID,
                        variantId: variant.id,
                        variantTitle: variant.title,
                        sku: variant.sku,
                        inventoryItemId: variant.inventory_item_id,
                        inventoryManagement: variant.inventory_management
                    });
                }

                url = getNextPageUrl(response.headers);

                if (url) {
                    log.audit('Next Variant Page Found', url);
                } else {
                    log.audit('No More Variant Pages', {
                        productId: SHOPIFY_PRODUCT_ID,
                        lastPageNo: pageNo
                    });
                }
            }

            log.audit('Total Variants To Process For Parent Product', {
                productId: SHOPIFY_PRODUCT_ID,
                total: variantsToProcess.length
            });

        } catch (e) {
            log.error('getInputData Error', {
                name: e.name,
                message: e.message,
                stack: e.stack
            });
        }

        return variantsToProcess;
    }

    function map(context) {
        var data = JSON.parse(context.value);

        try {
            var inventoryItemId = data.inventoryItemId;

            log.audit('MAP START - Processing Variant', {
                productId: data.productId,
                variantId: data.variantId,
                variantTitle: data.variantTitle,
                sku: data.sku,
                inventoryItemId: inventoryItemId,
                inventoryManagement: data.inventoryManagement
            });

            // 1. Get inventory item
            var inventoryItemUrl = BASE_URL + '/inventory_items/' + inventoryItemId + '.json';
            var inventoryItemResponse = shopifyRequest('GET', inventoryItemUrl, null, 'GET_INVENTORY_ITEM_' + inventoryItemId);

            log.audit('Inventory Item GET Response', {
                sku: data.sku,
                inventoryItemId: inventoryItemId,
                code: inventoryItemResponse ? inventoryItemResponse.code : 'NO_RESPONSE',
                headers: summarizeHeaders(inventoryItemResponse ? inventoryItemResponse.headers : null),
                bodyPreview: previewBody(inventoryItemResponse ? inventoryItemResponse.body : '')
            });

            if (!inventoryItemResponse || !isSuccess(inventoryItemResponse.code)) {
                throw new Error('Failed to get inventory item. Code: ' + (inventoryItemResponse ? inventoryItemResponse.code : 'NO_RESPONSE') + ', Body: ' + (inventoryItemResponse ? inventoryItemResponse.body : ''));
            }

            var inventoryItemBody = safeParse(inventoryItemResponse.body);
            var inventoryItem = inventoryItemBody.inventory_item || {};

            log.audit('Inventory Item Parsed', {
                sku: data.sku,
                inventoryItemId: inventoryItemId,
                tracked: inventoryItem.tracked
            });

            // 2. Turn inventory tracking ON if OFF
            if (inventoryItem.tracked !== true) {
                log.audit('Inventory Tracking OFF - Will Turn ON', {
                    sku: data.sku,
                    inventoryItemId: inventoryItemId
                });

                if (!TEST_MODE) {
                    var updateTrackingPayload = {
                        inventory_item: {
                            id: inventoryItemId,
                            tracked: true
                        }
                    };

                    var updateTrackingResponse = shopifyRequest(
                        'PUT',
                        BASE_URL + '/inventory_items/' + inventoryItemId + '.json',
                        updateTrackingPayload,
                        'UPDATE_TRACKING_' + inventoryItemId
                    );

                    log.audit('Inventory Tracking PUT Response', {
                        sku: data.sku,
                        inventoryItemId: inventoryItemId,
                        code: updateTrackingResponse ? updateTrackingResponse.code : 'NO_RESPONSE',
                        headers: summarizeHeaders(updateTrackingResponse ? updateTrackingResponse.headers : null),
                        bodyPreview: previewBody(updateTrackingResponse ? updateTrackingResponse.body : '')
                    });

                    if (!updateTrackingResponse || !isSuccess(updateTrackingResponse.code)) {
                        throw new Error('Failed to update inventory tracking. Code: ' + (updateTrackingResponse ? updateTrackingResponse.code : 'NO_RESPONSE') + ', Body: ' + (updateTrackingResponse ? updateTrackingResponse.body : ''));
                    }
                }
            } else {
                log.audit('Inventory Tracking Already ON', {
                    sku: data.sku,
                    inventoryItemId: inventoryItemId
                });
            }

            // 3. Check if SEKO location is connected
            var inventoryLevelCheckUrl =
                BASE_URL +
                '/inventory_levels.json?inventory_item_ids=' +
                encodeURIComponent(inventoryItemId) +
                '&location_ids=' +
                encodeURIComponent(SEKO_LOCATION_ID);

            var inventoryLevelResponse = shopifyRequest('GET', inventoryLevelCheckUrl, null, 'CHECK_SEKO_LEVEL_' + inventoryItemId);

            log.audit('Inventory Level Check Response', {
                sku: data.sku,
                inventoryItemId: inventoryItemId,
                sekoLocationId: SEKO_LOCATION_ID,
                code: inventoryLevelResponse ? inventoryLevelResponse.code : 'NO_RESPONSE',
                headers: summarizeHeaders(inventoryLevelResponse ? inventoryLevelResponse.headers : null),
                bodyPreview: previewBody(inventoryLevelResponse ? inventoryLevelResponse.body : '')
            });

            if (!inventoryLevelResponse || !isSuccess(inventoryLevelResponse.code)) {
                throw new Error('Failed to check SEKO inventory level. Code: ' + (inventoryLevelResponse ? inventoryLevelResponse.code : 'NO_RESPONSE') + ', Body: ' + (inventoryLevelResponse ? inventoryLevelResponse.body : ''));
            }

            var inventoryLevelBody = safeParse(inventoryLevelResponse.body);
            var inventoryLevels = inventoryLevelBody.inventory_levels || [];

            log.audit('Inventory Levels Parsed', {
                sku: data.sku,
                inventoryItemId: inventoryItemId,
                sekoLocationId: SEKO_LOCATION_ID,
                inventoryLevelCount: inventoryLevels.length,
                inventoryLevels: inventoryLevels
            });

            // 4. Connect SEKO if not connected
            if (!inventoryLevels.length) {
                log.audit('SEKO Location Not Connected - Will Connect', {
                    sku: data.sku,
                    inventoryItemId: inventoryItemId,
                    sekoLocationId: SEKO_LOCATION_ID
                });

                if (!TEST_MODE) {
                    var connectPayload = {
                        location_id: SEKO_LOCATION_ID,
                        inventory_item_id: inventoryItemId,
                        relocate_if_necessary: true
                    };

                    var connectResponse = shopifyRequest(
                        'POST',
                        BASE_URL + '/inventory_levels/connect.json',
                        connectPayload,
                        'CONNECT_SEKO_' + inventoryItemId
                    );

                    log.audit('SEKO Connect POST Response', {
                        sku: data.sku,
                        inventoryItemId: inventoryItemId,
                        sekoLocationId: SEKO_LOCATION_ID,
                        code: connectResponse ? connectResponse.code : 'NO_RESPONSE',
                        headers: summarizeHeaders(connectResponse ? connectResponse.headers : null),
                        bodyPreview: previewBody(connectResponse ? connectResponse.body : '')
                    });

                    if (!connectResponse || !isSuccess(connectResponse.code)) {
                        throw new Error('Failed to connect SEKO location. Code: ' + (connectResponse ? connectResponse.code : 'NO_RESPONSE') + ', Body: ' + (connectResponse ? connectResponse.body : ''));
                    }

                    log.audit('SEKO Location Connected', {
                        sku: data.sku,
                        inventoryItemId: inventoryItemId,
                        sekoLocationId: SEKO_LOCATION_ID
                    });
                } else {
                    log.audit('TEST MODE - Would Connect SEKO Location', {
                        sku: data.sku,
                        inventoryItemId: inventoryItemId,
                        sekoLocationId: SEKO_LOCATION_ID
                    });
                }
            } else {
                log.audit('SEKO Location Already Connected', {
                    sku: data.sku,
                    inventoryItemId: inventoryItemId,
                    sekoLocationId: SEKO_LOCATION_ID
                });
            }

            // 5. Verify after connect
            var verifyResponse = shopifyRequest('GET', inventoryLevelCheckUrl, null, 'VERIFY_SEKO_LEVEL_' + inventoryItemId);

            log.audit('VERIFY SEKO Location After Update', {
                sku: data.sku,
                inventoryItemId: inventoryItemId,
                sekoLocationId: SEKO_LOCATION_ID,
                code: verifyResponse ? verifyResponse.code : 'NO_RESPONSE',
                bodyPreview: previewBody(verifyResponse ? verifyResponse.body : '')
            });

            context.write({
                key: 'SUCCESS',
                value: {
                    sku: data.sku,
                    productId: data.productId,
                    variantId: data.variantId,
                    inventoryItemId: inventoryItemId
                }
            });

        } catch (e) {
            log.error('Map Error', {
                data: data,
                name: e.name,
                message: e.message,
                stack: e.stack
            });

            context.write({
                key: 'ERROR',
                value: {
                    sku: data.sku,
                    productId: data.productId,
                    variantId: data.variantId,
                    inventoryItemId: data.inventoryItemId,
                    error: e.message || String(e)
                }
            });
        }
    }

    function summarize(summary) {
        var successCount = 0;
        var errorCount = 0;

        summary.output.iterator().each(function (key, value) {
            if (key === 'SUCCESS') {
                successCount++;
            }

            if (key === 'ERROR') {
                errorCount++;
                log.error('Failed Record From Output', value);
            }

            return true;
        });

        if (summary.inputSummary.error) {
            log.error('Input Summary Error', summary.inputSummary.error);
        }

        summary.mapSummary.errors.iterator().each(function (key, error) {
            log.error('Map Summary Error', {
                key: key,
                error: error
            });
            return true;
        });

        log.audit('Shopify Parent Product SEKO Update Summary', {
            productId: SHOPIFY_PRODUCT_ID,
            successCount: successCount,
            errorCount: errorCount,
            testMode: TEST_MODE
        });
    }

    function shopifyRequest(method, url, payload, label) {
        var headers = {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
        };

        var response;

        for (var attempt = 1; attempt <= 3; attempt++) {
            try {
                log.audit('Shopify Request START', {
                    label: label || '',
                    method: method,
                    attempt: attempt,
                    url: url,
                    payloadPreview: payload ? previewBody(JSON.stringify(payload)) : ''
                });

                if (method === 'GET') {
                    response = https.get({
                        url: url,
                        headers: headers
                    });
                } else if (method === 'PUT') {
                    response = https.put({
                        url: url,
                        headers: headers,
                        body: JSON.stringify(payload || {})
                    });
                } else if (method === 'POST') {
                    response = https.post({
                        url: url,
                        headers: headers,
                        body: JSON.stringify(payload || {})
                    });
                } else {
                    throw new Error('Unsupported method: ' + method);
                }

                log.audit('Shopify Request END', {
                    label: label || '',
                    method: method,
                    attempt: attempt,
                    code: response ? response.code : 'NO_RESPONSE',
                    headers: summarizeHeaders(response ? response.headers : null)
                });

                if (response && Number(response.code) === 429 && attempt < 3) {
                    wait(1500 * attempt);
                    continue;
                }

                return response;

            } catch (e) {
                log.error('Shopify Request Exception', {
                    label: label || '',
                    method: method,
                    attempt: attempt,
                    url: url,
                    name: e.name,
                    message: e.message,
                    stack: e.stack
                });

                if (attempt === 3) {
                    throw e;
                }

                wait(1500 * attempt);
            }
        }

        return response;
    }

    function getNextPageUrl(headers) {
        if (!headers) {
            return null;
        }

        var linkHeader = getHeaderValue(headers, 'link');

        log.audit('Pagination Link Header', {
            linkHeader: linkHeader || ''
        });

        if (!linkHeader) {
            return null;
        }

        var links = String(linkHeader).split(',');

        for (var i = 0; i < links.length; i++) {
            var part = links[i];

            if (part.indexOf('rel="next"') !== -1) {
                var match = part.match(/<([^>]+)>/);

                if (match && match[1]) {
                    return match[1];
                }
            }
        }

        return null;
    }

    function summarizeHeaders(headers) {
        if (!headers) {
            return {};
        }

        return {
            link: getHeaderValue(headers, 'link') || '',
            apiCallLimit: getHeaderValue(headers, 'x-shopify-shop-api-call-limit') || '',
            apiVersion: getHeaderValue(headers, 'x-shopify-api-version') || '',
            requestId: getHeaderValue(headers, 'x-request-id') || '',
            retryAfter: getHeaderValue(headers, 'retry-after') || '',
            contentType: getHeaderValue(headers, 'content-type') || ''
        };
    }

    function getHeaderValue(headers, headerName) {
        if (!headers || !headerName) {
            return '';
        }

        var target = String(headerName).toLowerCase();

        for (var key in headers) {
            if (String(key).toLowerCase() === target) {
                return headers[key];
            }
        }

        return '';
    }

    function safeParse(body) {
        try {
            return JSON.parse(body || '{}');
        } catch (e) {
            log.error('JSON Parse Error', {
                bodyPreview: previewBody(body),
                errorName: e.name,
                errorMessage: e.message
            });
            return {};
        }
    }

    function previewBody(body) {
        if (!body) {
            return '';
        }

        var text = String(body);
        text = text.replace(/shpat_[A-Za-z0-9_]+/g, 'shpat_***');

        if (text.length > BODY_LOG_LIMIT) {
            return text.substring(0, BODY_LOG_LIMIT) + '... [TRUNCATED]';
        }

        return text;
    }

    function isSuccess(code) {
        code = Number(code);
        return code >= 200 && code < 300;
    }

    function maskToken(token) {
        if (!token) {
            return '';
        }

        token = String(token);

        if (token.length <= 10) {
            return '***';
        }

        return token.substring(0, 6) + '***' + token.substring(token.length - 4);
    }

    function wait(ms) {
        ms = Number(ms) || 1000;

        var end = new Date().getTime() + ms;

        while (new Date().getTime() < end) {
            // wait
        }
    }

    return {
        getInputData: getInputData,
        map: map,
        summarize: summarize
    };
});