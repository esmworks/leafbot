import type { ChromeAnswer, ChromeAsk } from '@leafbot/shared';
import { z } from 'zod';
import { type ChromeBridge, ChromeUnreachable } from '../chrome/bridge';
import type { AppTool, ToolResult } from '../engine/types';
import type { T } from '../i18n';
import type { Define } from './index';

/** What Chrome said, as the bot reads it; a refusal says why in the turn's language. */
export function chromeAnswerText(answer: ChromeAnswer, t: T): string {
  if (!answer.ok) return t(`chrome.${answer.reason}`);
  if (answer.kind === 'tabs')
    return answer.tabs.length ? JSON.stringify(answer.tabs, null, 2) : t('chrome.noTabs');
  const head = `${answer.tab.title}\n${answer.tab.url}`;
  const cut = answer.cut ? `\n\n${t('chrome.cut')}` : '';
  return `${head}\n\n${answer.text}${cut}`;
}

/**
 * The person's own Chrome, through the extension's side panel while it shares Chrome: the open
 * tabs and the text of one. Each goes through the turn's permission check, which asks once in a
 * turn at every level (the name prefix `person_browser_` marks them), and what comes back is
 * outside text. Chrome asks the person once more for each site the extension may not read yet.
 */
export function personBrowserTools(opts: {
  def: Define;
  t: T;
  chromes: ChromeBridge;
  person: string;
  /** The turn, whose own panel is asked. */
  turnId: string;
  /** Shown on the panel's card when the extension may not read a site yet. */
  botName: string;
}): AppTool[] {
  const { def, t, chromes, person, turnId, botName } = opts;

  const ask = async (q: ChromeAsk): Promise<ToolResult> => {
    try {
      return chromeAnswerText(await chromes.ask(turnId, person, q), t);
    } catch (err) {
      if (err instanceof ChromeUnreachable) return t('chrome.unreachable');
      throw err;
    }
  };

  return [
    def('person_browser_tabs', {}, async () => ask({ kind: 'tabs' })),
    def('person_browser_read', { tab: z.number().int().nonnegative().optional() }, async (a) =>
      ask({ kind: 'read', ...(a.tab !== undefined && { tabId: a.tab }), bot: botName.slice(0, 200) }),
    ),
  ];
}
