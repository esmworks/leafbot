import { z } from 'zod';

/**
 * A host on this computer or the private network: a service next to the server, such as
 * `ollama` or `whisper` in the same Docker network, or `192.168.1.20`. Plain http to such a host
 * stays off the internet, so a key may go there; anywhere else it must be https.
 */
export function internalHost(raw: string): boolean {
  const host = raw.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    !host.includes('.') ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(host) ||
    host === '::1' ||
    /^f[cd][0-9a-f]{2}:/.test(host)
  );
}

/**
 * ElevenLabs' API, which is not OpenAI-compatible: the server sends it requests in its own shape
 * (an `xi-api-key` header, `model_id`, a voice ID in the address), so speech can use its voices and
 * transcription, the most natural in Turkish, from the same address field as any other service.
 */
export function elevenLabs(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'elevenlabs.io' || host.endsWith('.elevenlabs.io');
  } catch {
    return false;
  }
}

/**
 * Google Cloud Text-to-Speech, also not OpenAI-compatible: its Chirp 3 HD and Gemini voices read
 * Turkish far better than OpenAI's, which are tuned for English, and its free monthly allowance
 * covers one person's spoken replies.
 */
export function googleSpeech(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'texttospeech.googleapis.com' || host.endsWith('-texttospeech.googleapis.com');
  } catch {
    return false;
  }
}

/** The model services the server calls besides the bots' own: memory search and speech. */
export const AI_KINDS = ['embeddings', 'stt', 'tts'] as const;
export type AiKind = (typeof AI_KINDS)[number];

/**
 * An OpenAI-compatible base address (`https://api.openai.com/v1`, `http://ollama:11434/v1`):
 * https, or plain http to a host on this computer or the private network.
 */
export const AiBaseUrl = z
  .string()
  .trim()
  .transform((v, ctx) => {
    try {
      const url = new URL(v);
      if (
        !url.username &&
        !url.password &&
        (url.protocol === 'https:' || (url.protocol === 'http:' && internalHost(url.hostname)))
      ) {
        url.hash = '';
        url.search = '';
        return url.toString().replace(/\/+$/, '');
      }
    } catch {
      // Falls through to the message below.
    }
    ctx.addIssue({ code: 'custom', message: 'validation.apiOrigin' });
    return z.NEVER;
  });

/**
 * The providers whose own API serves each kind in the OpenAI shape, at this address, with the key
 * saved for them under Providers: one key serves the bots and these services alike. Any endpoint of
 * the person's own (a Whisper or Kokoro server, ElevenLabs, Google's speech API) serves every kind.
 */
export const AI_PROVIDER_URLS: Record<AiKind, Record<string, string>> = {
  embeddings: {
    openai: 'https://api.openai.com/v1',
    google: 'https://generativelanguage.googleapis.com/v1beta/openai',
    mistral: 'https://api.mistral.ai/v1',
  },
  stt: {
    openai: 'https://api.openai.com/v1',
    groq: 'https://api.groq.com/openai/v1',
    mistral: 'https://api.mistral.ai/v1',
  },
  tts: {
    openai: 'https://api.openai.com/v1',
  },
};

/**
 * Whether a provider, as Providers lists it, can serve `kind`: an endpoint of the person's own
 * always can; a built-in provider when its API does this and it has a saved key (a plan's sign-in
 * alone does not open these APIs).
 */
export function servesAi(kind: AiKind, p: { id: string; hint: string | null; custom?: unknown }): boolean {
  return !!p.custom || (p.hint !== null && !!AI_PROVIDER_URLS[kind][p.id]);
}

/** The model, and for speech the voice, a provider starts with when it is picked for a kind. */
export const AI_DEFAULT_MODELS: Record<AiKind, Record<string, { model: string; voice?: string }>> = {
  embeddings: {
    openai: { model: 'text-embedding-3-small' },
    google: { model: 'gemini-embedding-001' },
    mistral: { model: 'mistral-embed' },
  },
  stt: {
    openai: { model: 'gpt-4o-mini-transcribe' },
    groq: { model: 'whisper-large-v3-turbo' },
    mistral: { model: 'voxtral-mini-latest' },
  },
  tts: {
    openai: { model: 'gpt-4o-mini-tts', voice: 'alloy' },
  },
};

/** One service as the app sees it: never its key. */
export const AiEndpoint = z.object({
  /**
   * The provider it goes through: a built-in one with a saved key, or an endpoint of the person's
   * own (`custom-…`). Empty when the server's environment names the service, or none does.
   */
  provider: z.string(),
  baseUrl: z.string(),
  model: z.string(),
  /** The voice speech is read in (text to speech only). */
  voice: z.string(),
  hasKey: z.boolean(),
  /** Where it comes from: the settings, the server's environment, or nowhere (off). */
  source: z.enum(['settings', 'env', 'none']),
  /** The chosen provider lost its key or was removed: the service is off until another is picked. */
  gone: z.boolean(),
});
export type AiEndpoint = z.infer<typeof AiEndpoint>;
export type AiEndpoints = Record<AiKind, AiEndpoint>;

const Model = z.string().trim().min(1).max(200);
const Voice = z.string().trim().max(100).default('');

/**
 * A service through a provider. The older shape, an address with its own key, is still taken from
 * apps that send it: the server files that address and key under Providers and points here.
 */
export const AiEndpointSet = z.union([
  z.object({ provider: z.string().trim().min(1).max(100), model: Model, voice: Voice }),
  z.object({
    baseUrl: AiBaseUrl,
    model: Model,
    voice: Voice,
    /** A new key; left out keeps the saved one, empty removes it. */
    apiKey: z.string().max(4000).optional(),
  }),
]);
export type AiEndpointSet = z.input<typeof AiEndpointSet>;
