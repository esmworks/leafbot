import { describe, expect, it } from 'vitest';
import {
  CtlToClient,
  encodeRt,
  hostProofMessage,
  MAX_MESSAGE,
  MAX_RT_MESSAGE,
  RtAssembler,
  CtlToServer,
  decodeAck,
  decodeFrame,
  droppedRequestHeader,
  encodeAck,
  encodeFrame,
  FRAME,
  MAX_FRAME_PAYLOAD,
  normalizeFingerprint,
  proofMessage,
  RequestHead,
  SignalFromRelay,
} from './tunnel';

describe('frames', () => {
  it('round-trips type, stream and payload', () => {
    const f = decodeFrame(encodeFrame(FRAME.DATA, 0xfffffffe, new Uint8Array([1, 2, 3])));
    expect(f?.type).toBe(FRAME.DATA);
    expect(f?.stream).toBe(0xfffffffe);
    expect([...f!.payload]).toEqual([1, 2, 3]);
  });

  it('reads a frame that sits inside a larger buffer', () => {
    const inner = encodeFrame(FRAME.END, 7);
    const outer = new Uint8Array(inner.byteLength + 10);
    outer.set(inner, 10);
    expect(decodeFrame(outer.subarray(10))).toMatchObject({ type: FRAME.END, stream: 7 });
  });

  it('refuses short, unknown and oversized messages', () => {
    expect(decodeFrame(new Uint8Array(4))).toBeNull();
    expect(decodeFrame(new Uint8Array([99, 0, 0, 0, 1]))).toBeNull();
    expect(decodeFrame(new Uint8Array(5 + MAX_FRAME_PAYLOAD + 1).fill(3, 0, 1))).toBeNull();
    expect(() => encodeFrame(FRAME.DATA, 1, new Uint8Array(MAX_FRAME_PAYLOAD + 1))).toThrow();
  });

  it('carries credit as 32 bits', () => {
    expect(decodeAck(encodeAck(262144))).toBe(262144);
    expect(decodeAck(new Uint8Array(3))).toBeNull();
  });
});

describe('request heads', () => {
  it('accepts a plain request', () => {
    const h = RequestHead.parse({
      method: 'GET',
      path: '/api/bots?x=1',
      headers: { accept: 'application/json' },
    });
    expect(h.path).toBe('/api/bots?x=1');
  });

  it('refuses what could smuggle a second request or reach another host', () => {
    for (const path of ['/a b', '/a\r\nX: y', '//evil.example/', 'http://evil.example/', 'api']) {
      expect(RequestHead.safeParse({ method: 'GET', path }).success, path).toBe(false);
    }
    expect(RequestHead.safeParse({ method: 'CONNECT', path: '/' }).success).toBe(false);
    expect(RequestHead.safeParse({ method: 'GET', path: '/', headers: { 'x\r\ny': '1' } }).success).toBe(
      false,
    );
    expect(
      RequestHead.safeParse({ method: 'GET', path: '/', headers: { a: 'b\r\nCookie: c' } }).success,
    ).toBe(false);
  });

  it('drops headers that would say who the request is from', () => {
    for (const h of [
      'Cookie',
      'authorization',
      'Host',
      'X-Leafbot-Proxy',
      'x-forwarded-for',
      'X-Real-IP',
      'upgrade',
    ]) {
      expect(droppedRequestHeader(h), h).toBe(true);
    }
    expect(droppedRequestHeader('content-type')).toBe(false);
    expect(droppedRequestHeader('range')).toBe(false);
  });
});

