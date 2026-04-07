// src/main.js - Sahibinden.com Emlak Scraper
import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';
import {
    randomUserAgent,
    randomDelay,
    formatPrice,
    extractCurrency,
    normalizeText,
    extractListingId,
} from './utils.js';
import { createBaseRowIntegration } from './baserow.js';

// Initialize the Apify Actor
await Actor.init();

// Get input
const input = await Actor.getInput() || {};
const {
    startUrls = [{ url: 'https://www.sahibinden.com/satilik-daire/istanbul?sorting=date_desc' }],
    maxItems = null,
    includeDetails = false,
    maxConcurrency = 3,
    proxyConfiguration = {
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
        countryCode: 'TR',
    },
    baseRowApiToken,
    baseRowTableId,
    baseRowDatabaseId,
    sessionCookies = [],
} = input;

// Force RESIDENTIAL proxy with TR country code
const finalProxyConfiguration = {
    useApifyProxy: true,
    apifyProxyGroups: ['RESIDENTIAL'],
    countryCode: 'TR',
    ...(proxyConfiguration || {}),
};
if (!finalProxyConfiguration.apifyProxyGroups || finalProxyConfiguration.apifyProxyGroups.length === 0) {
    finalProxyConfiguration.apifyProxyGroups = ['RESIDENTIAL'];
}
if (!finalProxyConfiguration.countryCode) {
    finalProxyConfiguration.countryCode = 'TR';
}

const proxyConfig = await Actor.createProxyConfiguration(finalProxyConfiguration);

log.info('Starting Sahibinden Emlak Scraper', {
    startUrls: startUrls.map(u => typeof u === 'string' ? u : u.url),
    maxItems,
    includeDetails,
    maxConcurrency,
    proxyGroups: finalProxyConfiguration.apifyProxyGroups,
    countryCode: finalProxyConfiguration.countryCode,
});

if (proxyConfig) {
    log.info('Using proxy configuration', {
        type: proxyConfig.usesApifyProxy ? 'Apify Proxy' : 'Custom Proxies',
        groups: finalProxyConfiguration.apifyProxyGroups,
        country: finalProxyConfiguration.countryCode,
    });
} else {
    log.warning('No proxy configuration specified. Sahibinden.com requires RESIDENTIAL proxy!');
}

// Initialize BaseRow integration if configured
let baseRowIntegration = null;
try {
    baseRowIntegration = await createBaseRowIntegration();
} catch (error) {
    log.warning('BaseRow integration initialization failed, continuing without it.', { error: error.message });
}

let scrapedItemsCount = 0;

// Normalize sameSite values from browser export formats to Playwright-accepted values
function normalizeSameSite(value) {
    if (!value) return 'Lax';
    const lower = value.toLowerCase();
    if (lower === 'strict') return 'Strict';
    if (lower === 'none' || lower === 'no_restriction') return 'None';
    return 'Lax';
}

// Check if page content indicates a bot challenge
function isChallengedPage(html) {
    return (
        html.includes('Just a moment') ||
        html.includes('Checking your browser') ||
        html.includes('cf-browser-verification') ||
        html.includes('challenge-platform') ||
        html.includes('Güvenlik doğrulaması gerçekleştirme') ||
        html.includes('Bir dakika lütfen') ||
        html.includes('Uyumsuz tarayıcı eklentisi')
    );
}

