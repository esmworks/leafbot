import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'sucrase';

/*
 * What a bot's page gets to look and work like an app: a theme (colours, font, light and dark),
 * `window.leafbot` to keep its own data, read and change the bot's tables and call the person's
 * connected apps through the host that shows it, and for a `.jsx` page React with Tailwind, lucide
 * icons and Recharts, served by this server so they load without reaching any CDN.
 */

/** Where the kit's files are served, outside /api: a page opened by its share link loads them too. */
export const PAGE_KIT_PATH = '/page-kit';

/** The modules a `.jsx` page may import, and the kit file that brings each. */
const MODULES: Record<string, string> = {
  react: 'react.js',
  'react/jsx-runtime': 'react.js',
  'react-dom': 'react.js',
  'react-dom/client': 'react.js',
  'lucide-react': 'lucide.js',
  recharts: 'recharts.js',
};

interface Kit {
  files: Map<string, string>;
  /** Changes with the files, so a browser may keep them for good under one address. */
  version: string;
}

let kit: Promise<Kit> | null = null;

/** The kit, prebuilt beside the bundled server (dist/page-kit), else built now (run from source). */
export function pageKit(): Promise<Kit> {
  kit ??= (async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const built = join(here, 'page-kit');
    let files: Record<string, string>;
    if (existsSync(built)) {
      files = Object.fromEntries(readdirSync(built).map((f) => [f, readFileSync(join(built, f), 'utf8')]));
    } else {
      // Run from source: esbuild is there to build it. The name is not written out, so the bundle
      // does not take the builder in.
      const builder = join(here, '..', 'page-kit.mjs');
      const mod = (await import(builder)) as { buildPageKit(): Promise<Record<string, string>> };
      files = await mod.buildPageKit();
    }
    const hash = createHash('sha256');
    for (const [name, text] of Object.entries(files).sort()) hash.update(name).update(text);
    return { files: new Map(Object.entries(files)), version: hash.digest('hex').slice(0, 12) };
  })();
  kit.catch(() => (kit = null));
  return kit;
}

/**
 * Colours and type every page starts from, in light and dark, as CSS variables, and the same
 * names as Tailwind colours (`bg-surface`, `text-muted`, `border-line`, `bg-accent`). The host says
 * which theme it shows; without it the system's is used.
 */
const THEME_CSS = `:root{color-scheme:light;--lb-bg:#f7f7f5;--lb-surface:#ffffff;--lb-surface-2:#f0f0ed;--lb-text:#1c1c1e;--lb-muted:#6b6b70;--lb-line:#e3e3df;--lb-accent:#2f7d4f;--lb-accent-text:#ffffff;--lb-danger:#d14343;--lb-radius:14px;--lb-font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--lb-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
:root[data-theme=dark]{color-scheme:dark;--lb-bg:#161618;--lb-surface:#1f1f22;--lb-surface-2:#2a2a2e;--lb-text:#ececee;--lb-muted:#a1a1a8;--lb-line:#34343a;--lb-accent:#5cb37f;--lb-accent-text:#0d1f14;--lb-danger:#f07070}
html{background:var(--lb-bg);color:var(--lb-text);font-family:var(--lb-font);-webkit-font-smoothing:antialiased}
body{margin:0}`;

/** Tailwind's own theme on the page's variables, and dark: following the host's theme. */
const TAILWIND_THEME = `@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));
@theme inline{--color-bg:var(--lb-bg);--color-surface:var(--lb-surface);--color-surface-2:var(--lb-surface-2);--color-fg:var(--lb-text);--color-muted:var(--lb-muted);--color-line:var(--lb-line);--color-accent:var(--lb-accent);--color-accent-fg:var(--lb-accent-text);--color-danger:var(--lb-danger);--font-sans:var(--lb-font);--font-mono:var(--lb-mono)}`;

/** What the helper's calls reject with where nothing shows the page (a share link, an image). */
const NO_HOST = 'This page is open on its own: it cannot keep data, read tables or call connected apps here.';

/**
 * `window.leafbot`: the page's calls, sent to the host that shows it as JSON-RPC requests
 * (`leafbot/<method>`). The host checks each and asks the server, which checks again.
 */
function helper(theme: 'light' | 'dark' | null): string {
  const set = theme
    ? `document.documentElement.dataset.theme=${JSON.stringify(theme)};`
    : `if(matchMedia('(prefers-color-scheme: dark)').matches)document.documentElement.dataset.theme='dark';`;
  return `<script>(()=>{${set}let n=0;const w=new Map();const host=window.parent!==window;addEventListener('message',(e)=>{if(e.source!==parent)return;const m=e.data;if(!m||m.jsonrpc!=='2.0'||typeof m.id!=='string'||!w.has(m.id))return;const p=w.get(m.id);w.delete(m.id);if(m.error)p[1](new Error(m.error.message||'Failed'));else p[0](m.result)});const call=(method,params)=>new Promise((ok,no)=>{if(!host)return no(new Error(${JSON.stringify(NO_HOST)}));const id='leafbot:'+ ++n;w.set(id,[ok,no]);parent.postMessage({jsonrpc:'2.0',id,method:'leafbot/'+method,params:params||{}},'*')});const list=(v)=>Array.isArray(v)?v:[v];window.leafbot={theme:document.documentElement.dataset.theme==='dark'?'dark':'light',state:{get:(key)=>call('state.get',{key}),set:(key,value)=>call('state.set',{key,value}),remove:(key)=>call('state.set',{key}),keys:()=>call('state.keys')},data:{tables:()=>call('data.tables'),rows:(table)=>call('data.rows',{table}),add:(table,rows)=>call('data.add',{table,rows:list(rows)}),update:(table,id,values)=>call('data.update',{table,id,values}),remove:(table,ids)=>call('data.remove',{table,ids:list(ids)})},connectors:{list:()=>call('connectors.list'),call:(tool,args)=>call('connectors.call',{tool,args:args||{}})}}})()</script>`;
}

