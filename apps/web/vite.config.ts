import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The portal is a static SPA (AGENTS.md §9): no SSR, no framework routing conventions. The
 * build output is a `dist/` folder that apps/api serves.
 *
 * In development the API runs separately on :3000 and this proxies `/api` to it, so client
 * code uses the same paths in both environments and never branches on a base URL.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.API_URL ?? 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The prerender writes into dist/prerendered afterwards; a later `vite build` clears it,
    // which is why `mise run build` always runs the two in that order.
    sourcemap: false,
  },
});