// Create the Playwright crawler
const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConfig,
    maxConcurrency,
    maxRequestsPerCrawl: maxItems ? maxItems * 3 : 1000,
    maxRequestRetries: 5,
    navigationTimeoutSecs: 90,
    requestHandlerTimeoutSecs: 180,

    // Session pool: persists cookies (including Cloudflare clearance) across requests
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
        maxPoolSize: 10,
        sessionOptions: {
            maxUsageCount: 50,
        },
    },

    browserPoolOptions: {
        retireBrowserAfterPageCount: 20,
    },

    launchContext: {
        launchOptions: {
            headless: process.env.HEADLESS !== 'false',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
                '--disable-infobars',
                '--window-size=1920,1080',
                '--start-maximized',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-site-isolation-trials',
            ],
        },
    },

    preNavigationHooks: [
        async ({ page, request }, gotoOptions) => {
            // Inject session cookies before navigation so they are sent with the first request
            if (sessionCookies && Array.isArray(sessionCookies) && sessionCookies.length > 0) {
                try {
                    const formattedCookies = sessionCookies.map(c => ({
                        name: c.name,
                        value: c.value,
                        domain: c.domain || '.sahibinden.com',
                        path: c.path || '/',
                        secure: c.secure !== false,
                        httpOnly: c.httpOnly === true,
                        sameSite: normalizeSameSite(c.sameSite),
                    }));
                    await page.context().addCookies(formattedCookies);
                    log.debug(`Injected ${formattedCookies.length} session cookies.`);
                } catch (e) {
                    log.warning(`Failed to inject session cookies: ${e.message}`);
                }
            }

            await page.setExtraHTTPHeaders({
                'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1',
                'sec-ch-ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
            });

            await page.setViewportSize({ width: 1920, height: 1080 });

            // Stealth init script — runs in page context before any page JS
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

                window.chrome = {
                    runtime: {},
                    loadTimes: function () { },
                    csi: function () { },
                    app: {},
                };

                const originalQuery = window.navigator.permissions.query;
                window.navigator.permissions.query = parameters => (
                    parameters.name === 'notifications'
                        ? Promise.resolve({ state: Notification.permission })
                        : originalQuery(parameters)
                );

                Object.defineProperty(navigator, 'languages', {
                    get: () => ['tr-TR', 'tr', 'en-US', 'en'],
                });
            });

            if (gotoOptions) {
                gotoOptions.waitUntil = 'networkidle';
                gotoOptions.timeout = 90000;
            }
        },
    ],

    postNavigationHooks: [
        async ({ page, response, request, session }) => {
            const statusCode = response?.status();
            log.info(`Response status: ${statusCode} for ${request.url}`);

            // Handle Cloudflare challenge (403/503/429)
            if (statusCode === 403 || statusCode === 503 || statusCode === 429) {
                log.warning(`Got ${statusCode}, waiting for Cloudflare challenge to resolve...`);

                await randomDelay(5000, 10000);

                // Simulate human mouse movement
                try {
                    await page.mouse.move(100 + Math.random() * 500, 100 + Math.random() * 500);
                    await page.mouse.move(200 + Math.random() * 500, 200 + Math.random() * 500);
                } catch (e) { }

                const content = await page.content();
                if (isChallengedPage(content)) {
                    log.info('Cloudflare challenge page detected, waiting for resolution...');
                    try {
                        await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 45000 });

                        // Re-check: navigation may have landed on another challenge page
                        const resolvedContent = await page.content();
                        if (isChallengedPage(resolvedContent)) {
                            log.warning('Cloudflare challenge navigated to another challenge page. Marking session bad.');
                            if (session) session.markBad();
                            throw new Error('Cloudflare Turnstile challenge requires manual verification');
                        }

                        log.info('Cloudflare challenge resolved!');
                    } catch (e) {
                        if (e.message.includes('Turnstile')) throw e;
                        log.warning('Cloudflare challenge did not resolve in time. Retrying...');
                        if (session) session.markBad();
                        throw new Error('Cloudflare challenge timeout');
                    }
                } else {
                    log.warning('Received 403 without recognized Cloudflare challenge. Marking session as bad.');
                    if (session) session.markBad();
                    throw new Error(`Blocked with status ${statusCode}`);
                }
            }

            // Detect tloading page (200 response but JS redirect page)
            if (page.url().includes('/cs/tloading')) {
                log.info('Detected tloading protection page, waiting for JS redirect...');
                try {
                    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 });
                    log.info(`tloading resolved, now at: ${page.url()}`);
                } catch (e) {
                    log.warning('tloading page did not redirect in time. Marking session bad and retrying.');
                    if (session) session.markBad();
                    throw new Error('tloading page did not resolve');
                }
            }

            // Validate we're not on the login page
            if (page.url().includes('/giris') || page.url().includes('secure.sahibinden.com')) {
                log.error('Redirected to login page. Your session cookies are missing or expired.');
                if (session) session.markBad();
                throw new Error('Mandatory login required. Please update the sessionCookies input.');
            }

            if (statusCode && statusCode >= 200 && statusCode < 300) {
                if (session) session.markGood();
            }
        },
    ],

    requestHandler: async ({ page, request, enqueueLinks, session }) => {
        const label = request.userData?.label || 'CATEGORY';
        log.info(`Processing page [${label}]: ${request.url}`);

        await randomDelay(2000, 5000);

        try {
            // Extra challenge check inside the handler
            const pageContent = await page.content();
            if (isChallengedPage(pageContent)) {
                log.warning('Bot challenge still present in page, waiting...');
                await randomDelay(8000, 15000);
                await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => { });

                const newContent = await page.content();
                if (isChallengedPage(newContent)) {
                    if (session) session.markBad();
                    throw new Error('Bot challenge not resolved');
                }
            }

            await page.waitForSelector('body', { timeout: 45000 });

            if (label === 'DETAIL') {
                await handleDetailPage(page, request);
            } else {
                await handleCategoryPage(page, request, enqueueLinks);
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log.error(`Error processing ${request.url}: ${errorMessage}`, {
                stack: error instanceof Error ? error.stack : undefined,
            });
            throw error;
        }
    },

    failedRequestHandler: async ({ request }) => {
        log.error(`Request failed after retries: ${request.url}`, {
            errors: request.errorMessages,
        });
    },
});

