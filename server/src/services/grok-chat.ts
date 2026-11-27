// Reads the Grok Bot desktop app's local client cache on this computer: the names of its bots and the recent chat of
// the one bot the person picked, so it can be imported as a conversation. Only the roster slice and that bot's
// transcript slice are opened. The app's sign-in material beside the cache (its secrets file, cookies) is never
// opened, and everything read is treated as untrusted: shapes are checked, sizes capped, secrets masked.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { maskSecretShapes, type GrokChatReason } from '@leafbot/shared';

export interface GrokChatLine {
  seq: number;
  role: 'user' | 'assistant';
  text: string;
  at: Date;
}

/** Where the app keeps its data under the home folder on macOS, Windows and Linux; the first that exists wins. */
const APP_FOLDERS = [
  ['Library', 'Application Support', 'Grok Bot'],
  ['AppData', 'Roaming', 'Grok Bot'],
  ['.config', 'Grok Bot'],
];
const CACHE_FOLDER = 'sand-client-persistence';
const KEY_PREFIX = 'sand.client.slice.account.';
/** A cache file bigger than this is skipped rather than parsed into memory. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const KEY_MARK = '[key]';

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** The key a cache file holds, from its name: unpadded base32 of the key's UTF-8 bytes plus `.blob`. */
export function sliceKey(fileName: string): string | null {
  if (!fileName.endsWith('.blob')) return null;
  const bytes: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of fileName.slice(0, -'.blob'.length).toLowerCase()) {
    const v = BASE32.indexOf(ch);
    if (v < 0) return null;
    acc = ((acc << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  // Fewer than 8 bits left over are padding, not data.
  try {
    return utf8.decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

/** The kind of slice a key names (`roster.last-roster`, `transcript.replicas.<botId>`), or null for other keys. */
function sliceKind(key: string): string | null {
  if (!key.startsWith(KEY_PREFIX)) return null;
  const rest = key.slice(KEY_PREFIX.length);
  // The account id is URL-encoded, so the first literal dot ends it.
  const dot = rest.indexOf('.');
  if (dot < 0) return null;
  try {
    return decodeURIComponent(rest.slice(dot + 1));
  } catch {
    return null;
  }
}

function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The cache folder, or null when the app has none on this computer. Symlinks are not followed. */
function cacheFolder(home: string): string | null {
  for (const parts of APP_FOLDERS) {
    const app = join(home, ...parts);
    if (!isRealDirectory(app)) continue;
    const cache = join(app, CACHE_FOLDER);
    return isRealDirectory(cache) ? cache : null;
  }
  return null;
}

/** The `value` of every cache file whose slice kind passes `want`, in file-name order. */
function readSlices(folder: string, want: (kind: string) => boolean): Json[] {
  let names: string[];
  try {
    names = readdirSync(folder).sort();
  } catch {
    return [];
  }
  const values: Json[] = [];
  for (const name of names) {
    const key = sliceKey(name);
    const kind = key === null ? null : sliceKind(key);
    if (kind === null || !want(kind)) continue;
    const path = join(folder, name);
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
      const file: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (isObject(file) && isObject(file.value)) values.push(file.value);
    } catch {
      // Unreadable or not JSON: this file is skipped, the rest still count.
    }
  }
  return values;
}

interface Bot {
  id: string;
  name: string;
}

/**
 * The bots in the roster; group chats are not bots and are left out. A bot listed by more than one
 * signed-in account counts once, so it is not taken for two bots of the same name.
 */
function rosterBots(folder: string): Bot[] {
  const bots = new Map<string, Bot>();
  for (const value of readSlices(folder, (kind) => kind === 'roster.last-roster')) {
    if (!Array.isArray(value.rows)) continue;
    for (const row of value.rows as unknown[]) {
      if (!isObject(row) || row.isGroup === true) continue;
      if (typeof row.id === 'string' && typeof row.name === 'string' && !bots.has(row.id))
        bots.set(row.id, { id: row.id, name: row.name.trim() });
    }
  }
  return [...bots.values()];
}

/** The names of the bots the app has, in the app's order; null when its cache is not on this computer. */
export function grokBotNames(home: string): string[] | null {
  const folder = cacheFolder(home);
  if (!folder) return null;
  return rosterBots(folder)
    .map((b) => b.name)
    .filter((name) => name !== '');
}

/** One chat line, trimmed and with secret-looking text masked; null when nothing is left of it. */
function line(seq: number, role: GrokChatLine['role'], text: string, at: Date): GrokChatLine | null {
  const clean = maskSecretShapes(text.trim(), KEY_MARK).trim();
  return clean === '' ? null : { seq, role, text: clean, at };
}

/** A question with choices, as the text the bot showed: the prompt, then each option on its own line. */
function widgetText(widget: Json): string {
  const options = Array.isArray(widget.options) ? (widget.options as unknown[]) : [];
  const labels = options.map((o) => (isObject(o) ? str(o.label).trim() : '')).filter((l) => l !== '');
  return [str(widget.prompt).trim(), ...labels.map((l) => `- ${l}`)].join('\n');
}

/** What the person answered to a question: the label of the chosen option, else the raw value. */
function answerText(widget: Json, responded: unknown): string {
  if (typeof responded !== 'string') return '';
  const options = Array.isArray(widget.options) ? (widget.options as unknown[]) : [];
  const chosen = options.find((o) => isObject(o) && o.value === responded);
  return isObject(chosen) ? str(chosen.label) : responded;
}

/** The chat lines of a transcript's entries, ordered by `seq`; an entry whose `seq` was seen before is ignored. */
export function grokChatLines(entries: unknown[]): GrokChatLine[] {
  const seen = new Set<number>();
  const usable: { entry: Json; seq: number; ms: number }[] = [];
  for (const entry of entries) {
    if (!isObject(entry)) continue;
    const { seq, timestampMs: ms } = entry;
    if (
      typeof seq !== 'number' ||
      !Number.isSafeInteger(seq) ||
      typeof ms !== 'number' ||
      !Number.isFinite(ms)
    )
      continue;
    if (seen.has(seq)) continue;
    seen.add(seq);
    usable.push({ entry, seq, ms });
  }
  usable.sort((a, b) => a.seq - b.seq);

  const lines: GrokChatLine[] = [];
  const add = (l: GrokChatLine | null) => l && lines.push(l);
  for (const { entry, seq, ms } of usable) {
    const at = new Date(ms);
    const kind = str(entry.kind);
    if (kind === 'message' && (entry.role === 'user' || entry.role === 'assistant')) {
      let text = str(entry.content).trim();
      // In a team chat the message says which bot wrote it.
      const from = isObject(entry.fromAgent) ? str(entry.fromAgent.name).trim() : '';
      if (from !== '' && text !== '') text = `${from}:\n${text}`;
      add(line(seq, entry.role, text, at));
    } else if (kind === 'send-message' && isObject(entry.message)) {
      const message = entry.message;
      if (message.type === 'text') add(line(seq, 'assistant', str(message.content), at));
      else if (message.type === 'attachment') add(line(seq, 'assistant', str(message.file_name), at));
      else if (message.type === 'widget' && isObject(message.widget)) {
        add(line(seq, 'assistant', widgetText(message.widget), at));
        // Kept at these exact values: they become stored client ids of chats that are already imported.
        add(line(seq + 0.5, 'user', answerText(message.widget, entry.respondedValue), new Date(ms + 1)));
      }
    } else if (kind === 'user-attachment') {
      add(line(seq, 'user', str(entry.file_name), at));
    }
  }
  return lines;
}

/** The recent chat of the bot called `name` (trimmed, case-insensitive), or why none could be read. */
export function readGrokChat(
  home: string,
  name: string,
): { lines: GrokChatLine[] } | { reason: GrokChatReason } {
  const folder = cacheFolder(home);
  if (!folder) return { reason: 'noApp' };
  const wanted = name.trim().toLowerCase();
  const matches = rosterBots(folder).filter((b) => b.name.toLowerCase() === wanted);
  // Two bots with the same name: importing the wrong one would be worse than importing none.
  if (matches.length > 1) return { reason: 'ambiguous' };
  const bot = matches[0];
  if (!bot) return { reason: 'noMatch' };
  const entries = readSlices(folder, (kind) => kind === `transcript.replicas.${bot.id}`).flatMap((v) =>
    Array.isArray(v.entries) ? (v.entries as unknown[]) : [],
  );
  const lines = grokChatLines(entries);
  return lines.length > 0 ? { lines } : { reason: 'empty' };
}
