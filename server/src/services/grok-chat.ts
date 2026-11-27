import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { maskSecretShapes } from '@leafbot/shared';

/**
 * What the Grok Bot desktop app keeps on this computer that a move may use: the names of the bots
 * it lists, and one bot's recent chat while that bot is being moved. Only the app's client cache
 * is read, and in it only the roster and that one chat; the sign-in material kept beside the cache
 * (its secrets file, cookies) is never opened. A layout this does not know reads as nothing.
 *
 * The cache's layout and this reading of it adapt an MIT-licensed importer; see NOTICE.
 */

/** Where the app keeps its data on macOS, Windows and Linux, under the home folder. */
const APP_FOLDERS = [
  ['Library', 'Application Support', 'Grok Bot'],
  ['AppData', 'Roaming', 'Grok Bot'],
  ['.config', 'Grok Bot'],
];
const CACHE_FOLDER = 'sand-client-persistence';
const SLICE_PREFIX = 'sand.client.slice.account.';
const ROSTER = 'roster.last-roster';
const CHAT = 'transcript.replicas.';
const MAX_SLICE_BYTES = 32 * 1024 * 1024;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Why a bot's chat did not come over. */
export const GROK_CHAT_REASONS = ['noApp', 'noMatch', 'ambiguous', 'empty'] as const;
export type GrokChatReason = (typeof GROK_CHAT_REASONS)[number];

/** One line of a moved chat, in the app's order and time. */
export interface GrokChatLine {
  /** The app's own number for the entry; keeps a second move from adding it again. */
  seq: number;
  role: 'user' | 'assistant';
  text: string;
  at: Date;
}

type Entry = Record<string, unknown>;
const record = (v: unknown): Entry => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Entry) : {});
const rows = (v: unknown): Entry[] => (Array.isArray(v) ? v.map(record) : []);
const words = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** A cache file's key: the file name is the key in unpadded lowercase base32, plus `.blob`. */
export function sliceKey(fileName: string): string | null {
  if (!fileName.endsWith('.blob')) return null;
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of fileName.slice(0, -'.blob'.length).toUpperCase()) {
    const digit = BASE32.indexOf(ch);
    if (digit < 0) return null;
    value = ((value << 5) | digit) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

/** What an account's slice holds (`roster.last-roster`, `transcript.replicas.<id>`), from its key. */
function sliceKind(key: string | null): string | null {
  if (!key?.startsWith(SLICE_PREFIX)) return null;
  // The account id is URL-encoded, so a dot in it is not taken for the separator.
  const dot = key.indexOf('.', SLICE_PREFIX.length);
  if (dot < 0) return null;
  try {
    return decodeURIComponent(key.slice(dot + 1));
  } catch {
    return null;
  }
}

/** The app's cache on this computer, or null when the app is not here. */
function cache(home: string) {
  let folder: string | undefined;
  for (const parts of APP_FOLDERS) {
    const path = join(home, ...parts, CACHE_FOLDER);
    try {
      if (lstatSync(path).isDirectory()) {
        folder = path;
        break;
      }
    } catch {
      // not here
    }
  }
  if (!folder) return null;
  let files: string[];
  try {
    files = readdirSync(folder);
  } catch {
    return null;
  }
  const read = (kind: string): Entry | null => {
    const file = files.find((f) => sliceKind(sliceKey(f)) === kind);
    if (!file) return null;
    try {
      const path = join(folder, file);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > MAX_SLICE_BYTES) return null;
      return record(record(JSON.parse(readFileSync(path, 'utf8'))).value);
    } catch {
      return null;
    }
  };
  const bots = rows(read(ROSTER)?.rows).filter(
    (r) => r.isGroup !== true && typeof r.id === 'string' && typeof r.name === 'string',
  );
  return { bots, read };
}

/** The names of the bots the app lists here; null when the app is not on this computer. */
export function grokBotNames(home: string): string[] | null {
  const found = cache(home);
  return found ? found.bots.map((b) => words(b.name)).filter(Boolean) : null;
}

/**
 * A bot's recent chat in the app, found by its name there. The app lets names repeat, so a name
 * that fits several bots picks none rather than the wrong one.
 */
export function readGrokChat(
  home: string,
  name: string,
): { lines: GrokChatLine[] } | { reason: GrokChatReason } {
  const found = cache(home);
  if (!found) return { reason: 'noApp' };
  const key = name.trim().toLowerCase();
  const named = found.bots.filter((b) => words(b.name).toLowerCase() === key);
  if (named.length > 1) return { reason: 'ambiguous' };
  if (!named.length) return { reason: 'noMatch' };
  const lines = grokChatLines(rows(found.read(`${CHAT}${named[0]!.id as string}`)?.entries));
  return lines.length ? { lines } : { reason: 'empty' };
}

/**
 * The chat's entries as lines, read as untrusted: the person's and the bot's messages, a question
 * the bot asked with its choices and the answer picked, and the names of files sent. Other kinds
 * (forms, approvals, calls) are left out. Keys of a known shape are masked.
 */
export function grokChatLines(entries: readonly Entry[]): GrokChatLine[] {
  const ordered = entries
    .filter((e) => Number.isSafeInteger(e.seq) && Number.isFinite(e.timestampMs))
    .sort((a, b) => (a.seq as number) - (b.seq as number));
  const out: GrokChatLine[] = [];
  const seen = new Set<number>();
  const add = (seq: number, at: number, role: GrokChatLine['role'], text: string) => {
    const clean = maskSecretShapes(text.trim(), '[key]');
    if (clean) out.push({ seq, role, text: clean, at: new Date(at) });
  };
  for (const e of ordered) {
    const seq = e.seq as number;
    if (seen.has(seq)) continue;
    seen.add(seq);
    const at = e.timestampMs as number;
    if (e.kind === 'message' && (e.role === 'user' || e.role === 'assistant')) {
      // In a team chat a message names the bot that wrote it or the one it went to.
      const from = words(record(e.fromAgent).name);
      const text = words(e.content);
      add(seq, at, e.role, from && text ? `${from}:\n${text}` : text);
    } else if (e.kind === 'send-message') {
      const m = record(e.message);
      if (m.type === 'text') add(seq, at, 'assistant', words(m.content));
      else if (m.type === 'attachment') add(seq, at, 'assistant', words(m.file_name));
      else if (m.type === 'widget') {
        const widget = record(m.widget);
        const options = rows(widget.options);
        const labels = options.map((o) => words(o.label)).filter(Boolean);
        add(seq, at, 'assistant', [words(widget.prompt), ...labels.map((l) => `- ${l}`)].join('\n'));
        const picked = options.find((o) => o.value === e.respondedValue);
        const answer = words(picked?.label) || words(e.respondedValue);
        // The answer is the person's, a moment after the question.
        if (answer) out.push({ seq: seq + 0.5, role: 'user', text: answer, at: new Date(at + 1) });
      }
    } else if (e.kind === 'user-attachment') {
      add(seq, at, 'user', words(e.file_name));
    }
  }
  return out;
}
