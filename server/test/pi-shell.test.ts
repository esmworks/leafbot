import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect as netConnect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  type FauxProviderRegistration,
} from '@earendil-works/pi-ai/compat';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PiEngine } from '../src/engine/pi';
import { shellRun, type ShellRun } from '../src/engine/pi-shell';
import type { PermissionAsk, Sandbox, TurnRequest } from '../src/engine/types';
import { translator } from '../src/i18n';
import { probeShellSandbox } from '../src/shell-sandbox';

const t = translator('tr');
const sandboxed = (await probeShellSandbox()).status === 'ok';
const signal = new AbortController().signal;

describe.skipIf(!sandboxed)('Pi kabuğu', () => {
  let dir: string;
  let cwd: string;
  let secret: string;
  let other: string;
  let shell: ShellRun;
  let local: Server;
  let port: number;

  beforeAll(async () => {
    local = createServer((_req, res) => res.end('yerel'));
    await new Promise<void>((r) => local.listen(0, '127.0.0.1', r));
    port = (local.address() as AddressInfo).port;
  });
  afterAll(() => local.close());

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'leafbot-pish-')));
    cwd = join(dir, 'thread');
    secret = join(dir, 'data');
    other = join(dir, 'other');
    for (const d of [cwd, secret, other]) mkdirSync(d);
    writeFileSync(join(secret, 'vault.key'), 'gizli-anahtar');
    writeFileSync(join(cwd, 'not.txt'), 'bot notu');
  });
  afterEach(() => {
    shell?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const open = (
    over: Partial<Sandbox> = {},
    onReach?: (host: string) => void,
    dial?: Parameters<typeof shellRun>[2]['dial'],
    keep?: (text: string) => string,
  ) => {
    const sb: Sandbox = {
      cwd,
      additionalDirectories: [],
      writable: [cwd],
      internet: false,
      readOnly: false,
      ...over,
    };
    shell = shellRun(sb, t, { hidden: [secret], onReach, dial, dir: join(secret, 'shell'), keep });
    return (command: string, timeout_seconds?: number) =>
      shell.tool.run({ command, ...(timeout_seconds ? { timeout_seconds } : {}) }, signal) as Promise<string>;
  };

  it('botun klasöründe okur, yazar ve çıkış kodunu verir', async () => {
    const run = open();
    const out = await run('cat not.txt && echo yeni > yeni.txt && exit 3');
    expect(out).toContain('Çıkış kodu: 3');
    expect(out).toContain('bot notu');
    expect(readFileSync(join(cwd, 'yeni.txt'), 'utf8')).toBe('yeni\n');
  });

  it('uzun çıktının başını ve sonunu verir, tamamını saklatır ve atlanan yeri söyler', async () => {
    const kept: string[] = [];
    const run = open({}, undefined, undefined, (text) => {
      kept.push(text);
      return 'k1';
    });
    const out = await run('seq 1 20000');
    expect(out).toContain('id "k1", offset 6000');
    expect(out).toContain('20000');
    expect(out).not.toContain('\n10000\n');
    expect(kept[0]).toContain('\n10000\n');
    expect(kept[0]!.slice(6000)).toMatch(/^\d/);
  });

  it('sunucunun verisini okuyamaz, klasörleri dışına yazamaz', async () => {
    const run = open();
    expect(await run(`cat ${join(secret, 'vault.key')}`)).not.toContain('gizli-anahtar');
    await run(`echo x > ${join(other, 'disari.txt')}`);
    expect(existsSync(join(other, 'disari.txt'))).toBe(false);
  });

  it('sunucunun ortam değişkenlerini görmez', async () => {
    process.env.LEAFBOT_TEST_SECRET = 'sizan-deger';
    try {
      const out = await open()('env');
      expect(out).not.toContain('sizan-deger');
      expect(out).not.toContain('LEAFBOT_');
    } finally {
      delete process.env.LEAFBOT_TEST_SECRET;
    }
  });

  it('internet kapalıyken hiçbir yere, açıkken bu bilgisayara ulaşamaz', async () => {
    const probe = `curl -sS -m 5 http://127.0.0.1:${port}/ ; echo bitti`;
    expect(await open()(probe)).not.toMatch(/\byerel\b/);
    shell.close();
    const reached: string[] = [];
    expect(await open({ internet: true }, (h) => reached.push(h))(probe)).not.toMatch(/\byerel\b/);
  });

  it('internet açıkken turun kendi vekilinden çıkar ve ulaştığı adresi söyler; vekilsiz çıkamaz', async () => {
    // The way out takes "ornek.test" for a public site and connects it to the local server.
    const reached: string[] = [];
    const run = open({ internet: true }, (h) => reached.push(h), {
      lookup: async () => [{ address: '93.184.216.34' }],
      connect: (_address, p) => netConnect({ host: '127.0.0.1', port: p, allowHalfOpen: true }),
      ports: null,
    });
    expect(await run(`curl -sS -m 5 http://ornek.test:${port}/`)).toMatch(/\byerel\b/);
    expect(reached).toContain('ornek.test');
    expect(await run(`curl --noproxy '*' -sS -m 5 http://127.0.0.1:${port}/ ; echo bitti`)).not.toMatch(
      /\byerel\b/,
    );
  });

  it('turun klasörünü sunucunun verisinde tutar ve tur bitince siler', async () => {
    const run = open();
    const home = (await run('echo "$HOME"')).split('\n').at(-1)!;
    expect(home.startsWith(join(secret, 'shell'))).toBe(true);
    expect(existsSync(home)).toBe(true);
    shell.close();
    expect(existsSync(home)).toBe(false);
  });

  it('süresi dolan komutu durdurur', async () => {
    const started = Date.now();
    const out = await open()('sleep 3; echo gec > gec.txt', 1);
    expect(out).toContain(t('shell.timedOut', { seconds: 1 }));
    expect(Date.now() - started).toBeLessThan(15_000);
    // Everything the command started went with it: nothing writes once the time is up.
    await new Promise((r) => setTimeout(r, 3500));
    expect(existsSync(join(cwd, 'gec.txt'))).toBe(false);
  });
});

