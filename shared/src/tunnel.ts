import { z } from 'zod';

/**
 * How a browser reaches a Leaf Bot server that opens no port. Both find each other through the
 * signalling relay, then talk over WebRTC data channels. The relay and any TURN server in between
 * see only encrypted DTLS; who is on the other end is proven inside the channel (`ctl`), bound to
 * both ends' DTLS fingerprints, so neither the relay nor TURN can sit in the middle.
 *
 * Kept free of Node APIs (Uint8Array, DataView, TextEncoder) because the browser uses it too.
 */

// ---- Data channels ---------------------------------------------------------------------------

/**
 * The browser opens the channels. `ctl` carries the proof of who it is and fresh tickets; `rt` is
 * one Socket.IO connection per channel, one WebSocket message per channel message; `http` carries
 * many requests as numbered streams. Nothing but `ctl` is served before the proof is accepted.
 */
export const CHANNEL = { ctl: 'ctl', rt: 'rt', http: 'http' } as const;

/** Socket.IO channels one connection may hold open; each reconnect opens a fresh one. */
export const MAX_RT_CHANNELS = 4;

// ---- Requests over the `http` channel ------------------------------------------------------

/**
 * One binary message is one frame: a type byte, a 32-bit stream number, then the payload.
 * The browser opens streams with REQUEST; the server answers each with RESPONSE.
 */
export const FRAME = {
  /** Payload: RequestHead as JSON. Opens the stream. */
  REQUEST: 1,
  /** Payload: ResponseHead as JSON. */
  RESPONSE: 2,
  /** Bytes of the body. */
  DATA: 3,
  /** The sender's body is complete; it still reads. */
  END: 4,
  /** The stream is over in both directions, cleanly or not. */
  RESET: 5,
  /** The receiver used this many more bytes (32-bit payload); the sender may send that many again. */
  ACK: 6,
} as const;
export type FrameType = (typeof FRAME)[keyof typeof FRAME];

export const FRAME_HEADER = 5;
/**
 * The largest payload in one message. Browsers and libdatachannel agree on 16 KiB without
 * splitting messages; larger ones fail on some pairings.
 */
export const MAX_FRAME_PAYLOAD = 16 * 1024;
/**
 * What a stream may send before the other end reports it used it. A 200 MB download then holds a
 * window's worth in memory, not the file, and a slow reader slows the sender down.
 */
export const STREAM_WINDOW = 256 * 1024;
/** Used bytes are reported once this many add up, or at once when the reader caught up. */
export const ACK_STEP = 32 * 1024;
/** Requests one connection may have open at once. */
export const MAX_STREAMS = 256;
/**
 * A sender pauses once this much waits in the channel's own send buffer and goes on when it has
 * drained to the low mark, so a fast stream cannot fill the process's memory.
 */
export const BUFFER_HIGH = 1024 * 1024;
export const BUFFER_LOW = 256 * 1024;

export interface Frame {
  type: FrameType;
  stream: number;
  payload: Uint8Array;
}

const TYPES = new Set<number>(Object.values(FRAME));

export function encodeFrame(type: FrameType, stream: number, payload?: Uint8Array): Uint8Array {
  const n = payload?.byteLength ?? 0;
  if (n > MAX_FRAME_PAYLOAD) throw new RangeError('frame payload too large');
  const out = new Uint8Array(FRAME_HEADER + n);
  const view = new DataView(out.buffer);
  view.setUint8(0, type);
  view.setUint32(1, stream >>> 0);
  if (payload) out.set(payload, FRAME_HEADER);
  return out;
}

/** A frame, or null when the message is not one (too short, unknown type, oversized). */
export function decodeFrame(data: Uint8Array): Frame | null {
  if (data.byteLength < FRAME_HEADER || data.byteLength > FRAME_HEADER + MAX_FRAME_PAYLOAD) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const type = view.getUint8(0);
  if (!TYPES.has(type)) return null;
  return { type: type as FrameType, stream: view.getUint32(1), payload: data.subarray(FRAME_HEADER) };
}

export function encodeAck(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0);
  return out;
}

export function decodeAck(payload: Uint8Array): number | null {
  if (payload.byteLength !== 4) return null;
  return new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0);
}

/**
 * Methods a tunnelled request may use. CONNECT, TRACE and the like serve nothing here; upgrades
 * (WebSocket) go over `rt`, never as a request.
 */
