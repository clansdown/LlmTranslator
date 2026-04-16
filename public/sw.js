/**
 * Service Worker for LlmTranslator PWA
 * - JS/CSS: cache-first (instant load from cache, hash-busted on deploy)
 * - HTML/Images: network-first (ETags handled by browser, offline fallback)
 */

const CACHE_NAME = 'llm-translator-v1';
const STATIC_CACHE = 'llm-translator-static-v1';
const DYNAMIC_CACHE = 'llm-translator-dynamic-v1';

const STATIC_ASSETS = [
    '/',
    '/index.html'
];

self.addEventListener('install', function(event) {
    event.waitUntil(
        caches.open(STATIC_CACHE).then(function(cache) {
            return cache.addAll(STATIC_ASSETS);
        }).then(function() {
            return self.skipWaiting();
        })
    );
});

self.addEventListener('activate', function(event) {
    event.waitUntil(
        caches.keys().then(function(cacheNames) {
            return Promise.all(
                cacheNames.map(function(cacheName) {
                    if (cacheName !== STATIC_CACHE && cacheName !== DYNAMIC_CACHE) {
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(function() {
            return self.clients.claim();
        })
    );
});

self.addEventListener('fetch', function(event) {
    const url = new URL(event.request.url);

    if (event.request.method !== 'GET') {
        return;
    }

    if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
        event.respondWith(cacheFirst(event.request));
    } else if (event.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
        event.respondWith(networkFirst(event.request, DYNAMIC_CACHE, event));
    } else if (url.pathname.match(/\.(png|jpg|jpeg|svg|ico)$/)) {
        event.respondWith(networkFirst(event.request, DYNAMIC_CACHE, event));
    } else {
        return;
    }
});

function cacheFirst(request) {
    return caches.match(request).then(function(cached) {
        if (cached) {
            return cached;
        }
        return fetch(request).then(function(response) {
            if (response.ok) {
                const responseClone = response.clone();
                caches.open(STATIC_CACHE).then(function(cache) {
                    cache.put(request, responseClone);
                });
            }
            return response;
        });
    });
}

function networkFirst(request, cacheName, fetchEvent) {
    return fetch(request).then(function(response) {
        if (response.ok) {
            const responseClone = response.clone();
            caches.open(cacheName).then(function(cache) {
                cache.put(request, responseClone);
            });
        }
        return response;
    }).catch(function() {
        return caches.match(request).then(function(cached) {
            if (cached) {
                return cached;
            }
            if (fetchEvent.request.mode === 'navigate') {
                return caches.match('/index.html');
            }
            return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
        });
    });
}