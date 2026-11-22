import { INTL_LOCALE, type Locale, type Message } from '@leafbot/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { dictationError, type DictationError } from '@/lib/dictation';
import { speakAndWait, stopSpeech } from '@/lib/speech';

/**
 * Talking with a bot like on a call: the app listens, sends what was said once the person stops,
 * reads the bot's answer aloud and listens again. Talking over the answer stops it.
 *
 * - `listening`: waiting for the person to speak
 * - `hearing`: they are speaking
 * - `sending`: what they said is being written out and sent
 * - `waiting`: the bot is working on its answer
 * - `speaking`: the answer is read aloud
 */
export type CallState = 'off' | 'listening' | 'hearing' | 'sending' | 'waiting' | 'speaking';

/** How loud the microphone is: the root mean square of a frame of samples, 0 to 1. */
export function loudness(samples: Float32Array): number {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

export interface DetectorOptions {
  /** Louder than this is speech. */
  threshold: number;
  /** Quiet this long after speech ends what was said. */
  silenceMs: number;
  /** Speech shorter than this (a cough, a door) is not taken as something said. */
  minSpeechMs: number;
}

export const DEFAULT_DETECTOR: DetectorOptions = { threshold: 0.02, silenceMs: 900, minSpeechMs: 250 };

/**
 * Tells from the microphone's loudness, frame by frame, when someone starts speaking and when
 * they have finished: `start` once speech has lasted `minSpeechMs`, `end` once it is followed by
 * `silenceMs` of quiet.
 */
export class TurnDetector {
  private loudSince: number | null = null;
  private quietSince: number | null = null;
  private speaking = false;

  constructor(private o: DetectorOptions = DEFAULT_DETECTOR) {}

  feed(level: number, now: number): 'start' | 'end' | null {
    const loud = level >= this.o.threshold;
    if (!this.speaking) {
      if (!loud) {
        this.loudSince = null;
        return null;
      }
      this.loudSince ??= now;
      if (now - this.loudSince < this.o.minSpeechMs) return null;
      this.speaking = true;
      this.quietSince = null;
      return 'start';
    }
    if (loud) {
      this.quietSince = null;
      return null;
    }
    this.quietSince ??= now;
    if (now - this.quietSince < this.o.silenceMs) return null;
    this.reset();
    return 'end';
  }

  reset() {
    this.loudSince = null;
    this.quietSince = null;
    this.speaking = false;
  }
}

/** The bot's answers and errors in a conversation, by id: what was there before a message was sent. */
export const answerIds = (messages: readonly Message[]) =>
  new Set(messages.filter((m) => m.role === 'assistant' || m.role === 'error').map((m) => m.id));

/**
 * The bot's answer to what was sent: its newest answer or error that was not there before
 * (`before`), once its turn has ended. Null while it still works or has not answered. Ids, not
 * times, since this device's clock and the server's may differ.
 */
export function answerAfter(
  messages: readonly Message[],
  before: ReadonlySet<string>,
  busy: boolean,
): Message | null {
  if (busy) return null;
  const fresh = messages.filter((m) => (m.role === 'assistant' || m.role === 'error') && !before.has(m.id));
  return fresh.at(-1) ?? null;
}

/** How often the microphone is looked at. */
const FRAME_MS = 50;
/** A recording with nothing said is started again after this long, so it does not grow. */
const IDLE_RESTART_MS = 20_000;
/** The answer is read aloud while this much louder than the threshold counts as talking over it. */
const OVER_ANSWER = 3;

function recordingType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) =>
    MediaRecorder.isTypeSupported(t),
  );
}

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((e: {
        resultIndex: number;
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
      }) => void)
    | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort?(): void;
}

function browserRecognition(): (new () => Recognition) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * A voice call with the bot of one conversation. With the server's speech-to-text service, the
 * app records and finds the pauses itself; without one, a browser with its own speech recognition
 * (Chrome, Safari) does both. Elsewhere `supported` is false.
 */
