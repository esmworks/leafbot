import './old-env';
import { pickLocale } from '@leafbot/shared';
import { createServer } from './app';
import { loginFromTerminal } from './cli/login';
import { loadConfig } from './config';
import { translator } from './i18n';
import { launchMark, launchSpan, launchTimingsLine } from './launch-timings';
import { loadRtc } from './tunnel/rtc-datachannel';

// Every module is loaded and run by now: the time to here is the cost of the code itself.
launchMark('modules');

// Terminal lines follow the terminal's language.
const locale = pickLocale([process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG]);
const t = translator(locale);
const config = loadConfig();
/** The exit code that asks whoever runs the server (the desktop app, Docker) to start it again. */
const RESTART_CODE = 75;

// With no command the server starts, as the desktop app and Docker run it; a command does one job
// on the same data folder and ends.
const command = process.argv[2];
if (command === 'login') {
  const withInstallCode = process.argv.slice(3).includes('--code');
  await exitAfterOutput(await loginFromTerminal(config, locale, { withInstallCode }));
}
if (command !== undefined) {
  console.error(t('cli.unknownCommand', { command }));
  await exitAfterOutput(2);
}

/** Exits once what was printed has been written: a pipe takes it later than a terminal does. */
async function exitAfterOutput(code: number): Promise<never> {
  await Promise.all(
    [process.stdout, process.stderr].map((s) => new Promise<void>((resolve) => s.write('', () => resolve()))),
  );
  process.exit(code);
}

const server = await createServer(config, {
  logger: process.env.LEAFBOT_LOG === '1',
  restart: () => void shutdown('restore', RESTART_CODE),
  // Browsers reach a server linked to an account over WebRTC; without a build for this platform
  // the server runs as before, reachable only at its own address.
  rtc: await launchSpan('rtc', loadRtc),
});
launchMark('created');
const address = await server.listen();
launchMark('listening');
// The desktop shell reads this line to learn the port, and the next one to learn where the time went.
console.log(`LEAFBOT_READY ${address}`);
console.log(launchTimingsLine());
if (!config.accessKey) console.log(t('log.accessKey', { path: `${config.dataDir}/access-key` }));

let closing = false;
const shutdown = async (signal: string, code = 0) => {
  if (closing) return;
  closing = true;
  console.log(t('log.shuttingDown', { signal }));
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  await server.close().catch((err) => console.error(err));
  process.exit(code);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
