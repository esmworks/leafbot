import { z } from 'zod';
import { TicketKind } from './account';

/**
 * The messages a browser and a Leaf Bot server exchange with the signalling relay. The relay only
 * passes the WebRTC handshake (SDP and ICE) between the two; app data never goes through it. Kept
 * here so the relay, the server and the browser read the same shapes.
 */

export const SIGNAL_PATH = '/v1/signal';

/** Larger messages close the socket (1009): an SDP with many candidates stays far below this. */
export const SIGNAL_MAX_MESSAGE_BYTES = 64 * 1024;

/** Why the relay closed a socket. The close reason carries a short machine word as well. */
export const SignalClose = {
  /** Not JSON, not a known message, or something other than `hello` first. */
  badMessage: 4400,
  /** The ticket or resume token failed a check (signature, issuer, kind, time, shape). */
  ticketInvalid: 4401,
  /** The ticket or resume token was used before. */
  ticketReplayed: 4402,
  /** Access changed: the server's epoch moved past the ticket, or an auth event ended it. */
  revoked: 4403,
  /** A client's server did not come online within the wait. */
  hostOffline: 4404,
  /** No `hello` in time, or no fresh ticket before the last one's window ended. */
  timeout: 4408,
  /** A newer socket took this one's place (a server's second socket, or a resumed client). */
  replaced: 4409,
  rateLimited: 4429,
  /** The relay is full, or the account service's keys could not be fetched; try again later. */
  busy: 4503,
} as const;

/** Made by the relay for each client socket; the server tells its browsers apart by it. */
export const ConnectionId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

const Sdp = z.string().min(1).max(60_000);

/** The fields of a browser `RTCIceCandidateInit`; `null` means the other side has no more. */
export const IceCandidate = z
  .object({
    candidate: z.string().max(2048),
    sdpMid: z.string().max(64).nullish(),
    sdpMLineIndex: z.number().int().min(0).max(1023).nullish(),
    usernameFragment: z.string().max(256).nullish(),
  })
  .nullable();

/**
 * Passed between a client and its server. A client leaves `connectionId` out (the relay writes its
 * own); a server names the client it answers.
 */
export const PeerMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('offer'), connectionId: ConnectionId.optional(), sdp: Sdp }),
  z.object({ type: z.literal('answer'), connectionId: ConnectionId.optional(), sdp: Sdp }),
  z.object({
    type: z.literal('ice-candidate'),
    connectionId: ConnectionId.optional(),
    candidate: IceCandidate,
  }),
  /** Asks the other side to restart ICE; the offer that follows carries the new credentials. */
  z.object({ type: z.literal('ice-restart'), connectionId: ConnectionId.optional() }),
  z.object({
    type: z.literal('bye'),
    connectionId: ConnectionId.optional(),
    reason: z
      .string()
      .regex(/^[a-z-]{1,32}$/)
      .optional(),
  }),
]);
export type PeerMessage = z.infer<typeof PeerMessage>;

/** What a browser or a server sends to the relay. */
export const SignalInbound = z.discriminatedUnion('type', [
  /**
   * The first message. `ticket` is a fresh ticket from the account service; `resume` is the token
   * the relay handed out on an earlier socket, so a quick reconnect needs no new ticket. Exactly one.
   */
  z.object({
    type: z.literal('hello'),
    role: TicketKind,
    ticket: z.string().min(1).max(4096).optional(),
    resume: z.string().min(1).max(8192).optional(),
  }),
  /** A fresh ticket on a live socket; without one the socket closes when its window ends. */
  z.object({ type: z.literal('refresh'), ticket: z.string().min(1).max(4096) }),
  ...PeerMessage.options,
]);
export type SignalInbound = z.infer<typeof SignalInbound>;

/** The STUN and TURN servers to hand to `RTCPeerConnection`. */
export const IceServer = z.object({
  urls: z.array(z.string()),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof IceServer>;

/** What the relay sends. Times are Unix seconds. */
export const SignalOutbound = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('welcome'),
    role: TicketKind,
    /** A client's own id; absent for a server. */
    connectionId: ConnectionId.optional(),
    /** For a client: whether its server is connected now. */
    hostOnline: z.boolean().optional(),
    resumeToken: z.string(),
    /** When the socket closes unless a fresh ticket arrives; a resume token works until then. */
    resumeExpiresAt: z.number().int(),
    iceServers: z.array(IceServer),
    iceServersExpireAt: z.number().int(),
  }),
  /** New TURN credentials, sent before the old ones run out. */
  z.object({ type: z.literal('ice-servers'), iceServers: z.array(IceServer), expiresAt: z.number().int() }),
  /** After a `refresh`: the window moved on, and this token resumes until its end. */
  z.object({ type: z.literal('resume-token'), resumeToken: z.string(), expiresAt: z.number().int() }),
  /** To a client: its server connected or went away. A live WebRTC connection is not affected. */
  z.object({ type: z.literal('host-online') }),
  z.object({ type: z.literal('host-offline') }),
  /**
   * To a server: a client's signalling socket opened or closed. A closed socket does not end the
   * client's WebRTC connection; only a `bye` does.
   */
  z.object({ type: z.literal('peer-joined'), connectionId: ConnectionId }),
  z.object({ type: z.literal('peer-left'), connectionId: ConnectionId }),
  /** A message the relay could not pass on; the socket stays open. */
  z.object({ type: z.literal('error'), code: z.enum(['host-offline', 'unknown-connection', 'bad-message']) }),
  ...PeerMessage.options,
]);
export type SignalOutbound = z.infer<typeof SignalOutbound>;
