import { BOT_IMPORT_FORMAT, MAX_BOT_IMPORT_BYTES, OLD_BOT_IMPORT_FORMAT } from './bot-import';
import { maskSecretShapes } from './secret-shapes';

/**
 * The bot import file as the other app hands it over, which is seldom a clean file: a chat reply
 * with the document in a code block and words around it, a phone that left trailing commas or
 * curled the quotes, or a long export split over several messages. This finds every import
 * document in such a text and joins them into the one document `BotImportService` reads, so a
 * pasted reply, a dropped file and a document sent over the connector all import the same way.
 */

/** What the person is told when nothing could be read; each one names what to ask the other app. */
export type BotImportTextError = 'notExport' | 'cutOff' | 'tooLarge' | 'credentials';

export class BotImportTextProblem extends Error {
  constructor(
    readonly code: BotImportTextError,
    /** The credential-looking field names, for `credentials`. */
    readonly keys: string[] = [],
  ) {
    super(code);
    this.name = 'BotImportTextProblem';
  }
}

/** Put in place of a key or token found in the text itself, outside a field of its own. */
export const BOT_IMPORT_SECRET_MARK = "[needs the user's key]";

/**
 * Field names that hold a credential. A document with one is refused whole: what else it carries
 * was written by the same hand, and the other app is told to leave them out.
 */
const CREDENTIAL_FIELD =
  /(?:^|_)(?:api_?key|apikey|token|tokens|secret|secrets|password|passwd|passphrase|credentials?|authorization|bearer|cookies?|private_?key|access_?key|client_?secret|session_?(?:id|key|token)|refresh_?token)(?:_|$)/;

/** `accessToken` and `access-token` read as `access_token`. */
const snake = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();

function credentialFields(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) credentialFields(item, found);
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (CREDENTIAL_FIELD.test(snake(key))) found.add(key);
      credentialFields(inner, found);
    }
  }
  return found;
}

/**
 * Every string in `value` with keys and tokens of a known shape masked. A picture's data is left
 * alone: base64 can hold such a shape by chance.
 */
function maskStrings<T>(value: T): T {
  if (typeof value === 'string') return maskSecretShapes(value, BOT_IMPORT_SECRET_MARK) as T;
  if (Array.isArray(value)) return value.map(maskStrings) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, k === 'avatar' ? v : maskStrings(v)]),
    ) as T;
  }
  return value;
}

/** Commas right before a `}` or `]`, outside strings: JSON refuses them, chat apps leave them. */
function dropTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Curled quotes used as JSON's own quotes, which some chat apps put in outside code blocks. Only
 * tried after the text failed as written, since a curled quote inside a string is ordinary text.
 */
const straightenQuotes = (text: string) => text.replace(/[\u201C\u201D\u201E\u201F]/g, '"');

function parse(text: string): unknown {
  for (const attempt of [(t: string) => t, dropTrailingCommas]) {
    try {
      return JSON.parse(attempt(text));
    } catch {
      // the next repair
    }
  }
  return undefined;
}

/**
 * The `{…}` spans of `text` at the top level, by matching braces outside strings. `open` is set
 * when a span starts but the text ends first: a reply the chat app cut off.
 */
function bracedSpans(text: string): { spans: string[]; open: boolean } {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (depth > 0 && ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0) spans.push(text.slice(start, i + 1));
    }
  }
  return { spans, open: depth > 0 };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const isImportDocument = (v: unknown): v is Record<string, unknown> =>
  isRecord(v) && (v.format === BOT_IMPORT_FORMAT || v.format === OLD_BOT_IMPORT_FORMAT);

/**
 * The import documents in `text`: the whole text, or objects inside chat words and code blocks.
 * With none as written, the same with curled quotes straightened.
 */
function documentsIn(text: string): { documents: Record<string, unknown>[]; cutOff: boolean } {
  const found = documentsAsWritten(text);
  if (found.documents.length) return found;
  const straight = straightenQuotes(text);
  return straight === text ? found : documentsAsWritten(straight);
}

