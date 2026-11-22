import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { INTL_LOCALE, type Locale } from '@leafbot/shared';
import { api } from './api';

const RATE_KEY = 'leafbot.speech.rate';
/** The reading speeds the bar spans; 1 is the voice's own. */
export const SPEECH_RATE_MIN = 0.5;
export const SPEECH_RATE_MAX = 2;
export const SPEECH_RATE_STEP = 0.01;

/** A speed the voices can take: within the bar, to the hundredth. */
export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.round(Math.min(SPEECH_RATE_MAX, Math.max(SPEECH_RATE_MIN, rate)) * 100) / 100;
}

function readRate(): number {
  try {
    const v = localStorage.getItem(RATE_KEY);
    return v === null ? 1 : clampRate(Number(v));
  } catch {
    return 1;
  }
}

/** Which message is being read aloud, if any, and how fast this device reads. */
export const useSpeech = create<{ speaking: string | null; rate: number; setRate(rate: number): void }>(
  (set) => ({
    speaking: null,
    rate: readRate(),
    setRate: (value) => {
      const rate = clampRate(value);
      try {
        localStorage.setItem(RATE_KEY, String(rate));
      } catch {
        // Kept for this page when storage is off.
      }
      // A reply the server's voice is reading follows the bar as it moves, so the speed can be
      // found by ear.
      if (playing) playing.playbackRate = rate;
      set({ rate });
    },
  }),
);

export const speechSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

/** Emoji, with the joiners and variation marks that build them. */
const EMOJI = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u200d|\ufe0f|\u20e3/gu;
/** Marks that are drawn, not said: arrows, bullets, check marks, box lines. */
const SYMBOLS = /[\u2190-\u21ff\u2022\u2023\u2043\u25a0-\u25ff\u2700-\u27bf\u2500-\u257f*~^\\]/g;

/**
 * Markdown as it sounds. Code, math, links' addresses, emoji and drawn marks are dropped, and every
 * heading, list item and table row ends in a full stop, so the voice pauses between them instead
 * of running them into one breathless sentence.
 */
export function speakable(markdown: string): string {
  const lines = markdown
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/\$\$[\s\S]*?\$\$/g, '\n')
    .replace(/<[^>\n]+>/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/(\*\*|__|\*|~~)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/(^|\W)_(\S(?:.*?\S)?)_(?=\W|$)/g, '$1$2')
    .split('\n')
    .map((line) => {
      // Table rules and horizontal rules are drawn, not said.
      if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) return '';
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return '';
      const text = line
        .replace(/^[ \t]*(#{1,6}|>+|[-*+]|\d+[.)])[ \t]+/, '')
        .replace(/^\s*\||\|\s*$/g, '')
        .replace(/\s*\|\s*/g, ', ')
        .replace(EMOJI, ' ')
        .replace(SYMBOLS, ' ')
        .replace(/(^|\s)#+(?=\s|$)/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\s+([,.;:!?])/g, '$1')
        .replace(/^[\s,]+|[\s,]+$/g, '');
      if (!/[\p{L}\p{N}]/u.test(text)) return '';
      return /[.!?…:;]$/.test(text) ? text : `${text}.`;
    })
    .filter(Boolean);
  return lines.join('\n');
}

const TURKISH_LETTERS = /[çğıöşüÇĞİÖŞÜ]/;
const ENGLISH_WORDS = /\b(the|and|is|are|of|to|you|it|that|this|with|for|have|be|was|not)\b/gi;

/**
 * The language a reply is written in, as far as a voice needs to know: a Turkish voice reading
 * English (or the other way round) sounds like nonsense. Falls back to the app's language.
 */
export function speechLanguage(text: string, fallback: Locale): Locale {
  if (TURKISH_LETTERS.test(text)) return 'tr';
  const words = text.split(/\s+/).filter(Boolean).length;
  const english = text.match(ENGLISH_WORDS)?.length ?? 0;
  if (words >= 4 && english / words >= 0.12) return 'en';
  return fallback;
}

/** Sound effects and joke voices macOS lists beside the real ones. */
const NOVELTY = new Set([
  'albert',
  'bad news',
  'bahh',
  'bells',
  'boing',
  'bubbles',
  'cellos',
  'fred',
  'good news',
  'jester',
  'junior',
  'kathy',
  'organ',
  'ralph',
  'superstar',
  'trinoids',
  'whisper',
  'wobble',
  'zarvox',
]);
/** Names systems give their better voices. */
const NATURAL = /premium|enhanced|gelişmiş|yüksek kalite|neural|natural|online|siri|google/i;
/** macOS's speech-synthesizer voices, built for screen readers rather than reading aloud. */
const SYNTHETIC = /^(eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)\b/i;

/** The most natural-sounding voice the system has for a language, or none. */
export function pickVoice(voices: readonly SpeechSynthesisVoice[], locale: Locale) {
  const region = INTL_LOCALE[locale].toLowerCase();
  let best: SpeechSynthesisVoice | undefined;
  let bestScore = -Infinity;
  for (const v of voices) {
    const lang = v.lang.toLowerCase().replace('_', '-');
    if (lang !== locale && !lang.startsWith(`${locale}-`)) continue;
    const name = v.name.toLowerCase();
    let score = 0;
    if (NOVELTY.has(name.replace(/\s*\(.*$/, ''))) score -= 100;
    if (NATURAL.test(v.name)) score += 10;
    if (SYNTHETIC.test(v.name)) score -= 5;
    // Network voices (Google's, Microsoft's online ones) are neural; local ones mostly are not.
    if (!v.localService) score += 4;
    if (lang === region) score += 2;
    if (v.default) score += 1;
    if (score > bestScore) {
      best = v;
      bestScore = score;
    }
  }
  return best;
}

/** The system's voices; Chromium lists none until it has loaded them. */
function systemVoices(): Promise<SpeechSynthesisVoice[]> {
  const synth = window.speechSynthesis;
  const now = synth.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => {
      synth.removeEventListener('voiceschanged', done);
      clearTimeout(timer);
      resolve(synth.getVoices());
    };
    const timer = setTimeout(done, 1500);
    synth.addEventListener('voiceschanged', done);
  });
}

