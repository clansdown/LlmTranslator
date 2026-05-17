import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';

export default defineConfig({
    base: './',
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
        strictPort: true
    }
});
