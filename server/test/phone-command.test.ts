import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { phone } from '../src/cli/phone';
import { loadConfig, type Config } from '../src/config';
import { translator } from '../src/i18n';
import { AccountHost } from '../src/tunnel/host';
import { KEY, testServer, type TestServer } from './helpers';

const en = translator('en');

describe('leafbot phone', () => {
  let t: TestServer;
  let config: Config;
  let dataDir: string;
  beforeAll(async () => {
    t = await testServer();
    dataDir = mkdtempSync(join(tmpdir(), 'leafbot-phone-'));
    config = { ...loadConfig({}, { dataDir, memoryDb: true, databaseUrl: null }), accessKey: KEY };
  });
  afterAll(async () => {
    await t.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** The running server, reached on its own computer as the command reaches it. */
  const server = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const res = await t.app.inject({
      method: (init?.method ?? 'GET') as 'POST',
      url: url.pathname,
      headers: { host: url.host, ...(init?.headers as Record<string, string>) },
    });
    return new Response(res.body, {
      status: res.statusCode,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  it('asks the server to be started first', async () => {
    const said: string[] = [];
    const code = await phone({
      config,
      locale: 'en',
      say: (l) => said.push(l),
      serverAnswers: async () => false,
    });
    expect(code).toBe(1);
    expect(said).toEqual([en('phone.startServer')]);
  });

  it('says why when the server is linked to no account, and prints a QR code once it is', async () => {
    const said: string[] = [];
    const run = () =>
      phone({
        config,
        locale: 'en',
        say: (l) => said.push(l),
        serverAnswers: async () => true,
        fetcher: server,
      });
    expect(await run()).toBe(1);
    expect(said).toEqual([en('error.serverNotLinked')]);

    said.length = 0;
    const made = vi.spyOn(AccountHost.prototype, 'phoneCode').mockResolvedValue({
      code: 'ABCDE-FGHJK',
      expiresAt: Date.now() + 120_000,
      url: 'leafbot://connect?code=ABCDE-FGHJK',
    });
    expect(await run()).toBe(0);
    made.mockRestore();
    expect(said[0]).toMatch(/[▀▄█]/);
    expect(said[1]).toBe(en('phone.scan', { code: 'ABCDE-FGHJK' }));
  });
});
