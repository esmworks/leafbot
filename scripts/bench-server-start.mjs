#!/usr/bin/env node
// Starts the built server (server/dist) a few times with the fake engine and prints how long each
// stage of its start took, as the server reports it on its LEAFBOT_TIMINGS line. One data folder
// is used for every run, so the first run pays for creating the database and the rest show a
// usual start; a compile cache folder is kept beside it unless --no-cache is given.
//
//   pnpm --filter @leafbot/server build
//   node scripts/bench-server-start.mjs [--runs 5] [--no-cache] [--exec <node or Electron binary>]
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const entry = join(import.meta.dirname, '../server/dist/start.mjs');
if (!existsSync(entry)) {
  console.error('server/dist/start.mjs is missing: run `pnpm --filter @leafbot/server build` first.');
  process.exit(1);
}
const runs = Math.max(1, Number(value('--runs', '5')));
const exec = value('--exec', process.execPath);
const dir = mkdtempSync(join(tmpdir(), 'leafbot-bench-'));
const cache = flag('--no-cache') ? null : join(dir, 'compile-cache');

/** Starts the server once; resolves with the wall time to its ready line and its own timings. */
function once() {
  return new Promise((resolve, reject) => {
    const from = performance.now();
    const child = spawn(exec, [entry], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        TMPDIR: process.env.TMPDIR ?? '/tmp',
        ELECTRON_RUN_AS_NODE: '1',
        LEAFBOT_HOST: '127.0.0.1',
        LEAFBOT_PORT: '0',
        LEAFBOT_DATA_DIR: join(dir, 'data'),
        LEAFBOT_ENGINE: 'fake',
        LEAFBOT_ACCESS_KEY: 'bench-key-0123456789abcdef',
        ...(cache ? { LEAFBOT_COMPILE_CACHE: cache } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready = 0;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('no ready line within 60 s'));
    }, 60_000);
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (line.startsWith('LEAFBOT_READY ')) ready = performance.now() - from;
      if (line.startsWith('LEAFBOT_TIMINGS ')) {
        clearTimeout(timer);
        const timings = JSON.parse(line.slice('LEAFBOT_TIMINGS '.length));
        child.once('exit', () => resolve({ ready, ...timings }));
        child.kill('SIGTERM');
      }
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    child.once('exit', (code) => {
      if (!ready) {
        clearTimeout(timer);
        reject(new Error(`the server stopped (${code}) before it was ready:\n${stderr}`));
      }
    });
  });
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
};
const fmt = (ms) => `${ms.toFixed(0).padStart(6)} ms`;

const results = [];
try {
  for (let i = 0; i < runs + 1; i++) {
    const r = await once();
    results.push(r);
    console.log(`run ${i === 0 ? 'first' : i}: ready after ${fmt(r.ready)}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// The first run creates the database (and fills the compile cache): it is shown on its own.
const usual = results.slice(1);
const names = (key) => [...new Set(results.flatMap((r) => Object.keys(r[key])))];
console.log(`\n${exec}${cache ? ' with a compile cache' : ' without a compile cache'}`);
console.log('stage (ms since the process began)      first     median of the rest');
for (const name of ['modules', ...names('marks').filter((n) => n !== 'modules')]) {
  const first = results[0].marks[name] ?? 0;
  console.log(`  ${name.padEnd(36)} ${fmt(first)}  ${fmt(median(usual.map((r) => r.marks[name] ?? 0)))}`);
}
console.log('step (its own length)');
for (const name of names('spans')) {
  const first = results[0].spans[name] ?? 0;
  console.log(`  ${name.padEnd(36)} ${fmt(first)}  ${fmt(median(usual.map((r) => r.spans[name] ?? 0)))}`);
}
console.log(
  `  ${'wall time to the ready line'.padEnd(36)} ${fmt(results[0].ready)}  ${fmt(median(usual.map((r) => r.ready)))}`,
);
