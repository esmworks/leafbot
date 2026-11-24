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

/** One service as the app sees it: never its key. */
export const AiEndpoint = z.object({
  baseUrl: z.string(),
  model: z.string(),
  /** The voice speech is read in (text to speech only). */
  voice: z.string(),
  hasKey: z.boolean(),
  /** Where it comes from: the settings, the server's environment, or nowhere (off). */
  source: z.enum(['settings', 'env', 'none']),
});
export type AiEndpoint = z.infer<typeof AiEndpoint>;
export type AiEndpoints = Record<AiKind, AiEndpoint>;

export const AiEndpointSet = z.object({
  baseUrl: AiBaseUrl,
  model: z.string().trim().min(1).max(200),
  voice: z.string().trim().max(100).default(''),
  /** A new key; left out keeps the saved one, empty removes it. */
  apiKey: z.string().max(4000).optional(),
});
export type AiEndpointSet = z.input<typeof AiEndpointSet>;
