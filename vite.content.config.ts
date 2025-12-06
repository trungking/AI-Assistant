import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
    plugins: [react()],
    define: {
        'process.env.NODE_ENV': '"production"',
    },
    build: {
        emptyOutDir: false, // Don't wipe the dist folder, main build does that
        outDir: 'dist',
        lib: {
            entry: resolve(__dirname, 'src/content/index.ts'),
            name: 'ContentScript',
            fileName: () => 'assets/content.js',
            formats: ['iife'],
        },
        rollupOptions: {
            output: {
                extend: true,
            },
        },
    },
})
