/**
 * How the realtime socket stands. A refused access key is not here: that is `authed === false`.
 * `reconnecting` is only reached from `live`, so a first connect that is still trying is told
 * apart from a connection that was up and dropped.
 */
export type Connection = { kind: 'connecting' } | { kind: 'live' } | { kind: 'reconnecting'; since: number };

export type ConnectionEvent =
  | { type: 'connect' }
  /** `serverClosed`: the server dropped the socket itself, which Socket.IO does not retry. */
  | { type: 'disconnect'; at: number; serverClosed: boolean };

/** What the caller does after a step. */
export type ConnectionEffect = 'reconnect';

export function stepConnection(
  state: Connection,
  event: ConnectionEvent,
): { state: Connection; effects: ConnectionEffect[] } {
  if (event.type === 'connect') return { state: { kind: 'live' }, effects: [] };
  const effects: ConnectionEffect[] = event.serverClosed ? ['reconnect'] : [];
  switch (state.kind) {
    case 'live':
      return { state: { kind: 'reconnecting', since: event.at }, effects };
    case 'reconnecting':
    case 'connecting':
      return { state, effects };
  }
}