// CRITICAL: Override Crawlee's internal blocked request check
// Crawlee hardcodes 403 as "blocked" and throws BEFORE requestHandler runs.
// We handle 403/503 ourselves in postNavigationHooks.
const originalThrowOnBlocked = crawler._throwOnBlockedRequest?.bind(crawler);
if (originalThrowOnBlocked) {
    crawler._throwOnBlockedRequest = function (session, statusCode) {
        if (statusCode === 403 || statusCode === 503) {
            log.debug(`Suppressing Crawlee's built-in ${statusCode} block check (handled by postNavigationHook)`);
            return;
        }
        return originalThrowOnBlocked(session, statusCode);
    };
    log.info('Overridden Crawlee blocked request check for Cloudflare compatibility');
}

// =============================================
// CATEGORY PAGE HANDLER
// =============================================
async function handleCategoryPage(page, request, enqueueLinks) {
    log.info(`Handling category page: ${request.url}`);

    const listingRowSelector = 'tbody.searchResultsRowClass > tr.searchResultsItem';
    const titleLinkSelector = 'td.searchResultsTitleValue a.classifiedTitle';
    const priceSelector = 'td.searchResultsPriceValue span';
    const dateSelector = 'td.searchResultsDateValue';
    const locationSelector = 'td.searchResultsLocationValue';
    const nextPageSelector = 'a.prevNextBut[title="Sonraki"]:not(.passive)';

    try {
        let listingElements = [];
        try {
            await page.waitForSelector(listingRowSelector, { timeout: 15000 });
            listingElements = await page.$$(listingRowSelector);
        } catch (e) {
            log.warning(`Primary selector failed: ${listingRowSelector}`);

            const pageTitle = await page.title().catch(() => 'unknown');
            const currentUrl = page.url();
            const bodyHTML = await page.$eval('body', el => el.innerHTML.substring(0, 3000)).catch(() => 'Could not get HTML');

            log.info('DEBUG Page state:', { title: pageTitle, url: currentUrl });
            log.info('DEBUG HTML preview (first 2000 chars):', { html: bodyHTML.substring(0, 2000) });

            try {
                const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
                await Actor.setValue('DEBUG-screenshot', screenshot, { contentType: 'image/png' });
                log.info('DEBUG: Screenshot saved to key-value store as "DEBUG-screenshot"');
            } catch (screenshotErr) {
                log.warning('Could not save debug screenshot');
            }

            const alternativeSelectors = [
                'table.searchResultsTable tr.searchResultsItem',
                '.searchResultsRowClass .searchResultsItem',
                'tr.searchResultsItem',
                '.classified-list-item',
                '[data-id]',
                '.searchResults .result-item',
                'table tr[data-id]',
            ];

            for (const altSelector of alternativeSelectors) {
                const altElements = await page.$$(altSelector);
                if (altElements.length > 0) {
                    log.info(`Found ${altElements.length} elements with alternative selector: ${altSelector}`);
                    listingElements = altElements;
                    break;
                }
            }

            if (listingElements.length === 0) {
                const tableCount = await page.$$eval('table', tables => tables.length).catch(() => 0);
                const trCount = await page.$$eval('tr', rows => rows.length).catch(() => 0);
                const tbodyCount = await page.$$eval('tbody', bodies => bodies.length).catch(() => 0);
                log.info('DEBUG: Page structure', { tables: tableCount, rows: trCount, tbodies: tbodyCount });

                const searchClasses = await page.evaluate(() => {
                    const allElements = document.querySelectorAll('*');
                    const classes = new Set();
                    allElements.forEach(el => {
                        if (el.className && typeof el.className === 'string') {
                            el.className.split(' ').forEach(cls => {
                                if (cls.toLowerCase().includes('search') || cls.toLowerCase().includes('result') || cls.toLowerCase().includes('listing') || cls.toLowerCase().includes('classified')) {
                                    classes.add(cls);
                                }
                            });
                        }
                    });
                    return Array.from(classes);
                }).catch(() => []);
                log.info('DEBUG: Relevant CSS classes found:', { classes: searchClasses });

                throw new Error('No listing elements found with any selector');
            }
        }

        log.info(`Found ${listingElements.length} listings on page.`);

        const results = [];

        for (const element of listingElements) {
            if (maxItems !== null && scrapedItemsCount >= maxItems) {
                log.info(`Maximum items limit (${maxItems}) reached. Stopping scrape.`);

                if (results.length > 0) {
                    await Actor.pushData(results);
                    if (baseRowIntegration) {
                        try {
                            await baseRowIntegration.storeListings(results);
                        } catch (error) {
                            log.warning('Failed to store data in BaseRow', { error: error.message });
                        }
                    }
                }

                await crawler.autoscaledPool?.abort();
                return;
            }

            try {
                const titleElement = await element.$(titleLinkSelector);
                const title = await titleElement?.evaluate(el => el.textContent?.trim()).catch(() => null);
                const detailUrl = await titleElement?.evaluate(el => el.href).catch(() => null);

                if (!title || !detailUrl) {
                    log.debug('Skipping row due to missing title or detailUrl.');
                    continue;
                }

                const priceText = await element.$eval(priceSelector, el => el.textContent?.trim()).catch(() => null);

                const location = await element.$eval(locationSelector, el => {
                    return el.innerText?.trim().replace(/\n/g, ' / ');
                }).catch(() => null);

                const date = await element.$eval(dateSelector, el => {
                    return el.innerText?.trim().replace(/\n/g, ' ');
                }).catch(() => null);

                const image = await element.$eval('img', el => el.src || el.dataset?.src || null).catch(() => null);

                const id = extractListingId(detailUrl);

                const listingData = {
                    id: id,
                    url: detailUrl,
                    title: normalizeText(title),
                    price: formatPrice(priceText),
                    price_currency: extractCurrency(priceText),
                    price_raw: priceText,
                    location: normalizeText(location),
                    date: normalizeText(date),
                    image: image,
                    scrapedAt: new Date().toISOString(),
                    sourceUrl: request.url,
                };

                if (includeDetails && detailUrl) {
                    await enqueueLinks({
                        urls: [detailUrl],
                        userData: {
                            label: 'DETAIL',
                            listingData: listingData,
                        },
                    });
                } else {
                    results.push(listingData);
                    scrapedItemsCount++;
                }

            } catch (extractError) {
                const errorMsg = extractError instanceof Error ? extractError.message : String(extractError);
                log.warning(`Could not process one item on ${request.url}`, { error: errorMsg });
            }
        }

        if (results.length > 0) {
            await Actor.pushData(results);
            log.info(`Pushed ${results.length} listings from page. Total scraped: ${scrapedItemsCount}`);

            if (baseRowIntegration) {
                try {
                    await baseRowIntegration.storeListings(results);
                } catch (error) {
                    log.warning('Failed to store data in BaseRow', { error: error.message });
                }
            }
        } else if (!includeDetails) {
            log.info(`No listings extracted from page ${request.url}.`);
        }

        if (maxItems !== null && scrapedItemsCount >= maxItems) {
            log.info(`Maximum items limit (${maxItems}) reached. Not enqueueing next page.`);
            await crawler.autoscaledPool?.abort();
            return;
        }

        const nextPageUrl = await page.$eval(nextPageSelector, anchor => anchor.href).catch(() => null);
        if (nextPageUrl) {
            log.info(`Enqueueing next category page: ${nextPageUrl}`);
            const absoluteNextPageUrl = new URL(nextPageUrl, request.loadedUrl || request.url).toString();
            await enqueueLinks({
                urls: [absoluteNextPageUrl],
                userData: { label: 'CATEGORY' },
            });
            await randomDelay(1000, 3000);
        } else {
            log.info(`No next page button found on ${request.url}`);
        }

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.warning(`Could not handle category page ${request.url}: ${errorMessage}`);
    }
}

