import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { findExports, MOVE_HOOK_PATH, MoveLink, readExports } from './grok-move';

const doc = (ref: string, extra: Record<string, unknown> = {}) => ({
  format: 'leafbot-bot-import',
  version: 1,
  bots: [{ ref, name: ref.toUpperCase(), instructions: 'Work.', ...extra }],
});

describe('MoveLink', () => {
  let http: Server | null = null;
  let link: MoveLink | null = null;
  afterEach(() => {
    http?.close();
    link?.stop();
  });

  /** A link on a public address, served by a plain HTTP server the way the route serves it. */
  const open = async (check: (doc: Record<string, unknown>) => Promise<void> = async () => {}) => {
    let arrivals = 0;
    http = createServer((req, res) => {
      const key = req.url!.slice(`${MOVE_HOOK_PATH}/`.length);
      if (req.method !== 'POST' || !link!.matches(key)) return res.writeHead(404).end();
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => void link!.handle(req, res, JSON.parse(body)));
    });
    await new Promise<void>((r) => http!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    link = new MoveLink({
      publicUrl: base,
      onUserComputer: false,
      instructions: () => 'THE INSTRUCTIONS',
      check,
      onArrival: () => arrivals++,
    });
    const state = await link.connect();
    const client = new Client({ name: 'grok-bot', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(state.url!)));
    return { state, client, arrivals: () => arrivals };
  };
  const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

  it('takes documents over MCP and gives back nothing but a count', async () => {
    const { state, client, arrivals } = await open();
    expect(state.url).toMatch(new RegExp(`${MOVE_HOOK_PATH}/[A-Za-z0-9_-]{43}$`));
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(['get_export_instructions', 'move_status', 'send_export']);
    expect(text(await client.callTool({ name: 'get_export_instructions', arguments: {} }))).toBe(
      'THE INSTRUCTIONS',
    );
    const sent = await client.callTool({ name: 'send_export', arguments: { document: doc('a') } });
    expect(sent.isError).toBeFalsy();
    expect(text(sent)).toContain('Received: A');
    // A document as text, the way some apps pass a nested object.
    await client.callTool({ name: 'send_export', arguments: { document: JSON.stringify(doc('b')) } });
    expect(text(await client.callTool({ name: 'move_status', arguments: {} }))).toContain('2 bot(s)');
    expect(arrivals()).toBe(2);
    const seen = link!.state();
    expect(seen.arrived.map((a) => a.names)).toEqual([['A'], ['B']]);
    expect(seen.arrived[0]).not.toHaveProperty('text');
    // Read up to the first: only its text, and reading again gives it again until it is imported.
    const first = link!.texts(seen.arrived[0]!.seq)!;
    expect(JSON.parse(first)).toMatchObject({ bots: [{ ref: 'a' }] });
    expect(link!.texts(seen.arrived[0]!.seq)).toBe(first);
    expect(link!.state().arrived).toHaveLength(2);
    expect(link!.imported(seen.arrived[0]!.seq).arrived.map((a) => a.names)).toEqual([['B']]);
    expect(link!.texts(seen.arrived[1]!.seq)).toContain('"ref":"b"');
    expect(link!.imported(99).arrived).toEqual([]);
    expect(link!.texts(seen.arrived[1]!.seq)).toBe('');
    await client.close();
  });

  it('refuses a document with credentials or one the import would refuse, keeping nothing', async () => {
    const { client } = await open(async (d) => {
      if ((d.bots as { name: string }[])[0]!.name === 'BAD')
        throw new Error('the field bots.0.name is wrong');
    });
    const keys = await client.callTool({
      name: 'send_export',
      arguments: { document: doc('a', { api_key: 'x' }) },
    });
    expect(keys.isError).toBe(true);
    expect(text(keys)).toContain('api_key');
    const bad = await client.callTool({ name: 'send_export', arguments: { document: doc('bad') } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('bots.0.name');
    expect(link!.state().arrived).toEqual([]);
    await client.close();
  });

  it('answers a wrong key with nothing, and the link stops when ended', async () => {
    const { state, client } = await open();
    expect(link!.matches('x'.repeat(43))).toBe(false);
    await client.close();
    link!.end();
    expect(link!.matches(state.url!.split('/').at(-1)!)).toBe(false);
    expect(link!.state()).toMatchObject({ url: null, stopped: false, arrived: [] });
  });

  describe('over a quick tunnel', () => {
    let dir: string;
    const dirs: string[] = [];
    afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

    /** A stand-in for cloudflared: notes its arguments and pid, prints an address, then waits. */
    const stub = (body: string) => {
      dir = mkdtempSync(join(tmpdir(), 'leafbot-cloudflared-'));
      dirs.push(dir);
      const bin = join(dir, 'cloudflared');
      writeFileSync(bin, `#!/bin/sh\necho "$@" > "${dir}/args"\necho $$ > "${dir}/pid"\n${body}\n`, {
        mode: 0o755,
      });
      return bin;
    };
    const tunnelLink = (bin: () => string | null) =>
      new MoveLink({
        publicUrl: null,
        onUserComputer: true,
        instructions: () => 'THE INSTRUCTIONS',
        check: async () => {},
        onArrival: () => {},
        findCloudflared: bin,
      });
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    it('opens cloudflared on a loopback port, answers there, and stops it when ended', async () => {
      const bin = stub('echo "INF |  https://quick-test-link.trycloudflare.com  |" >&2\nexec sleep 30');
      link = tunnelLink(() => bin);
      expect(link.available()).toBe(true);
      const state = await link.connect();
      expect(state.url).toMatch(/^https:\/\/quick-test-link\.trycloudflare\.com\/move\/[A-Za-z0-9_-]{43}$/);
      const args = readFileSync(join(dir, 'args'), 'utf8');
      expect(args).toMatch(
        /^tunnel --no-autoupdate --config \S+config\.yml --url http:\/\/127\.0\.0\.1:\d+$/m,
      );
      const local = `${args.trim().split(' ').at(-1)}/move/${state.url!.split('/').at(-1)}`;

      const client = new Client({ name: 'grok-bot', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(local)));
      await client.callTool({ name: 'send_export', arguments: { document: doc('a') } });
      expect(link.state().arrived.map((a) => a.names)).toEqual([['A']]);
      await client.close();
      // Only POST carries a message; a wrong key is not told the link exists.
      const get = await fetch(local);
      expect(get.status).toBe(405);
      expect(get.headers.get('allow')).toBe('POST');
      expect((await fetch(local.replace(/[^/]+$/, 'x'.repeat(43)), { method: 'POST' })).status).toBe(404);

      const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
      expect(alive(pid)).toBe(true);
      link.end();
      await expect.poll(() => alive(pid), { timeout: 5000 }).toBe(false);
      await expect(fetch(local)).rejects.toThrow();
    });

    it('does not put in place a link ended while its tunnel was starting', async () => {
      const bin = stub('sleep 1\necho "https://late-start.trycloudflare.com" >&2\nexec sleep 30');
      link = tunnelLink(() => bin);
      const starting = link.connect();
      await expect.poll(() => existsSync(join(dir, 'pid'))).toBe(true);
      link.end();
      expect((await starting).url).toBeNull();
      const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
      await expect.poll(() => alive(pid), { timeout: 5000 }).toBe(false);
    });

    it('fails a start whose tunnel stops, and opens the next one', async () => {
      const broken = stub('exit 1');
      let bin = broken;
      link = tunnelLink(() => bin);
      await expect(link.connect()).rejects.toThrow('cloudflared stopped');
      expect(link.state()).toMatchObject({ url: null, stopped: false });
      bin = stub('echo "https://second-try.trycloudflare.com" >&2\nexec sleep 30');
      expect((await link.connect()).url).toContain('second-try.trycloudflare.com');
    });
  });

  it('is unavailable with no public address and no cloudflared', async () => {
    const none = new MoveLink({
      publicUrl: null,
      onUserComputer: true,
      instructions: () => '',
      check: async () => {},
      onArrival: () => {},
      findCloudflared: () => null,
    });
    expect(none.available()).toBe(false);
    expect((await none.connect()).url).toBeNull();
  });
});

describe('findExports', () => {
  let home: string;
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('finds recent export files in Downloads, newest first, skipping links and other files', () => {
    home = mkdtempSync(join(tmpdir(), 'leafbot-home-'));
    const downloads = join(home, 'Downloads');
    mkdirSync(downloads);
    const put = (name: string, body: unknown, ageDays = 0) => {
      writeFileSync(join(downloads, name), typeof body === 'string' ? body : JSON.stringify(body));
      const t = (Date.now() - ageDays * 86_400_000) / 1000;
      utimesSync(join(downloads, name), t, t);
    };
    put('leafbot-bots.json', doc('older'), 2);
    put('leafbot-bots (1).json', `Here it is:\n\`\`\`json\n${JSON.stringify(doc('newer'))}\n\`\`\``, 1);
    put('leafbot-bots-old.json', doc('stale'), 60);
    put('leafbot-bots-broken.json', '{ nope');
    put('notes.json', doc('other'));
    symlinkSync(join(downloads, 'leafbot-bots.json'), join(downloads, 'leafbot-bots-link.json'));
    const found = findExports(home);
    expect(found.map((f) => [f.name, f.bots])).toEqual([
      ['leafbot-bots (1).json', ['NEWER']],
      ['leafbot-bots.json', ['OLDER']],
    ]);
    expect(readExports(home, ['leafbot-bots.json'])).toContain('"older"');
    expect(() => readExports(home, ['leafbot-bots-link.json'])).toThrow();
    expect(readExports(home, ['../secret.json'])).toBe('');
  });

  it('finds nothing without a Downloads folder', () => {
    home = mkdtempSync(join(tmpdir(), 'leafbot-home-'));
    expect(findExports(home)).toEqual([]);
  });
});
