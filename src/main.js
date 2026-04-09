// src/main.js - Sahibinden.com Emlak Scraper
import { Actor } from 'apify';
import { PuppeteerCrawler, log } from 'crawlee';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import {
    randomUserAgent,
    randomDelay,
    formatPrice,
    extractCurrency,
    normalizeText,
    extractListingId,
} from './utils.js';
import { createBaseRowIntegration } from './baserow.js';

// Apply the stealth plugin to puppeteer
puppeteer.use(StealthPlugin());

// Initialize the Apify Actor
await Actor.init();

// Get input
const input = await Actor.getInput() || {};
const {
    startUrls = [{ url: 'https://www.sahibinden.com/satilik-daire/istanbul?sorting=date_desc' }],
    maxItems = null,
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
    debugMode = false,
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

const cookieNames = (sessionCookies || []).map(c => c.name);
const hasCfClearanceInput = cookieNames.includes('cf_clearance');
const hasPxCookies = ['_px3', '_pxhd', '_pxvid', 'pxcts'].some(n => cookieNames.includes(n));
log.info('Starting Sahibinden Emlak Scraper', {
    startUrls: startUrls.map(u => typeof u === 'string' ? u : u.url),
    maxItems,
    maxConcurrency,
    proxyGroups: finalProxyConfiguration.apifyProxyGroups,
    countryCode: finalProxyConfiguration.countryCode,
    sessionCookiesProvided: cookieNames.length,
    cookieNames,
    hasCfClearance: hasCfClearanceInput,
    hasPerimeterXCookies: hasPxCookies,
});
if (!hasPxCookies) {
    log.warning('No PerimeterX cookies provided (_px3, _pxhd, _pxvid, pxcts). ' +
        'If sahibinden shows a "Basılı Tutun" challenge, the actor will try to hold it automatically. ' +
        'For reliable bypass: visit sahibinden.com in your browser, solve the hold challenge, then export ALL cookies.');
}

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

// Check if page content is a Cloudflare challenge page
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

// Check if page content is a PerimeterX "press and hold" challenge
function isPxHoldChallenge(html) {
    return (
        html.includes('Basılı Tutun') ||
        html.includes('px-captcha') ||
        html.includes('_pxCaptcha') ||
        html.includes('PerimeterX') ||
        html.includes('Bağlantınız kontrol ediliyor') ||
        html.includes('human-challenge')
    );
}

// Attempt to solve the PerimeterX press-and-hold challenge programmatically
async function tryHoldPxButton(page) {
    try {
        // Try known PX hold button selectors
        const selectors = [
            '#px-captcha',
            '.px-captcha-container',
            'div[id^="px-captcha"]',
            'button',
        ];

        let holdTarget = null;
        for (const sel of selectors) {
            holdTarget = await page.$(sel).catch(() => null);
            if (holdTarget) {
                log.info(`Found PX hold target with selector: ${sel}`);
                break;
            }
        }

        if (!holdTarget) {
            log.warning('Could not find PX hold button element.');
            return false;
        }

        const box = await holdTarget.boundingBox();
        if (!box) {
            log.warning('PX hold button has no bounding box (not visible?)');
            return false;
        }

        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;

        log.info(`Attempting PX hold at (${Math.round(cx)}, ${Math.round(cy)}) for 10s...`);

        // Move to button naturally
        await page.mouse.move(cx - 50, cy - 30);
        await new Promise(r => setTimeout(r, 300));
        await page.mouse.move(cx, cy, { steps: 10 });
        await new Promise(r => setTimeout(r, 200));

        // Hold down
        await page.mouse.down();
        await new Promise(r => setTimeout(r, 10000));
        await page.mouse.up();

        log.info('Released PX hold button, waiting for redirect...');
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});

        const afterHtml = await page.content();
        if (isPxHoldChallenge(afterHtml) || isChallengedPage(afterHtml)) {
            log.warning('PX hold did not resolve the challenge.');
            return false;
        }

        log.info('PX hold challenge resolved successfully!');
        return true;
    } catch (e) {
        log.warning(`PX hold attempt error: ${e.message}`);
        return false;
    }
}

