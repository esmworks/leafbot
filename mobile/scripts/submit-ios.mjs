// Sends an iOS store build to App Store Connect with `eas submit`, without asking which App Store Connect app it is for.
// That app belongs to whoever releases Leaf Bot, as the Expo project does, so its id (`ascAppId`, the "Apple ID" under
// App Information in App Store Connect) is kept in app.local.json, which git ignores. eas-cli reads that id only from
// the submit profile in eas.json and fills environment variables into other fields only, so the id is written into
// eas.json while the command runs and the file is put back as it was when it ends, fails or is stopped.
//
// Usage: pnpm --filter @leafbot/mobile submit:ios -- --id <build id>   (or --latest; other eas submit flags pass on)
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const localFile = join(root, 'app.local.json');
const easFile = join(root, 'eas.json');

const local = existsSync(localFile) ? JSON.parse(readFileSync(localFile, 'utf8')) : {};
const ascAppId = String(local.ascAppId ?? '');
if (!/^\d+$/.test(ascAppId)) {
  console.error(
    'Set "ascAppId" in mobile/app.local.json to the App Store Connect app\'s id: the digits shown as "Apple ID" under App Information.',
  );
  process.exit(1);
}

// pnpm passes the `--` that separates its own flags from the script's along.
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const named = args.findIndex((arg) => arg === '--profile' || arg.startsWith('--profile='));
const profile =
  named < 0 ? 'production' : args[named].includes('=') ? args[named].split('=')[1] : args[named + 1];
if (!profile) {
  console.error('--profile needs a profile name.');
  process.exit(1);
}

const original = readFileSync(easFile, 'utf8');
const eas = JSON.parse(original);
eas.submit ??= {};
eas.submit[profile] ??= {};
eas.submit[profile].ios = { ...eas.submit[profile].ios, ascAppId };
writeFileSync(easFile, `${JSON.stringify(eas, null, 2)}\n`);

let restored = false;
const restore = () => {
  if (restored) return;
  restored = true;
  writeFileSync(easFile, original);
};
process.on('exit', restore);

const child = spawn(
  'eas',
  ['submit', '--platform', 'ios', ...(named < 0 ? ['--profile', profile] : []), ...args],
  {
    cwd: root,
    stdio: 'inherit',
  },
);
// Ctrl-C reaches eas as well; this process waits for it to end so eas.json is put back after it, not before.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('error', (err) => {
  console.error(`Could not run eas: ${err.message}. Install it with \`npm install -g eas-cli\`.`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
