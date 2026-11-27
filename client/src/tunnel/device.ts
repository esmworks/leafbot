import { ed25519ThumbprintInput } from '@leafbot/shared/tunnel';

/**
 * The browser's device key: an Ed25519 key pair made in WebCrypto with a private half that cannot be
 * exported, so a script that runs on the page later can use it only while the page is open and can
 * never copy it out. Each ticket names the key's thumbprint (`cnf.jkt`), and the browser proves it
 * holds the key on the tunnel's `ctl` channel.
 */
export interface DeviceKey {
  /** The raw public key, base64url: what the proof sends as `key`. */
  readonly x: string;
  /** RFC 7638 thumbprint of the public key, base64url: what a ticket is asked for with. */
  readonly jkt: string;
  /** The key's base64url signature over `message`. */
  sign(message: Uint8Array): Promise<string>;
}

export function toB64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomB64url(bytes = 24): string {
  return toB64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

const ED25519 = { name: 'Ed25519' } as const;

/** A WebCrypto key pair, as `generateKey` makes it and IndexedDB keeps it. */
export interface DeviceKeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

/** Whether this browser can make and use Ed25519 keys; older ones cannot reach a server. */
export async function deviceKeysSupported(): Promise<boolean> {
  try {
    await crypto.subtle.generateKey(ED25519, false, ['sign', 'verify']);
    return true;
  } catch {
    return false;
  }
}

/** A new key pair, to be kept (IndexedDB stores it as it is) and reused. */
export async function newDeviceKeyPair(): Promise<DeviceKeyPair> {
  return (await crypto.subtle.generateKey(ED25519, false, ['sign', 'verify'])) as DeviceKeyPair;
}

/** The device key for a stored pair. Refuses a pair whose private half could be exported. */
export async function deviceKey(pair: DeviceKeyPair): Promise<DeviceKey> {
  if (pair.privateKey.extractable) throw new Error('device key must not be extractable');
  const x = toB64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ed25519ThumbprintInput(x)));
  return {
    x,
    jkt: toB64url(new Uint8Array(digest)),
    sign: async (message) =>
      toB64url(new Uint8Array(await crypto.subtle.sign(ED25519, pair.privateKey, new Uint8Array(message)))),
  };
}

/** Whether `sig` is the server key `hkey`'s signature over `message`. */
export async function verifyHost(hkey: string, message: Uint8Array, sig: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', fromB64url(hkey), ED25519, false, ['verify']);
    return await crypto.subtle.verify(ED25519, key, fromB64url(sig), new Uint8Array(message));
  } catch {
    return false;
  }
}
