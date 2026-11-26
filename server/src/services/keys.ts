import { eq, like } from 'drizzle-orm';
import type { Model, ModelAuth, OpenAICompletionsCompat } from '@earendil-works/pi-ai';
import { getModels, getProviders } from '@earendil-works/pi-ai/compat';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';
import {
  EFFORTS,
  elevenLabs,
  googleSpeech,
  type CustomEndpointCreate,
  type CustomEndpointUpdate,
  type Effort,
  type ModelInfo,
  type ProviderInfo,
} from '@leafbot/shared';
import type { Ctx } from '../context';
import { schema } from '../db';
import { HttpError } from '../util';
import type { CatalogModel, ModelCatalogService } from './model-catalog';
import type { SubscriptionService } from './subscriptions';
import type { VaultService } from './vault';

const PREFIX = 'secret.apikey.';
const ENDPOINTS = 'custom.endpoints';
/** Ids of the person's own endpoints; no built-in provider starts this way. */
export const CUSTOM_PREFIX = 'custom-';
/** Sent as the key to an endpoint saved without one; local servers ignore it. */
const NO_KEY = 'none';
/** A model list that takes longer than this counts as unreachable. */
const LIST_TIMEOUT = 15_000;
/**
 * Not offered: providers that sign in with a subscription, and ones that need cloud
 * credentials or an account endpoint besides a key.
 */
const NO_API_KEY = new Set([
  'github-copilot',
  'openai-codex',
  'amazon-bedrock',
  'google-vertex',
  'azure',
  'cloudflare-ai-gateway',
  'cloudflare-workers-ai',
]);

/** An OpenAI-compatible server the person runs or pays for, such as Ollama or LM Studio. */
interface CustomEndpoint {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  /** What the server said about each model, when it said anything. */
  meta?: Record<string, ModelMeta>;
}

/** Limits a model list may give: OpenRouter, vLLM and models.dev-style gateways do. */
export interface ModelMeta {
  contextWindow?: number;
  maxTokens?: number;
  images?: boolean;
  /** False for a model that cannot use tools (an Ollama model built without them). */
  tools?: boolean;
}

const posInt = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined);

/** A model entry of a `/models` list read for its limits, under the names servers use for them. */
export function modelMeta(raw: Record<string, unknown>): ModelMeta {
  const top = (raw.top_provider ?? {}) as Record<string, unknown>;
  const limit = (raw.limit ?? {}) as Record<string, unknown>;
  const arch = (raw.architecture ?? {}) as Record<string, unknown>;
  const inputs = [
    ...(Array.isArray(arch.input_modalities) ? arch.input_modalities : []),
    ...(Array.isArray((raw.modalities as Record<string, unknown> | undefined)?.input)
      ? ((raw.modalities as Record<string, unknown>).input as unknown[])
      : []),
  ];
  const meta: ModelMeta = {
    contextWindow:
      posInt(raw.context_length) ??
      posInt(raw.max_model_len) ??
      posInt(raw.context_window) ??
      posInt(limit.context),
    maxTokens: posInt(top.max_completion_tokens) ?? posInt(raw.max_output_tokens) ?? posInt(limit.output),
    images: inputs.includes('image') || undefined,
  };
  return Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined)) as ModelMeta;
}

