/**
 * Asset caching for the Translate service worker.
 *
 * Behaviour is carried over from the previous `public/sw.js`:
 *  - JS/CSS and HTML: network-first, so edits are picked up promptly.
 *  - Images: network-first with an offline cache fallback.
 *
 * Caching is disabled in the dev-server worker build (`__SW_DEV__`): the worker
 * still activates and claims the page (so the streaming path is exercised in
 * development), but it never precaches, never purges, and never reads or writes
 * a cache entry.
 */
import { swSelf } from './scope';

/** Cache names are namespaced per FindForge app; only caches with this prefix are ours. */
const CACHE_PREFIX: string = 'translate-';

/** Cache names used before the suite-wide namespacing; purged once on activate. */
const LEGACY_CACHE_PREFIXES: string[] = ['llm-translator-'];

/** Cache-name suffix so previous cache versions age out on activate. */
const CACHE_VERSION: string = __SW_BUILD_ID__;

const STATIC_CACHE: string = `${CACHE_PREFIX}static-${CACHE_VERSION}`;
const DYNAMIC_CACHE: string = `${CACHE_PREFIX}dynamic-${CACHE_VERSION}`;

/** Application shell cached during install (resolved relative to the worker). */
const STATIC_ASSETS: string[] = ['./', './index.html'];

/** Cached shell used as the offline fallback for navigations. */
const SHELL_URL: string = './index.html';

/**
 * Registers the install/activate/fetch listeners that implement caching.
 * @returns {void}
 */
export function installCaching(): void {
    swSelf.addEventListener('install', (event: ExtendableEvent) => {
        event.waitUntil(handleInstall());
    });

    swSelf.addEventListener('activate', (event: ExtendableEvent) => {
        event.waitUntil(handleActivate());
    });

    swSelf.addEventListener('fetch', (event: FetchEvent) => {
        if (__SW_DEV__) { return; }
        if (event.request.method !== 'GET') { return; }

        const url = new URL(event.request.url);
        if (url.origin !== swSelf.location.origin) { return; }

        if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
            event.respondWith(networkFirst(event.request, STATIC_CACHE));
        } else if (event.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
            event.respondWith(networkFirst(event.request, DYNAMIC_CACHE));
        } else if (/\.(png|jpg|jpeg|svg|ico)$/.test(url.pathname)) {
            event.respondWith(networkFirst(event.request, DYNAMIC_CACHE));
        }
    });
}

/**
 * Handles installation: precaches the app shell (production only) then activates.
 * @returns {Promise<void>} Resolves once the worker is ready to activate
 */
async function handleInstall(): Promise<void> {
    if (!__SW_DEV__) {
        await precacheShell();
    }
    await swSelf.skipWaiting();
}

/**
 * Handles activation: purges stale caches (production only) then claims clients.
 * `clients.claim()` always runs, including in dev, so the page is controlled and
 * the service-worker streaming path is exercised during development.
 * @returns {Promise<void>} Resolves once stale caches are gone and clients claimed
 */
async function handleActivate(): Promise<void> {
    if (!__SW_DEV__) {
        const names = await caches.keys();
        await Promise.all(names.map((name) => removeStaleCache(name)));
    }
    await swSelf.clients.claim();
}

/**
 * Caches the application shell. Failures are tolerated so a flaky network never
 * blocks worker activation.
 * @returns {Promise<void>} Resolves once the shell is cached or the attempt failed
 */
async function precacheShell(): Promise<void> {
    try {
        const cache = await caches.open(STATIC_CACHE);
        await cache.addAll(STATIC_ASSETS);
    } catch (error) {
        console.warn('[sw] Precache failed; continuing without the app shell:', error);
    }
}

/**
 * Deletes a stale cache belonging to this app. Caches owned by other FindForge
 * apps (a different prefix) are deliberately left untouched.
 * @param {string} name - Cache name to consider
 * @returns {Promise<void>} Resolves once the cache is removed or deliberately kept
 */
function removeStaleCache(name: string): Promise<void> {
    const isOurs: boolean = name.startsWith(CACHE_PREFIX)
        || LEGACY_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix));
    if (!isOurs) { return Promise.resolve(); }
    if (name === STATIC_CACHE || name === DYNAMIC_CACHE) { return Promise.resolve(); }
    return caches.delete(name).then(() => undefined);
}

/**
 * Fetches network-first, falling back to the cache (and the cached shell for navigations).
 * @param {Request} request - Request being handled
 * @param {string} cacheName - Cache to read from and populate
 * @returns {Promise<Response>} The network response, a cached response, or an offline error
 */
async function networkFirst(request: Request, cacheName: string): Promise<Response> {
    const forceRevalidate: boolean = request.url.endsWith('.js')
        || request.url.endsWith('.css')
        || request.url.endsWith('.html')
        || request.mode === 'navigate';
    const fetchOptions: RequestInit = forceRevalidate ? { cache: 'no-cache' } : {};

    try {
        const response = await fetch(request, fetchOptions);
        if (response.ok) {
            const responseClone = response.clone();
            void caches.open(cacheName).then((cache) => cache.put(request, responseClone));
        }
        return response;
    } catch {
        const cached = await caches.match(request, { cacheName });
        if (cached) { return cached; }
        if (request.mode === 'navigate') {
            const shell = await caches.match(SHELL_URL, { cacheName: STATIC_CACHE });
            if (shell) { return shell; }
        }
        return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
    }
}