// =============================================
// DETAIL PAGE HANDLER
// =============================================
async function handleDetailPage(page, request) {
    log.info(`Handling detail page: ${request.url}`);

    const listingData = request.userData?.listingData || {};

    try {
        await page.waitForSelector('body', { timeout: 30000 });
        await randomDelay(1000, 3000);

        const description = await page.$eval('#classifiedDescription', el => {
            return el.textContent?.trim() || '';
        }).catch(() => '');

        const info = {};
        try {
            const infoItems = await page.$$('.classifiedInfoList li');
            for (const item of infoItems) {
                const label = await item.$eval('strong', el => el.textContent?.trim()).catch(() => null);
                const value = await item.$eval('span', el => el.textContent?.trim()).catch(() => null);
                if (label && value) {
                    info[normalizeText(label)] = normalizeText(value);
                }
            }
        } catch (e) {
            log.debug('Could not extract info list', { error: e.message });
        }

        const images = await page.$$eval(
            '.classifiedDetailMainPhoto img, .swiper-slide img, #classifiedDetailPhotos img',
            imgs => imgs.map(img => img.src || img.dataset?.src).filter(Boolean)
        ).catch(() => []);

        const uniqueImages = [...new Set(images)];

        const seller = await page.$eval(
            '.classifiedUserContent h5, .classifiedOtherBoxes .username-info-area',
            el => el.textContent?.trim()
        ).catch(() => null);

        const pageId = await page.$eval(
            '.classifiedId',
            el => el.textContent?.replace(/[^0-9]/g, '')
        ).catch(() => null);

        const completeData = {
            ...listingData,
            id: listingData.id || pageId || extractListingId(request.url),
            description: normalizeText(description),
            images: uniqueImages,
            seller: seller ? normalizeText(seller) : null,
            info: info,
            size: info['Brüt / Net M2'] || info['m² (Brüt)'] || info['m² (Net)'] || null,
            rooms: info['Oda Sayısı'] || null,
            buildingAge: info['Bina Yaşı'] || null,
            floor: info['Bulunduğu Kat'] || null,
            totalFloors: info['Kat Sayısı'] || null,
            heating: info['Isınma'] || null,
            furnished: info['Eşyalı'] || null,
            usage: info['Kullanım Durumu'] || null,
            inSite: info['Site İçinde'] || null,
            dues: info['Aidat'] || null,
            deedStatus: info['Tapu Durumu'] || null,
            creditEligible: info['Krediye Uygun'] || null,
        };

        await Actor.pushData(completeData);
        scrapedItemsCount++;
        log.info(`Pushed detail data for listing ${completeData.id}. Total scraped: ${scrapedItemsCount}`);

        if (baseRowIntegration) {
            try {
                await baseRowIntegration.storeListing(completeData);
            } catch (error) {
                log.warning('Failed to store detail data in BaseRow', { error: error.message });
            }
        }

        if (maxItems !== null && scrapedItemsCount >= maxItems) {
            log.info(`Maximum items limit (${maxItems}) reached.`);
            await crawler.autoscaledPool?.abort();
        }

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.warning(`Could not handle detail page ${request.url}: ${errorMessage}`);

        if (listingData.title) {
            await Actor.pushData(listingData);
            scrapedItemsCount++;
        }
    }
}

// =============================================
// START THE CRAWLER
// =============================================
const startRequests = (Array.isArray(startUrls) ? startUrls : [startUrls]).map(item => {
    let urlString;
    if (typeof item === 'string') {
        urlString = item;
    } else if (item && typeof item.url === 'string') {
        urlString = item.url;
    } else {
        log.warning('Skipping invalid start URL item:', { item });
        return null;
    }

    if (!urlString || !urlString.startsWith('http')) {
        log.warning('Skipping item with invalid URL string:', { urlString });
        return null;
    }

    const isDetailUrl = urlString.includes('/ilan/') && urlString.includes('/detay');
    return { url: urlString, userData: { label: isDetailUrl ? 'DETAIL' : 'CATEGORY' } };
}).filter(req => req !== null);

if (startRequests.length > 0) {
    await crawler.addRequests(startRequests);
    log.info(`Added ${startRequests.length} initial requests to the queue.`);
} else {
    log.warning('No valid start URLs found in the input. Exiting.');
    await Actor.exit(1, 'No valid start URLs provided.');
}

log.info('Starting the crawler...');
await crawler.run();
log.info(`Crawler finished. Total items scraped: ${scrapedItemsCount}`);

await Actor.exit();
