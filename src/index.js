const Apify = require('apify');
const { scrapePosts, handlePostsGraphQLResponse } = require('./posts');
const { scrapeComments, handleCommentsGraphQLResponse }  = require('./comments');
const { scrapeDetails }  = require('./details');
const { getItemSpec } = require('./helpers');
const { GRAPHQL_ENDPOINT, ABORTED_RESOUCE_TYPES, SCRAPE_TYPES } = require('./consts');
const errors = require('./errors');

async function main() {
    const input = await Apify.getInput();
    const { proxy, instagramUsername, resultsLimit = 200 } = input;

    try {
        if (!proxy) throw errors.proxyIsRequired();
    } catch (error) {
        console.log('--  --  --  --  --');
        console.log(' ');
        Apify.utils.log.error(`Run failed because the provided input is incorrect:`);
        Apify.utils.log.error(error.message);
        console.log(' ');
        console.log('--  --  --  --  --');
        process.exit(1);
    }

    const requestQueue = await Apify.openRequestQueue();

    const requestList = await Apify.openRequestList('request-list', [{
        url: 'https://www.instagram.com/'+instagramUsername+'/',
        userData: { limit: resultsLimit },
    }]);

    const gotoFunction = async ({request, page}) => {
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            if (ABORTED_RESOUCE_TYPES.includes(request.resourceType())) return request.abort();
            request.continue();
        });

        page.on('response', async (response) => {
            const responseUrl = response.url();

            // Skip non graphql responses
            if (!responseUrl.startsWith(GRAPHQL_ENDPOINT)) return;

            // Wait for the page to parse it's data
            while (!page.itemSpec) await page.waitFor(100);

            Apify.utils.log.info(`request.userData: ${JSON.stringify(request.userData)}`);
            if (typeof request.userData.limit !== 'undefined') {
                Apify.utils.log.info(`Handling graphql response`);
                return handlePostsGraphQLResponse(page, response)
                    .catch( error => Apify.utils.log.error(error))
            }
        });

        return page.goto(request.url, {
            // itemSpec timeouts
            timeout: 50 * 1000
        });
    };

    const handlePageFunction = async ({ page, request }) => {
        const entryData = await page.evaluate(() => window.__initialData.data.entry_data);
        const itemSpec = getItemSpec(entryData);
        page.itemSpec = itemSpec;

        Apify.utils.log.info(`request.userData: ${JSON.stringify(request.userData)}`);
        if (typeof request.userData.limit !== 'undefined') {
            Apify.utils.log.info('Fetching posts');
            return scrapePosts(page, request, itemSpec, entryData, requestQueue);
        } else {
            Apify.utils.log.info(`Fetching post`);
            return scrapeDetails(request, itemSpec, entryData)
        }
    }

    if (proxy.apifyProxyGroups && proxy.apifyProxyGroups.length === 0) delete proxy.apifyProxyGroups;

    const crawler = new Apify.PuppeteerCrawler({
        requestList,
        requestQueue,
        gotoFunction,
        puppeteerPoolOptions: {
            maxOpenPagesPerInstance: 1
        },
        launchPuppeteerOptions: {
            ...proxy,
        },
        handlePageTimeoutSecs: 12 * 60 * 60,
        handlePageFunction,

        // If request failed 4 times then this function is executed.
        handleFailedRequestFunction: async ({ request }) => {
            Apify.utils.log.error(`${request.url}: Request ${request.url} failed 4 times`);
            await Apify.pushData({
                '#debug': Apify.utils.createRequestDebugInfo(request),
                '#error': request.url
            });
        },
    });

    await crawler.run();
};

module.exports = main;