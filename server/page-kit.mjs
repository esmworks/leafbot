// The libraries a bot's page may use, built into files the server hands out itself (see src/page-kit.ts):
// React, lucide icons, Recharts and Tailwind. Pages run in a sandbox that reaches no CDN when the computer is
// offline or a network blocks it, and the same versions are served to every page.
//
// Each file is a plain script that adds its library to `globalThis.__leafbotKit`; lucide and Recharts take React
// from there, so a page holds one React however many of them it loads.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);

/** The React modules the other files share, by the names pages import them under. */
const SHARED = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'];

/** Resolves the shared React modules to the copy the react file put on the page. */
const sharedReact = {
  name: 'shared-react',
  setup(b) {
    const filter = new RegExp(`^(${SHARED.map((s) => s.replace('/', '\\/')).join('|')})$`);
    b.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'kit' }));
    b.onLoad({ filter: /.*/, namespace: 'kit' }, (args) => ({
      contents: `module.exports = globalThis.__leafbotKit[${JSON.stringify(args.path)}];`,
      loader: 'js',
    }));
  },
};

async function bundle(contents, plugins = []) {
  const out = await build({
    stdin: { contents, resolveDir: import.meta.dirname, loader: 'js' },
    bundle: true,
    write: false,
    format: 'iife',
    minify: true,
    target: 'es2020',
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins,
    logLevel: 'silent',
  });
  return out.outputFiles[0].text;
}

const put = (entries) =>
  `const k = (globalThis.__leafbotKit = globalThis.__leafbotKit || {});\n${entries
    .map(
      ([name, mod], i) =>
        `import * as m${i} from ${JSON.stringify(mod)};\nk[${JSON.stringify(name)}] = m${i};`,
    )
    .join('\n')}`;

/** The kit's files by name: `react.js`, `lucide.js`, `recharts.js`, `tailwind.js`. */
export async function buildPageKit() {
  return {
    'react.js': await bundle(put(SHARED.map((s) => [s, s]))),
    'lucide.js': await bundle(put([['lucide-react', 'lucide-react']]), [sharedReact]),
    'recharts.js': await bundle(put([['recharts', 'recharts']]), [sharedReact]),
    'tailwind.js': readFileSync(require.resolve('@tailwindcss/browser'), 'utf8'),
  };
}