let debugCounter = 0;
async function saveDebugInfo(page, label) {
    if (!debugMode) return;
    const idx = ++debugCounter;
    const key = `DEBUG-${String(idx).padStart(3, '0')}-${label}`;
    try {
        const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
        await Actor.setValue(`${key}-screenshot`, screenshot, { contentType: 'image/png' });
        log.info(`[DEBUG] Screenshot saved → KV store key: "${key}-screenshot"`);
    } catch (e) {
        log.warning(`[DEBUG] Could not save screenshot: ${e.message}`);
    }
    try {
        const html = await page.content();
        await Actor.setValue(`${key}-html`, html, { contentType: 'text/html' });
        log.info(`[DEBUG] HTML saved → KV store key: "${key}-html" (${html.length} chars)`);
    } catch (e) {
        log.warning(`[DEBUG] Could not save HTML: ${e.message}`);
    }
    try {
        const cookies = await page.cookies();
        const cookieSummary = cookies.map(c => `${c.name}=${c.value.substring(0, 20)}... (expires: ${c.expires})`);
        log.info(`[DEBUG] Cookies at "${label}":`, { cookies: cookieSummary });
    } catch (e) { }
}

// Create the Puppeteer crawler
const crawler = new PuppeteerCrawler({
    proxyConfiguration: proxyConfig,
    maxConcurrency: maxConcurrency,
    maxRequestsPerCrawl: maxItems ? maxItems * 3 : 1000,
    maxRequestRetries: 8,
    navigationTimeoutSecs: 90,
    requestHandlerTimeoutSecs: 180,

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
        launcher: puppeteer,
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
            ignoreDefaultArgs: ['--enable-automation'],
        },
        useChrome: true,
    },

    preNavigationHooks: [
        async ({ page, request, session }, gotoOptions) => {
            // Inject user-provided session cookies — but only ONCE per session.
            // After the first request, CF/PX set fresh cookies in the browser.
            // Re-injecting on every request overwrites those fresh cookies with older
            // originals, breaking subsequent requests (e.g. detail pages after category).
            const nowSecs = Date.now() / 1000;
            const alreadyInjected = session?.userData?.cookiesInjected === true;
            if (!alreadyInjected && sessionCookies && Array.isArray(sessionCookies) && sessionCookies.length > 0) {
                try {
                    const validCookies = sessionCookies.filter(c => {
                        const expiry = c.expirationDate ?? c.expires ?? null;
                        if (expiry && expiry < nowSecs) {
                            log.debug(`Skipping expired cookie: ${c.name}`);
                            return false;
                        }
                        return true;
                    });

                    if (validCookies.length < sessionCookies.length) {
                        log.warning(`Filtered ${sessionCookies.length - validCookies.length} expired cookies. ` +
                            `If cf_clearance expired, the scraper will earn a fresh one via session pre-warm.`);
                    }

                    if (validCookies.length > 0) {
                        const formattedCookies = validCookies.map(c => ({
                            name: c.name,
                            value: c.value,
                            domain: c.domain || '.sahibinden.com',
                            path: c.path || '/',
                            secure: c.secure !== false,
                            httpOnly: c.httpOnly === true,
                            sameSite: c.sameSite === 'no_restriction' ? 'None' : (c.sameSite || 'Lax'),
                        }));
                        await page.setCookie(...formattedCookies);
                        log.info(`Injected ${formattedCookies.length} valid session cookies: ${formattedCookies.map(c => c.name).join(', ')}`);
                        if (session) session.userData = { ...session.userData, cookiesInjected: true };
                    } else {
                        log.warning('All provided sessionCookies were expired — none injected. Please export fresh cookies from your browser.');
                    }
                } catch (e) {
                    log.warning(`Failed to inject session cookies: ${e.message}`);
                }
            } else if (alreadyInjected) {
                log.debug('Session already has cookies from previous request — skipping re-injection to preserve fresh CF/PX cookies.');
            }

            // Check if we have a valid cf_clearance (from either input cookies or session pool)
            const allCurrentCookies = await page.cookies('https://www.sahibinden.com').catch(() => []);
            const cfClearanceCookie = allCurrentCookies.find(c => c.name === 'cf_clearance');
            const hasValidCfClearance = cfClearanceCookie
                ? (!cfClearanceCookie.expires || cfClearanceCookie.expires === -1 || cfClearanceCookie.expires > nowSecs)
                : false;

            if (cfClearanceCookie) {
                const expiry = cfClearanceCookie.expires;
                const expiresIn = expiry && expiry !== -1 ? Math.round((expiry - nowSecs) / 60) : null;
                log.info(`cf_clearance cookie found. expires in: ${expiresIn !== null ? expiresIn + ' min' : 'session'}, valid: ${hasValidCfClearance}`);
            } else {
                log.info('No cf_clearance cookie present in page context.');
            }

            // Pre-warm: navigate to homepage BEFORE target URL to earn cf_clearance.
            // Only runs once per session (tracked via session.userData.warmedUp).
            if (!hasValidCfClearance && !session?.userData?.warmedUp) {
                log.info('No valid cf_clearance found — pre-warming session via homepage...');
                try {
                    await page.goto('https://www.sahibinden.com', {
                        waitUntil: 'networkidle2',
                        timeout: 60000,
                    });
                    const warmContent = await page.content();
                    if (isChallengedPage(warmContent)) {
                        log.info('CF challenge on homepage during pre-warm, waiting for auto-resolution...');
                        await saveDebugInfo(page, 'prewarm-challenge');
                        try {
                            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
                            const afterWarm = await page.content();
                            if (isChallengedPage(afterWarm)) {
                                log.warning('Pre-warm CF challenge did not resolve. Will attempt target URL anyway.');
                                await saveDebugInfo(page, 'prewarm-challenge-unresolved');
                            } else {
                                log.info('Pre-warm CF challenge resolved.');
                            }
                        } catch (e) {
                            log.warning(`Pre-warm CF challenge wait timed out: ${e.message}`);
                        }
                    } else {
                        log.info('Pre-warm homepage loaded successfully (no challenge).');
                    }
                    if (session) session.userData = { ...session.userData, warmedUp: true };
                    await randomDelay(1500, 3000);
                } catch (e) {
                    log.warning(`Session pre-warm failed: ${e.message}`);
                }
            } else if (hasValidCfClearance) {
                log.debug('Valid cf_clearance present, skipping pre-warm.');
            }

            // Use a stable user agent for this session.
            // cf_clearance is tied to the UA that earned it — changing UA between requests
            // (category page → detail pages) causes CF to challenge every detail page.
            let ua = session?.userData?.userAgent;
            if (!ua) {
                ua = randomUserAgent();
                if (session) session.userData = { ...session.userData, userAgent: ua };
                log.debug(`Assigned user agent for session: ${ua}`);
            }
            await page.setUserAgent(ua);

            // Derive sec-ch-ua version from the UA string so they stay consistent.
            // Only Chrome/Edge UAs send sec-ch-ua; skip the header for Firefox/Safari.
            const chromeVerMatch = ua.match(/Chrome\/(\d+)/);

            // For detail pages, simulate a same-origin navigation from the category page.
            // CF checks Sec-Fetch-Site and Referer — a direct navigation ('none') to a
            // /ilan/*/detay URL is highly suspicious; same-origin navigation is normal.
            const requestLabel = request.userData?.label;
            const isDetailPage = requestLabel === 'DETAIL';
            const sourceUrl = request.userData?.listingData?.sourceUrl;

            const extraHeaders = {
                'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': isDetailPage ? 'same-origin' : 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1',
            };
            if (isDetailPage && sourceUrl) {
                extraHeaders['Referer'] = sourceUrl;
            }
            if (chromeVerMatch) {
                const v = chromeVerMatch[1];
                extraHeaders['sec-ch-ua'] = `"Not A(Brand";v="99", "Google Chrome";v="${v}", "Chromium";v="${v}"`;
                extraHeaders['sec-ch-ua-mobile'] = '?0';
                extraHeaders['sec-ch-ua-platform'] = '"Windows"';
            }
            await page.setExtraHTTPHeaders(extraHeaders);

            // Extra delay before detail pages — burst of navigations triggers CF/PX rate limits.
            if (isDetailPage) {
                await randomDelay(4000, 8000);
            }

            await page.setViewport({ width: 1920, height: 1080 });

            // Stealth overrides — run before any page JS
            await page.evaluateOnNewDocument(() => {
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

                // Realistic navigator properties (PerimeterX checks these)
                Object.defineProperty(navigator, 'languages', { get: () => ['tr-TR', 'tr', 'en-US', 'en'] });
                Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
                Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
                Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
                Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });

                // Screen properties consistent with viewport
                Object.defineProperty(screen, 'width', { get: () => 1920 });
                Object.defineProperty(screen, 'height', { get: () => 1080 });
                Object.defineProperty(screen, 'availWidth', { get: () => 1920 });
                Object.defineProperty(screen, 'availHeight', { get: () => 1040 });
                Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
                Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });

                // Mock plugins
                Object.defineProperty(navigator, 'plugins', {
                    get: () => {
                        const plugins = [
                            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                            { name: 'Chrome PDF Viewer', filename: 'mhjimihiapuabedfglidnhagcfenogec', description: '' },
                            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
                        ];
                        plugins.item = (i) => plugins[i];
                        plugins.namedItem = (name) => plugins.find(p => p.name === name);
                        plugins.refresh = () => { };
                        plugins[Symbol.iterator] = function* () { yield* Object.values(plugins); };
                        Object.setPrototypeOf(plugins, PluginArray.prototype);
                        return plugins;
                    },
                });

                // WebGL fingerprint
                const getParameter = WebGLRenderingContext.prototype.getParameter;
                WebGLRenderingContext.prototype.getParameter = function (parameter) {
                    if (parameter === 37445) return 'Intel Inc.';
                    if (parameter === 37446) return 'Intel Iris OpenGL Engine';
                    return getParameter.call(this, parameter);
                };
            });

            if (gotoOptions) {
                gotoOptions.waitUntil = 'networkidle2';
                gotoOptions.timeout = 90000;
            }
        },
    ],

    postNavigationHooks: [
        async ({ page, response, request, session }) => {
            const statusCode = response?.status();
            log.info(`Response status: ${statusCode} for ${request.url}`);

            if (statusCode === 403 || statusCode === 503 || statusCode === 429) {
                log.warning(`Got ${statusCode} for ${request.url} — checking page content...`);
                await saveDebugInfo(page, `${statusCode}-initial`);

                await randomDelay(5000, 10000);

                try {
                    await page.mouse.move(100 + Math.random() * 500, 100 + Math.random() * 500);
                    await page.mouse.move(200 + Math.random() * 500, 200 + Math.random() * 500);
                } catch (e) { }

                const content = await page.content();

                if (isPxHoldChallenge(content)) {
                    // PerimeterX "press and hold" challenge
                    log.info('PerimeterX hold challenge detected — attempting automated hold...');
                    await saveDebugInfo(page, `${statusCode}-px-hold`);
                    const pxSolved = await tryHoldPxButton(page);
                    if (!pxSolved) {
                        log.warning('PerimeterX hold challenge failed. Provide _px3/_pxhd/_pxvid/pxcts cookies from your browser to bypass this.');
                        await saveDebugInfo(page, `${statusCode}-px-hold-failed`);
                        if (session) session.markBad();
                        throw new Error('PerimeterX hold challenge not resolved');
                    }
                } else if (isChallengedPage(content)) {
                    log.info('Cloudflare challenge page detected, waiting for auto-resolution...');
                    await saveDebugInfo(page, `${statusCode}-challenge`);
                    try {
                        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 });

                        // Re-check: navigation may have landed on another challenge page
                        const resolvedContent = await page.content();
                        if (isPxHoldChallenge(resolvedContent)) {
                            log.info('CF resolved but now hit PX hold challenge — attempting hold...');
                            await saveDebugInfo(page, `${statusCode}-cf-then-px`);
                            const pxSolved = await tryHoldPxButton(page);
                            if (!pxSolved) {
                                if (session) session.markBad();
                                throw new Error('PerimeterX hold challenge not resolved after CF');
                            }
                        } else if (isChallengedPage(resolvedContent)) {
                            log.warning('Cloudflare challenge navigated to another challenge page. Marking session bad.');
                            await saveDebugInfo(page, `${statusCode}-challenge-still-blocked`);
                            if (session) session.markBad();
                            throw new Error('Cloudflare Turnstile challenge requires manual verification');
                        } else {
                            log.info('Cloudflare challenge resolved!');
                        }
                    } catch (e) {
                        if (e.message.includes('Turnstile') || e.message.includes('PerimeterX')) throw e;
                        log.warning('Cloudflare challenge did not resolve in time. Retrying...');
                        await saveDebugInfo(page, `${statusCode}-challenge-timeout`);
                        if (session) session.markBad();
                        throw new Error('Cloudflare challenge timeout');
                    }
                } else {
                    log.warning('Received 403 without recognized challenge page. Marking session as bad.');
                    await saveDebugInfo(page, `${statusCode}-unknown-block`);
                    if (session) session.markBad();
                    throw new Error(`Blocked with status ${statusCode}`);
                }
            }

            // Detect tloading page (200 but JS redirect page)
            if (page.url().includes('/cs/tloading')) {
                log.info('Detected tloading protection page, waiting for JS redirect...');
                try {
                    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
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

    requestHandler: async ({ page, request, enqueueLinks }) => {
        const label = request.userData?.label || 'CATEGORY';
        log.info(`Processing page [${label}]: ${request.url}`);

        await randomDelay(2000, 5000);

        try {
            await page.waitForSelector('body', { timeout: 45000 });

            await handleCategoryPage(page, request, enqueueLinks);

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
    const pricePerSqmSelector = 'td.searchResultsPriceValue:nth-of-type(2)';
    const areaSelector = 'td.searchResultsAttributeValue';
    const dateSelector = 'td.searchResultsDateValue';
    const locationSelector = 'td.searchResultsLocationValue';
    const nextPageSelector = 'a.prevNextBut[title="Sonraki"]:not(.passive)';

    try {
        let listingElements = [];
        try {
            await page.waitForSelector(listingRowSelector, { timeout: 15000 });
            listingElements = await page.$$(listingRowSelector);
            if (debugMode) await saveDebugInfo(page, 'category-loaded');
        } catch (e) {
            log.warning(`Primary selector failed: ${listingRowSelector}`);

            const pageTitle = await page.title().catch(() => 'unknown');
            const currentUrl = page.url();
            log.info('Page state when selector failed:', { title: pageTitle, url: currentUrl });
            await saveDebugInfo(page, 'category-selector-failed');

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
                        try { await baseRowIntegration.storeListings(results); } catch (error) {
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
                const pricePerSqmText = await element.$eval(pricePerSqmSelector, el => el.textContent?.trim()).catch(() => null);
                const areaText = await element.$eval(areaSelector, el => el.textContent?.trim()).catch(() => null);
                const location = await element.$eval(locationSelector, el => el.innerText?.trim().replace(/\n/g, ' / ')).catch(() => null);
                const date = await element.$eval(dateSelector, el => el.innerText?.trim().replace(/\n/g, ' ')).catch(() => null);
                const image = await element.$eval('img', el => el.src || el.dataset?.src || null).catch(() => null);
                // Use data-id attribute directly — more reliable than regex on the URL
                const id = await element.evaluate(el => el.getAttribute('data-id')).catch(() => null)
                    ?? extractListingId(detailUrl);

                const listingData = {
                    id,
                    url: detailUrl,
                    title: normalizeText(title),
                    price: formatPrice(priceText),
                    price_currency: extractCurrency(priceText),
                    price_raw: priceText,
                    price_per_sqm: normalizeText(pricePerSqmText),
                    area: normalizeText(areaText),
                    location: normalizeText(location),
                    date: normalizeText(date),
                    image,
                    scrapedAt: new Date().toISOString(),
                    sourceUrl: request.url,
                };

                results.push(listingData);
                scrapedItemsCount++;

            } catch (extractError) {
                const errorMsg = extractError instanceof Error ? extractError.message : String(extractError);
                log.warning(`Could not process one item on ${request.url}`, { error: errorMsg });
            }
        }

        if (results.length > 0) {
            await Actor.pushData(results);
            log.info(`Pushed ${results.length} listings from page. Total scraped: ${scrapedItemsCount}`);
            if (baseRowIntegration) {
                try { await baseRowIntegration.storeListings(results); } catch (error) {
                    log.warning('Failed to store data in BaseRow', { error: error.message });
                }
            }
        } else {
            log.info(`No listings extracted from page ${request.url}.`);
        }

        // Enqueue next category page BEFORE processing detail pages inline,
        // so subsequent pages are queued and will run after we finish this batch.
        if (maxItems === null || scrapedItemsCount < maxItems) {
            const nextPageUrl = await page.$eval(nextPageSelector, anchor => anchor.href).catch(() => null);
            if (nextPageUrl) {
                log.info(`Enqueueing next category page: ${nextPageUrl}`);
                const absoluteNextPageUrl = new URL(nextPageUrl, request.loadedUrl || request.url).toString();
                await enqueueLinks({ urls: [absoluteNextPageUrl], userData: { label: 'CATEGORY' } });
            } else {
                log.info(`No next page button found on ${request.url}`);
            }
        }

        if (maxItems !== null && scrapedItemsCount >= maxItems) {
            log.info(`Maximum items limit (${maxItems}) reached after detail processing.`);
            await crawler.autoscaledPool?.abort();
        }

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.warning(`Could not handle category page ${request.url}: ${errorMessage}`);
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