/** OpenAI-compatible servers people run on their own computer, at their usual addresses. */
export const LOCAL_SERVERS = [
  { name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  { name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
  { name: 'Jan', baseUrl: 'http://127.0.0.1:1337/v1' },
  { name: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080/v1' },
  { name: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1' },
] as const;
/** A local server answers at once or not at all. */
const PROBE_TIMEOUT = 1_500;

/** `https://host/v1/` → `https://host/v1`; null for anything but an http(s) address. */
export function endpointUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** An address that only speaks or listens, and is saved without a list of chat models. */
export const speechOnly = (baseUrl: string) => elevenLabs(baseUrl) || googleSpeech(baseUrl);

/**
 * Whether a key may be sent to this address: over https, or over plain http only to this computer.
 * Anywhere else a plain-http request carries the key readable to everyone on the way.
 */
export function keySafeAt(baseUrl: string): boolean {
  const url = new URL(baseUrl);
  if (url.protocol === 'https:') return true;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

/**
 * API keys for the Pi engine, sealed with the vault key. Kept server-side only: the API returns
 * a short hint, no app tool reads them, and the engine passes a key only to its own provider.
 */
export class ProviderKeyService {
  constructor(
    private ctx: Ctx,
    private vault: VaultService,
    private fetcher: typeof fetch = fetch,
    /** Sign-ins with the person's own plan (ChatGPT, Copilot), besides keys. */
    private plans?: SubscriptionService,
    /** Names, thinking and limits the engine's list lacks, and models released since. */
    private catalog?: ModelCatalogService,
  ) {}

  /** The providers the engine has a model list for, keys or not; what the catalog is kept for. */
  builtIn(): string[] {
    return (getProviders() as string[]).filter((p) => !NO_API_KEY.has(p));
  }

  private async endpoints(): Promise<CustomEndpoint[]> {
    const [row] = await this.ctx.db.select().from(schema.kv).where(eq(schema.kv.key, ENDPOINTS)).limit(1);
    return Array.isArray(row?.value) ? (row.value as CustomEndpoint[]) : [];
  }

  private async saveEndpoints(list: CustomEndpoint[]) {
    await this.ctx.db
      .insert(schema.kv)
      .values({ key: ENDPOINTS, value: list })
      .onConflictDoUpdate({ target: schema.kv.key, set: { value: list } });
    this.ctx.bus.refresh({ scope: 'info' });
  }

  private async endpoint(id: string): Promise<CustomEndpoint | undefined> {
    return id.startsWith(CUSTOM_PREFIX) ? (await this.endpoints()).find((e) => e.id === id) : undefined;
  }

  /** The person's own endpoint by id, for services that call it directly (speech, pictures). */
  async customEndpoint(
    id: string,
  ): Promise<{ id: string; name: string; baseUrl: string; models: string[] } | null> {
    const e = await this.endpoint(id);
    return e ? { id: e.id, name: e.name, baseUrl: e.baseUrl, models: e.models } : null;
  }

  async customEndpoints(): Promise<{ id: string; name: string; baseUrl: string; models: string[] }[]> {
    return (await this.endpoints()).map((e) => ({
      id: e.id,
      name: e.name,
      baseUrl: e.baseUrl,
      models: e.models,
    }));
  }

  /**
   * Files an address that already serves speech or memory search, with its key, as an endpoint of
   * the person's own: what a service set with its own address and key becomes, so every key lives
   * under Providers. The address was checked where it was first saved; it lists no chat models.
   */
  async adoptEndpoint(name: string, baseUrl: string, key: string): Promise<string> {
    const list = await this.endpoints();
    const id = uniqueId(name, new Set(list.map((e) => e.id)));
    await this.saveEndpoints([...list, { id, name: name.trim().slice(0, 60), baseUrl, models: [] }]);
    if (key) await this.store(id, key);
    return id;
  }

  /** Saves a key for a built-in provider that has none yet, as a service's own key moves here. */
  async adoptKey(provider: string, key: string) {
    if (!this.builtIn().includes(provider)) throw new HttpError(404, 'error.unknownProvider');
    await this.store(provider, key);
    this.ctx.bus.refresh({ scope: 'info' });
  }

  async providers(): Promise<string[]> {
    const plans = (this.plans?.providers() ?? []).filter((p) => !this.builtIn().includes(p));
    return [...this.builtIn(), ...plans, ...(await this.endpoints()).map((e) => e.id)];
  }

  private async check(provider: string) {
    if (!(await this.providers()).includes(provider)) throw new HttpError(404, 'error.unknownProvider');
  }

  async list(): Promise<ProviderInfo[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.kv)
      .where(like(schema.kv.key, `${PREFIX}%`));
    const hints = new Map(rows.map((r) => [r.key.slice(PREFIX.length), hint(this.unseal(String(r.value)))]));
    const plans = this.plans?.providers() ?? [];
    const signedIn = new Set<string>();
    for (const p of plans) if (await this.plans!.signedIn(p)) signedIn.add(p);
    const signIn = (id: string) => (plans.includes(id) ? { signIn: { signedIn: signedIn.has(id) } } : {});
    return [
      ...this.builtIn().map((id) => ({
        id,
        configured: hints.has(id) || signedIn.has(id),
        hint: hints.get(id) ?? null,
        ...signIn(id),
      })),
      // A plan whose provider takes no key (Copilot) is listed for its sign-in alone.
      ...plans
        .filter((id) => !this.builtIn().includes(id))
        .map((id) => ({ id, configured: signedIn.has(id), hint: null, ...signIn(id) })),
      ...(await this.endpoints()).map((e) => ({
        id: e.id,
        // Usable without a key: a local server needs none.
        configured: true,
        hint: hints.get(e.id) ?? null,
        custom: { name: e.name, baseUrl: e.baseUrl },
      })),
    ];
  }

  async models(provider: string): Promise<string[]> {
    await this.check(provider);
    const custom = await this.endpoint(provider);
    if (custom) return custom.models;
    const ids = (getModels(provider as never) as { id: string }[]).map((m) => m.id);
    // A Copilot plan opens only some models; without a key those are the ones offered.
    const open = !(await this.get(provider)) ? await this.plans?.availableModels(provider) : null;
    return open ? ids.filter((id) => open.has(id)) : ids;
  }

  /**
   * The provider's models as the model picker shows them, newest first: the engine's list, with the
   * names and dates the catalog gives, and the chat models the catalog lists that the engine's list
   * does not have yet. Thinking levels are the ones the engine will send for each model.
   */
  async modelInfo(provider: string): Promise<ModelInfo[]> {
    await this.check(provider);
    const custom = await this.endpoint(provider);
    if (custom) {
      return custom.models.map((id) => ({
        id,
        name: id,
        efforts: [],
        images: custom.meta?.[id]?.images === true,
        contextWindow: custom.meta?.[id]?.contextWindow ?? null,
        released: null,
      }));
    }
    const listed = getModels(provider as never) as Model<string>[];
    const dev = (await this.catalog?.provider(provider))?.models ?? {};
    const known = new Set(listed.map((m) => m.id));
    const extra = Object.entries(dev)
      .filter(([id, m]) => !known.has(id) && m.chat && m.tools && !m.deprecated)
      .map(([id, m]) => withCatalog(unlistedModel(listed, id), m))
      .filter((m): m is Model<string> => !!m);
    const info = [...listed, ...extra].map((m) => ({
      id: m.id,
      name: dev[m.id]?.name || m.name || m.id,
      efforts: modelEfforts(m),
      images: m.input.includes('image'),
      contextWindow: m.contextWindow || null,
      released: dev[m.id]?.released ?? null,
    }));
    // A Copilot plan opens only some models; without a key those are the ones offered.
    const open = !(await this.get(provider)) ? await this.plans?.availableModels(provider) : null;
    const shown = open ? info.filter((m) => open.has(m.id)) : info;
    // Newest first; a model of unknown date keeps its place after the dated ones.
    return shown
      .map((m, i) => ({ m, i }))
      .sort((a, b) =>
        a.m.released && b.m.released
          ? b.m.released.localeCompare(a.m.released) || a.i - b.i
          : a.m.released
            ? -1
            : b.m.released
              ? 1
              : a.i - b.i,
      )
      .map(({ m }) => m);
  }

  /** A stored key in the clear. One saved before keys were sealed is sealed on the way. */
  async get(provider: string): Promise<string | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.kv)
      .where(eq(schema.kv.key, PREFIX + provider))
      .limit(1);
    if (!row) return null;
    const stored = String(row.value);
    const key = this.unseal(stored);
    if (key === stored) await this.store(provider, key);
    return key;
  }

  /** The key the engine sends: the stored one, or a stand-in for an endpoint that takes none. */
  async credential(provider: string): Promise<string | null> {
    const key = await this.get(provider);
    if (key) return key;
    return (await this.endpoint(provider)) ? NO_KEY : null;
  }

  /** Whether `auth` has something for the provider, read from what is kept, without refreshing a sign-in. */
  async hasAuth(provider: string): Promise<boolean> {
    if (await this.get(provider)) return true;
    if (await this.plans?.signedIn(provider)) return true;
    return !!(await this.endpoint(provider));
  }

  /**
   * What the engine's requests to a provider carry: a saved key first, then a sign-in with the
   * person's plan (with the address it gives), then the stand-in for an endpoint that takes none.
   */
  async auth(provider: string): Promise<ModelAuth | null> {
    const key = await this.get(provider);
    if (key) return { apiKey: key };
    const plan = await this.plans?.auth(provider);
    if (plan?.apiKey) return plan;
    return (await this.endpoint(provider)) ? { apiKey: NO_KEY } : null;
  }

  private unseal(value: string): string {
    if (!value.startsWith('v1:')) return value;
    try {
      return this.vault.open(value);
    } catch {
      // A key sealed with a vault key that is gone cannot be read; it reads as no key.
      return '';
    }
  }

  private async store(provider: string, key: string) {
    const value = this.vault.seal(key);
    await this.ctx.db
      .insert(schema.kv)
      .values({ key: PREFIX + provider, value })
      .onConflictDoUpdate({ target: schema.kv.key, set: { value } });
  }

  /** A provider that takes a key: a built-in one or the person's endpoint, not a plan alone. */
  private async checkKey(provider: string) {
    if (!this.builtIn().includes(provider) && !(await this.endpoint(provider))) {
      throw new HttpError(404, 'error.unknownProvider');
    }
  }

  async set(provider: string, key: string) {
    await this.checkKey(provider);
    const value = key.trim();
    if (value.length < 8) throw new HttpError(400, 'error.keyTooShort');
    // Subscription tokens are never used through this path.
    if (value.startsWith('sk-ant-oat')) {
      throw new HttpError(400, 'error.subscriptionToken');
    }
    await this.store(provider, value);
    this.ctx.bus.refresh({ scope: 'info' });
  }

  async remove(provider: string) {
    await this.check(provider);
    await this.ctx.db.delete(schema.kv).where(eq(schema.kv.key, PREFIX + provider));
    this.ctx.bus.refresh({ scope: 'info' });
  }

  /** Saves an endpoint after asking it for its models; one that cannot list them needs them named. */
  async addEndpoint(input: CustomEndpointCreate): Promise<ProviderInfo> {
    const baseUrl = endpointUrl(input.baseUrl);
    if (!baseUrl) throw new HttpError(400, 'error.endpointUrl');
    const key = input.key?.trim() || null;
    if (key && !keySafeAt(baseUrl)) throw new HttpError(400, 'error.endpointKeyHttp');
    const listed = speechOnly(baseUrl)
      ? { ids: [], meta: {} }
      : await this.readModels(baseUrl, key).catch((err: Error) => err);
    const models = input.models?.length ? input.models : listed instanceof Error ? [] : listed.ids;
    // ElevenLabs and Google's speech API list no chat models: they are saved for speech alone.
    if (!models.length && !speechOnly(baseUrl)) {
      throw new HttpError(400, 'error.endpointModels', {
        message: listed instanceof Error ? listed.message : '',
      });
    }
    const list = await this.endpoints();
    const id = uniqueId(input.name, new Set(list.map((e) => e.id)));
    const meta = listed instanceof Error ? undefined : listed.meta;
    await this.saveEndpoints([...list, { id, name: input.name.trim(), baseUrl, models, meta }]);
    if (key) await this.store(id, key);
    return (await this.list()).find((p) => p.id === id)!;
  }

  /**
   * Renames an endpoint, moves it to another address, gives it a new key or a new model list.
   * A new address must list its models; an empty key or model list keeps the saved one. A model
   * list given here wins over what a new address lists, so a model the server leaves out can be
   * named by hand.
   */
  async updateEndpoint(id: string, patch: CustomEndpointUpdate): Promise<ProviderInfo> {
    const list = await this.endpoints();
    const e = list.find((x) => x.id === id);
    if (!e) throw new HttpError(404, 'error.unknownProvider');
    const key = patch.key?.trim() || null;
    const next = { ...e, ...(patch.name?.trim() ? { name: patch.name.trim() } : {}) };
    if (patch.baseUrl !== undefined) {
      const baseUrl = endpointUrl(patch.baseUrl);
      if (!baseUrl) throw new HttpError(400, 'error.endpointUrl');
      if ((key ?? (await this.get(id))) && !keySafeAt(baseUrl)) {
        throw new HttpError(400, 'error.endpointKeyHttp');
      }
      if (baseUrl !== e.baseUrl) {
        let read: { ids: string[]; meta: Record<string, ModelMeta> };
        try {
          read = await this.readModels(baseUrl, key ?? (await this.get(id)));
        } catch (err) {
          throw new HttpError(400, 'error.endpointModels', { message: (err as Error).message });
        }
        Object.assign(next, { baseUrl, ...(read.ids.length ? { models: read.ids, meta: read.meta } : {}) });
      }
    }
    const models = [...new Set(patch.models ?? [])];
    if (models.length) next.models = models;
    await this.saveEndpoints(list.map((x) => (x.id === id ? next : x)));
    if (key) await this.store(id, key);
    return (await this.list()).find((p) => p.id === id)!;
  }

  /** Asks the endpoint for its models again; keeps the old list if it cannot answer. */
  async refreshEndpoint(id: string): Promise<string[]> {
    const list = await this.endpoints();
    const e = list.find((x) => x.id === id);
    if (!e) throw new HttpError(404, 'error.unknownProvider');
    let read: { ids: string[]; meta: Record<string, ModelMeta> };
    try {
      read = await this.readModels(e.baseUrl, await this.get(id));
    } catch (err) {
      throw new HttpError(502, 'error.endpointModels', { message: (err as Error).message });
    }
    const models = read.ids;
    if (models.length) {
      await this.saveEndpoints(list.map((x) => (x.id === id ? { ...x, models, meta: read.meta } : x)));
    }
    return models.length ? models : e.models;
  }

  async removeEndpoint(id: string) {
    const list = await this.endpoints();
    if (!list.some((e) => e.id === id)) throw new HttpError(404, 'error.unknownProvider');
    await this.ctx.db.delete(schema.kv).where(eq(schema.kv.key, PREFIX + id));
    await this.saveEndpoints(list.filter((e) => e.id !== id));
  }

  /**
   * Model servers answering at their usual address on the server's computer, with their models,
   * leaving out the ones already saved. Nothing is sent but a request for the model list.
   */
  async discover(
    candidates: readonly { name: string; baseUrl: string }[] = LOCAL_SERVERS,
  ): Promise<{ name: string; baseUrl: string; models: string[] }[]> {
    const saved = new Set((await this.endpoints()).map((e) => e.baseUrl.replace('localhost', '127.0.0.1')));
    const found = await Promise.all(
      candidates
        .filter((c) => !saved.has(c.baseUrl))
        .map(async (c) => {
          const models = await this.listModels(c.baseUrl, null, PROBE_TIMEOUT).catch(() => null);
          return models?.length ? { ...c, models } : null;
        }),
    );
    return found.filter((f) => f !== null);
  }

  /** The `/models` list every OpenAI-compatible server offers. */
  private async listModels(baseUrl: string, key: string | null, timeout = LIST_TIMEOUT): Promise<string[]> {
    return (await this.readModels(baseUrl, key, timeout)).ids;
  }

  /** The model ids of the list, and what it says about each one's limits. */
  private async readModels(
    baseUrl: string,
    key: string | null,
    timeout = LIST_TIMEOUT,
  ): Promise<{ ids: string[]; meta: Record<string, ModelMeta> }> {
    const res = await this.fetcher(`${baseUrl}/models`, {
      headers: { accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      signal: AbortSignal.timeout(timeout),
      redirect: 'error',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: Record<string, unknown>[] };
    const meta: Record<string, ModelMeta> = {};
    const ids: string[] = [];
    for (const m of Array.isArray(body.data) ? body.data : []) {
      const id = m?.id;
      if (typeof id !== 'string' || !id || id.length > 200) continue;
      ids.push(id);
      const known = modelMeta(m);
      if (Object.keys(known).length) meta[id] = known;
    }
    const ollama = await this.ollamaModels(baseUrl, ids, timeout);
    if (ollama) {
      // Ollama says what each model can do: embedding-only ones are not chat models at all.
      for (const [id, caps] of ollama) {
        if (!caps.includes('completion')) {
          ids.splice(ids.indexOf(id), 1);
          delete meta[id];
          continue;
        }
        meta[id] = { ...meta[id], tools: caps.includes('tools'), images: caps.includes('vision') };
      }
    }
    return { ids: [...new Set(ids)].sort((a, b) => a.localeCompare(b)), meta };
  }

  /**
   * What each model of an Ollama server can do (completion, tools, vision, embedding), when the
   * endpoint is one; null for any other server.
   */
  private async ollamaModels(baseUrl: string, ids: string[], timeout: number) {
    // Ollama serves plain http on the person's own machine or network; hosted providers are not asked.
    if (!baseUrl.startsWith('http://')) return null;
    const root = baseUrl.replace(/\/v1$/, '');
    const ask = (path: string, init?: RequestInit) =>
      this.fetcher(`${root}${path}`, { ...init, signal: AbortSignal.timeout(timeout), redirect: 'error' });
    const version = await ask('/api/version').catch(() => null);
    if (!version?.ok) return null;
    const v = (await version.json().catch(() => null)) as { version?: unknown } | null;
    if (typeof v?.version !== 'string') return null;
    const out = new Map<string, string[]>();
    for (const id of ids.slice(0, 50)) {
      const res = await ask('/api/show', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: id }),
      }).catch(() => null);
      const caps = res?.ok
        ? ((await res.json().catch(() => null)) as { capabilities?: unknown } | null)
        : null;
      if (Array.isArray(caps?.capabilities))
        out.set(
          id,
          caps.capabilities.filter((c) => typeof c === 'string'),
        );
    }
    return out;
  }

  /** Whether a model on one of the person's endpoints takes tools; unknown counts as yes. */
  async takesTools(provider: string, id: string): Promise<boolean> {
    const e = await this.endpoint(provider);
    return e?.meta?.[id]?.tools !== false;
  }

  /**
   * A model the catalog does not describe, for the engine: one on the person's endpoints, or one
   * a built-in provider serves but the catalog does not list yet. For an endpoint, what the server
   * does not say is assumed: chat completions, text in, a modest context.
   */
  async customModel(provider: string, id: string): Promise<Model<string> | undefined> {
    const e = await this.endpoint(provider);
    if (!e) {
      if (!this.builtIn().includes(provider)) return undefined;
      const base = unlistedModel(getModels(provider as never) as Model<string>[], id);
      const dev = (await this.catalog?.provider(provider))?.models[id];
      return dev ? withCatalog(base, dev) : base;
    }
    // The client's types tie `compat` to one api, which the generic model type cannot name; the
    // client reads it all the same.
    return {
      id,
      name: id,
      ...endpointApi(e.baseUrl),
      provider: e.id,
      baseUrl: e.baseUrl,
      reasoning: false,
      input: e.meta?.[id]?.images ? ['text', 'image'] : ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: e.meta?.[id]?.contextWindow ?? 128_000,
      maxTokens: Math.min(
        e.meta?.[id]?.maxTokens ?? 8_192,
        // Room for the input in a small window.
        Math.max(1_024, Math.floor((e.meta?.[id]?.contextWindow ?? 128_000) / 4)),
      ),
    } as Model<string>;
  }
}

/**
 * How a model on a custom endpoint is reached. OpenAI's own server takes the Responses API, which
 * its newer models need. Any other server is only known to speak chat completions, and the
 * client's guesses for OpenAI-only fields are turned off for it: a stricter server answers an
 * unknown `store` or the `developer` role with an error and the turn fails at once.
 */
export function endpointApi(
  baseUrl: string,
): { api: 'openai-responses' } | { api: 'openai-completions'; compat: OpenAICompletionsCompat } {
  let host = '';
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    // An address that does not parse is treated like any other server.
  }
  if (host === 'api.openai.com') return { api: 'openai-responses' };
  return {
    api: 'openai-completions',
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: 'max_tokens',
    },
  };
}

