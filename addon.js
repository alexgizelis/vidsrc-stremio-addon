const { addonBuilder } = require("stremio-addon-sdk");

const host = process.env.VERCEL_URL || 'http://127.0.0.1:3000';
const iconUrl = host.startsWith('http') ? `${host}/icon.png` : `https://${host}/icon.png`;

const manifest = {
    "id": "community.nepflix.ries",
    "version": "1.6.0", // Versie verhoogd
    "name": "Nepflix",
    "description": "HLS streams van VidSrc",
    "icon": iconUrl,
    "catalogs": [],
    "resources": ["stream"],
    "types": ["movie", "series"],
    "idPrefixes": ["tt"]
};

const VIDSRC_DOMAINS = ["vidsrc-embed.ru", "vidsrc-embed.su", "vidsrcme.su", "vsrc.su"];

const BROWSER_PROFILES = [
    {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    }
];

function getRandomBrowserProfile() {
    return BROWSER_PROFILES[Math.floor(Math.random() * BROWSER_PROFILES.length)];
}

const COMMON_HEADERS = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q-0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
};

async function searchDomain(domain, apiType, imdbId, season, episode, controller, requestHeaders) {
    const signal = controller.signal;
    if (signal.aborted) return null;

    console.log(`[SEARCH] Asking resolver for domain: ${domain}`);
    const initialTarget = `https://${domain}/embed/${apiType}/${imdbId}${apiType === 'tv' && season && episode ? `/${season}-${episode}` : ''}`;

    const resolverUrl = host.startsWith('http') ? `${host}/api/resolve` : `https://${host}/api/resolve`;

    try {
        const response = await fetch(resolverUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                targetUrl: initialTarget,
                sourceDomain: domain,
                headers: requestHeaders
            }),
            signal
        });

        if (!response.ok) {
            console.log(`[RESOLVER CLIENT] Resolver failed for ${domain} with status ${response.status}`);
            if (response.status === 499) controller.abort();
            return null;
        }

        const data = await response.json();
        if (data.masterUrl) {
            console.log(`[SUCCESS] Resolver found m3u8 for domain ${domain}`);
            controller.abort();
            return {
                masterUrl: data.masterUrl,
                sourceDomain: data.sourceDomain,
                filename: data.filename
            };
        }
        return null;
    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error(`[RESOLVER CLIENT] Error calling resolver for ${domain}:`, error.message);
        }
        return null;
    }
}

function getVidSrcStream(type, imdbId, season, episode) {
    const apiType = type === 'series' ? 'tv' : 'movie';
    const controller = new AbortController();
    const MAX_CONCURRENT_SEARCHES = 3;
    const requestHeaders = { ...COMMON_HEADERS, ...getRandomBrowserProfile() };
    const domainQueue = [...VIDSRC_DOMAINS].sort(() => 0.5 - Math.random());

    console.log(`[GETSTREAM] Starting parallel search for ${imdbId}`);

    return new Promise(resolve => {
        let activeSearches = 0;
        let resultFound = false;
        const launchNext = () => {
            if (resultFound || domainQueue.length === 0) {
                if (activeSearches === 0 && !resultFound) resolve(null);
                return;
            }
            activeSearches++;
            const domain = domainQueue.shift();
            searchDomain(domain, apiType, imdbId, season, episode, controller, requestHeaders)
                .then(result => {
                    if (result && !resultFound) {
                        resultFound = true;
                        resolve(result);
                    }
                })
                .catch(err => { if (err.name !== 'AbortError') console.error(`[GETSTREAM] Error on domain ${domain}:`, err.message); })
                .finally(() => {
                    activeSearches--;
                    launchNext();
                });
        };
        for (let i = 0; i < MAX_CONCURRENT_SEARCHES && i < VIDSRC_DOMAINS.length; i++) {
            launchNext();
        }
    });
}

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    if (!imdbId) return Promise.resolve({ streams: [] });
    const streamSource = await getVidSrcStream(type, imdbId, season, episode);
    if (streamSource) {
        const title = streamSource.filename || `${streamSource.sourceDomain}`;
        const stream = {
            url: streamSource.masterUrl,
            title: title
        };
        return Promise.resolve({ streams: [stream] });
    }
    return Promise.resolve({ streams: [] });
});

module.exports = builder.getInterface();
