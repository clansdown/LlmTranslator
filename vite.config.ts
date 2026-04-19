import { defineConfig } from 'vite';

export default defineConfig({
    build: {
        target: 'es2020',
        minify: 'esbuild',
        sourcemap: true
    },
    server: {
        port: 8002,
        strictPort: true
    }
});
