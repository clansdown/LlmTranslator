import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';
import { serviceWorkerDevPlugin } from './build/serviceWorkerDevPlugin';

export default defineConfig({
    base: './',
    resolve: {
        alias: {
            '@': path.resolve('src')
        }
    },
    build: {
        target: 'es2020',
        minify: 'esbuild',
        sourcemap: true,
        chunkSizeWarningLimit: 2000,
        rollupOptions: {
            output: {
                manualChunks: {
                    'clerk': ['@clerk/clerk-js'],
                    'bootstrap': ['bootstrap'],
                    'marked': ['marked'],
                    'dompurify': ['dompurify']
                }
            }
        }
    },
    plugins: [
        serviceWorkerDevPlugin(),
        {
            name: 'exclude-clerk-key',
            closeBundle() {
                const distPath = path.resolve('dist', 'clerk-key.js');
                if (fs.existsSync(distPath)) {
                    fs.unlinkSync(distPath);
                }
            }
        }
    ],
    server: {
        port: 8002,
        strictPort: true,
        watch: {
            ignored: ['**/.dev-sw/**']
        }
    }
});
