import { dialPublic, EgressMux, WEB_PORTS } from '@leafbot/shared/egress';
import type { Socket } from 'socket.io-client';
import { tunnelSocket, type TunnelListener } from './tunnel-socket';

/**
 * A binary frame as Socket.IO hands it over: a Buffer from a socket of Node's own, an ArrayBuffer
 * from the tunnel's WebSocket-shaped one.
 */
export function asBytes(f: unknown): Buffer | null {
  if (Buffer.isBuffer(f)) return f;
  if (f instanceof ArrayBuffer) return Buffer.from(f);
  if (ArrayBuffer.isView(f)) return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
  return null;
}

export interface EgressOptions {
  /** Tells this offer when the tunnel to the account server opens and ends. */
  tunnel(listener: TunnelListener): () => void;
  /** How this computer is named in the server's settings. */
  device: string;
  log(level: 'info' | 'warn', message: string): void;
}

/**
 * Offers this computer as the way out to the web for the bots' browsers on an account server, so
 * sites see this computer's connection. The server uses it only while its setting is on, and only
 * for a person who manages that server.
 *
 * Only web ports and public addresses are reached; the names are looked up here and the
 * connection goes to the address found. This computer's own services and its home or office
 * network stay out of reach of the server.
 */
export function startEgress(o: EgressOptions): () => void {
  let stopSocket: (() => void) | null = null;

  const attach = (tunnel: Parameters<TunnelListener>[0]) => {
    stopSocket?.();
    stopSocket = null;
    if (!tunnel) return;
    let mux: EgressMux | null = null;
    const socket: Socket = tunnelSocket(tunnel, '/egress', { device: o.device });
    socket.on('connect', () => {
      mux?.close();
      mux = new EgressMux({
        send: (f) => {
          if (socket.connected) socket.emit('f', f);
        },
        dial: (host, port) => dialPublic(host, port, { ports: WEB_PORTS }),
      });
      o.log('info', 'egress: connected');
    });
    socket.on('f', (f: unknown) => {
      const bytes = asBytes(f);
      if (bytes) mux?.receive(bytes);
    });
    socket.on('disconnect', (reason) => {
      mux?.close();
      mux = null;
      // A server that let this computer go (another one took over) is not asked again until the
      // tunnel opens anew; two computers would otherwise take it from each other in turns.
      o.log('info', `egress: disconnected (${reason})`);
    });
    socket.on('connect_error', (err) => o.log('warn', `egress: ${err.message}`));
    socket.connect();
    stopSocket = () => {
      mux?.close();
      mux = null;
      socket.disconnect();
    };
  };

  const unsubscribe = o.tunnel(attach);
  return () => {
    unsubscribe();
    stopSocket?.();
    stopSocket = null;
  };
}
