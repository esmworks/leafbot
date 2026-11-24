import { elevenLabs } from '@leafbot/shared';
import { HttpError } from '../util';
import { askService, authHeaders, serviceError, type AiEndpointService } from './ai-endpoints';

/** Text read in one request; a longer reply is read in its first part. */
export const MAX_SPEECH_CHARS = 4000;
const TIMEOUT_MS = 120_000;

/**
 * Text to speech through the OpenAI-compatible service set in the settings or the server's
 * environment (OpenAI, or a speech server of the person's own such as Kokoro). The browser's own
 * voices stand in when none is set; their Turkish is often poor or missing.
 */
export class SpeechService {
  constructor(
    private ai: AiEndpointService,
    private fetcher: typeof fetch = fetch,
  ) {}

  async available(): Promise<boolean> {
    return !!(await this.ai.get('tts'));
  }

  /** The text read aloud, as MP3. */
  async speak(text: string): Promise<{ audio: Buffer; type: string }> {
    const s = await this.ai.get('tts');
    if (!s) throw new HttpError(409, 'error.speechNone');
    const input = text.trim().slice(0, MAX_SPEECH_CHARS);
    if (!input) throw new HttpError(400, 'error.speechEmpty');
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

  async test(): Promise<{ bytes: number }> {
    const { audio } = await this.speak('Leaf Bot');
    return { bytes: audio.length };
  }
}
