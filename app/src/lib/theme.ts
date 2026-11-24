import { create } from 'zustand';

export type ThemeChoice = 'system' | 'light' | 'dark';
/** A tint over the gray surfaces; see index.css. */
export type ToneChoice = 'neutral' | 'slate' | 'leaf' | 'rose' | 'lavender' | 'peach' | 'sand';
export const TONES: readonly ToneChoice[] = ['neutral', 'slate', 'leaf', 'rose', 'lavender', 'peach', 'sand'];
const KEY = 'leafbot.theme';
const TONE_KEY = 'leafbot.tone';
const media = window.matchMedia('(prefers-color-scheme: dark)');

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

function readTone(): ToneChoice {
  try {
    const v = localStorage.getItem(TONE_KEY);
    return TONES.includes(v as ToneChoice) ? (v as ToneChoice) : 'neutral';
  } catch {
    return 'neutral';
  }
}

function applyTone(tone: ToneChoice) {
  if (tone === 'neutral') delete document.documentElement.dataset.tone;
  else document.documentElement.dataset.tone = tone;
}

function apply(choice: ThemeChoice) {
  const dark = choice === 'dark' || (choice === 'system' && media.matches);
  document.documentElement.classList.toggle('dark', dark);
  return dark;
}

interface ThemeState {
  choice: ThemeChoice;
  dark: boolean;
  tone: ToneChoice;
  setChoice(c: ThemeChoice): void;
  setTone(t: ToneChoice): void;
}

export const useTheme = create<ThemeState>((set) => {
  const choice = read();
  const tone = readTone();
  applyTone(tone);
  return {
    choice,
    dark: apply(choice),
    tone,
    setTone: (t) => {
      try {
        localStorage.setItem(TONE_KEY, t);
      } catch {
        // ignore
      }
      applyTone(t);
      set({ tone: t });
    },
    setChoice: (c) => {
      try {
        localStorage.setItem(KEY, c);
      } catch {
        // ignore
      }
      set({ choice: c, dark: apply(c) });
    },
  };
});

media.addEventListener('change', () => {
  const { choice } = useTheme.getState();
  useTheme.setState({ dark: apply(choice) });
});
