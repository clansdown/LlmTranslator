/**
 * Debug configuration module
 * Set flags to true for development/debugging, false for production
 *
 * The values live in `core/debug.ts` so the service worker can import them
 * without reaching into the page root. This module re-exports them for
 * page-only consumers.
 */

export { DEBUG_TRANSLATIONS, DEBUG_SESSIONS, DEBUG_API_CALLS } from './core/debug';
