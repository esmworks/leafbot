import { createServer, request } from 'node:http';
import { describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { connectInProcess, tunnelIdentity, type TunnelIdentity } from './identity';

const who: TunnelIdentity = { userId: 'u', accountUserId: 'a', sessionId: 's', connection: 'c' };

describe('connectInProcess', () => {
  it('tags the app’s socket with the person', async () => {
    const server = createServer((req, res) => res.end(tunnelIdentity(req.socket)?.userId ?? 'none'));
    const body = await new Promise<string>((resolve, reject) => {
      const req = request({ path: '/', createConnection: () => connectInProcess(server, who) }, (res) => {
        let text = '';
        res.on('data', (c: Buffer) => (text += c.toString()));
        res.on('end', () => resolve(text));
      });
      req.on('error', reject);
      req.end();
    });
    expect(body).toBe('u');
  });

  it('ends a request the app dropped instead of leaving it waiting', async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-length': '100' });
      res.write('partial');
      setTimeout(() => req.socket.destroy(), 10);
    });
    const outcome = await new Promise<string>((resolve) => {
      const req = request({ path: '/', createConnection: () => connectInProcess(server, who) }, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve('end'));
        res.on('aborted', () => resolve('aborted'));
        res.on('error', () => resolve('error'));
        res.on('close', () => resolve('close'));
      });
      req.on('error', () => resolve('error'));
      req.end();
      setTimeout(() => resolve('hung'), 2000);
    });
    expect(outcome).not.toBe('hung');
  });

  it('closes a WebSocket the app terminated', async () => {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    wss.on('connection', (ws) => setTimeout(() => ws.terminate(), 10));
    const ws = new WebSocket('ws://tunnel.invalid/', {
      createConnection: (() => connectInProcess(server, who)) as never,
    });
    ws.on('error', () => {});
    const closed = await new Promise<string>((resolve) => {
      ws.on('close', () => resolve('closed'));
      setTimeout(() => resolve('hung'), 2000);
    });
    expect(closed).toBe('closed');
  });
});
