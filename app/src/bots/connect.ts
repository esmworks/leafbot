import { Tunnel, TunnelError, type TunnelEndCode } from '@leafbot/client/tunnel';
import { connectPeer } from '@leafbot/client/webrtc';
import { useLocale } from '@/i18n';
import { account, type ServerEntry } from './account';
import { loadDevice } from './device';

/** The relay browsers and servers find each other through; another one only for development. */
export const RELAY_URL: string =
  (import.meta.env.VITE_LEAFBOT_RELAY_URL as string | undefined) || 'wss://signal.leafbot.app/v1/signal';

/**
 * Opens a tunnel to one of the person's servers: tickets from the account service for this
 * browser's device key, the WebRTC setup through the relay, then the proof both ways. The server
 * must hold the key the account service lists for it; a ticket naming another key is refused.
 */
export async function openServer(server: ServerEntry, onEnd: (code: TunnelEndCode) => void): Promise<Tunnel> {
  const device = await loadDevice();
  const ticket = async () => {
    const t = await account.ticket(server.id, device.jkt);
    if (t.publicKey !== server.publicKey) throw new TunnelError('host-proof');
    return t.ticket;
  };
  const peer = await connectPeer({ relayUrl: RELAY_URL, ticket });
  return Tunnel.open({
    peer,
    device,
    ticket,
    hostKey: server.publicKey,
    language: useLocale.getState().locale,
    onEnd,
  });
}
