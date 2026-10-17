/**
 * Vite dev-server plugin that builds and serves the Translate service worker.
 *
 * The worker carries critical runtime behaviour (streaming completions), so it
 * must be available in development too. `vite dev` does not run a production
 * build, so this plugin bundles `src/sw/index.ts` using the same configuration
 * as the production build (`build/swBuildConfig.ts`) and serves the result at
 * `/sw.js`, which matches the path registered in `index.html`.
 */
import fs from 'fs';
import path from 'path';
import { build, type Plugin, type ViteDevServer } from 'vite';
import { createSwBuildConfig } from './swBuildConfig';

/** Directory the dev-server worker build is written to (git-ignored). */
const DEV_SW_DIR: string = '.dev-sw';

/** Source subtrees that, when changed, require the worker to be rebuilt. */
const WATCHED_SEGMENTS: string[] = ['/src/sw/', '/src/core/'];

/**
 * Creates the dev-server plugin that builds and serves `sw.js`.
 * @returns {Plugin} Vite plugin scoped to `serve`
 */
export function serviceWorkerDevPlugin(): Plugin {
    let rebuildInFlight: Promise<void> | null = null;
    let rebuildQueued: boolean = false;

    /** Bundles the worker into the dev output directory. */
    async function rebuild(): Promise<void> {
        await build({
            configFile: false,
            ...createSwBuildConfig({ outDir: DEV_SW_DIR, dev: true })
        });
    }

    /** Runs a rebuild, coalescing requests that arrive while one is running. */
    function scheduleRebuild(): void {
        if (rebuildInFlight) {
            rebuildQueued = true;
            return;
        }
        rebuildInFlight = rebuild()
            .catch((error: unknown) => { console.error('[service-worker-dev] rebuild failed:', error); })
            .finally(() => {
                rebuildInFlight = null;
                if (rebuildQueued) {
                    rebuildQueued = false;
                    scheduleRebuild();
                }
            });
    }

    return {
        name: 'service-worker-dev',
        apply: 'serve',
        async configureServer(server: ViteDevServer): Promise<void> {
            server.middlewares.use((req, res, next) => {
                const url = req.url?.split('?')[0];
                if (url !== '/sw.js' && url !== '/sw.js.map') {
                    next();
                    return;
                }

                const filePath = path.resolve(DEV_SW_DIR, url === '/sw.js.map' ? 'sw.js.map' : 'sw.js');
                fs.readFile(filePath, (error, data) => {
                    if (error) {
                        res.statusCode = 404;
                        res.setHeader('Content-Type', 'application/javascript');
                        res.end('// service worker not built yet');
                        return;
                    }
                    res.statusCode = 200;
                    res.setHeader('Content-Type', url === '/sw.js.map' ? 'application/json' : 'application/javascript');
                    res.setHeader('Cache-Control', 'no-store');
                    res.end(data);
                });
            });

            const onSourceChange = (file: string): void => {
                if (WATCHED_SEGMENTS.some((segment) => file.includes(segment))) { scheduleRebuild(); }
            };
            server.watcher.on('change', onSourceChange);
            server.watcher.on('add', onSourceChange);

            await rebuild();
        }
    };
}
