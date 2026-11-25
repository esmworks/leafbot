import type { T } from '@/i18n';
import { type SettingsTab, useUi } from './store';
import { type ThemeChoice, useTheme } from './theme';

/** Something ⌘K can do besides finding a bot or a message: open a place or change a setting. */
export interface PaletteCommand {
  id: string;
  label: string;
  /** Other words it is found by, such as the settings section's own keywords. */
  words: string;
  run(): void;
}

/** The settings sections in the order the settings page lists them. */
export const SETTINGS_TABS: readonly SettingsTab[] = [
  'profile',
  'general',
  'providers',
  'services',
  'memory',
  'routines',
  'skills',
  'channels',
  'groups',
  'people',
  'permissions',
  'computer',
  'vault',
  'connection',
  'import',
  'usage',
  'about',
];

/** Sections only those who look after the server use: what they change is the server's. */
export const SERVER_TABS: ReadonlySet<SettingsTab> = new Set([
  'providers',
  'channels',
  'services',
  'groups',
  'import',
  'usage',
]);

/** At most this many commands show above the bots and messages. */
const MAX_SHOWN = 6;

/**
 * Every command the person may use: server sections only for those who look after the server
 * (`manages`), or while the session is not known yet, as the settings page shows them.
 */
export function paletteCommands(
  t: T,
  opts: { manages: boolean; known: boolean; computer?: boolean },
): PaletteCommand[] {
  const ui = () => useUi.getState();
  const theme = (choice: ThemeChoice): PaletteCommand => ({
    id: `theme:${choice}`,
    label: t('palette.theme', { theme: t(`general.theme.${choice}`) }),
    words: t('general.theme'),
    run: () => useTheme.getState().setChoice(choice),
  });
  const sections = SETTINGS_TABS.filter(
    (tab) =>
      (!opts.known || opts.manages || !SERVER_TABS.has(tab)) &&
      (tab !== 'computer' || opts.computer !== false),
  );
  return [
    {
      id: 'new-bot',
      label: t('sidebar.newBot'),
      words: t('palette.newBotWords'),
      run: () => ui().openBotPage({ mode: 'create' }),
    },
    { id: 'today', label: t('today.title'), words: '', run: () => ui().setTodayOpen(true) },
    { id: 'board', label: t('board.title'), words: '', run: () => ui().setBoardOpen(true) },
    { id: 'apps', label: t('apps.title'), words: '', run: () => ui().openApps({ botId: null }) },
    { id: 'shortcuts', label: t('shortcuts.title'), words: '', run: () => ui().setShortcutsOpen(true) },
    theme('light'),
    theme('dark'),
    theme('system'),
    ...sections.map((tab) => ({
      id: `settings:${tab}`,
      label: t('palette.settings', { section: t(`settings.tab.${tab}`) }),
      words: t(`settings.keywords.${tab}`),
      run: () => ui().openSettings(tab),
    })),
  ];
}

/** The commands whose name or words hold every word typed, in their own order; none for no words. */
export function matchCommands(all: readonly PaletteCommand[], query: string, intl: string): PaletteCommand[] {
  const needles = query.trim().toLocaleLowerCase(intl).split(/\s+/).filter(Boolean);
  if (!needles.length) return [];
  return all
    .filter((c) => {
      const hay = `${c.label} ${c.words}`.toLocaleLowerCase(intl);
      return needles.every((n) => hay.includes(n));
    })
    .slice(0, MAX_SHOWN);
}
