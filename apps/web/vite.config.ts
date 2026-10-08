import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // xfwd passes the browser's host, so the server's Origin check accepts same-origin admin writes in dev.
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true, xfwd: true } },
  },
});
