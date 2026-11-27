import { Tunnel, TunnelError, type TunnelEndCode } from '@leafbot/client/tunnel';
import { connectPeer } from '@leafbot/client/webrtc';
import { account, type ServerEntry } from './account';
import { loadDevice } from './device';
import { uiLocale } from './i18n';

/** The relay Chrome and the server find each other through. */
export const RELAY_URL = 'wss://signal.leafbot.app/v1/signal';

/**
 * Opens a tunnel to one of the person's servers: a ticket from the account for this Chrome's
 * device key, the WebRTC setup through the relay, then the proof both ways. A server showing
 * another key than the account lists for it is refused.
 */
export async function openServer(server: ServerEntry, onEnd: (code: TunnelEndCode) => void): Promise<Tunnel> {
  const device = await loadDevice();
  const ticket = async () => {
    const t = await account.ticket(server.id, device.jkt);
    if (t.publicKey !== server.publicKey) throw new TunnelError('host-proof');
    return t.ticket;
  };
  const peer = await connectPeer({ relayUrl: RELAY_URL, ticket });
  return Tunnel.open({ peer, device, ticket, hostKey: server.publicKey, language: uiLocale, onEnd });
}
