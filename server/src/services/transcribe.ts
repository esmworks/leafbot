import type { Locale } from '@leafbot/shared';
import { HttpError } from '../util';
import { askService, authHeaders, type AiEndpointService } from './ai-endpoints';
import type { ProviderKeyService } from './keys';

/**
 * Speech to text for the message box and for voice notes from chat apps: through the service set in
 * the settings or the server's environment (a Whisper server of the person's own), else through a
 * provider whose key the person already saved: OpenAI first, then Groq. The recording goes from the
 * server to that service and nowhere else; nothing is kept.
 */
const SERVICES = [
  {
    provider: 'openai',
    url: 'https://api.openai.com/v1/audio/transcriptions',
    model: 'gpt-4o-mini-transcribe',
  },
  {
    provider: 'groq',
    url: 'https://api.groq.com/openai/v1/audio/transcriptions',
    model: 'whisper-large-v3-turbo',
  },
] as const;
/** The providers take at most 25 MB; a minute of speech is well under 1 MB. */
export const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

/** A file name the provider reads the format from. */
function fileName(type: string): string {
  const sub = type.split(';')[0]!.split('/')[1] ?? 'webm';
  const ext =
    sub === 'mpeg' ? 'mp3' : sub === 'x-m4a' || sub === 'mp4' ? 'm4a' : sub.replace(/[^a-z0-9]/g, '');
  return `speech.${ext || 'webm'}`;
}

/** Half a second of silence as a WAV file, to try a service with. */
function silence(): Buffer {
  const rate = 16_000;
  const samples = rate / 2;
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples * 2, 40);
  return b;
}

export class TranscribeService {
  constructor(
    private keys: ProviderKeyService,
    private ai?: AiEndpointService,
    private fetcher: typeof fetch = fetch,
  ) {}

  private async service(): Promise<{ url: string; model: string; headers: Record<string, string> } | null> {
    const own = await this.ai?.get('stt');
    if (own)
      return { url: `${own.baseUrl}/audio/transcriptions`, model: own.model, headers: authHeaders(own) };
    for (const s of SERVICES) {
      const key = await this.keys.get(s.provider);
      if (key) return { url: s.url, model: s.model, headers: { authorization: `Bearer ${key}` } };
    }
    return null;
  }

  /** Whether the server can turn speech into text: a service is set, or some provider has a key. */
  async available(): Promise<boolean> {
    return !!(await this.service());
  }

  async transcribe(audio: Buffer, type: string, locale?: Locale): Promise<string> {
    const s = await this.service();
    if (!s) throw new HttpError(409, 'error.transcribeNone');
    if (!audio.length) throw new HttpError(400, 'error.transcribeEmpty');
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type }), fileName(type));
    form.append('model', s.model);
    if (locale) form.append('language', locale);
    const res = await askService(
      this.fetcher,
      s.url,
      { method: 'POST', headers: s.headers, body: form },
      { unreachable: 'error.transcribeUnreachable', timeout: 'error.transcribeTimeout' },
      TIMEOUT_MS,
    );
    const body = (await res.json().catch(() => null)) as {
      text?: unknown;
      error?: { message?: string } | string;
      detail?: unknown;
    } | null;
    if (!res.ok || typeof body?.text !== 'string') {
      const message =
        typeof body?.error === 'string'
          ? body.error
          : (body?.error?.message ?? (typeof body?.detail === 'string' ? body.detail : String(res.status)));
      throw new HttpError(502, 'error.transcribeFailed', { message });
    }
    return body.text.trim();
  }

  /** Tries the service with half a second of silence; what it heard, usually nothing. */
  async test(): Promise<string> {
    return this.transcribe(silence(), 'audio/wav');
  }
}
