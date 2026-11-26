import { BodyTooLarge, readCapped } from './read-capped';
import { redactSecrets } from './secrets';
import type { ProviderKeyService } from './keys';

/** The shape the bot asks for; each provider gets it in its own terms. */
export type ImageShape = 'square' | 'landscape' | 'portrait';

/**
 * Providers that turn a prompt into a picture, through a key the person already saved. Both take
 * the same request at `/v1/images/generations` and answer with the image in base64. Each lists only
 * models that take that provider's sizes as written here, so a chosen model never gets a size it
 * refuses; the first is the one used when none is chosen.
 */
const SERVICES = [
  {
    provider: 'openai',
    url: 'https://api.openai.com/v1/images/generations',
    models: [
      { id: 'gpt-image-2', name: 'GPT Image 2' },
      { id: 'gpt-image-1.5', name: 'GPT Image 1.5' },
      { id: 'gpt-image-1-mini', name: 'GPT Image 1 mini' },
    ],
    shape: (s: ImageShape) => ({
      size: { square: '1024x1024', landscape: '1536x1024', portrait: '1024x1536' }[s],
    }),
  },
  {
    provider: 'xai',
    url: 'https://api.x.ai/v1/images/generations',
    models: [{ id: 'grok-imagine-image-2.0', name: 'Grok Imagine 2.0' }],
    shape: (s: ImageShape) => ({
      aspect_ratio: { square: '1:1', landscape: '3:2', portrait: '2:3' }[s],
      response_format: 'b64_json',
    }),
  },
] as const;

export const IMAGE_PROVIDERS: readonly string[] = SERVICES.map((s) => s.provider);

/** A model that makes pictures, as `provider/model`, with the name the app shows. */
export interface ImageModel {
  ref: string;
  provider: string;
  name: string;
  /** The name the person gave their own endpoint; built-in providers are named by the app. */
  providerName?: string;
}

/**
 * Model names that make pictures, as image services name them. An endpoint of the person's own
 * lists every model it serves; these are the ones offered for pictures, called the way OpenAI's are.
 */
const IMAGE_MODEL_NAME =
  /image|dall-?e|flux|imagen|sdxl|stable-diffusion|seedream|recraft|ideogram|hidream|kolors|playground|midjourney/i;

/** Every model offered for pictures, whether or not its provider has a key. */
export const IMAGE_MODELS: readonly ImageModel[] = SERVICES.flatMap((s) =>
  s.models.map((m) => ({ ref: `${s.provider}/${m.id}`, provider: s.provider, name: m.name })),
);

/**
 * How an avatar description becomes a picture: the person says what the bot looks like, and the
 * rest makes it work as a small round picture beside a name.
 */
export function avatarPrompt(description: string): string {
  return [
    `Avatar picture for a chat assistant: ${description.trim()}`,
    'One subject, centred, filling most of a square frame, so it still reads when shown small and cropped to a circle.',
    'Plain or softly blurred background, no text, no letters, no logos, no frame or border.',
  ].join('\n');
}

/** Large enough for a 4K picture; anything bigger is not what was asked for. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Making a picture takes a while; one that takes longer than this has failed. */
const TIMEOUT_MS = 180_000;