function documentsAsWritten(text: string): { documents: Record<string, unknown>[]; cutOff: boolean } {
  const whole = parse(text.trim());
  if (isImportDocument(whole)) return { documents: [whole], cutOff: false };
  if (Array.isArray(whole) && whole.length && whole.every(isImportDocument)) {
    return { documents: whole, cutOff: false };
  }
  const documents: Record<string, unknown>[] = [];
  const { spans, open } = bracedSpans(text);
  for (const span of spans) {
    const value = parse(span);
    if (isImportDocument(value)) documents.push(value);
  }
  const named = text.includes(BOT_IMPORT_FORMAT) || text.includes(OLD_BOT_IMPORT_FORMAT);
  return { documents, cutOff: named && (open || documents.length === 0) };
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** `a` then each item of `b` not already in it: a part sent twice adds nothing. */
const union = (a: unknown[], b: unknown[]) => [...a, ...b.filter((x) => !a.some((y) => same(x, y)))];

/**
 * One bot from its parts. Lists are joined, dropping exact repeats (two routines may share a
 * name and differ); a text field keeps its last non-empty value.
 */
function mergeBot(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (Array.isArray(value)) out[key] = union(list(a[key]), value);
    else if (value !== '' && value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

/** Documents that each hold part of the export, as one: bots by `ref`, groups by name. */
function merge(documents: Record<string, unknown>[]): Record<string, unknown> {
  const [first, ...rest] = documents;
  const bots = new Map<string, Record<string, unknown>>();
  const loose: unknown[] = [];
  const groups = new Map<string, Record<string, unknown>>();
  const looseGroups: unknown[] = [];
  let notImported: unknown[] = [];
  for (const doc of documents) {
    // A ref repeated inside one document is a mistake the import names, not a part to join.
    const inThis = new Set<string>();
    for (const bot of list(doc.bots)) {
      const ref = isRecord(bot) && typeof bot.ref === 'string' ? bot.ref : null;
      if (ref === null || !isRecord(bot) || inThis.has(ref)) loose.push(bot);
      else {
        inThis.add(ref);
        bots.set(ref, bots.has(ref) ? mergeBot(bots.get(ref)!, bot) : bot);
      }
    }
    for (const group of list(doc.groups)) {
      const name = isRecord(group) && typeof group.name === 'string' ? group.name : null;
      if (name === null || !isRecord(group)) looseGroups.push(group);
      else {
        const had = groups.get(name);
        groups.set(name, had ? { ...had, members: union(list(had.members), list(group.members)) } : group);
      }
    }
    notImported = union(notImported, list(doc.notImported));
  }
  if (!rest.length) return first!;
  return {
    ...first,
    bots: [...bots.values(), ...loose],
    groups: [...groups.values(), ...looseGroups],
    notImported,
  };
}

/**
 * The import document in a pasted reply, a file's text or a connector message, ready for the
 * import's own checks. Throws `BotImportTextProblem` when there is none, it was cut off, it is too
 * large, or it names a credential. Keys of a known shape inside its texts are masked.
 */
export function botImportFromText(text: string): Record<string, unknown> {
  if (new TextEncoder().encode(text).length > MAX_BOT_IMPORT_BYTES) {
    throw new BotImportTextProblem('tooLarge');
  }
  const { documents, cutOff } = documentsIn(text.replace(/^\uFEFF/, ''));
  if (!documents.length) throw new BotImportTextProblem(cutOff ? 'cutOff' : 'notExport');
  const keys = credentialFields(documents);
  if (keys.size) throw new BotImportTextProblem('credentials', [...keys].sort());
  return maskStrings(merge(documents));
}

/** The names of the bots in an import document, for saying what arrived. */
export function botImportNames(doc: Record<string, unknown>): string[] {
  return list(doc.bots).flatMap((b) => (isRecord(b) && typeof b.name === 'string' ? [b.name.trim()] : []));
}

/** What the server found of Grok Bot on the person's computer. */
export interface GrokLook {
  /** False when the server runs elsewhere, where neither can be looked for. */
  onComputer: boolean;
  /** Export files in Downloads, newest first. */
  files: { name: string; modifiedAt: string; bots: string[] }[];
  /** The bots the Grok Bot app lists here; null when the app is not on this computer. */
  appBots: string[] | null;
}

/** The link Grok Bot sends bots over, and what has arrived on it. */
export interface GrokMoveLink {
  /** False where no link can be made: no public address and no `cloudflared` on this computer. */
  available: boolean;
  url: string | null;
  expiresAt: string | null;
  /** The link stopped working before the person ended it: its hour ran out, or the tunnel closed. */
  stopped: boolean;
  /** What arrived and was not read into the import yet, oldest first; its text is read apart. */
  arrived: { seq: number; at: string; names: string[] }[];
}

/** Why a moved bot's chat did not come over from the Grok Bot app. */
export type GrokChatReason = 'noApp' | 'noMatch' | 'ambiguous' | 'empty';
export type GrokChatResult = { id: string } & ({ messages: number } | { reason: GrokChatReason });
