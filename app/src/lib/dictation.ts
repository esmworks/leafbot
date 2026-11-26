import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { INTL_LOCALE, LOCALES, type Locale } from '@leafbot/shared';
import { api } from './api';
import { desktop } from './desktop';

/**
 * Speaking a message instead of typing it. With an OpenAI or Groq key saved on the server, the
 * recording goes there to be written out, which works in every browser and in the desktop app.
 * Without one, a browser with its own speech recognition (Chrome, Safari) writes as the person
 * speaks; the desktop app has none of its own. Elsewhere there is no microphone button.
 */
export type DictationState = 'idle' | 'recording' | 'working';

/** A microphone problem the person can fix; `key` is its guidance in the translation catalogs. */
export type DictationError = {
  key?: 'chat.micDenied' | 'chat.micDeniedDesktop' | 'chat.micMissing' | 'chat.micBusy';
  message: string;
};

/**
 * Turns what the browser says when the microphone cannot be opened (a DOMException name, or the
 * speech recognition's error code) into guidance, since the raw text ("Permission denied") does
 * not say what to do. Anything unknown keeps the browser's own message.
 */
export function dictationError(name: string, message: string, inDesktopApp = !!desktop): DictationError {
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'not-allowed':
    case 'service-not-allowed':
      return { key: inDesktopApp ? 'chat.micDeniedDesktop' : 'chat.micDenied', message };
    case 'NotFoundError':
    case 'OverconstrainedError':
      return { key: 'chat.micMissing', message };
    case 'NotReadableError':
    case 'AbortError':
    case 'audio-capture':
      return { key: 'chat.micBusy', message };
    default:
      return { message };
  }
}

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((e: {
        resultIndex: number;
        results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
      }) => void)
    | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

function browserRecognition(): (new () => Recognition) | null {
  if (typeof window === 'undefined' || desktop) return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const canRecord = () =>
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof MediaRecorder !== 'undefined';

/** Picks a recording format the browser makes and the providers read. */
function recordingType(): string | undefined {
  for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported?.(type)) return type;
  }
  return undefined;
}

/**
 * Which language dictation listens for: the app's own, whatever is spoken, or a set one. People
 * often write to bots in a language other than the interface's, and dictation held to the
 * interface language wrote their speech out as nonsense.
 */
export type DictationLanguage = 'app' | 'auto' | Locale;
const LANGUAGE_KEY = 'leafbot.dictationLanguage';

function readLanguage(): DictationLanguage {
  try {
    const v = localStorage.getItem(LANGUAGE_KEY);
    return v === 'auto' || (LOCALES as readonly string[]).includes(v ?? '')
      ? (v as DictationLanguage)
      : 'app';
  } catch {
    return 'app';
  }
}

/** Kept per device, like the microphone it is spoken into. */
export const useDictationLanguage = create<{ language: DictationLanguage; set(l: DictationLanguage): void }>(
  (set) => ({
    language: readLanguage(),
    set: (language) => {
      try {
        localStorage.setItem(LANGUAGE_KEY, language);
      } catch {
        // Held for this page.
      }
      set({ language });
    },
  }),
);

/** The language to ask for, or none to let the service tell. */
export function spokenLanguage(choice: DictationLanguage, appLocale: Locale): Locale | undefined {
  if (choice === 'auto') return undefined;
  return choice === 'app' ? appLocale : choice;
}

export function useDictation(opts: {
  locale: Locale;
  /** Text to add to the message box: each finished phrase, or the whole recording at once. */
  onText(text: string): void;
  onError(error: DictationError): void;
}) {
  const { data } = useQuery({ queryKey: ['transcribe'], queryFn: api.transcribeStatus, staleTime: 60_000 });
  const server = !!data?.available && canRecord();
  const Browser = browserRecognition();
  const supported = server || !!Browser;
  const [state, setState] = useState<DictationState>('idle');
  const stopRef = useRef<(() => void) | null>(null);
  const choice = useDictationLanguage((s) => s.language);
  const latest = useRef({ ...opts, choice });
  useEffect(() => {
    latest.current = { ...opts, choice };
  });
  // Leaving the conversation stops listening.
  useEffect(() => () => stopRef.current?.(), []);

  const startServer = async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      latest.current.onError(dictationError((e as Error).name, (e as Error).message));
      return;
    }
    const type = recordingType();
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      stopRef.current = null;
      const blob = new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' });
      if (!blob.size) return setState('idle');
      setState('working');
      try {
        const { text } = await api.transcribe(
          blob,
          spokenLanguage(latest.current.choice, latest.current.locale),
        );
        if (text) latest.current.onText(text);
      } catch (e) {
        latest.current.onError({ message: (e as Error).message });
      } finally {
        setState('idle');
      }
    };
    recorder.start();
    stopRef.current = () => {
      if (recorder.state !== 'inactive') recorder.stop();
    };
    setState('recording');
  };

  const startBrowser = () => {
    const r = new Browser!();
    // The browser's recognizer cannot tell the language itself; with no set one it uses the app's.
    r.lang =
      INTL_LOCALE[spokenLanguage(latest.current.choice, latest.current.locale) ?? latest.current.locale];
    r.continuous = true;
    r.interimResults = false;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]!;
        if (result.isFinal) latest.current.onText(result[0].transcript.trim());
      }
    };
    r.onerror = (e) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted')
        latest.current.onError(dictationError(e.error, e.error));
    };
    r.onend = () => {
      stopRef.current = null;
      setState('idle');
    };
    r.start();
    stopRef.current = () => r.stop();
    setState('recording');
  };

  const toggle = () => {
    if (state === 'recording') return stopRef.current?.();
    if (state !== 'idle') return;
    if (server) void startServer();
    else if (Browser) startBrowser();
  };

  return { supported, state, toggle };
}
