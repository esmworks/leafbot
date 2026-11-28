import type { Locale } from '@leafbot/shared';
import QRCode from 'qrcode';
import { loadAccessKey } from '../auth';
import type { Config } from '../config';
import { translator } from '../i18n';
import { serverAnswers } from './login';

export interface PhoneOptions {
  config: Config;
  locale: Locale;
  say(line: string): void;
  /** The running server as the tests stand it in; a request to its own address otherwise. */
  fetcher?: typeof fetch;
  serverAnswers?: (config: Config) => Promise<boolean>;
}

/** The running server's own address, as {@link serverAnswers} reaches it. */
function localOrigin(config: Config): string {
  const any = !config.host || config.host === '0.0.0.0' || config.host === '::';
  const host = any ? '127.0.0.1' : config.host.includes(':') ? `[${config.host}]` : config.host;
  return `http://${host}:${config.port}`;
}

/**
 * `leafbot phone`: signs the owner's phone in to their Leaf Bot account from a server with no
 * screen. The running server asks the account for a one-time code, which is printed as a QR code
 * for the phone app to scan; the phone then reaches the server through the account, as everywhere
 * else. It asks the running server with the access key, so it works only on the server's own
 * computer, and only once the server is linked to an account. Returns the exit code.
 */
export async function phone(opts: PhoneOptions): Promise<number> {
  const { config, say } = opts;
  const t = translator(opts.locale);
  if (!(await (opts.serverAnswers ?? serverAnswers)(config))) {
    say(t('phone.startServer'));
    return 1;
  }
  const res = await (opts.fetcher ?? fetch)(`${localOrigin(config)}/api/account-host/phone-code`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${loadAccessKey(config)}`,
      'accept-language': opts.locale,
    },
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  const body = (await res?.json().catch(() => null)) as {
    code?: string;
    url?: string;
    expiresAt?: number;
    error?: string;
  } | null;
  if (!res?.ok || !body?.code || !body.url) {
    say(body?.error ?? t('phone.codeFailed'));
    return 1;
  }
  say(await QRCode.toString(body.url, { type: 'terminal', small: true, errorCorrectionLevel: 'M' }));
  say(t('phone.scan', { code: body.code }));
  return 0;
}
