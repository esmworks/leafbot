import type { RtSocket } from '@leafbot/client/tunnel';
import { io, type Socket, WebSocket as WebSocketTransport } from 'socket.io-client';

// Kept apart from the WebRTC setup, so what speaks over a tunnel can be tried against a server
// reached any other way.

/** What the offers need of a tunnel: a new Socket.IO connection to the server on a channel of its own. */
export interface Carrier {
  realtime(): RtSocket;
}

/**
 * A Socket.IO connection to one namespace of the server, carried by `tunnel`. The address is a
 * placeholder: the tunnel decides where the connection goes. The server sees the person the tunnel
 * proved, not a cookie or a key, so this computer's own sign-in is not sent.
 */
export function tunnelSocket(tunnel: Carrier, namespace: string, auth: Record<string, unknown>): Socket {
  return io(`http://tunnel.invalid${namespace}`, {
    path: '/socket.io',
    transports: [
      class TunnelTransport extends WebSocketTransport {
        override createSocket() {
          return tunnel.realtime() as unknown as WebSocket;
        }
      },
    ],
    auth,
    autoConnect: false,
    reconnectionDelay: 2_000,
    reconnectionDelayMax: 60_000,
  });
}

/** What the offers see of the link: a tunnel while one is up, null while none is. */
export type TunnelListener = (tunnel: Carrier | null) => void;
