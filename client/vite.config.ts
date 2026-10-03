import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev the SPA runs here (5173) and proxies API calls to the Nest server (3002).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Keep the browser's Host: the server only accepts changes whose Origin matches it
      // (the string shorthand would rewrite Host to 127.0.0.1:3002).
      '/api': { target: 'http://127.0.0.1:3002', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
