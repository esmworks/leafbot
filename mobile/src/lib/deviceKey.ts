import { ed25519 } from '@noble/curves/ed25519.js';
import { fromB64url, toB64url, type DeviceKey } from '@leafbot/client/tunnel';
import { ed25519ThumbprintInput } from '@leafbot/shared/tunnel';

/**
 * The phone's device key, made with the Ed25519 of @noble/curves because WebCrypto's is not in
 * Hermes. Its private half is a 32-byte seed kept in the keychain (expo-secure-store), so it stays
 * the same across launches; each ticket names the key's thumbprint and the phone proves it holds the
 * key on the tunnel's `ctl` channel.
 */
export interface KeyDeps {
  /** The seed as it was kept (base64url), or null when none was. */
  read(): Promise<string | null>;
  write(seed: string): Promise<void>;
  random(bytes: number): Uint8Array;
  sha256(data: Uint8Array): Promise<Uint8Array>;
}

const SEED_BYTES = 32;

export async function loadDeviceKey(d: KeyDeps): Promise<DeviceKey> {
  let seed: Uint8Array | null = null;
  try {
    const saved = await d.read();
    const bytes = saved ? fromB64url(saved) : null;
    if (bytes?.length === SEED_BYTES) seed = bytes;
  } catch {
    // An unreadable keychain only means a new key.
  }
  if (!seed) {
    seed = d.random(SEED_BYTES);
    // Not kept (a keychain that refuses): this run has a key of its own, and the next makes another.
    await d.write(toB64url(seed)).catch(() => undefined);
  }
  return deviceKeyOf(seed, d.sha256);
}

/** The device key for a seed. */
export async function deviceKeyOf(
  seed: Uint8Array,
  sha256: (data: Uint8Array) => Promise<Uint8Array>,
): Promise<DeviceKey> {
  const x = toB64url(ed25519.getPublicKey(seed));
  const jkt = toB64url(await sha256(new TextEncoder().encode(ed25519ThumbprintInput(x))));
  return {
    x,
    jkt,
    sign: async (message) => toB64url(ed25519.sign(message, seed)),
  };
}

/** Whether `sig` is the server key `hkey`'s signature over `message`; the tunnel's `verify` for this phone. */
export async function verifyHost(hkey: string, message: Uint8Array, sig: string): Promise<boolean> {
  try {
    return ed25519.verify(fromB64url(sig), message, fromB64url(hkey));
  } catch {
    return false;
  }
}
