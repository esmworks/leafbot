import './old-env';
import { pickLocale } from '@leafbot/shared';
import { createServer } from './app';
import { loadConfig } from './config';
import { translator } from './i18n';
import { loadRtc } from './tunnel/rtc-datachannel';

const config = loadConfig();
/** The exit code that asks whoever runs the server (the desktop app, Docker) to start it again. */
const RESTART_CODE = 75;
const server = await createServer(config, {
  logger: process.env.LEAFBOT_LOG === '1',
  restart: () => void shutdown('restore', RESTART_CODE),
  // Browsers reach a server linked to an account over WebRTC; without a build for this platform
  // the server runs as before, reachable only at its own address.
  rtc: await loadRtc(),
});
const address = await server.listen();
// The desktop shell reads this line to learn the port.
console.log(`LEAFBOT_READY ${address}`);
// Terminal lines follow the terminal's language.
const t = translator(pickLocale([process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG]));
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
