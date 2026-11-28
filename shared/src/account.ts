import { z } from 'zod';

/**
 * What the account service, the signalling relay and a Leaf Bot server agree on. A server opens no
 * port: people sign in to their account, the account service signs a short ticket for one server,
 * and the relay and the server each check that ticket against the account service's public keys
 * (JWKS) without asking it. Kept in one place so the three sides cannot drift apart.
 */

/** Where the account service publishes the keys tickets are checked against. */
export const JWKS_PATH = '/.well-known/jwks.json';

/** Tickets are signed with ES256 (P-256); the header names the key in `kid`. */
export const TICKET_ALG = 'ES256';

/**
 * A ticket lives a minute: long enough to reach the relay and finish the WebRTC handshake, short
 * enough that a copied one is of little use. Connections that last longer present a fresh one.
 */
export const TICKET_TTL_S = 60;

/** A connection that has not shown a fresh ticket for this long is closed. */
export const TICKET_REFRESH_S = 600;

/** Clock difference tolerated when checking `iat` and `exp`. */
export const TICKET_SKEW_S = 30;

export const ROLES = ['owner', 'admin', 'member'] as const;
export const Role = z.enum(ROLES);
export type Role = z.infer<typeof Role>;

/** Who presents a ticket: a person's device (`client`) or the server itself (`host`). */
export const TicketKind = z.enum(['client', 'host']);
export type TicketKind = z.infer<typeof TicketKind>;

/** Ids are opaque, URL-safe strings made by the account service. */
const Id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

/** The claims of a ticket, after its signature has been checked. Times are Unix seconds. */
export const TicketClaims = z.object({
  /** The account service that signed it, e.g. `https://api.leafbot.app`. */
  iss: z.string().url(),
  /** The server the ticket is for. A ticket for one server is refused by every other. */
  aud: Id,
  /** The account user; for a `host` ticket, the server's own id. */
  sub: Id,
  kind: TicketKind,
  /** The account sign-in session the ticket came from; ending it ends the connections it opened. */
  sid: Id,
  /** Single use: the relay and the server remember it until `exp` and refuse it a second time. */
  jti: Id,
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
  /** The person's role on this server; absent on a `host` ticket. */
  role: Role.optional(),
  /** The membership the role comes from; absent on a `host` ticket. */
  mid: Id.optional(),
  /**
   * The server's access counter when the ticket was signed. It goes up whenever someone's access to
   * the server changes; a ticket signed before the current value is refused.
   */
  epoch: z.number().int().nonnegative(),
  /**
   * The key the device proves it holds (RFC 7800 `cnf.jkt`: the base64url SHA-256 thumbprint of its
   * public JWK). Its signature binds the ticket to the two DTLS fingerprints of the connection, so
   * neither the relay nor a TURN server can sit in the middle. Required on `client` tickets.
   */
  cnf: z.object({ jkt: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).optional(),
  /**
   * The server's own Ed25519 public key (raw, base64url), as it registered it when it was linked.
   * The browser checks the server's proof on the tunnel against it, so a relay cannot pose as the
   * server. Required on `client` tickets.
   */
  hkey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
  /**
   * The person's name as their account has it, so the server can call them by it without asking
   * again. Absent on a `host` ticket and while the account has no name yet.
   */
  name: z.string().min(1).max(80).optional(),
  /**
   * The person on the server the membership's invite was made for, by the server's own id for them.
   * Someone who was on the server before signing in with an account comes in as that person, with
   * what is theirs there, rather than as someone new. Absent on a `host` ticket and on memberships
   * an invite made for no one in particular.
   */
  person: Id.optional(),
});
export type TicketClaims = z.infer<typeof TicketClaims>;

/**
 * Sent by the account service to the relay (and on to the server) when access changes, signed with
 * a secret the two share (HMAC-SHA256 of the body in `x-leafbot-signature`). The relay drops the
 * matching connections at once; the account service sends it again from its cron until the relay
 * answers 2xx, so `id` lets the relay ignore repeats.
 */
export const AuthEvent = z.object({
  id: Id,
  hostId: Id,
  /** The server's access counter after the change; tickets with a lower `epoch` stop working. */
  epoch: z.number().int().nonnegative(),
  /** Only this person's connections, or every connection to the server when absent. */
  userId: Id.optional(),
  /** Only the connections opened from this sign-in session. */
  sessionId: Id.optional(),
  at: z.number().int().nonnegative(),
});
export type AuthEvent = z.infer<typeof AuthEvent>;

/** The header the relay reads the event's signature from. */
export const AUTH_EVENT_SIGNATURE_HEADER = 'x-leafbot-signature';
