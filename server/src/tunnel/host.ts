import { createPrivateKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { Server } from 'node:http';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '../db';
import { HttpError, newId } from '../util';
import { AccountLinks } from './links';
import { TunnelGateway } from './gateway';
import { SignalClient, type RtcFactory } from './signal';
import { TicketChecker } from './ticket';

/** Where this server meets the account service and the relay; each can be set for a test setup. */
export interface AccountHostConfig {
  /** The account service, `https://api.leafbot.app`: claims, host tickets and its keys. */
  issuer: string;
  /** The relay's signalling address, `wss://…/v1/signal`. */
  relayUrl: string;
  /** The Host tunnelled requests carry: the website the web app runs on. */
  webHost: string;
}

/** Where a server meets its account: as configured, or the public service when nothing names one. */
export function accountHostConfig(config: { account?: AccountHostConfig }): AccountHostConfig {
  return (
    config.account ?? {
      issuer: 'https://api.leafbot.app',
      relayUrl: 'wss://signal.leafbot.app/v1/signal',
      webHost: 'www.leafbot.app',
    }
  );
}

/** What the server keeps once it is linked to an account (`kv`, key `account-host`). */
interface Stored {
  hostId: string;
  /** Kept when the link is removed, so linking again (a reinstall) keeps the server's id. */
  linked: boolean;
  credentialId?: string;
  /** The machine token, sealed with the vault key and bound to this server's id. */
  token?: string;
  /** The server's Ed25519 private key (PKCS#8 PEM), sealed the same way. */
  key?: string;
  name?: string;
  linkedAt?: string;
}

export interface Sealer {
  seal(plain: string, bind?: readonly string[]): string;
  open(sealed: string, bind?: readonly string[]): string;
}

export interface AccountHostState {
  linked: boolean;
  hostId: string | null;
  name: string | null;
  /** Whether browsers can reach the server now: linked, with WebRTC available, and running. */
  running: boolean;
  /** Linked, but this build cannot make WebRTC connections. */
  noWebRtc: boolean;
}

const KV_KEY = 'account-host';

/** The message a server signs to redeem an install code; the account service checks these exact bytes. */
export function claimMessage(hostId: string, code: string): Buffer {
  return Buffer.from(`leafbot-claim:${hostId}:${code.toUpperCase().replace(/[\s-]/g, '')}`, 'utf8');
}

/** Install codes are 20 letters and digits, shown in groups of five. */
const CODE = /^[A-Za-z0-9]{5}(-?[A-Za-z0-9]{5}){3}$/;

/**
 * This server's place in a Leaf Bot account. The owner links it once with an install code from the
 * account; the server then holds a machine token for host tickets and its own key, keeps an
 * outgoing socket to the relay, and serves the browsers whose tickets the account signed. Nothing
 * here opens a port.
 */
export class AccountHost {
  private signal: SignalClient | null = null;
  private gateway: TunnelGateway | null = null;
  private fetcher: typeof fetch;

  constructor(
    private deps: {
      db: Db;
      vault: Sealer;
      server: Server;
      config: AccountHostConfig;
      /** Makes WebRTC connections; null when this build has no WebRTC library. */
      rtc: RtcFactory | null;
      fetcher?: typeof fetch;
      /** Told when a ticket changed a person's name here. */
      onNameChanged?: () => void;
      /** Someone came over the account for the first time. */
      onJoined?: (userId: string) => void;
    },
  ) {
    this.fetcher = deps.fetcher ?? ((i, init) => fetch(i, init));
  }

  private async read(): Promise<Stored | null> {
    const [row] = await this.deps.db.select().from(schema.kv).where(eq(schema.kv.key, KV_KEY)).limit(1);
    return (row?.value as Stored | undefined) ?? null;
  }

  private async write(v: Stored) {
    await this.deps.db
      .insert(schema.kv)
      .values({ key: KV_KEY, value: v })
      .onConflictDoUpdate({ target: schema.kv.key, set: { value: v } });
  }

  private bind(hostId: string, what: string) {
    return ['account-host', hostId, what];
  }

  async state(): Promise<AccountHostState> {
    const s = await this.read();
    const linked = Boolean(s?.linked);
    return {
      linked,
      hostId: linked ? (s?.hostId ?? null) : null,
      name: linked ? (s?.name ?? null) : null,
      running: Boolean(this.signal),
      noWebRtc: linked && !this.deps.rtc,
    };
  }

  /**
   * Redeems an install code: proves this server holds its new key by signing the code, and keeps
   * the machine token the account service answers with. The same server linked again (a reinstall,
   * or after unlinking) keeps its id, so its people keep their access.
   */
  async link(code: string, name: string): Promise<AccountHostState> {
    const trimmed = code.trim();
    if (!CODE.test(trimmed)) throw new HttpError(400, 'error.installCodeInvalid');
    const before = await this.read();
    const hostId = before?.hostId ?? newId();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const res = await this.fetcher(`${this.deps.config.issuer}/v1/host/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: trimmed,
        hostId,
        publicKey: publicKey.export({ format: 'jwk' }).x,
        signature: sign(null, claimMessage(hostId, trimmed), privateKey).toString('base64url'),
        name: name.trim().slice(0, 80) || 'Leaf Bot',
      }),
    }).catch(() => null);
    if (!res) throw new HttpError(502, 'error.accountUnreachable');
    const body = (await res.json().catch(() => null)) as {
      error?: string;
      hostId?: string;
      machineToken?: string;
      credentialId?: string;
    } | null;
    if (!res.ok || !body?.machineToken || body.hostId !== hostId) {
      if (body?.error === 'host_taken') throw new HttpError(409, 'error.installCodeOtherAccount');
      if (res.status === 400 || res.status === 404) throw new HttpError(400, 'error.installCodeInvalid');
      if (res.status === 429) throw new HttpError(429, 'error.accountTooManyTries');
      throw new HttpError(502, 'error.accountUnreachable');
    }
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    await this.write({
      hostId,
      linked: true,
      ...(body.credentialId ? { credentialId: body.credentialId } : {}),
      token: this.deps.vault.seal(body.machineToken, this.bind(hostId, 'token')),
      key: this.deps.vault.seal(pem, this.bind(hostId, 'key')),
      name: name.trim().slice(0, 80) || 'Leaf Bot',
      linkedAt: new Date().toISOString(),
    });
    // A new key: connections made under the old one end, and the tunnel starts again with this one.
    this.stop();
    await this.start();
    return this.state();
  }

  /**
   * Forgets the machine token and key here. The server stays listed in the account until its owner
   * removes it there; without the token it can no longer get tickets, so nobody reaches it.
   */
  async unlink(): Promise<AccountHostState> {
    const s = await this.read();
    this.stop();
    if (s) await this.write({ hostId: s.hostId, linked: false });
    return this.state();
  }

  private async secrets(): Promise<{ hostId: string; token: string; key: KeyObject } | null> {
    const s = await this.read();
    if (!s?.linked || !s.token || !s.key) return null;
    return {
      hostId: s.hostId,
      token: this.deps.vault.open(s.token, this.bind(s.hostId, 'token')),
      key: createPrivateKey(this.deps.vault.open(s.key, this.bind(s.hostId, 'key'))),
    };
  }

  /** A host ticket from the account service, proving to the relay which server this is. */
  private async hostTicket(token: string): Promise<string> {
    const res = await this.fetcher(`${this.deps.config.issuer}/v1/host/ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    const body = (await res.json().catch(() => null)) as { ticket?: string } | null;
    if (!res.ok || !body?.ticket) throw new Error(`host ticket: ${res.status}`);
    return body.ticket;
  }

  /** Starts serving browsers when the server is linked and can make WebRTC connections. */
  async start(): Promise<void> {
    if (this.signal || !this.deps.rtc) return;
    const s = await this.secrets();
    if (!s) return;
    const { config } = this.deps;
    const checker = new TicketChecker({
      issuer: config.issuer,
      hostId: s.hostId,
      fetchJwks: async () => {
        const res = await this.fetcher(`${config.issuer}/.well-known/jwks.json`);
        if (!res.ok) throw new Error(`jwks: ${res.status}`);
        return res.json();
      },
    });
    const links = new AccountLinks(this.deps.db, this.deps.onNameChanged, this.deps.onJoined);
    this.gateway = new TunnelGateway({
      server: this.deps.server,
      checker,
      resolve: (claims) => links.resolve(claims),
      host: config.webHost,
      hostKey: s.key,
    });
    this.signal = new SignalClient({
      url: config.relayUrl,
      hostTicket: () => this.hostTicket(s.token),
      rtc: this.deps.rtc,
      gateway: this.gateway,
    });
    this.signal.start();
  }

  /** A person was removed or disabled here: their tunnelled connections close now. */
  dropUser(userId: string) {
    this.gateway?.dropUser(userId);
  }

  stop() {
    this.signal?.stop();
    this.signal = null;
    this.gateway?.close();
    this.gateway = null;
  }
}
