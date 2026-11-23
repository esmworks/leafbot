import { describe, expect, it } from 'vitest';
import type { Bot } from '@leafbot/shared';
import { translator } from '../i18n';
import { buildSystemPrompt } from './prompt';
import type { WorkspacePaths } from '../workspace';

const bot = {
  id: 'b1',
  name: 'Ada',
  description: '',
  instructions: '',
  isManager: false,
  groupId: null,
} as Bot;
const paths = { botFiles: '/b', groupFiles: null } as unknown as WorkspacePaths;

const build = (locale: 'en' | 'tr', extra: Partial<Parameters<typeof buildSystemPrompt>[0]> = {}) =>
  buildSystemPrompt({
    bot,
    paths,
    cwd: '/b',
    memory: { user: [], bot: [] },
    peers: [],
    timezone: 'UTC',
    locale,
    ...extra,
  });

describe('prompt rules about status and routines', () => {
  for (const locale of ['en', 'tr'] as const) {
    const t = translator(locale);
    it(`tells the bot to report in plain words (${locale})`, () => {
      expect(build(locale)).toContain(t('prompt.ruleStatus'));
      expect(build(locale, { team: true })).toContain(t('prompt.ruleStatus'));
    });

    it(`offers to update a routine only where routine tools exist (${locale})`, () => {
      expect(build(locale)).toContain(t('prompt.ruleRoutineFacts'));
      expect(build(locale, { team: true })).not.toContain(t('prompt.ruleRoutineFacts'));
      expect(build(locale, { contact: 'route' })).not.toContain(t('prompt.ruleRoutineFacts'));
    });
  }
});
