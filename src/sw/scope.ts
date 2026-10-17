/**
 * Typed handle to the service-worker global scope.
 *
 * The TypeScript WebWorker lib types `self` as `WorkerGlobalScope`, which does
 * not include the service-worker-only APIs (`clients`, `skipWaiting`,
 * `registration`). Narrowing once here keeps the rest of `src/sw` clean.
 */
export const swSelf: ServiceWorkerGlobalScope = self as unknown as ServiceWorkerGlobalScope;