describe('proof', () => {
  it('compares fingerprints whatever their case and spacing', () => {
    expect(normalizeFingerprint('SHA-256 ab:cd:ef')).toBe('sha-256 AB:CD:EF');
    expect(normalizeFingerprint('  sha-256   AB:CD:EF ')).toBe('sha-256 AB:CD:EF');
    expect(() => normalizeFingerprint('nonsense')).toThrow();
  });

  it('binds the ticket, both fingerprints and the nonce in order', () => {
    const base = {
      ticket: 'tkt',
      clientFingerprint: 'sha-256 AA',
      serverFingerprint: 'sha-256 BB',
      nonce: 'n',
    };
    const a = new TextDecoder().decode(proofMessage(base));
    expect(a).toBe('leafbot-tunnel-proof-v1\ntkt\nsha-256 AA\nsha-256 BB\nn');
    const swapped = new TextDecoder().decode(
      proofMessage({ ...base, clientFingerprint: 'sha-256 BB', serverFingerprint: 'sha-256 AA' }),
    );
    expect(swapped).not.toBe(a);
  });
});

describe('messages', () => {
  it('parses the control messages', () => {
    expect(CtlToClient.parse({ t: 'challenge', nonce: 'a'.repeat(22) }).t).toBe('challenge');
    expect(CtlToClient.parse({ t: 'denied', code: 'proof' }).t).toBe('denied');
    expect(CtlToClient.safeParse({ t: 'ok', refreshIn: 600 }).success).toBe(false);
    expect(
      CtlToServer.safeParse({
        t: 'auth',
        ticket: 'x'.repeat(20),
        key: 'k'.repeat(43),
        sig: 's'.repeat(86),
        cnonce: 'c'.repeat(22),
      }).success,
    ).toBe(true);
    expect(
      CtlToServer.safeParse({
        t: 'auth',
        ticket: 'x'.repeat(20),
        key: 'short',
        sig: 's'.repeat(86),
        cnonce: 'c'.repeat(22),
      }).success,
    ).toBe(false);
  });

  it('parses what the relay sends', () => {
    const m = SignalFromRelay.parse({ t: 'revoke', epoch: 4, userId: 'user_123456' });
    expect(m).toEqual({ t: 'revoke', epoch: 4, userId: 'user_123456' });
    expect(SignalFromRelay.safeParse({ t: 'offer', cid: 'c', sdp: '' }).success).toBe(false);
  });
});

describe('Socket.IO pieces', () => {
  it('cuts a large binary message into channel-sized pieces and puts it back', () => {
    const big = new Uint8Array(100_000).map((_, i) => i % 251);
    const pieces = encodeRt(big);
    expect(pieces.length).toBe(Math.ceil(big.byteLength / (MAX_MESSAGE - 1)));
    for (const p of pieces) expect(p.byteLength).toBeLessThanOrEqual(MAX_MESSAGE);
    const a = new RtAssembler();
    const out = pieces.map((p) => a.push(p));
    expect(out.slice(0, -1).every((o) => o === null)).toBe(true);
    expect(out.at(-1)).toEqual(big);
  });

  it('keeps text as text, including an empty message', () => {
    const a = new RtAssembler();
    expect(a.push(encodeRt('42["hello","ü"]')[0]!)).toBe('42["hello","ü"]');
    const empty = encodeRt('');
    expect(empty.length).toBe(1);
    expect(a.push(empty[0]!)).toBe('');
    expect(a.push(encodeRt(new Uint8Array(0))[0]!)).toEqual(new Uint8Array(0));
  });

  it('refuses a message past the limit', () => {
    const a = new RtAssembler();
    const piece = new Uint8Array(MAX_MESSAGE);
    expect(() => {
      for (let i = 0; i <= MAX_RT_MESSAGE / (MAX_MESSAGE - 1) + 1; i++) a.push(piece);
    }).toThrow();
  });
});

describe('host proof', () => {
  it('covers both fingerprints and the browser nonce', () => {
    const m = new TextDecoder().decode(
      hostProofMessage({ clientFingerprint: 'sha-256 aa', serverFingerprint: 'sha-256 bb', cnonce: 'cn' }),
    );
    expect(m).toBe('leafbot-tunnel-host-v1\nsha-256 AA\nsha-256 BB\ncn');
  });
});
