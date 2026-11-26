import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { ed25519ThumbprintInput, proofMessage } from '@leafbot/shared/tunnel';
import { describe, expect, it } from 'vitest';
import { checkProof, TicketChecker, TunnelRefusal } from './ticket';

const ISSUER = 'https://accounts.example';
const HOST = 'host_12345678';
const NOW = 1_800_000_000;

function issuer(kid = 'k1') {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'ES256' };
  return { privateKey, jwk, kid };
}

function device() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x!;
  const jkt = createHash('sha256').update(ed25519ThumbprintInput(x)).digest('base64url');
  return { privateKey, x, jkt };
}

let n = 0;
function ticket(
  iss: { privateKey: KeyObject; kid: string },
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
) {
  const h = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: iss.kid, ...header })).toString(
    'base64url',
  );
  const p = Buffer.from(
    JSON.stringify({
      iss: ISSUER,
      aud: HOST,
      sub: 'user_12345678',
      kind: 'client',
      sid: 'sess_12345678',
      jti: `jti_${String(++n).padStart(8, '0')}`,
      iat: NOW,
      exp: NOW + 60,
      role: 'member',
      mid: 'mem_12345678',
      epoch: 3,
      cnf: { jkt: 'A'.repeat(43) },
      hkey: 'H'.repeat(43),
      ...claims,
    }),
  ).toString('base64url');
  const s = sign('sha256', Buffer.from(`${h}.${p}`), { key: iss.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${h}.${p}.${s.toString('base64url')}`;
}

function checker(keys: { jwk: object }[], fetches = { n: 0 }) {
  return new TicketChecker({
    issuer: ISSUER,
    hostId: HOST,
    now: () => NOW,
    fetchJwks: async () => {
      fetches.n++;
      return { keys: keys.map((k) => k.jwk) };
    },
  });
}

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    if (err instanceof TunnelRefusal) return err.code;
    throw err;
  }
  return 'accepted';
};

describe('TicketChecker', () => {
  it('accepts a ticket for this server once', async () => {
    const iss = issuer();
    const c = checker([iss]);
    const t = ticket(iss);
    expect((await c.check(t)).sub).toBe('user_12345678');
    expect(await refusal(c.check(t))).toBe('ticket');
  });

  it('refuses tickets for another server, issuer or kind', async () => {
    const iss = issuer();
    const c = checker([iss]);
    expect(await refusal(c.check(ticket(iss, { aud: 'host_other123' })))).toBe('ticket');
    expect(await refusal(c.check(ticket(iss, { iss: 'https://evil.example' })))).toBe('ticket');
    expect(await refusal(c.check(ticket(iss, { kind: 'host', role: undefined, mid: undefined })))).toBe(
      'ticket',
    );
    expect(await refusal(c.check(ticket(iss, { cnf: undefined })))).toBe('ticket');
    expect(await refusal(c.check(ticket(iss, { hkey: undefined })))).toBe('ticket');
  });

  it('refuses expired, future and long-lived tickets', async () => {
    const iss = issuer();
    const c = checker([iss]);
    expect(await refusal(c.check(ticket(iss, { iat: NOW - 200, exp: NOW - 100 })))).toBe('ticket');
    expect(await refusal(c.check(ticket(iss, { iat: NOW + 120, exp: NOW + 180 })))).toBe('ticket');
    expect(await refusal(c.check(ticket(iss, { exp: NOW + 3600 })))).toBe('ticket');
    // Within the tolerated clock difference.
    expect(await refusal(c.check(ticket(iss, { iat: NOW + 20, exp: NOW + 80 })))).toBe('accepted');
  });

  it('refuses a ticket signed by another key or with another algorithm', async () => {
    const iss = issuer();
    const other = issuer('k1');
    const c = checker([iss]);
    expect(await refusal(c.check(ticket(other)))).toBe('ticket');
    expect(await refusal(c.check(ticket(iss, {}, { alg: 'none' })))).toBe('ticket');
    expect(await refusal(c.check(ticket(iss, {}, { alg: 'HS256' })))).toBe('ticket');
    const [h, p] = ticket(iss).split('.');
    expect(await refusal(c.check(`${h}.${p}.`))).toBe('ticket');
    expect(await refusal(c.check('not-a-ticket'))).toBe('ticket');
  });

  it('refuses tickets signed before access last changed', async () => {
    const iss = issuer();
    const c = checker([iss]);
    await c.check(ticket(iss, { epoch: 5 }));
    expect(c.epoch).toBe(5);
    expect(await refusal(c.check(ticket(iss, { epoch: 4 })))).toBe('revoked');
    c.raiseEpoch(9);
    c.raiseEpoch(2);
    expect(c.epoch).toBe(9);
    expect(await refusal(c.check(ticket(iss, { epoch: 8 })))).toBe('revoked');
  });

  it('fetches keys again for a new kid, but not on every unknown one', async () => {
    const a = issuer('k1');
    const b = issuer('k2');
    const keys = [a];
    const fetches = { n: 0 };
    const c = checker(keys, fetches);
    await c.check(ticket(a));
    expect(fetches.n).toBe(1);
    keys.push(b);
    // Within the retry interval the unknown kid is refused without asking again.
    expect(await refusal(c.check(ticket(b)))).toBe('ticket');
    expect(fetches.n).toBe(1);
  });
});

describe('checkProof', () => {
  const fps = {
    clientFingerprint: 'sha-256 AA:BB',
    serverFingerprint: 'sha-256 CC:DD',
    nonce: 'nonce_1234567890123456',
  };

  function proof(d: ReturnType<typeof device>, t: string, over: Partial<typeof fps> = {}) {
    return sign(null, proofMessage({ ticket: t, ...fps, ...over }), d.privateKey).toString('base64url');
  }

  it('accepts the device the ticket names, on this connection', () => {
    const d = device();
    const claims = { cnf: { jkt: d.jkt } } as never;
    expect(() => checkProof({ claims, ticket: 't', key: d.x, sig: proof(d, 't'), ...fps })).not.toThrow();
  });

  it('refuses another device, another connection or another nonce', () => {
    const d = device();
    const other = device();
    const claims = { cnf: { jkt: d.jkt } } as never;
    const bad = (f: () => void) => expect(f).toThrow(TunnelRefusal);
    bad(() => checkProof({ claims, ticket: 't', key: other.x, sig: proof(other, 't'), ...fps }));
    bad(() =>
      checkProof({
        claims,
        ticket: 't',
        key: d.x,
        sig: proof(d, 't', { serverFingerprint: 'sha-256 EE:FF' }),
        ...fps,
      }),
    );
    bad(() =>
      checkProof({
        claims,
        ticket: 't',
        key: d.x,
        sig: proof(d, 't', { nonce: 'other_nonce_1234567890' }),
        ...fps,
      }),
    );
    bad(() => checkProof({ claims, ticket: 'u', key: d.x, sig: proof(d, 't'), ...fps }));
  });
});
