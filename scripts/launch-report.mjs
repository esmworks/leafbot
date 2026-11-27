#!/usr/bin/env node
// Prints the desktop app's last starts, stage by stage: the median and the slowest tenth of the
// usual starts (not the first, not the first after an update), and the last start in full. The app
// keeps them in launch-history.json in its data folder, on this computer only.
//
//   node scripts/launch-report.mjs [path to launch-history.json]
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const fallback = () => {
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library/Application Support/esmworks-leafbot');
  if (process.platform === 'win32')
    return join(process.env.APPDATA ?? join(home, 'AppData/Roaming'), 'esmworks-leafbot');
  return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'esmworks-leafbot');
};
const file = process.argv[2] ?? join(process.env.LEAFBOT_DESKTOP_DATA ?? fallback(), 'launch-history.json');

let history;
try {
  history = JSON.parse(readFileSync(file, 'utf8'));
} catch {
  console.error(`No launch times at ${file} yet: start the desktop app once (0.9.2 or later).`);
  process.exit(1);
}

const quantile = (values, q) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] : 0;
};
const ms = (v) => `${Math.round(v)}`.padStart(7);

const usual = history.filter((r) => r.kind === 'usual');
console.log(`${history.length} starts kept, ${usual.length} usual (${file})\n`);
const names = [...new Set(usual.flatMap((r) => Object.keys(r.marks)))];
const rows = names
  .map((name) => {
    const values = usual.map((r) => r.marks[name]).filter((v) => typeof v === 'number');
    return { name, p50: quantile(values, 0.5), p90: quantile(values, 0.9) };
  })
  .sort((a, b) => a.p50 - b.p50);
console.log('stage (ms since the app began)     median  slowest 10%');
for (const r of rows) console.log(`  ${r.name.padEnd(30)} ${ms(r.p50)}  ${ms(r.p90)}`);

const last = history.at(-1);
if (last) {
  console.log(`\nlast start: ${last.at}, ${last.version}, ${last.kind}, ${last.shown}`);
  for (const [name, v] of Object.entries(last.marks).sort((a, b) => a[1] - b[1])) {
    console.log(`  ${name.padEnd(30)} ${ms(v)}`);
  }
  if (last.server) {
    console.log('  server (ms since the server process began)');
    for (const [name, v] of Object.entries(last.server.marks).sort((a, b) => a[1] - b[1])) {
      console.log(`    ${name.padEnd(28)} ${ms(v)}`);
    }
    const slow = Object.entries(last.server.spans).filter(([, v]) => v >= 20);
    if (slow.length)
      console.log(`    steps of 20 ms or more: ${slow.map(([n, v]) => `${n} ${Math.round(v)}`).join(', ')}`);
  }
  if (last.pageLongTasks) {
    console.log(
      `  page work of 50 ms or more before the chat: ${last.pageLongTasks.count} times, ${last.pageLongTasks.totalMs} ms`,
    );
  }
}
