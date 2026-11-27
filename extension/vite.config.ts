import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { manifest } from './manifest.ts';

/** The extension carries the app's version, so the panel and the server it talks to read alike. */
const version = (
  JSON.parse(readFileSync(new URL('../app/package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

/** Writes manifest.json next to the built pages. */
const manifestFile = (): Plugin => ({
  name: 'leafbot-extension-manifest',
  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: 'manifest.json',
      source: `${JSON.stringify(manifest(version), null, 2)}\n`,
    });
  },
});

export default defineConfig({
  base: './',
  plugins: [react(), manifestFile()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Chrome loads the files as they are; the extension stores no secrets in them.
    sourcemap: false,
    rolldownOptions: {
      input: { sidepanel: 'sidepanel.html', background: 'src/background.ts' },
      output: { entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js' },
    },
  },
});
