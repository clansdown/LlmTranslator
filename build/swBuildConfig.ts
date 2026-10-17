/**
 * Shared build configuration for the Translate service worker.
 *
 * The worker is bundled as a single self-contained IIFE ("classic" script) so
 * that it can be registered without `{ type: 'module' }` and without runtime
 * `import` statements. It is emitted to the application root (`sw.js`) so that
 * its default scope covers the whole app rather than the assets directory.
 *
 * Both `vite.sw.config.ts` (production) and the dev-server plugin
 * (`serviceWorkerDevPlugin.ts`) build from this one definition, so dev and
 * production run an identical bundle.
 */
import path from 'path';
import type { UserConfig } from 'vite';

/** Options controlling a service-worker build. */
export interface SwBuildOptions {
    /** Directory the bundled `sw.js` is written to. */
    outDir: string;
    /** True for the dev-server build: caching disabled, no minification. */
    dev: boolean;
}

/**
 * Builds the Vite configuration used to bundle the service worker.
 * @param {SwBuildOptions} options - Output directory and dev/prod flag
 * @returns {UserConfig} Vite configuration for the worker bundle
 */
export function createSwBuildConfig(options: SwBuildOptions): UserConfig {
    return {
        base: './',
        resolve: {
            alias: {
                '@': path.resolve('src')
            }
        },
        define: {
            __SW_DEV__: JSON.stringify(options.dev)
        },
        build: {
            outDir: options.outDir,
            emptyOutDir: false,
            target: 'es2020',
            sourcemap: true,
            minify: options.dev ? false : 'esbuild',
            lib: {
                entry: path.resolve('src/sw/index.ts'),
                formats: ['iife'],
                name: 'TranslateServiceWorker',
                fileName: () => 'sw.js'
            },
            rollupOptions: {
                output: {
                    inlineDynamicImports: true
                }
            }
        }
    };
}
