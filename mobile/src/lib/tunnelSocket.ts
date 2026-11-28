import type { ClientToServerEvents, ServerToClientEvents } from '@leafbot/shared';
import { RtSocket } from '@leafbot/client/tunnel';
import { io, WebSocket as WebSocketTransport, type Socket } from 'socket.io-client';
import { getLink } from './connection';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * A Socket.IO connection to the server, carried by a channel of the tunnel instead of a network
 * address (the address is a placeholder; the tunnel decides where it goes). The tunnel is looked up
 * each time Socket.IO makes its connection, so after a dropped tunnel is opened again the reconnects go
 * through the new one; until then each try fails at once and Socket.IO backs off. The server sees
 * the person the tunnel proved, so no cookie or key is sent.
 */
export function tunnelSocket(): AppSocket {
  return io('http://tunnel.invalid', {
    path: '/socket.io',
    transports: [
      class TunnelTransport extends WebSocketTransport {
        override createSocket() {
          const tunnel = getLink()?.open;
          const socket = tunnel
            ? tunnel.realtime()
            : new RtSocket(() => Promise.reject(new Error('no tunnel')));
          return socket as unknown as WebSocket;
        }
      },
    ],
  });
}
