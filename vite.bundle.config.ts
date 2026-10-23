import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Release build: one classic IIFE script, no ES modules anywhere.
 *
 * The normal build emits `<script type="module">`, which is correct for the web
 * but is the exact thing that fails when `Pathcraft.html` is opened from disk in
 * some environments (file:// treats the document as an opaque origin, and a few
 * embedded webviews refuse module scripts there outright). A classic script has
 * no such restriction, so double-clicking the file works everywhere.
 */
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist-bundle',
    emptyOutDir: true,
    target: 'es2019',
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'pathcraft.js',
        assetFileNames: 'pathcraft.[ext]',
      },
    },
  },
})
