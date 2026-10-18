/**
 * Ambient declarations for the service-worker build.
 *
 * `__SW_DEV__` and `__SW_BUILD_ID__` are injected by Vite at build time (see
 * `build/swBuildConfig.ts`): `__SW_DEV__` is `true` for the dev-server worker
 * build (caching disabled) and `false` for production; `__SW_BUILD_ID__` is a
 * fresh identifier per build, used to version the worker's caches.
 */
declare const __SW_DEV__: boolean;

declare const __SW_BUILD_ID__: string;
