import { defineConfig } from 'vite';

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
    server: {
        port: 8002,
        strictPort: true
    }
});
