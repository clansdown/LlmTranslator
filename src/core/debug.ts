/**
 * Debug flags shared by the page and the service worker.
 *
 * This module belongs to the `core/` layer so worker code (`sw/`) can read the
 * flags without importing a page-root module. Page-only modules import the same
 * values through the `src/debug.ts` re-export shim, so there is one source of
 * truth.
 */

/** Log translation pipeline diagnostics. */
export const DEBUG_TRANSLATIONS: boolean = false;

/** Log session storage diagnostics. */
export const DEBUG_SESSIONS: boolean = false;

/** Log OpenRouter API call diagnostics (page and worker). */
export const DEBUG_API_CALLS: boolean = true;

/** Log streaming chunk arrival and render timing (page only). */
export const DEBUG_STREAM_RENDER: boolean = false;