export const TUNNEL_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

/**
 * Request headers the server drops before the request reaches the app. Who the request is from is
 * the tunnel's proof, never a cookie, a key or a proxy header the page could set; `host` and the
 * hop-by-hop headers are the server's to write.
 */
export const DROPPED_REQUEST_HEADERS = [
  'cookie',
  'authorization',
  'host',
  'origin',
  'referer',
  'connection',
  'upgrade',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'te',
  'trailer',
  'content-length',
  'expect',
  'forwarded',
] as const;
/** Header name prefixes dropped the same way: the app's own and those a reverse proxy writes. */
export const DROPPED_REQUEST_PREFIXES = ['x-leafbot-', 'x-yumakbot-', 'x-forwarded-', 'x-real-ip'] as const;

/** Response headers the server drops: no cookie is set through the tunnel, and framing is its own. */
export const DROPPED_RESPONSE_HEADERS = [
  'set-cookie',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'strict-transport-security',
] as const;

export function droppedRequestHeader(name: string): boolean {
  const n = name.toLowerCase();
  return (
    (DROPPED_REQUEST_HEADERS as readonly string[]).includes(n) ||
    DROPPED_REQUEST_PREFIXES.some((p) => n.startsWith(p))
  );
}

/** Header names as HTTP allows them (a token); values without control characters. */
const HeaderName = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/);
const HeaderValue = z
  .string()
  .max(8192)
  .regex(/^[\t\x20-\x7e\x80-￿]*$/);

export const RequestHead = z.object({
  method: z.enum(TUNNEL_METHODS),
  /** Path and query, always starting with one slash; never a full URL. */
  path: z
    .string()
    .max(8192)
    .regex(/^\/(?!\/)[\x21-\x7e]*$/),
  headers: z.record(HeaderName, HeaderValue).default({}),
  /** The body's length when the page knows it; otherwise it arrives until END. */
  length: z.number().int().nonnegative().optional(),
});
export type RequestHead = z.infer<typeof RequestHead>;

export const ResponseHead = z.object({
  status: z.number().int().min(100).max(599),
  headers: z.record(HeaderName, z.union([HeaderValue, z.array(HeaderValue)])),
});
export type ResponseHead = z.infer<typeof ResponseHead>;

// ---- Proving who is on the other end (`ctl`) ------------------------------------------------

/**
 * Why the server refuses or closes a connection: the `ticket` is wrong or for another server, the
 * `proof` does not match it, the person no longer has `access`, no fresh ticket came in time
 * (`expired`), or the account service took access away (`revoked`).
 */
export const TunnelDenial = z.enum(['ticket', 'proof', 'access', 'expired', 'revoked', 'busy']);
export type TunnelDenial = z.infer<typeof TunnelDenial>;

const B64Url = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/);

/** Sent by the server: sign this nonce with the next ticket. A new one follows every accepted proof. */
const Challenge = z.object({ t: z.literal('challenge'), nonce: B64Url(22, 64) });
/**
 * Sent by the browser, first and then before `TICKET_REFRESH_S` runs out: a ticket for this server
 * and person, the device's Ed25519 public key (raw, base64url) whose thumbprint is the ticket's
 * `cnf.jkt`, and that key's signature over `proofMessage(...)`.
 */
const Auth = z.object({
  t: z.literal('auth'),
  ticket: z.string().min(16).max(4096),
  key: B64Url(43, 43),
  sig: B64Url(86, 86),
});
/** The proof was accepted; the next one is due within `refreshIn` seconds. */
const Ok = z.object({ t: z.literal('ok'), refreshIn: z.number().int().positive() });
/** The proof was refused, or the connection is being closed; the channel closes after it. */
const Denied = z.object({ t: z.literal('denied'), code: TunnelDenial });

export const CtlToServer = Auth;
export type CtlToServer = z.infer<typeof CtlToServer>;
export const CtlToClient = z.discriminatedUnion('t', [Challenge, Ok, Denied]);
export type CtlToClient = z.infer<typeof CtlToClient>;

/**
 * DTLS fingerprints as both ends compare them: the hash name in lower case, a space, the hex bytes
 * in upper case joined by colons (`sha-256 AB:CD:...`). SDP and the WebRTC libraries differ in
 * case and spacing.
 */
