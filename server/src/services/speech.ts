import { DEFAULT_LOCALE, elevenLabs, googleSpeech, type Locale } from '@leafbot/shared';
import { HttpError } from '../util';
import {
  askService,
  authHeaders,
  serviceError,
  type AiEndpointService,
  type AiService,
} from './ai-endpoints';

/** Text read in one request; a longer reply is read in its first part. */
export const MAX_SPEECH_CHARS = 4000;
/** Google takes at most 4,000 bytes of text in one request for its Gemini voices; Turkish letters take two. */
const GOOGLE_MAX_BYTES = 4000;

/** The text cut to whole characters that fit in `max` bytes of UTF-8. */
function fitBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  let out = '';
  let size = 0;
  for (const ch of text) {
    size += Buffer.byteLength(ch);
    if (size > max) break;
    out += ch;
  }
  return out;
}

/**
 * The language Google reads in: a Chirp 3 HD voice names it (`tr-TR-Chirp3-HD-Kore`), a Gemini voice
 * (`Kore`) does not, so it comes from the person's language, with its usual region (`tr` → `tr-TR`).
 */
function googleLanguage(voice: string, locale: Locale): string {
  const named = /^([a-z]{2,3}-[A-Z]{2})-/.exec(voice);
  if (named) return named[1]!;
  const full = new Intl.Locale(locale).maximize();
  return full.region ? `${full.language}-${full.region}` : full.language;
}
const TIMEOUT_MS = 120_000;

/**
 * Text to speech through the service set in the settings or the server's environment: an
 * OpenAI-compatible one (OpenAI, or a speech server of the person's own such as Kokoro), ElevenLabs,
 * or Google Cloud Text-to-Speech. The browser's own voices stand in when none is set; their Turkish
 * is often poor or missing.
 */
export class SpeechService {
  constructor(
    private ai: AiEndpointService,
    private fetcher: typeof fetch = fetch,
  ) {}

  async available(): Promise<boolean> {
    return !!(await this.ai.get('tts'));
  }

  /** The text read aloud, as MP3, in the person's language where the service needs telling. */
  async speak(text: string, locale: Locale = DEFAULT_LOCALE): Promise<{ audio: Buffer; type: string }> {
    const s = await this.ai.get('tts');
    if (!s) throw new HttpError(409, 'error.speechNone');
    const input = text.trim().slice(0, MAX_SPEECH_CHARS);
    if (!input) throw new HttpError(400, 'error.speechEmpty');
    if (googleSpeech(s.baseUrl)) return this.google(s, input, locale);
    // ElevenLabs names the voice in the address and has no default one; OpenAI's shape falls back to
    // its first voice.
    const eleven = elevenLabs(s.baseUrl);
    if (eleven && !s.voice) throw new HttpError(400, 'error.speechVoiceId');
    const [url, body] = eleven
      ? [
          `${s.baseUrl}/text-to-speech/${encodeURIComponent(s.voice)}?output_format=mp3_44100_128`,
          { text: input, model_id: s.model },
        ]
      : [
          `${s.baseUrl}/audio/speech`,
          { model: s.model, input, voice: s.voice || 'alloy', response_format: 'mp3' },
        ];
    const res = await askService(
      this.fetcher,
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(s) },
        body: JSON.stringify(body),
      },
      { unreachable: 'error.speechUnreachable', timeout: 'error.speechTimeout' },
      TIMEOUT_MS,
    );
    if (!res.ok) {
      const failed = (await res.json().catch(() => null)) as unknown;
      throw new HttpError(502, 'error.speechFailed', { message: serviceError(failed, res.status) });
    }
    return {
      audio: Buffer.from(await res.arrayBuffer()),
      type: res.headers.get('content-type')?.split(';')[0] || 'audio/mpeg',
    };
  }

  /**
   * Google's synthesize call: the voice by name (a Chirp 3 HD voice, or a Gemini voice with the Gemini
   * model in `modelName`), MP3 back as base64. Google has no default voice either.
   */
  private async google(s: AiService, text: string, locale: Locale): Promise<{ audio: Buffer; type: string }> {
    if (!s.voice) throw new HttpError(400, 'error.speechVoiceName');
    const voice: Record<string, string> = { languageCode: googleLanguage(s.voice, locale), name: s.voice };
    if (s.model.startsWith('gemini')) voice.modelName = s.model;
    const res = await askService(
      this.fetcher,
      `${s.baseUrl}/text:synthesize`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(s) },
        body: JSON.stringify({
          input: { text: fitBytes(text, GOOGLE_MAX_BYTES) },
          voice,
          audioConfig: { audioEncoding: 'MP3' },
        }),
      },
      { unreachable: 'error.speechUnreachable', timeout: 'error.speechTimeout' },
      TIMEOUT_MS,
    );
    const body = (await res.json().catch(() => null)) as { audioContent?: unknown } | null;
    if (!res.ok || typeof body?.audioContent !== 'string') {
      throw new HttpError(502, 'error.speechFailed', { message: serviceError(body, res.status) });
    }
    return { audio: Buffer.from(body.audioContent, 'base64'), type: 'audio/mpeg' };
  }

  async test(): Promise<{ bytes: number }> {
    const { audio } = await this.speak('Leaf Bot');
    return { bytes: audio.length };
  }
}
