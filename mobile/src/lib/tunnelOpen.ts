import './runtime';
import { Tunnel, TunnelError, type RtSocket } from '@leafbot/client/tunnel';
import { connectPeer } from '@leafbot/client/webrtc';
import * as ExpoCrypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { RTCPeerConnection } from 'react-native-webrtc';
import { locale } from '@/i18n';
import { RELAY_URL, type AccountClient, type ServerEntry } from './account';
import { loadDeviceKey, verifyHost } from './deviceKey';
import type { LiveTunnel } from './tunnelLink';
import { ticketsAhead } from './ticketsAhead';

const KEY = 'leafbot.device-key';
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

let device: ReturnType<typeof loadDeviceKey> | null = null;

/** This phone's device key, kept in the keychain so tickets name the same key every launch. */
function phoneKey() {
  device ??= loadDeviceKey({
    read: () => SecureStore.getItemAsync(KEY, OPTIONS),
    write: (seed) => SecureStore.setItemAsync(KEY, seed, OPTIONS),
    random: (n) => ExpoCrypto.getRandomBytes(n),
    sha256: async (data) =>
      new Uint8Array(
        await ExpoCrypto.digest(ExpoCrypto.CryptoDigestAlgorithm.SHA256, data as Uint8Array<ArrayBuffer>),
      ),
  });
  device.catch(() => {
    device = null;
  });
  return device;
}

/** Forgets the key made for this sign-in; the next one makes another. */
export async function forgetDeviceKey() {
  device = null;
  await SecureStore.deleteItemAsync(KEY, OPTIONS).catch(() => undefined);
}

/**
 * Opens a tunnel to one of the person's servers: tickets from the account service for this phone's
 * key, the WebRTC setup through the relay, then the proof both ways. The server must hold the key
 * the account service lists for it; a ticket naming another key is refused.
 */
export async function openServer(
  server: ServerEntry,
  account: AccountClient,
  onEnd: (code: string) => void,
): Promise<LiveTunnel> {
  const key = await phoneKey();
  const fetchTicket = async () => {
    const t = await account.ticket(server.id, key.jkt);
    if (t.publicKey !== server.publicKey) throw new TunnelError('host-proof');
    return t.ticket;
  };
  const ticket = ticketsAhead(fetchTicket);
  const peer = await connectPeer({
    relayUrl: RELAY_URL,
    ticket,
    rtc: {
      RTCPeerConnection: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection,
      WebSocket: globalThis.WebSocket,
    },
  });
  const tunnel = await Tunnel.open({
    peer,
    device: key,
    ticket,
    hostKey: server.publicKey,
    language: locale,
    onEnd,
    verify: verifyHost,
  });
  return {
    request: (path, init) => tunnel.request(path, init),
    realtime: (): RtSocket => tunnel.realtime(),
    close: () => tunnel.close(),
  };
}
