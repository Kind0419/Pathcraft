import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    watch: {
      ignored: [
        '**/.edge-profile*/**',
        '**/.tmp-test/**',
        '**/screenshot*.png',
        '**/dist/**',
      ],
    },
  },
})