/** Whether the server reads replies aloud with a speech service of its own. */
export function useServerVoice(): boolean {
  const { data } = useQuery({ queryKey: ['speech'], queryFn: api.speechStatus, staleTime: 60_000 });
  return !!data?.available;
}

/** The reply the server is reading aloud, so another one, or the same again, stops it. */
let playing: HTMLAudioElement | null = null;

function stopAll() {
  if (speechSupported()) window.speechSynthesis.cancel();
  if (playing) {
    playing.pause();
    URL.revokeObjectURL(playing.src);
    playing = null;
  }
}

/**
 * Reads a message aloud; again on the same one stops. `server`: with the server's speech service,
 * whose voices read Turkish far better than most systems'; else, or when it fails, with the
 * system's voice for the language.
 */
export function toggleSpeech(id: string, markdown: string, locale: Locale, server = false) {
  const was = useSpeech.getState().speaking;
  stopAll();
  if (was === id) return useSpeech.setState({ speaking: null });
  if (server) {
    useSpeech.setState({ speaking: id });
    void api.speech(speakable(markdown)).then(
      (blob) => {
        // Stopped, or another reply started, while the audio was on its way.
        if (useSpeech.getState().speaking !== id) return;
        const audio = new Audio(URL.createObjectURL(blob));
        audio.playbackRate = useSpeech.getState().rate;
        const done = () => {
          if (playing === audio) stopAll();
          if (useSpeech.getState().speaking === id) useSpeech.setState({ speaking: null });
        };
        audio.onended = done;
        audio.onerror = done;
        playing = audio;
        void audio.play().catch(done);
      },
      (err) => {
        console.warn('Server speech failed; reading with the system voice', err);
        // Straight on with the system voice: the reply stays the one being read, so whoever waits
        // for it to end does not take the switch for its end.
        if (useSpeech.getState().speaking === id) speakSystem(id, markdown, locale);
      },
    );
    return;
  }
  speakSystem(id, markdown, locale);
}

/** Reads a message with the system's voice for its language; ends at once where there is none. */
function speakSystem(id: string, markdown: string, locale: Locale) {
  if (!speechSupported()) {
    if (useSpeech.getState().speaking === id) useSpeech.setState({ speaking: null });
    return;
  }
  const text = speakable(markdown);
  useSpeech.setState({ speaking: id });
  void systemVoices().then((voices) => {
    // Stopped, or another reply started, while the voices were loading.
    if (useSpeech.getState().speaking !== id) return;
    const lang = speechLanguage(text, locale);
    const u = new SpeechSynthesisUtterance(text);
    u.lang = INTL_LOCALE[lang];
    u.rate = useSpeech.getState().rate;
    const voice = pickVoice(voices, lang);
    if (voice) u.voice = voice;
    const done = () => {
      if (useSpeech.getState().speaking === id) useSpeech.setState({ speaking: null });
    };
    u.onend = done;
    u.onerror = done;
    window.speechSynthesis.speak(u);
  });
}

/** Stops whatever is being read aloud. */
export function stopSpeech() {
  stopAll();
  useSpeech.setState({ speaking: null });
}

/**
 * The longest a reply may take to read before it counts as ended: some browsers never say a long
 * reading ended, and a call waiting on it would wait for good.
 */
export const speechDeadline = (markdown: string) => Math.max(15_000, speakable(markdown).length * 120);

/** Reads a message aloud and resolves once it has been read, was stopped, or ran past its deadline. */
export function speakAndWait(id: string, markdown: string, locale: Locale, server = false): Promise<void> {
  if (useSpeech.getState().speaking === id) stopSpeech();
  toggleSpeech(id, markdown, locale, server);
  if (useSpeech.getState().speaking !== id) return Promise.resolve();
  return new Promise((resolve) => {
    const end = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const unsubscribe = useSpeech.subscribe((s) => {
      if (s.speaking !== id) end();
    });
    const timer = setTimeout(() => {
      if (useSpeech.getState().speaking === id) stopSpeech();
      end();
    }, speechDeadline(markdown));
  });
}
