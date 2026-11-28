import { BRAND_COLOR } from '@leafbot/shared';
import type { Settings } from '@/lib/api';

/** The colours the bot editor offers; a bot keeps one it already has even if it is not listed. */
export const COLORS = [
  BRAND_COLOR,
  '#4f6bed',
  '#7c5cff',
  '#c026d3',
  '#e11d74',
  '#e5484d',
  '#f97316',
  '#d4a017',
  '#0d9488',
  '#0891b2',
  '#64748b',
];

export interface BotEngine {
  engine: 'claude' | 'pi';
  model: string;
}

/** The engine and model a new bot starts with: the provider picked in the settings, else Claude. */
export function newBotEngine(settings?: Pick<Settings, 'defaultEngine' | 'piModel'>): BotEngine {
  return settings?.defaultEngine === 'pi' && settings.piModel
    ? { engine: 'pi', model: settings.piModel }
    : { engine: 'claude', model: '' };
}

/** `HH:MM` on a 24-hour clock. */
export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Tomorrow on the local calendar, as YYYY-MM-DD: where a one-time date starts. */
export function tomorrow(): string {
  return daysAhead(1);
}

/** A day this many days from today on the local calendar, as YYYY-MM-DD. */
export function daysAhead(n: number): string {
  const d = new Date(Date.now() + n * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A name that only this computer answers to. */
export function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h);
}
