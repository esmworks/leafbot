import { describe, expect, it } from 'vitest';
import { fromB64url, toB64url } from '@leafbot/client/tunnel';
import { deviceKeyOf, loadDeviceKey, verifyHost } from './deviceKey';

const sha256 = async (data: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>));
const seed = new Uint8Array(32).map((_, i) => i + 1);

/** The platform's own Ed25519 for the same 32-byte seed, to compare the phone's library against. */
async function platformKey() {
  const prefix = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);
  const der = new Uint8Array([...prefix, ...seed]);
  const key = await crypto.subtle.importKey('pkcs8', der, 'Ed25519', true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  return { key, x: jwk.x! };
}

describe('deviceKeyOf', () => {
  it('has the public key and signatures the platform derives from the same seed', async () => {
    const key = await deviceKeyOf(seed, sha256);
    const platform = await platformKey();
    expect(key.x).toBe(platform.x);
    const message = new TextEncoder().encode('hello tunnel');
    // Ed25519 signatures are deterministic, so the two libraries give the same bytes.
    const expected = new Uint8Array(await crypto.subtle.sign('Ed25519', platform.key, message));
    expect(await key.sign(message)).toBe(toB64url(expected));
    expect(fromB64url(await key.sign(message))).toHaveLength(64);
  });

  it('names the key by the thumbprint of its public half', async () => {
    const key = await deviceKeyOf(seed, sha256);
    const input = `{"crv":"Ed25519","kty":"OKP","x":"${key.x}"}`;
    expect(key.jkt).toBe(toB64url(await sha256(new TextEncoder().encode(input))));
  });
});

describe('loadDeviceKey', () => {
  it('makes a seed once and keeps it', async () => {
    let kept: string | null = null;
    const deps = {
      read: async () => kept,
      write: async (s: string) => {
        kept = s;
      },
      random: (n: number) => new Uint8Array(n).fill(7),
      sha256,
    };
    const first = await loadDeviceKey(deps);
    expect(kept).not.toBeNull();
    const second = await loadDeviceKey({ ...deps, random: () => new Uint8Array(32).fill(9) });
    expect(second.x).toBe(first.x);
  });

  it('makes another key when what was kept is damaged or the keychain fails', async () => {
    const deps = {
      read: async () => 'not-a-seed',
      write: async () => {
        throw new Error('keychain refused');
      },
      random: (n: number) => new Uint8Array(n).fill(5),
      sha256,
    };
    const key = await loadDeviceKey(deps);
    expect((await deviceKeyOf(new Uint8Array(32).fill(5), sha256)).x).toBe(key.x);
  });
});

describe('verifyHost', () => {
  it("accepts the server key's signature and refuses any other", async () => {
    const key = await deviceKeyOf(seed, sha256);
    const message = new TextEncoder().encode('proof');
    const sig = await key.sign(message);
    expect(await verifyHost(key.x, message, sig)).toBe(true);
    expect(await verifyHost(key.x, new TextEncoder().encode('other'), sig)).toBe(false);
    expect(await verifyHost(key.x, message, 'AAAA')).toBe(false);
    expect(await verifyHost('!!', message, sig)).toBe(false);
  });
});