/**
 * A model a built-in provider serves but the catalog does not list, such as one released after
 * this version. It borrows the API, address and limits of the listed model whose id starts most
 * like it (`gpt-6.2` takes after `gpt-6.1-sol`), since one provider may serve model families
 * through different APIs. Its price is unknown and counted as nothing.
 */
export function unlistedModel(listed: readonly Model<string>[], id: string): Model<string> | undefined {
  let best: Model<string> | undefined;
  let shared = -1;
  for (const m of listed) {
    let n = 0;
    while (n < m.id.length && n < id.length && m.id[n] === id[n]) n++;
    if (n > shared) [best, shared] = [m, n];
  }
  if (!best) return undefined;
  return { ...best, id, name: id, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}

/**
 * An unlisted model with what the catalog knows of it: its name, whether it thinks, what it takes
 * in, its limits and its price. How it is reached (API, address) stays the borrowed model's.
 */
export function withCatalog(base: Model<string> | undefined, m: CatalogModel): Model<string> | undefined {
  if (!base) return undefined;
  const contextWindow = m.contextWindow ?? base.contextWindow;
  return {
    ...base,
    name: m.name,
    reasoning: m.reasoning,
    input: m.images ? ['text', 'image'] : ['text'],
    contextWindow,
    maxTokens: Math.min(m.maxTokens ?? base.maxTokens, contextWindow),
    ...(m.cost && { cost: m.cost }),
  };
}

/** The thinking levels the engine sends for this model, in the app's own words. */
export function modelEfforts(m: Model<string>): Effort[] {
  if (!m.reasoning) return [];
  const levels = new Set<string>(getSupportedThinkingLevels(m));
  return EFFORTS.filter((e) => levels.has(e));
}

function hint(key: string) {
  return key.length > 8 ? `…${key.slice(-4)}` : '…';
}

function uniqueId(name: string, taken: Set<string>): string {
  const base =
    CUSTOM_PREFIX +
    (name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'endpoint');
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}
