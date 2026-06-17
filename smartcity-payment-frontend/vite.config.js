import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  // cache bust: 1781680979
  logLevel: 'error',
  plugins: [react()],
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  build: {
    rollupOptions: {
      output: {
        // 매 빌드마다 새 해시 → 브라우저 캐시 무효화
        entryFileNames: `assets/[name]-[hash].js`,
        chunkFileNames: `assets/[name]-[hash].js`,
        assetFileNames: `assets/[name]-[hash].[ext]`,
      }
    }
  },
  preview: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: 'all',
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
  },
});
