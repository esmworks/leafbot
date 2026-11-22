import { useColorScheme } from 'react-native';
import { useStored } from './stored';
import { inTone, TONE_KEY, TONES, type ToneChoice } from './tone';

/** The web app's color tokens in sRGB, so both apps look alike in light and dark. */
const light = {
  background: '#FAFAFA',
  foreground: '#121212',
  card: '#FFFFFF',
  primary: '#161616',
  primaryForeground: '#FAFAFA',
  muted: '#F0F0F0',
  mutedForeground: '#636363',
  border: '#E1E1E1',
  /** The edge of something to tap, such as a chip or a checkbox: stronger than a card's border. */
  outline: '#D0D0D0',
  destructive: '#DC2626',
  brand: '#4F6BED',
  /** The bot list and the bot's replies sit on this. */
  sidebar: '#F5F5F5',
  /** A pressed row. */
  accent: '#EBEBEB',
  /** The chosen part of a segmented control: lighter than the muted track in both themes. */
  raised: '#FFFFFF',
  bubble: '#F5F5F5',
  unread: '#0EA5E9',
  /** Cards that wait for the person, and their counts. */
  amber: '#D97706',
  amberSoft: 'rgba(245,158,11,0.10)',
  /** Behind the words a search found. */
  mark: 'rgba(252,211,77,0.6)',
  success: '#059669',
};

export type Colors = typeof light;

const dark: Colors = {
  background: '#070707',
  foreground: '#EEEEEE',
  card: '#121212',
  primary: '#EEEEEE',
  primaryForeground: '#0B0B0B',
  muted: '#1B1B1B',
  mutedForeground: '#8F8F8F',
  border: '#1D1D1D',
  outline: '#383838',
  destructive: '#EF4444',
  brand: '#4F6BED',
  sidebar: '#040404',
  accent: '#1F1F1F',
  raised: '#2E2E2E',
  bubble: '#161616',
  unread: '#0EA5E9',
  amber: '#F59E0B',
  amberSoft: 'rgba(245,158,11,0.12)',
  mark: 'rgba(252,211,77,0.6)',
  success: '#34D399',
};

export type ThemeChoice = 'system' | 'light' | 'dark';
export const THEME_KEY = 'leafbot.theme';

/** The theme picked in the settings, or the phone's own. */
export function useTheme(): [ThemeChoice, (v: ThemeChoice) => void] {
  const [choice, set] = useStored<ThemeChoice>(THEME_KEY, 'system');
  return [choice, set];
}

export function useIsDark(): boolean {
  const scheme = useColorScheme();
  const [choice] = useTheme();
  return choice === 'system' ? scheme === 'dark' : choice === 'dark';
}

/** The color tone picked in the settings, kept on this phone like the theme. */
export function useTone(): [ToneChoice, (v: ToneChoice) => void] {
  const [tone, set] = useStored<ToneChoice>(TONE_KEY, 'neutral');
  return [TONES.includes(tone) ? tone : 'neutral', set];
}

// Built once, so a screen's colors stay the same object between renders and its styles are not
// worked out again each time.
const TABLES = Object.fromEntries(
  TONES.map((tone) => [tone, { light: inTone(light, tone, false), dark: inTone(dark, tone, true) }]),
) as Record<ToneChoice, { light: Colors; dark: Colors }>;

export function useColors(): Colors {
  const [tone] = useTone();
  return TABLES[tone][useIsDark() ? 'dark' : 'light'];
}

/** Heights and corner radii shared by inputs and buttons. */
export const CONTROL_HEIGHT = 48;
