import { once } from 'node:events';
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import type { ServerInfo } from '@leafbot/shared';
import { dialPublic, EgressError, EgressMux } from '@leafbot/shared/egress';
import { io, type Socket as IoSocket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import type { RtSocket } from '@leafbot/client/tunnel';
import WebSocket from 'ws';
import { startEgress } from '../../desktop/src/egress';
import type { TunnelListener } from '../../desktop/src/tunnel-socket';
import { EgressHub, startLocalSocks } from '../src/egress/hub';
import { KEY, testServer, waitFor } from './helpers';

/**
 * The desktop app's tunnel to the server, stood in for by a plain WebSocket from this computer with
 * the access key: what the exit says over it is the same.
 */
const viaKey =
  (url: string) =>
  (listener: TunnelListener): (() => void) => {
    listener({
      realtime: () => {
        const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket`, {
          headers: { authorization: `Bearer ${KEY}` },
        });
        ws.binaryType = 'arraybuffer';
        return ws as unknown as RtSocket;
      },
    });
    return () => undefined;
  };

const servers: Server[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const c of cleanups.splice(0)) c();
});

/** A TCP server that answers every connection with `text` and closes. */
async function answering(text: string): Promise<number> {
  const server = createServer((s) => s.end(text));
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

/** Connects through a SOCKS5 proxy; resolves with the reply code and what the target sent. */
async function viaSocks(proxy: number, host: string, port: number): Promise<{ code: number; text: string }> {
  const c: Socket = connect(proxy, '127.0.0.1');
  await once(c, 'connect');
  const name = Buffer.from(host);
  c.write(Buffer.from([5, 1, 0]));
  c.write(
    Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 255])]),
  );
  const chunks: Buffer[] = [];
  for await (const chunk of c) chunks.push(chunk as Buffer);
  const all = Buffer.concat(chunks);
  return { code: all[3]!, text: all.subarray(12).toString('utf8') };
}

/** A stand-in for the desktop app: an exit on the far side of the hub. */
function fakeComputer(hub: EgressHub, dial: (host: string, port: number) => ReturnType<typeof dialPublic>) {
  const far: { exit?: EgressMux } = {};
  const link = hub.attach(
    'Test Mac',
    (f) => setImmediate(() => far.exit!.receive(f)),
    () => far.exit!.close(),
  );
  far.exit = new EgressMux({ send: (f) => setImmediate(() => link.receive(f)), dial });
  return link;
}

describe('the way out through the person computer', () => {
  it('goes through the computer while it is on and connected, else from the server', async () => {
    const direct = await answering('from the server');
    const far = await answering('from the computer');
    const hub = new EgressHub();
    const socks = await startLocalSocks(hub, ['127.0.0.1']);
    cleanups.push(socks.close);

    // Off: straight from the server, even with a computer connected.
    const asked: string[] = [];
    fakeComputer(hub, (host, port) => {
      asked.push(`${host}:${port}`);
      return dialPublic('127.0.0.1', far, { anyAddress: true });
    });
    expect(await viaSocks(socks.port, '127.0.0.1', direct)).toEqual({ code: 0, text: 'from the server' });
    expect(asked).toEqual([]);

    // On: through the computer, which is given the name to look up itself.
    hub.setEnabled(true);
    expect(await viaSocks(socks.port, 'x.com', 443)).toEqual({ code: 0, text: 'from the computer' });
    expect(asked).toEqual(['x.com:443']);
  });

  it('goes from the server when the computer is gone, but not when it refused', async () => {
    const direct = await answering('from the server');
    const hub = new EgressHub();
    hub.setEnabled(true);
    const socks = await startLocalSocks(hub, ['127.0.0.1']);
    cleanups.push(socks.close);

    expect(await viaSocks(socks.port, '127.0.0.1', direct)).toEqual({ code: 0, text: 'from the server' });

    fakeComputer(hub, () => Promise.reject(new EgressError('refused')));
    const refused = await viaSocks(socks.port, '192.168.1.1', 80);
    // "Not allowed by ruleset", and nothing went out from the server instead.
    expect(refused.code).toBe(2);
  });

  it('refuses private addresses on the server path unless the operator allowed them', async () => {
    const hub = new EgressHub();
    const socks = await startLocalSocks(hub, []);
    cleanups.push(socks.close);
    const port = await answering('private');
    expect((await viaSocks(socks.port, '127.0.0.1', port)).code).toBe(2);
  });

  it('without a way out through a computer, still checks each address it connects to', async () => {
    const port = await answering('private');
    const closed = await startLocalSocks(null, []);
    cleanups.push(closed.close);
    expect((await viaSocks(closed.port, '127.0.0.1', port)).code).toBe(2);
    expect((await viaSocks(closed.port, 'localhost', port)).code).toBe(2);
    expect((await viaSocks(closed.port, '::ffff:127.0.0.1', port)).code).toBe(2);
    const allowed = await startLocalSocks(null, ['127.0.0.1']);
    cleanups.push(allowed.close);
    expect(await viaSocks(allowed.port, '127.0.0.1', port)).toEqual({ code: 0, text: 'private' });
  });

  it("with an upstream proxy, still refuses private addresses and sends the operator's hosts straight", async () => {
    const port = await answering('private');
    let upstreamAsked = 0;
    const upstream = createServer((s) => {
      upstreamAsked++;
      s.destroy();
    });
    servers.push(upstream);
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const via = { host: '127.0.0.1', port: (upstream.address() as AddressInfo).port };
    const socks = await startLocalSocks(null, ['localhost'], via);
    cleanups.push(socks.close);
    expect((await viaSocks(socks.port, '127.0.0.1', port)).code).toBe(2);
    expect(await viaSocks(socks.port, 'localhost', port)).toEqual({ code: 0, text: 'private' });
    expect(upstreamAsked).toBe(0);
  });

  it('tells each bot once when the way out changes', () => {
    const hub = new EgressHub();
    expect(hub.takeExitNote('a')).toBeNull();
    hub.setEnabled(true);
    expect(hub.takeExitNote('a')).toBe('server');
    expect(hub.takeExitNote('a')).toBeNull();
    const link = fakeComputer(hub, () => Promise.reject(new EgressError('failed')));
    expect(hub.takeExitNote('a')).toBe('computer');
    expect(hub.takeExitNote('b')).toBe('computer');
    link.detach();
    expect(hub.takeExitNote('a')).toBe('server');
  });

  it('lets the last computer to connect take over', () => {
    const hub = new EgressHub();
    let firstClosed = false;
    hub.attach(
      'First',
      () => {},
      () => (firstClosed = true),
    );
    hub.attach(
      'Second',
      () => {},
      () => {},
    );
    expect(firstClosed).toBe(true);
    expect(hub.state()).toEqual({ enabled: false, connected: true, device: 'Second' });
  });
});

describe('the desktop app connection', () => {
  it('shows the connected computer and the switch in the server info', async () => {
    const t = await testServer({ onUserComputer: false });
    const url = await t.listen();
    const socket: IoSocket = io(`${url}/egress`, {
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { authorization: `Bearer ${KEY}` },
      auth: { device: 'Test Mac' },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.on('connect', resolve);
        socket.on('connect_error', reject);
      });
      const info = await waitFor(async () => {
        const r = (await t.api<ServerInfo>('GET', '/api/info')).body;
        return r.egress?.connected ? r : null;
      });
      expect(info.egress).toEqual({ enabled: false, connected: true, device: 'Test Mac' });

      expect((await t.api('PATCH', '/api/settings', { browserViaComputer: true })).status).toBe(200);
      const on = await waitFor(async () => {
        const r = (await t.api<ServerInfo>('GET', '/api/info')).body;
        return r.egress?.enabled ? r : null;
      });
      expect(on.egress?.connected).toBe(true);
    } finally {
      socket.close();
      await t.dispose();
    }
  });

  it('carries a browser connection over the app connection to the computer and back', async () => {
    const far = await answering('through the app');
    const t = await testServer({ onUserComputer: false });
    const url = await t.listen();
    // The desktop app's part: an exit on its end of the socket.
    const asked: string[] = [];
    const socket: IoSocket = io(`${url}/egress`, {
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { authorization: `Bearer ${KEY}` },
      auth: { device: 'Test Mac' },
    });
    const exit = new EgressMux({
      send: (f) => socket.emit('f', f),
      dial: (host, port) => {
        asked.push(`${host}:${port}`);
        return dialPublic('127.0.0.1', far, { anyAddress: true });
      },
    });
    socket.on('f', (f: unknown) => {
      if (Buffer.isBuffer(f)) exit.receive(f);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.on('connect', resolve);
        socket.on('connect_error', reject);
      });
      await t.api('PATCH', '/api/settings', { browserViaComputer: true });
      const hub = t.services.ctx.egress!;
      await waitFor(async () => hub.exit() === 'computer');
      const conn = await hub.dial('x.com', 443);
      conn.end();
      const chunks: Buffer[] = [];
      for await (const c of conn) chunks.push(c as Buffer);
      expect(Buffer.concat(chunks).toString('utf8')).toBe('through the app');
      expect(asked).toEqual(['x.com:443']);
    } finally {
      exit.close();
      socket.close();
      await t.dispose();
    }
  });

  it("the desktop app's exit refuses the person's own network and ports other than the web's", async () => {
    const t = await testServer({ onUserComputer: false });
    const url = await t.listen();
    const stop = startEgress({
      tunnel: viaKey(url),
      device: 'Test Mac',
      log: () => {},
    });
    try {
      await t.api('PATCH', '/api/settings', { browserViaComputer: true });
      const hub = t.services.ctx.egress!;
      await waitFor(async () => hub.exit() === 'computer');
      expect(hub.state().device).toBe('Test Mac');
      for (const [host, port] of [
        ['192.168.1.1', 443],
        ['127.0.0.1', 80],
        ['localhost', 443],
        ['x.com', 22],
      ] as const) {
        await expect(hub.dial(host, port), `${host}:${port}`).rejects.toMatchObject({ code: 'refused' });
      }
    } finally {
      stop();
      await t.dispose();
    }
  });

  it('lets the desktop app connect again after the server stops, not after a takeover', async () => {
    const reason = (lines: string[]) =>
      lines.map((l) => /disconnected \((.+)\)/.exec(l)?.[1]).find((r): r is string => !!r);
    const t = await testServer({ onUserComputer: false });
    const url = await t.listen();
    const start = (device: string, lines: string[]) =>
      startEgress({
        tunnel: viaKey(url),
        device,
        log: (_level, line) => lines.push(line),
      });
    const first: string[] = [];
    const second: string[] = [];
    const stopFirst = start('First Mac', first);
    let stopSecond: (() => void) | null = null;
    try {
      const hub = t.services.ctx.egress!;
      await waitFor(async () => hub.state().device === 'First Mac');
      stopSecond = start('Second Mac', second);
      // The one let go is told so: socket.io does not connect again after a server's disconnect.
      expect(await waitFor(async () => reason(first))).toBe('io server disconnect');
      await waitFor(async () => hub.state().device === 'Second Mac');
      await t.dispose();
      // A stop is a dropped connection, which the client connects again after.
      expect(await waitFor(async () => reason(second))).toBe('transport close');
    } finally {
      stopFirst();
      stopSecond?.();
    }
  });

  it('turns away a connection without the access key', async () => {
    const t = await testServer({ onUserComputer: false });
    const url = await t.listen();
    const socket = io(`${url}/egress`, { transports: ['websocket'], reconnection: false });
    try {
      const err = await new Promise<Error>((resolve) => socket.on('connect_error', resolve));
      expect(err).toBeInstanceOf(Error);
    } finally {
      socket.close();
      await t.dispose();
    }
  });
});
