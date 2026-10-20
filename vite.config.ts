import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import type { Plugin } from 'vite'

// katex.min.css is inlined into index.css by Tailwind, so its relative
// `url(fonts/KaTeX_*)` references can't be resolved by Vite and would point at
// /assets/fonts/ (missing). The fonts are shipped from public/lib/katex/fonts.
// Runs after vite:css, so it sees the final CSS. (The content popup rewrites
// these itself at runtime; see src/content/shadowStyles.ts.)
const katexFontUrls = (): Plugin => ({
  name: 'katex-font-urls',
  transform(code, id) {
    if (!/\.css(?:$|\?)/.test(id) || !code.includes('KaTeX_')) return null
    return {
      code: code.replace(
        /url\(\s*(['"]?)(?:\.\/)?fonts\/(KaTeX_[\w-]+\.(?:woff2|woff|ttf))\1\s*\)/g,
        'url(/lib/katex/fonts/$2)',
      ),
      map: null,
    }
  },
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), katexFontUrls()],
  build: {
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/index.html'),
        options: resolve(__dirname, 'src/options/index.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
  esbuild: {
    charset: 'ascii',
  },
})