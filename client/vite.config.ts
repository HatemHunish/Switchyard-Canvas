import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev the SPA runs here (5173) and proxies API calls to the Nest server (3002).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3002',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
