import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// In development the API runs separately; the proxy keeps the page and the API on one origin
// so the session cookie and the Origin check behave as in production.
const api = process.env.LEAFBOT_API ?? 'http://127.0.0.1:4319';

/**
 * The web app on the website (`vite build --mode bots`): served under www.leafbot.app/bots, where it
 * reaches servers only through the tunnel. Its page comes from `bots/index.html` and is written as
 * the build's `index.html`, so the files sit at the paths the website serves them on.
 */
const botsPage: Plugin = {
  name: 'leafbot-bots-page',
  // After the HTML plugin, which adds the page to the bundle late.
  enforce: 'post',
  generateBundle(_, bundle) {
    const page = bundle['bots/index.html'];
    if (page) page.fileName = 'index.html';
  },
};

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), ...(mode === 'bots' ? [botsPage] : [])],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: api },
      // The libraries a bot's page loads from the server (see server/src/page-kit.ts).
      '/page-kit': { target: api },
      '/socket.io': { target: api, ws: true },
    },
  },
  ...(mode === 'bots'
    ? {
        base: '/bots/',
        build: {
          outDir: 'dist-bots/bots',
          emptyOutDir: true,
          // The website serves only what the page runs; the server's own build keeps the maps.
          sourcemap: false,
          rollupOptions: { input: fileURLToPath(new URL('./bots/index.html', import.meta.url)) },
        },
      }
    : { build: { outDir: 'dist', sourcemap: true } }),
}));
