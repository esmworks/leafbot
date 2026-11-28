import type { Approval, Bot, Locale, Message, MessageFile, ReplyQuote } from '@leafbot/shared';
import { APPROVAL_TIMED_OUT, describeAction, questionItems } from '@leafbot/shared';
import { useMemo } from 'react';
import type { Palette } from '@/components/Markdown';
import { t } from '@/i18n';
import { useBots } from '@/lib/queries';
import type { Colors } from '@/lib/theme';

export function messageFiles(m: Message): MessageFile[] {
  return Array.isArray(m.props.files) ? (m.props.files as MessageFile[]) : [];
}

export function replyQuoteOf(m: Message): ReplyQuote | null {
  const q = m.props.replyTo as Partial<ReplyQuote> | undefined;
  return q && typeof q.id === 'string' && typeof q.text === 'string' ? { id: q.id, text: q.text } : null;
}

export const isImage = (name: string) => /\.(png|jpe?g|gif|webp|svg)$/i.test(name);

/** Bots by id, for the author of a message and the bots named on cards. */
export function useBotMap(): Map<string, Bot> {
  const { data } = useBots();
  return useMemo(() => new Map((data ?? []).map((b) => [b.id, b])), [data]);
}

/** A file size the way the web app words it: 12 KB, 3.4 MB. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Text colors on a user bubble, which is tinted in the bot's color in light and dark alike. */
export const ON_TINT: Palette = {
  text: '#FFFFFF',
  code: 'rgba(255,255,255,0.15)',
  line: 'rgba(255,255,255,0.5)',
};

const palettes = new WeakMap<Colors, Palette>();

/** One palette object per theme, so a bubble that did not change is not drawn again. */
export function bubblePalette(c: Colors): Palette {
  let p = palettes.get(c);
  if (!p) palettes.set(c, (p = { text: c.foreground, code: c.muted, line: c.border }));
  return p;
}

/** LeafBot's own tools, under the server name every engine gives them. */
const OWN = 'leafbot';

/**
 * What the bot is doing, in words, from the tool it is running. Null for a tool the "Working" line
 * has nothing to add for: the browser shows itself and an unknown tool reads as plain thinking.
 */
export function toolLabel(tool: string, apps: ReadonlyMap<string, string>): string | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool);
  const server = m?.[1] ?? null;
  const name = m?.[2] ?? tool;
  if (server && server !== OWN) return t('activity.tool.app', { app: apps.get(server) ?? server });
  if (name === 'Bash' || name === 'run_command') return t('activity.tool.shell');
  if (['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'].includes(name)) return t('activity.tool.files');
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'send_file'].includes(name))
    return t('activity.tool.write');
  if (name === 'WebFetch' || name === 'WebSearch') return t('activity.tool.web');
  if (name === 'image_create') return t('activity.tool.image');
  if (name === 'video_create') return t('activity.tool.video');
  if (name === 'slides_create') return t('activity.tool.slides');
  if (name === 'page_to_image') return t('activity.tool.pageImage');
  if (name === 'page_to_video') return t('activity.tool.pageVideo');
  if (name === 'Task' || name === 'Agent') return t('activity.tool.agent');
  if (name.startsWith('memory_')) return t('activity.tool.memory');
  return null;
}

/** The one line an answered card leaves in the thread. */
export function answeredText(a: Approval, botName: string, locale: Locale, service?: string): string {
  const timedOut = a.status === 'expired' && a.answer === APPROVAL_TIMED_OUT;
  if (a.kind === 'login') {
    const site = typeof a.input.site === 'string' ? a.input.site : '';
    if (a.status === 'allowed') return t('signin.done', { bot: botName, site, username: a.answer ?? '' });
    if (a.status === 'denied') return t('signin.skipped', { bot: botName, site });
    return t(timedOut ? 'signin.timedOut' : 'approval.expired', { bot: botName, site });
  }
  if (a.kind === 'question') {
    if (a.status === 'allowed') {
      const { items } = questionItems(a);
      if (items.length === 1 && items[0]!.secret) return t('question.secretGiven');
      return t('question.answer', { answer: a.answer ?? '' });
    }
    if (a.status === 'denied') return t('question.skipped');
    return t(timedOut ? 'question.timedOut' : 'question.unanswered');
  }
  const action = describeAction(a.toolName, a.input, { bot: botName, locale, service });
  if (a.status === 'allowed') return a.remembered ? action.always : action.once;
  if (a.status === 'denied') return action.wont;
  return t(timedOut ? 'approval.timedOut' : 'approval.expired');
}

/** Lower case in a way that keeps each character's place: Turkish İ/ı and the default rules. */
function fold(s: string): string {
  const tr = s.toLocaleLowerCase('tr');
  return tr.length === s.length ? tr : s.toLowerCase();
}

/**
 * Where `query` occurs in `text`, as [start, end) pairs. Case is ignored, and any run of spaces
 * or line breaks in the query matches any run in the text, as the server's search does.
 */
export function findOffsets(text: string, query: string): [number, number][] {
  const words = fold(query.trim()).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'g');
  const out: [number, number][] = [];
  for (const m of fold(text).matchAll(re)) out.push([m.index, m.index + m[0].length]);
  return out;
}

/** A message sent from this phone that the server has not listed yet. */
export const isLocal = (m: Message) => m.id.startsWith('local-');