/** The theme and helper every bot page starts with, before its own markup. */
export function pageHead(theme: 'light' | 'dark' | null): string {
  return `<style>${THEME_CSS}</style>${helper(theme)}`;
}

const scriptText = (s: string) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

/** The modules a page's code imports, in the order it names them. */
function importsOf(source: string): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(
    /(?:\bimport\b[^'"`;]*?\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g,
  ))
    found.add(m[1]!);
  return [...found];
}

/** A page that cannot run, saying why, in its place. */
const failedPage = (why: string) =>
  `<div style="padding:24px;font-family:var(--lb-font);color:var(--lb-danger)"><b>This page could not start.</b><pre style="white-space:pre-wrap;font-family:var(--lb-mono);font-size:12px;color:var(--lb-muted)">${why.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</pre></div>`;

/**
 * A `.jsx` page: one React component file whose default export is the page. It is turned into
 * plain script here; the kit files it needs load first, Tailwind styles its classes, and
 * `import { useStored, useRows } from 'leafbot'` gives it state and tables as React hooks.
 */
export async function jsxPage(source: string): Promise<string> {
  const { version } = await pageKit();
  const url = (file: string) => `${PAGE_KIT_PATH}/${version}/${file}`;
  const wanted = importsOf(source);
  const unknown = wanted.filter((m) => m !== 'leafbot' && !MODULES[m]);
  if (unknown.length)
    return failedPage(
      `It imports ${unknown.join(', ')}; a page may import only react, react-dom, lucide-react, recharts and leafbot.`,
    );
  let code: string;
  try {
    code = transform(source, {
      transforms: ['jsx', 'typescript', 'imports'],
      jsxRuntime: 'automatic',
      production: true,
    }).code;
  } catch (err) {
    return failedPage((err as Error).message);
  }
  const files = new Set(['react.js', ...wanted.map((m) => MODULES[m]).filter((f): f is string => !!f)]);
  const scripts = [...files].map((f) => `<script src="${url(f)}"></script>`).join('');
  const run = `(()=>{const K=globalThis.__leafbotKit||{};const R=K.react;const L=window.leafbot;
const useStored=(key,initial)=>{const[v,setV]=R.useState(initial);const[ready,setReady]=R.useState(false);R.useEffect(()=>{let on=true;L.state.get(key).then((x)=>{if(on){if(x!==undefined&&x!==null)setV(x);setReady(true)}},()=>on&&setReady(true));return()=>{on=false}},[key]);const set=R.useCallback((next)=>{setV((cur)=>{const val=typeof next==='function'?next(cur):next;L.state.set(key,val).catch((e)=>console.error(e));return val})},[key]);return[v,set,ready]};
const useRows=(table)=>{const[s,setS]=R.useState({rows:[],loading:true,error:null});const load=R.useCallback(()=>L.data.rows(table).then((rows)=>setS({rows,loading:false,error:null}),(e)=>setS({rows:[],loading:false,error:e.message})),[table]);R.useEffect(()=>{load()},[load]);return{...s,reload:load}};
const kit={...L,useStored,useRows};
const require=(n)=>{if(n==='leafbot')return kit;if(!(n in K))throw new Error('Cannot load '+n);return K[n]};
const module={exports:{}};const exports=module.exports;
const show=(e)=>{document.getElementById('root').innerHTML=${JSON.stringify(failedPage('__WHY__'))}.replace('__WHY__',String(e&&e.message||e).replace(/[<&]/g,(c)=>c==='<'?'&lt;':'&amp;'))};
try{(function(require,module,exports){${scriptText(code)}
})(require,module,exports);const Page=module.exports.default||module.exports;if(typeof Page!=='function')throw new Error('The file has no default export: export default function App() {…}');
class Guard extends R.Component{constructor(p){super(p);this.state={e:null}}static getDerivedStateFromError(e){return{e}}componentDidCatch(e){show(e)}render(){return this.state.e?null:this.props.children}}
K['react-dom/client'].createRoot(document.getElementById('root')).render(R.createElement(Guard,null,R.createElement(Page)))}catch(e){show(e)}})()`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script src="${url('tailwind.js')}"></script><style type="text/tailwindcss">${TAILWIND_THEME}</style>${scripts}</head><body><div id="root"></div><script>${run}</script></body></html>`;
}

/**
 * The connected-app tools a page says it calls: `<meta name="leafbot:connectors" content="a b">`
 * in an HTML page, `// leafbot:connectors a, b` in a `.jsx` one. A page may call only these.
 */
export function declaredConnectors(text: string): string[] {
  const found = new Set<string>();
  const add = (list: string) => {
    for (const name of list.split(/[\s,]+/)) if (/^[\w.:-]{1,200}$/.test(name)) found.add(name);
  };
  for (const m of text.matchAll(/<meta\b[^>]*\bname=["']leafbot:connectors["'][^>]*>/gi)) {
    const content = /\bcontent=["']([^"']*)["']/i.exec(m[0])?.[1];
    if (content) add(content);
  }
  for (const m of text.matchAll(/^\s*\/\/\s*leafbot:connectors\s+(.+)$/gm)) add(m[1]!);
  return [...found].slice(0, 24);
}

/** Whether a page file is a React component page rather than an HTML one. */
export const isJsxPage = (file: string) => /\.(jsx|tsx)$/i.test(file);
/** Whether a file is a page a bot may show: HTML, or a React component. */
export const isPageFile = (file: string) => /\.(html?|jsx|tsx)$/i.test(file);