export function normalizeFingerprint(fp: string): string {
  const m = /^\s*([A-Za-z0-9-]+)\s+([0-9A-Fa-f:]+)\s*$/.exec(fp);
  if (!m) throw new Error('bad fingerprint');
  return `${m[1]!.toLowerCase()} ${m[2]!.toUpperCase()}`;
}

const PROOF_CONTEXT = 'leafbot-tunnel-proof-v1';

/**
 * What the device's key signs: the ticket, the browser's and the server's DTLS fingerprints and
 * the server's nonce. Someone who relays the channel (signalling, TURN) has different
 * fingerprints on at least one side, so a proof copied onto their own connection fails; the nonce
 * keeps an old proof from being replayed on the same pair.
 */
export function proofMessage(p: {
  ticket: string;
  clientFingerprint: string;
  serverFingerprint: string;
  nonce: string;
}): Uint8Array {
  return new TextEncoder().encode(
    [
      PROOF_CONTEXT,
      p.ticket,
      normalizeFingerprint(p.clientFingerprint),
      normalizeFingerprint(p.serverFingerprint),
      p.nonce,
    ].join('\n'),
  );
}

/**
 * The JSON whose SHA-256 (base64url) is the ticket's `cnf.jkt` for an Ed25519 key (RFC 7638:
 * required members only, in lexical order, no spaces).
 */
export function ed25519ThumbprintInput(x: string): string {
  return `{"crv":"Ed25519","kty":"OKP","x":"${x}"}`;
}

// ---- Signalling ------------------------------------------------------------------------------

/** STUN/TURN servers for one connection, with short-lived TURN credentials from the relay. */
export const IceServer = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof IceServer>;

/** A connection between one browser and the server, numbered by the relay. */
const Cid = B64Url(8, 64);
const Sdp = z.string().max(64 * 1024);

/** Sent by the browser and by the server to the relay first: who they are. */
const Hello = z.object({
  t: z.literal('hello'),
  ticket: z.string().min(16).max(4096),
  /** Continues an earlier relay session after a brief drop, so open connections are kept. */
  resume: z.string().max(512).optional(),
});
/**
 * The relay accepted the hello. The browser's has the connection id it signals with; `resume`
 * continues the session after a brief drop.
 */
const Ready = z.object({
  t: z.literal('ready'),
  cid: Cid.optional(),
  iceServers: z.array(IceServer),
  resume: z.string().max(512).optional(),
});
/** To the server: a browser wants a connection; offers and candidates for it carry `cid`. */
const Connect = z.object({ t: z.literal('connect'), cid: Cid, iceServers: z.array(IceServer) });
const Offer = z.object({ t: z.literal('offer'), cid: Cid, sdp: Sdp });
const Answer = z.object({ t: z.literal('answer'), cid: Cid, sdp: Sdp });
const Ice = z.object({
  t: z.literal('ice'),
  cid: Cid,
  candidate: z.string().max(2048),
  mid: z.string().max(64).nullable(),
});
/** Either side gives up on a connection. */
const Bye = z.object({ t: z.literal('bye'), cid: Cid });
/**
 * To the server: the account service took access away. The relay cannot add access, only take it,
 * so the server acts on this without a signature it could check: it raises its access counter to
 * `epoch` and closes the matching connections. A ticket signed before the counter's new value is
 * refused from then on.
 */
const Revoke = z.object({
  t: z.literal('revoke'),
  epoch: z.number().int().nonnegative(),
  userId: z.string().max(64).optional(),
  sessionId: z.string().max(64).optional(),
});
/** The relay refused a message or the hello. */
const SignalError = z.object({
  t: z.literal('error'),
  code: z.enum(['ticket', 'offline', 'busy', 'bad-message', 'unknown-connection']),
});

export const SignalToRelay = z.discriminatedUnion('t', [Hello, Offer, Answer, Ice, Bye]);
export type SignalToRelay = z.infer<typeof SignalToRelay>;
export const SignalFromRelay = z.discriminatedUnion('t', [
  Ready,
  Connect,
  Offer,
  Answer,
  Ice,
  Bye,
  Revoke,
  SignalError,
]);
export type SignalFromRelay = z.infer<typeof SignalFromRelay>;

/** Where the relay serves signalling. */
export const SIGNAL_PATH = '/v1/signal';
