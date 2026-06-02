import base44 from "@base44/vite-plugin"
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  logLevel: 'error',
  plugins: [
    base44({
      legacySDKImports: process.env.BASE44_LEGACY_SDK_IMPORTS === 'true',
      hmrNotifier: true,
      navigationNotifier: true,
      analyticsTracker: true,
      visualEditAgent: true
    }),
    react(),
  ],
  resolve: {
    alias: {
      '@': '/src',
    },
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