export function useVoiceCall(opts: {
  locale: Locale;
  /** Whether the bot is working on something in this conversation. */
  busy: boolean;
  /** The conversation's messages, newest last. */
  messages: readonly Message[];
  /** Sends what was said as the person's message. */
  send(text: string): void;
  /** Whether the server reads aloud with a voice of its own. */
  serverVoice: boolean;
  onError(error: DictationError): void;
}) {
  const { data } = useQuery({ queryKey: ['transcribe'], queryFn: api.transcribeStatus, staleTime: 60_000 });
  const server = !!data?.available && typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices;
  const Browser = typeof window === 'undefined' ? null : browserRecognition();
  const supported = server || !!Browser;
  const [state, setState] = useState<CallState>('off');
  const [level, setLevel] = useState(0);
  const latest = useRef(opts);
  useEffect(() => {
    latest.current = opts;
  });
  const stateRef = useRef<CallState>('off');
  const set = (s: CallState) => {
    stateRef.current = s;
    setState(s);
  };
  // What the running call holds, released on hang-up.
  const call = useRef<{ stop(): void; listen(): void; pause(): void } | null>(null);
  const before = useRef<ReadonlySet<string>>(new Set());
  // Which call is running: work that comes back after its call ended (a microphone granted late,
  // speech written out after hang-up) sees a different number and is dropped.
  const callNo = useRef(0);

  // The answer to what was sent: read aloud, then the call listens again.
  useEffect(() => {
    if (state !== 'waiting') return;
    const answer = answerAfter(opts.messages, before.current, opts.busy);
    if (!answer) return;
    if (answer.role === 'error' || !answer.text.trim()) {
      call.current?.listen();
      return;
    }
    set('speaking');
    call.current?.pause();
    void speakAndWait(answer.id, answer.text, latest.current.locale, latest.current.serverVoice).then(() => {
      if (stateRef.current === 'speaking') call.current?.listen();
    });
  }, [state, opts.messages, opts.busy]);

  const said = (no: number, text: string) => {
    if (no !== callNo.current) return;
    const clean = text.trim();
    if (!clean) return call.current?.listen();
    before.current = answerIds(latest.current.messages);
    set('waiting');
    latest.current.send(clean);
  };

  const startServer = async (no: number) => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      if (no !== callNo.current) return;
      set('off');
      latest.current.onError(dictationError((e as Error).name, (e as Error).message));
      return;
    }
    // Hung up, or left the conversation, while the microphone was being granted.
    if (no !== callNo.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const audio = new AudioContext();
    const analyser = audio.createAnalyser();
    analyser.fftSize = 1024;
    audio.createMediaStreamSource(stream).connect(analyser);
    const frame = new Float32Array(analyser.fftSize);
    const detector = new TurnDetector();
    const over = new TurnDetector({
      ...DEFAULT_DETECTOR,
      threshold: DEFAULT_DETECTOR.threshold * OVER_ANSWER,
    });
    const type = recordingType();
    let recorder: { r: MediaRecorder; chunks: Blob[] } | null = null;
    let since = Date.now();

    const record = () => {
      since = Date.now();
      const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      // Each recording keeps its own pieces: a stopped one still hands over its last piece after
      // the next has started.
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      r.start();
      recorder = { r, chunks };
    };
    /** Ends the recording; `keep` sends what it holds to be written out. */
    const finish = (keep: boolean) => {
      const held = recorder;
      recorder = null;
      if (!held || held.r.state === 'inactive') return;
      const { r, chunks } = held;
      r.onstop = keep
        ? () => {
            if (no !== callNo.current) return;
            const blob = new Blob(chunks, { type: r.mimeType || type || 'audio/webm' });
            set('sending');
            api.transcribe(blob, latest.current.locale).then(
              ({ text }) => said(no, text),
              (e: Error) => {
                if (no !== callNo.current) return;
                latest.current.onError({ message: e.message });
                call.current?.listen();
              },
            );
          }
        : null;
      r.stop();
    };

    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(frame);
      const now = Date.now();
      const l = loudness(frame);
      setLevel(l);
      const s = stateRef.current;
      if (s === 'speaking') {
        // Talking over the answer stops it, and what is said now is the next message.
        if (over.feed(l, now) === 'start') {
          stopSpeech();
          detector.reset();
          record();
          set('hearing');
        }
        return;
      }
      if (s !== 'listening' && s !== 'hearing') return;
      const event = detector.feed(l, now);
      if (event === 'start') set('hearing');
      else if (event === 'end') finish(true);
      else if (s === 'listening' && now - since > IDLE_RESTART_MS) {
        finish(false);
        record();
      }
    }, FRAME_MS);

    call.current = {
      listen() {
        detector.reset();
        over.reset();
        if (!recorder) record();
        set('listening');
      },
      // The microphone stays on while the answer is read, to hear the person talk over it.
      pause() {},
      stop() {
        clearInterval(timer);
        finish(false);
        stopSpeech();
        stream.getTracks().forEach((t) => t.stop());
        void audio.close();
      },
    };
    call.current.listen();
  };

  const startBrowser = (no: number) => {
    const r = new Browser!();
    r.lang = INTL_LOCALE[latest.current.locale];
    r.continuous = true;
    r.interimResults = false;
    let on = true;
    // While the answer is read, recognition is stopped: it would hear the bot's own voice and send
    // it back. Stopping drops what it had not finished, the answer's last words included.
    let paused = false;
    let running = false;
    const halt = () => (r.abort ? r.abort() : r.stop());
    const begin = () => {
      if (!on || paused || running) return;
      try {
        r.start();
        running = true;
      } catch {
        // Already started: its end starts it again.
      }
    };
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]!;
        if (!result.isFinal) continue;
        const s = stateRef.current;
        if (!paused && (s === 'listening' || s === 'hearing')) said(no, result[0]!.transcript);
      }
    };
    r.onerror = (e) => {
      if (no !== callNo.current) return;
      if (e.error !== 'no-speech' && e.error !== 'aborted') {
        latest.current.onError(dictationError(e.error, e.error));
        call.current?.stop();
        call.current = null;
        set('off');
      }
    };
    // The browser stops listening by itself after a while; the call goes on.
    r.onend = () => {
      running = false;
      begin();
    };
    begin();
    call.current = {
      listen() {
        paused = false;
        set('listening');
        begin();
      },
      pause() {
        paused = true;
        halt();
      },
      stop() {
        on = false;
        halt();
        stopSpeech();
      },
    };
    call.current.listen();
  };

  const hangUp = () => {
    callNo.current++;
    call.current?.stop();
    call.current = null;
    setLevel(0);
    set('off');
  };
  // Leaving the conversation ends the call.
  useEffect(
    () => () => {
      callNo.current++;
      call.current?.stop();
    },
    [],
  );

  const start = () => {
    if (stateRef.current !== 'off') return;
    const no = ++callNo.current;
    set('listening');
    if (server) void startServer(no);
    else if (Browser) startBrowser(no);
  };

  return { supported, state, level, start, hangUp };
}