/** The picture's format, read from its first bytes rather than from what the provider says. */
export function imageType(data: Buffer): 'png' | 'jpg' | 'webp' | 'gif' | null {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP')
    return 'webp';
  if (data.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  return null;
}

/** Why a picture could not be made, in words the bot passes on. */
export class ImageError extends Error {
  constructor(
    readonly reason: 'noKey' | 'failed' | 'notImage' | 'tooLarge',
    message = '',
    readonly provider = '',
  ) {
    super(message);
  }
}

export interface CreatedImage {
  data: Buffer;
  ext: 'png' | 'jpg' | 'webp' | 'gif';
  provider: string;
  /** `provider/model` that made it. */
  model: string;
}

export class ImageService {
  constructor(
    private keys: ProviderKeyService,
    private fetcher: typeof fetch = fetch,
  ) {}

  /**
   * The provider and model to use: the model the person chose, while its provider still has a key;
   * otherwise the provider the bot already talks to when it can make pictures, so the person pays
   * one account; otherwise the first with a saved key, each with its first model. Only a saved key
   * counts: a plan's sign-in does not open these endpoints.
   */
  private async service(chosen?: string, prefer?: string) {
    const own = await this.ownService(chosen);
    if (own) return own;
    const pick = IMAGE_MODELS.find((m) => m.ref === chosen);
    const first = pick?.provider ?? prefer;
    const order = [...SERVICES].sort((a, b) => Number(b.provider === first) - Number(a.provider === first));
    for (const s of order) {
      const key = await this.keys.get(s.provider);
      if (!key) continue;
      const model = pick?.provider === s.provider ? pick.ref.slice(s.provider.length + 1) : s.models[0].id;
      return { ...s, model, key };
    }
    return null;
  }

  /**
   * A model chosen on an endpoint of the person's own, asked in OpenAI's shape. Only ever the one
   * chosen: when none is, pictures never go to such an endpoint on their own.
   */
  private async ownService(chosen?: string) {
    const slash = chosen?.indexOf('/') ?? -1;
    if (!chosen || slash < 0) return null;
    const e = await this.keys.customEndpoint(chosen.slice(0, slash));
    if (!e) return null;
    return {
      provider: e.name,
      /** What the model is chosen by: the endpoint's id, not the name shown. */
      id: e.id,
      url: `${e.baseUrl}/images/generations`,
      model: chosen.slice(slash + 1),
      key: (await this.keys.get(e.id)) ?? '',
      shape: SERVICES[0].shape,
    };
  }

  async available(chosen?: string): Promise<boolean> {
    return !!(await this.service(chosen));
  }

  /**
   * The models whose provider has a saved key, then the picture models of the person's own
   * endpoints, in the order they are offered.
   */
  async models(): Promise<ImageModel[]> {
    const out: ImageModel[] = [];
    for (const s of SERVICES) {
      if (await this.keys.get(s.provider)) out.push(...IMAGE_MODELS.filter((m) => m.provider === s.provider));
    }
    for (const e of await this.keys.customEndpoints()) {
      for (const id of e.models.filter((m) => IMAGE_MODEL_NAME.test(m))) {
        out.push({ ref: `${e.id}/${id}`, provider: e.id, name: id, providerName: e.name });
      }
    }
    return out;
  }

  async create(
    prompt: string,
    opts: { shape?: ImageShape; model?: string; prefer?: string; signal?: AbortSignal } = {},
  ): Promise<CreatedImage> {
    const s = await this.service(opts.model, opts.prefer);
    if (!s) throw new ImageError('noKey');
    const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(opts.signal ? [opts.signal] : [])]);
    const fail = (message: string): never => {
      // A provider may echo the request back; the key must not reach the bot or the chat.
      throw new ImageError(
        'failed',
        redactSecrets(s.key ? message.replaceAll(s.key, '***') : message, '***').text,
        s.provider,
      );
    };
    let res: Response;
    try {
      res = await this.fetcher(s.url, {
        method: 'POST',
        headers: {
          ...(s.key ? { authorization: `Bearer ${s.key}` } : {}),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: s.model, prompt, n: 1, ...s.shape(opts.shape ?? 'square') }),
        signal,
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      return fail(err instanceof Error ? err.message : String(err));
    }
    const body = (await res.json().catch(() => null)) as {
      data?: { b64_json?: unknown; url?: unknown }[];
      error?: { message?: unknown } | string;
    } | null;
    const first = body?.data?.[0];
    if (!res.ok || !first) {
      const e = body?.error;
      return fail(String((typeof e === 'string' ? e : e?.message) ?? `HTTP ${res.status}`));
    }
    let data: Buffer;
    if (typeof first.b64_json === 'string' && first.b64_json) {
      data = Buffer.from(first.b64_json, 'base64');
    } else if (typeof first.url === 'string' && first.url.startsWith('https://')) {
      // Some answers give an address to fetch the picture from instead of the picture itself.
      const img = await this.fetcher(first.url, { signal }).catch((err: unknown) =>
        fail(err instanceof Error ? err.message : String(err)),
      );
      if (!img.ok) return fail(`HTTP ${img.status}`);
      if (Number(img.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) {
        throw new ImageError('tooLarge', '', s.provider);
      }
      // Counted as it arrives: without a size header the whole body would otherwise be held first.
      try {
        data = await readCapped(img.body, MAX_IMAGE_BYTES);
      } catch (err) {
        if (err instanceof BodyTooLarge) throw new ImageError('tooLarge', '', s.provider);
        if (opts.signal?.aborted) throw err;
        return fail(err instanceof Error ? err.message : String(err));
      }
    } else {
      throw new ImageError('notImage', '', s.provider);
    }
    if (data.length > MAX_IMAGE_BYTES) throw new ImageError('tooLarge', '', s.provider);
    const ext = imageType(data);
    if (!ext) throw new ImageError('notImage', '', s.provider);
    return { data, ext, provider: s.provider, model: `${'id' in s ? s.id : s.provider}/${s.model}` };
  }
}
