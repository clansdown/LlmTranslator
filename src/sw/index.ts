/**
 * Translate service worker entry point.
 *
 * Layers:
 *  - `cache.ts`   — asset caching (a normal, expected service-worker duty).
 *  - `router.ts`  — page message dispatch (streaming jobs and cancellation).
 *
 * This file is bundled by Vite as a self-contained classic script and served at
 * the application root (`sw.js`), which gives it app-wide scope. See
 * `docs/service-worker-architecture.md`.
 */
import { DEBUG_API_CALLS } from '@/debug';
import { setDebugApiCalls } from '@/core/openrouter';
import { installCaching } from './cache';
import { installRouter } from './router';

// Share the app's debug setting with the streaming code running in the worker.
setDebugApiCalls(DEBUG_API_CALLS);

installCaching();
installRouter();
