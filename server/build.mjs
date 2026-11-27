// Bundles the server into dist/ for the desktop app and the Docker image.
import { cpSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

rmSync('dist', { recursive: true, force: true });
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // These load files relative to their own package (CLI binary, wasm), so they stay in node_modules.
  external: [
    '@anthropic-ai/claude-agent-sdk',
    // API-key bots' shell runs its command-line program, which loads helpers from its own package.
    '@anthropic-ai/sandbox-runtime',
    '@electric-sql/pglite',
    '@electric-sql/pglite/*',
    'playwright-core',
    // The same Playwright, patched, for the desktop's browser (see src/browser/manager.ts).
    'patchright-core',
    // A native image library, with a build for each platform beside it.
    'sharp',
    // WebRTC for browsers reaching the server through its account: native, with a package per platform.
    'node-datachannel',
    // Loaded only once WhatsApp is set up; it brings its own protocol files and native helpers.
    '@whiskeysockets/baileys',
    // Loaded only once 1Password is connected; its core is a WebAssembly file read from its package.
    '@1password/sdk',
    '@1password/sdk-core',
  ],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});
cpSync('drizzle', 'dist/drizzle', { recursive: true });
