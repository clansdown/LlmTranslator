/**
 * Production build configuration for the Translate service worker.
 *
 * Emits `dist/sw.js` (the application root) so the worker's default scope
 * covers the whole app. Run after the main `vite build`, which owns `dist/`;
 * `emptyOutDir` is disabled in the shared config so the main build is preserved.
 */
import { defineConfig } from 'vite';
import { createSwBuildConfig } from './build/swBuildConfig';

export default defineConfig(createSwBuildConfig({ outDir: 'dist', dev: false }));
