/**
 * The color tone tints the gray surfaces the way the web app's does (app/src/index.css): each
 * color keeps its lightness in OKLCH and takes the tone's hue at a low chroma, so text reads as
 * well in every tone. The words, the main button, red, amber and the brand color are left alone.
 */
export type ToneChoice = 'neutral' | 'slate' | 'leaf' | 'rose' | 'lavender' | 'peach' | 'sand';
export const TONES: readonly ToneChoice[] = ['neutral', 'slate', 'leaf', 'rose', 'lavender', 'peach', 'sand'];
export const TONE_KEY = 'leafbot.tone';

/** The tint of each tone as chroma and hue, a little stronger on dark surfaces to show at all. */
export const TINTS: Record<Exclude<ToneChoice, 'neutral'>, { light: number; dark: number; hue: number }> = {
  slate: { light: 0.015, dark: 0.018, hue: 255 },
  leaf: { light: 0.015, dark: 0.016, hue: 160 },
  rose: { light: 0.022, dark: 0.024, hue: 350 },
  lavender: { light: 0.02, dark: 0.022, hue: 300 },
  peach: { light: 0.02, dark: 0.02, hue: 50 },
  sand: { light: 0.018, dark: 0.018, hue: 85 },
};

/** The keys a tone tints: the gray surfaces and the muted words, as on the web. */
export const TINTED = [
  'background',
  'card',
  'muted',
  'mutedForeground',
  'border',
  'outline',
  'sidebar',
  'accent',
  'raised',
  'bubble',
] as const;

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** OKLCH lightness of a #RRGGBB color. */
export function lightness(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255)) as [
    number,
    number,
    number,
  ];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

/** A #RRGGBB color from OKLCH, clipped into what a screen can show. */
export function oklch(L: number, C: number, hue: number): string {
  const h = (hue * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${rgb
    .map((c) =>
      Math.round(Math.min(1, Math.max(0, fromLinear(c))) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase()}`;
}

/** A color table in a tone: the gray surfaces tinted, everything else as it was. */
export function inTone<T extends Record<(typeof TINTED)[number], string>>(
  colors: T,
  tone: ToneChoice,
  dark: boolean,
): T {
  if (tone === 'neutral') return colors;
  const tint = TINTS[tone];
  const next = { ...colors };
  for (const key of TINTED) {
    const L = lightness(colors[key]);
    // Pure white stays white, as the web's light cards do: a tint there would only be clipped.
    if (L > 0.995) continue;
    next[key] = oklch(L, dark ? tint.dark : tint.light, tint.hue) as T[typeof key];
  }
  return next;
}
