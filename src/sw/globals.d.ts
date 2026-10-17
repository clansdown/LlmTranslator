/**
 * Ambient declarations for the service-worker build.
 *
 * `__SW_DEV__` is injected by Vite at build time (see `build/swBuildConfig.ts`):
 * `true` for the dev-server worker build (caching disabled), `false` for the
 * production worker build.
 */
declare const __SW_DEV__: boolean;
