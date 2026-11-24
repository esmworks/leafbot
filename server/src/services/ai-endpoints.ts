import {
  AI_KINDS,
  AiEndpointSet,
  type AiEndpoint,
  type AiEndpoints,
  type AiEndpointSet as SetInput,
  type AiKind,
} from '@leafbot/shared';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { ServerKey } from '../i18n';
import { HttpError } from '../util';
import type { VaultService } from './vault';

/** A service as the server calls it, key included. Never leaves the server. */
export interface AiService {
  baseUrl: string;
  model: string;
  apiKey: string;
  voice: string;
}

const KEY = (kind: AiKind) => `ai.${kind}`;
const SECRET = (kind: AiKind) => `secret.ai.${kind}`;

/**
 * The model services the server calls besides the bots' own: embeddings for memory search, and
 * speech to text and text to speech. Each is an OpenAI-compatible address set in the settings, or,
 * while the settings name none, in the server's environment. Keys are sealed with the vault key.
 */
export class AiEndpointService {
  private listeners = new Set<(kind: AiKind) => void>();

  constructor(
    private ctx: Ctx,
    private vault: VaultService,
  ) {}

  /** Called after a service is set or cleared, e.g. to index memory with a new model. */
  onChange(fn: (kind: AiKind) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private async read(key: string): Promise<unknown> {
    const [row] = await this.ctx.db.select().from(schema.kv).where(eq(schema.kv.key, key)).limit(1);
    return row?.value;
  }

  private async write(key: string, value: unknown) {
    await this.ctx.db
      .insert(schema.kv)
      .values({ key, value })
      .onConflictDoUpdate({ target: schema.kv.key, set: { value } });
  }

  private async saved(kind: AiKind): Promise<{ baseUrl: string; model: string; voice: string } | null> {
    const v = (await this.read(KEY(kind))) as
      { baseUrl?: unknown; model?: unknown; voice?: unknown } | undefined;
    if (!v || typeof v.baseUrl !== 'string' || typeof v.model !== 'string' || !v.baseUrl || !v.model)
      return null;
    return { baseUrl: v.baseUrl, model: v.model, voice: typeof v.voice === 'string' ? v.voice : '' };
  }

  private async savedKey(kind: AiKind): Promise<string> {
    const sealed = await this.read(SECRET(kind));
    if (typeof sealed !== 'string' || !sealed) return '';
    try {
      return this.vault.open(sealed);
    } catch {
      return '';
    }
  }

  /** The service to call for `kind`, or null when it is off. */
  async get(kind: AiKind): Promise<AiService | null> {
    const own = await this.saved(kind);
    if (own) return { ...own, apiKey: await this.savedKey(kind) };
    return this.ctx.config.aiEndpoints[kind] ?? null;
  }

  async describe(kind: AiKind): Promise<AiEndpoint> {
    const own = await this.saved(kind);
    if (own) return { ...own, hasKey: !!(await this.savedKey(kind)), source: 'settings' };
    const env = this.ctx.config.aiEndpoints[kind];
    if (env)
      return {
        baseUrl: env.baseUrl,
        model: env.model,
        voice: env.voice,
        hasKey: !!env.apiKey,
        source: 'env',
      };
    return { baseUrl: '', model: '', voice: '', hasKey: false, source: 'none' };
  }

  async all(): Promise<AiEndpoints> {
    const out = {} as AiEndpoints;
    for (const kind of AI_KINDS) out[kind] = await this.describe(kind);
    return out;
  }

  async set(kind: AiKind, raw: SetInput): Promise<AiEndpoint> {
    const input = AiEndpointSet.parse(raw);
    await this.write(KEY(kind), { baseUrl: input.baseUrl, model: input.model, voice: input.voice });
    if (input.apiKey !== undefined)
      await this.write(SECRET(kind), input.apiKey ? this.vault.seal(input.apiKey) : '');
    this.changed(kind);
    return this.describe(kind);
  }

  /** Forgets the settings' service; the environment's, if any, takes over. */
  async clear(kind: AiKind): Promise<AiEndpoint> {
    await this.ctx.db.delete(schema.kv).where(eq(schema.kv.key, KEY(kind)));
    await this.ctx.db.delete(schema.kv).where(eq(schema.kv.key, SECRET(kind)));
    this.changed(kind);
    return this.describe(kind);
  }

  private changed(kind: AiKind) {
    this.ctx.bus.refresh({ scope: 'info' });
    for (const fn of this.listeners) fn(kind);
  }
}

/** Headers for a call to an OpenAI-compatible service; a local server without a key gets none. */
export const authHeaders = (s: AiService): Record<string, string> =>
  s.apiKey ? { authorization: `Bearer ${s.apiKey}` } : {};

/**
 * A request to a speech service that got no answer at all. Without this the network's error reached
 * the person only as a bare server error; now they read whether the service was out of reach (with
 * the network's own reason: refused, not found, a certificate) or too slow, and the server log keeps
 * the full error.
 */
export async function askService(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  keys: { unreachable: ServerKey; timeout: ServerKey },
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    console.error(`${url}:`, err);
    const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
    if (e?.name === 'TimeoutError') throw new HttpError(504, keys.timeout, { seconds: timeoutMs / 1000 });
    const reason = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(err);
    throw new HttpError(502, keys.unreachable, { reason });
  }
}
