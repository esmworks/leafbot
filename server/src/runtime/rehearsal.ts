import { READ_ONLY_TOOLS } from '../services/approvals';

/**
 * The app's own tools that only look. In a rehearsal these run for real; every other tool of the
 * app is only written down, so a tool added later is held back until it is listed here. A tool's
 * "internal" class is not enough: it means "needs no card", and memory notes, messages to people
 * and browser clicks are internal too.
 */
export const REHEARSAL_READS: ReadonlySet<string> = new Set([
  'skill_read',
  'plan_update',
  'quick_replies',
  'my_activity',
  'conversations_search',
  'message_read',
  'memory_search',
  'bots_list',
  'bot_status',
  'bot_requests',
  'bot_conversations_read',
  'models_list',
  'bot_profile',
  'api_keys_list',
  'api_operations',
  'api_request',
  'api_call',
  'tables_list',
  'table_rows',
  'dashboards',
  'email_inbox',
  'email_read',
  'tickets_list',
  'ticket_read',
  'whatsapp_chats',
  'whatsapp_history',
  'whatsapp_status',
  'browser_open',
  'browser_snapshot',
  'browser_screenshot',
  'browser_scroll',
  'browser_wait',
  'browser_hover',
  'browser_network',
  'browser_console',
  'computer_screenshot',
]);

/**
 * Whether a step of a rehearsal is done for real because it only reads: the built-in tools that
 * read, searching and reading pages, a connected app's tools marked read-only, the app's own
 * reading tools and a command that only reads the bot's own folders. A step the person's rules
 * would ask about, a page that imitates a site they use and a call the tool itself says changes
 * something are never reads, so no card is needed and none is asked.
 */
export function isRehearsalRead(o: {
  toolName: string;
  appTool?: { name: string; server?: string; readOnly: boolean };
  /** The tools that need no card here, as the turn works them out. */
  free: ReadonlySet<string>;
  gated: boolean;
  copied: boolean;
  asked: boolean;
  /** A command that only reads the bot's own folders. */
  readingLine: boolean;
}): boolean {
  if (o.asked || o.copied || o.gated) return false;
  if (o.readingLine) return true;
  if (READ_ONLY_TOOLS.has(o.toolName)) return true;
  if (o.toolName === 'WebFetch' || o.toolName === 'WebSearch') return o.free.has(o.toolName);
  if (!o.appTool) return false;
  return o.appTool.server ? o.appTool.readOnly : REHEARSAL_READS.has(o.appTool.name);
}
