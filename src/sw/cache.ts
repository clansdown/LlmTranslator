/**
 * Asset caching for the Translate service worker.
 *
 * Behaviour is carried over from the previous `public/sw.js`:
 *  - JS/CSS and HTML: network-first, so edits are picked up promptly.
 *  - Images: network-first with an offline cache fallback.
 *
 * Caching is disabled in the dev-server worker build (`__SW_DEV__`) so that
 * transformed development modules are never served from cache.
 */
import { swSelf } from './scope';

/** Cache-name suffix so previous cache versions age out on activate. */
const CACHE_VERSION: string = 'v2';

const STATIC_CACHE: string = `llm-translator-static-${CACHE_VERSION}`;
const DYNAMIC_CACHE: string = `llm-translator-dynamic-${CACHE_VERSION}`;

/** Application shell cached during install (resolved relative to the worker). */
const STATIC_ASSETS: string[] = ['./', './index.html'];

/**
 * Registers the install/activate/fetch listeners that implement caching.
 * @returns {void}
 */
export function installCaching(): void {
    swSelf.addEventListener('install', (event: ExtendableEvent) => {
        event.waitUntil(
            caches.open(STATIC_CACHE)
                .then((cache) => cache.addAll(STATIC_ASSETS))
                .then(() => swSelf.skipWaiting())
        );
    });

    swSelf.addEventListener('activate', (event: ExtendableEvent) => {
        event.waitUntil(
            caches.keys()
                .then((names) => Promise.all(names.map((name) => removeOldCache(name))))
                .then(() => swSelf.clients.claim())
        );
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
 * Deletes a cache that is not one of the current cache names.
 * @param {string} name - Cache name to consider
 * @returns {Promise<void>} Resolves once the cache is removed or deliberately kept
 */
function removeOldCache(name: string): Promise<void> {
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
        const cached = await caches.match(request);
        if (cached) { return cached; }
        if (request.mode === 'navigate') {
            const shell = await caches.match('./index.html');
            if (shell) { return shell; }
        }
        return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
    }
}
