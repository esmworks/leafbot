import {
  AI_KINDS,
  AI_PROVIDER_URLS,
  AiEndpointSet,
  elevenLabs,
  googleSpeech,
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
import type { ProviderKeyService } from './keys';
import type { VaultService } from './vault';

/** A service as the server calls it, key included. Never leaves the server. */
export interface AiService {
  baseUrl: string;
  model: string;
  apiKey: string;
  voice: string;
}

const KEY = (kind: AiKind) => `ai.${kind}`;
/** Where a service's own key was kept before keys moved under Providers; read once, then removed. */
const SECRET = (kind: AiKind) => `secret.ai.${kind}`;

interface Saved {
  provider: string;
  model: string;
  voice: string;
}

/** The name an adopted address is filed under in Providers. */
function endpointName(baseUrl: string): string {
  if (elevenLabs(baseUrl)) return 'ElevenLabs';
  if (googleSpeech(baseUrl)) return 'Google Text-to-Speech';
  try {
    return new URL(baseUrl).host;
  } catch {
    return 'Endpoint';
  }
}

/**
 * The model services the server calls besides the bots' own: embeddings for memory search, and
 * speech to text and text to speech. Each goes through a provider saved under Providers, a
 * built-in one with its key or an endpoint of the person's own, so one key serves the bots and these
 * services and a service never keeps a key of its own. While the settings name none, the server's
 * environment may name an address instead.
 */
export class AiEndpointService {
  private listeners = new Set<(kind: AiKind) => void>();
  private moved: Promise<void> | null = null;

  constructor(
    private ctx: Ctx,
    private vault: VaultService,
    private keys: ProviderKeyService,
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

  /**
   * Services saved with an address and a key of their own, as they were before, are filed under
   * Providers once: the address and model the services call stay the same, so nothing is indexed
   * again and nothing has to be typed in again.
   */
  private ready(): Promise<void> {
    this.moved ??= (async () => {
      for (const kind of AI_KINDS) {
        const v = (await this.read(KEY(kind))) as { provider?: unknown; baseUrl?: unknown } | undefined;
        if (!v || typeof v.provider === 'string' || typeof v.baseUrl !== 'string' || !v.baseUrl) continue;
        const old = v as { baseUrl: string; model?: unknown; voice?: unknown };
        let key = '';
        const sealed = await this.read(SECRET(kind));
        if (typeof sealed === 'string' && sealed) {
          try {
            key = this.vault.open(sealed);
          } catch {
            // Sealed with a vault key that is gone: it reads as no key, as it did before.
          }
        }
        const provider = await this.adopt(old.baseUrl, key);
        await this.write(KEY(kind), {
          provider,
          model: typeof old.model === 'string' ? old.model : '',
          voice: typeof old.voice === 'string' ? old.voice : '',
        });
        await this.ctx.db.delete(schema.kv).where(eq(schema.kv.key, SECRET(kind)));
      }
    })().catch((err: unknown) => {
      this.moved = null;
      throw err;
    });
    return this.moved;
  }

  /**
   * The provider an address and key belong to: a built-in provider whose API it is, when that
   * provider has no key yet or the same one; else an endpoint of the person's own at that address
   * with that key; else a new endpoint.
   */
  private async adopt(baseUrl: string, key: string): Promise<string> {
    const builtIn = Object.values(AI_PROVIDER_URLS)
      .flatMap((m) => Object.entries(m))
      .find(([, url]) => url === baseUrl)?.[0];
    if (builtIn && key) {
      const saved = await this.keys.get(builtIn);
      if (!saved) await this.keys.adoptKey(builtIn, key);
      if (!saved || saved === key) return builtIn;
    }
    for (const e of await this.keys.customEndpoints()) {
      if (e.baseUrl === baseUrl && ((await this.keys.get(e.id)) ?? '') === key) return e.id;
    }
    return this.keys.adoptEndpoint(endpointName(baseUrl), baseUrl, key);
  }

  private async saved(kind: AiKind): Promise<Saved | null> {
    await this.ready();
    const v = (await this.read(KEY(kind))) as
      { provider?: unknown; model?: unknown; voice?: unknown } | undefined;
    if (!v || typeof v.provider !== 'string' || typeof v.model !== 'string' || !v.provider || !v.model)
      return null;
    return { provider: v.provider, model: v.model, voice: typeof v.voice === 'string' ? v.voice : '' };
  }

  /**
   * The address and key a provider is reached at for `kind`: an endpoint of the person's own, or a
   * built-in provider that serves that kind and has a key. Null when it has neither any more.
   */
  private async reach(kind: AiKind, provider: string): Promise<{ baseUrl: string; apiKey: string } | null> {
    const own = await this.keys.customEndpoint(provider);
    if (own) return { baseUrl: own.baseUrl, apiKey: (await this.keys.get(provider)) ?? '' };
    const url = AI_PROVIDER_URLS[kind][provider];
    const key = url ? await this.keys.get(provider) : null;
    return url && key ? { baseUrl: url, apiKey: key } : null;
  }

  /** The service to call for `kind`, or null when it is off. */
  async get(kind: AiKind): Promise<AiService | null> {
    const own = await this.saved(kind);
    if (own) {
      const at = await this.reach(kind, own.provider);
      return at ? { ...at, model: own.model, voice: own.voice } : null;
    }
    return this.ctx.config.aiEndpoints[kind] ?? null;
  }

  async describe(kind: AiKind): Promise<AiEndpoint> {
    const own = await this.saved(kind);
    if (own) {
      const at = await this.reach(kind, own.provider);
      return {
        ...own,
        baseUrl: at?.baseUrl ?? '',
        hasKey: !!at?.apiKey,
        source: 'settings',
        gone: !at,
      };
    }
    const env = this.ctx.config.aiEndpoints[kind];
    if (env)
      return {
        provider: '',
        baseUrl: env.baseUrl,
        model: env.model,
        voice: env.voice,
        hasKey: !!env.apiKey,
        source: 'env',
        gone: false,
      };
    return { provider: '', baseUrl: '', model: '', voice: '', hasKey: false, source: 'none', gone: false };
  }

  async all(): Promise<AiEndpoints> {
    const out = {} as AiEndpoints;
    for (const kind of AI_KINDS) out[kind] = await this.describe(kind);
    return out;
  }

  async set(kind: AiKind, raw: SetInput): Promise<AiEndpoint> {
    const input = AiEndpointSet.parse(raw);
    const before = await this.get(kind);
    let provider: string;
    if ('provider' in input) {
      provider = input.provider;
    } else {
      // An app that still sends an address and key: they are filed under Providers like old ones.
      // A key left out stays the one the service had.
      const current = await this.saved(kind);
      const key = input.apiKey ?? (current ? ((await this.reach(kind, current.provider))?.apiKey ?? '') : '');
      provider = await this.adopt(input.baseUrl, key);
    }
    if (!(await this.reach(kind, provider))) throw new HttpError(400, 'error.aiProvider');
    await this.write(KEY(kind), { provider, model: input.model, voice: input.voice });
    const after = await this.get(kind);
    this.changed(kind, before?.baseUrl !== after?.baseUrl || before?.model !== after?.model);
    return this.describe(kind);
  }

  /** Forgets the settings' service; the environment's, if any, takes over. */
  async clear(kind: AiKind): Promise<AiEndpoint> {
    await this.ready();
    await this.ctx.db.delete(schema.kv).where(eq(schema.kv.key, KEY(kind)));
    this.changed(kind, true);
    return this.describe(kind);
  }

  /** `moved`: the address or model changed, so what was made with the old one is made again. */
  private changed(kind: AiKind, moved: boolean) {
    this.ctx.bus.refresh({ scope: 'info' });
    if (moved) for (const fn of this.listeners) fn(kind);
  }
}

/** Headers for a call to an OpenAI-compatible service; a local server without a key gets none. */
export const authHeaders = (s: AiService): Record<string, string> =>
  !s.apiKey
    ? {}
    : elevenLabs(s.baseUrl)
      ? { 'xi-api-key': s.apiKey }
      : googleSpeech(s.baseUrl)
        ? { 'x-goog-api-key': s.apiKey }
        : { authorization: `Bearer ${s.apiKey}` };

/** What a service said went wrong: OpenAI's `error`, or the `detail` of Whisper servers and ElevenLabs. */
export function serviceError(body: unknown, status: number): string {
  const b = body as {
    error?: { message?: unknown } | string;
    detail?: { message?: unknown } | string;
  } | null;
  if (typeof b?.error === 'string') return b.error;
  if (typeof b?.error?.message === 'string') return b.error.message;
  if (typeof b?.detail === 'string') return b.detail;
  if (typeof b?.detail?.message === 'string') return b.detail.message;
  return String(status);
}

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
