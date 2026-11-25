import type { IconName } from '@/components/page';

/**
 * The settings sections in groups, as the web app has them, so a long list reads as a few short
 * ones: what is the person's own, the AI the bots think with, what the bots do, who may reach
 * what, and the server itself. The first group has no heading.
 */
export const SECTIONS = [
  { id: 'profile', icon: 'user', group: 'own' },
  { id: 'general', icon: 'sliders', group: 'own' },
  { id: 'providers', icon: 'cpu', group: 'ai' },
  { id: 'services', icon: 'volume-2', group: 'ai' },
  { id: 'memory', icon: 'book', group: 'ai' },
  { id: 'routines', icon: 'clock', group: 'bots' },
  { id: 'skills', icon: 'star', group: 'bots' },
  { id: 'channels', icon: 'message-circle', group: 'bots' },
  { id: 'groups', icon: 'folder', group: 'bots' },
  { id: 'people', icon: 'users', group: 'access' },
  { id: 'permissions', icon: 'shield', group: 'access' },
  { id: 'vault', icon: 'key', group: 'access' },
  { id: 'connection', icon: 'link-2', group: 'server' },
  { id: 'import', icon: 'download', group: 'server' },
  { id: 'usage', icon: 'bar-chart-2', group: 'server' },
  { id: 'about', icon: 'info', group: 'server' },
] as const satisfies readonly { id: string; icon: IconName; group: string }[];

export type SectionId = (typeof SECTIONS)[number]['id'];

/** Sections only those who look after the server use: what they change is the server's. */
export const SERVER_SECTIONS: ReadonlySet<SectionId> = new Set([
  'providers',
  'channels',
  'services',
  'groups',
  'import',
  'usage',
]);

export function isSection(id: string | undefined): id is SectionId {
  return SECTIONS.some((s) => s.id === id);
}
