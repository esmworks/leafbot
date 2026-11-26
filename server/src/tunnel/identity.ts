import type { Server } from 'node:http';
import { duplexPair, type Duplex } from 'node:stream';

/**
 * Who a tunnelled connection belongs to, as the tunnel proved it: the person's account, the
 * sign-in session the ticket came from and the person on this server their account is linked to.
 */
export interface TunnelIdentity {
  /** The person on this server (`users.id`). */
  userId: string;
  /** Their account at the account service (the ticket's `sub`). */
  accountUserId: string;
  /** The account sign-in session the ticket came from (`sid`). */
  sessionId: string;
  /** The tunnel connection this request travels on, to close everything it opened at once. */
  connection: string;
}

/**
 * Keyed by the in-process socket the request arrived on. Only the gateway makes these sockets and
 * nothing outside the process can reach them, so no header, cookie or loopback connection can
 * claim a tunnel identity.
 */
const identities = new WeakMap<object, TunnelIdentity>();

export function tunnelIdentity(socket: object | null | undefined): TunnelIdentity | undefined {
  return socket ? identities.get(socket) : undefined;
}

/**
 * Hands the HTTP server a new connection that exists only inside this process, tagged with who
 * it belongs to, and returns the end the gateway writes requests into.
 */
export function connectInProcess(server: Server, identity: TunnelIdentity): Duplex {
  const [gatewayEnd, serverEnd] = duplexPair();
  identities.set(serverEnd, identity);
  // Destroying one end of a pair does not reach the other. Closing the gateway's end (access
  // taken away, the channel gone) must close the app's socket too, or a Socket.IO connection
  // would stay signed in.
  gatewayEnd.once('close', () => serverEnd.destroy());
  server.emit('connection', serverEnd);
  return gatewayEnd;
}