let faux: FauxProviderRegistration;
beforeAll(() => {
  faux = registerFauxProvider({ provider: 'kabukdeneme', models: [{ id: 'm1' }], tokensPerSecond: 0 });
});

describe('Pi motorunda kabuk', () => {
  let dir: string;
  let cwd: string;
  let asks: PermissionAsk[];
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'leafbot-pishe-')));
    cwd = join(dir, 'thread');
    mkdirSync(cwd);
    asks = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const engine = (ready: boolean) =>
    new PiEngine({
      sessionsDir: join(dir, 'sessions'),
      apiKey: async () => 'anahtar',
      resolveModel: (p, id) => (p === 'kabukdeneme' ? faux.getModel(id) : undefined),
      shellReady: () => ready,
      hidden: [join(dir, 'data')],
    });
  const request = (shell: TurnRequest['shell'] = 'sandbox'): TurnRequest => ({
    turnId: 't1',
    threadId: 'th1',
    botId: 'b1',
    model: 'kabukdeneme/m1',
    prompt: 'çalıştır',
    sessionId: null,
    systemPrompt: 'Test.',
    locale: 'tr',
    sandbox: { cwd, additionalDirectories: [], writable: [cwd], internet: false, readOnly: false },
    shell,
    tools: [],
    canUseTool: async (ask) => {
      asks.push(ask);
      return { behavior: 'allow' };
    },
    onText: () => {},
    onSession: () => {},
    signal: new AbortController().signal,
  });
  const offered = async (e: PiEngine, req: TurnRequest) => {
    let names: string[] = [];
    faux.setResponses([
      (ctx) => {
        names = ((ctx.messages[0] as { toolsAdded?: { name: string }[] }).toolsAdded ?? []).map(
          (x) => x.name,
        );
        return fauxAssistantMessage('Tamam.');
      },
    ]);
    await e.run(req);
    return names;
  };

  it('kabuk yalnızca sandbox kurulabiliyorsa ve botun masaüstü yoksa sunulur', async () => {
    expect(await offered(engine(true), request())).toContain('bash');
    expect(await offered(engine(false), request())).not.toContain('bash');
    expect(await offered(engine(true), request('computer'))).not.toContain('bash');
  });

  it.skipIf(!sandboxed)('komutu Claude’un adıyla (Bash) sorar ve çalıştırır', async () => {
    let seen = '';
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'echo merhaba > m.txt && cat m.txt' })], {
        stopReason: 'toolUse',
      }),
      (ctx) => {
        seen = JSON.stringify(ctx.messages.at(-1));
        return fauxAssistantMessage('Çalıştı.');
      },
    ]);
    expect(await engine(true).run(request())).toMatchObject({ ok: true, text: 'Çalıştı.' });
    expect(asks).toEqual([{ toolName: 'Bash', input: { command: 'echo merhaba > m.txt && cat m.txt' } }]);
    expect(seen).toContain('merhaba');
    expect(readFileSync(join(cwd, 'm.txt'), 'utf8')).toBe('merhaba\n');
  });
});
