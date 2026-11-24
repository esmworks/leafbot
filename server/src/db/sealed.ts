import { sql, type SQL } from 'drizzle-orm';
import { customType, type PgColumn } from 'drizzle-orm/pg-core';
import { openWith, sealWith } from '../crypto';

/**
 * Content sealed at rest: conversation text, prompts, memory, mail and the like are written to the
 * database encrypted (AES-256-GCM) while sealing is on, so a copy of the database (a dump, a backup
 * of the Postgres server, a disk) does not reveal them. The key comes from the vault key in the
 * data folder, which the database never holds.
 *
 * A sealed text is `yb1:` followed by exactly the shape AES-GCM gives (a 12-byte iv, a 16-byte tag
 * and the data, each base64), so ordinary text that happens to start with `yb1:` is never taken
 * for sealed. Anything else is read as it is: sealed and plain rows live side by side while
 * existing rows are converted. One server runs per process, so the key and switches are the
 * process's.
 */
const PREFIX = 'yb1:';
const SHAPE = /^yb1:[A-Za-z0-9+/]{16}:[A-Za-z0-9+/]{22}==:[A-Za-z0-9+/]*={0,2}$/;
/** The same shape as the database matches it. */
const SHAPE_SQL = "'^yb1:[A-Za-z0-9+/]{16}:[A-Za-z0-9+/]{22}==:[A-Za-z0-9+/]*={0,2}$'";
/** The marker of a JSON value (or a part of one) sealed as a whole. */
const MARK = '$sealed';

let key: Buffer | null = null;
let sealing = false;
let inServer = false;

export function setContentKey(k: Buffer | null) {
  key = k;
}

/** Whether new writes are sealed; reads open sealed values either way. */
export function setSealing(on: boolean) {
  sealing = on && !!key;
}

export const contentSealed = () => sealing;

/**
 * Whether text searches must open and match rows in the server: while sealing is on, and while
 * sealed rows are being opened again after it was turned off.
 */
export function setMatchInServer(on: boolean) {
  inServer = on;
}

export const matchInServer = () => inServer || sealing;

/** Whether a value as stored is sealed text. */
export const isSealed = (v: unknown) => typeof v === 'string' && SHAPE.test(v);

export function sealText(v: string): string {
  if (!sealing || !key || !v || isSealed(v)) return v;
  return `${PREFIX}${sealWith(key, v)}`;
}

/** The text of a stored value: itself when plain, opened when sealed, null when it cannot be opened. */
export function tryOpenText(v: string): string | null {
  if (!isSealed(v)) return v;
  if (!key) return null;
  try {
    return openWith(key, v.slice(PREFIX.length));
  } catch {
    // Sealed with another key: a database moved without its data folder.
    return null;
  }
}

/** As `tryOpenText`, with what cannot be opened read as empty. */
export const openText = (v: string): string => (typeof v === 'string' ? (tryOpenText(v) ?? '') : v);

const sealedPart = (v: unknown) => ({ [MARK]: sealText(JSON.stringify(v)) });
const isSealedPart = (v: unknown): v is { [MARK]: string } =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  typeof (v as Record<string, unknown>)[MARK] === 'string';
/** A sealed part's value; undefined when it cannot be opened. */
function openPart(v: { [MARK]: string }): unknown {
  const text = tryOpenText(v[MARK]);
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
/**
 * A jsonb value as the driver hands it: JSON text from some drivers, already parsed (a JSON string
 * as a plain string) from others, as drizzle's own jsonb reads it.
 */
function parse(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
}

/** A text column sealed at rest while sealing is on; the database sees plain `text`. */
export const sealedText = customType<{ data: string; driverData: string }>({
  dataType: () => 'text',
  toDriver: (v) => sealText(v),
  fromDriver: (v) => openText(v),
});

/** A JSON column sealed as a whole while sealing is on (history entries, a card's input). */
export const sealedJson = customType<{ data: unknown; driverData: string }>({
  dataType: () => 'jsonb',
  toDriver: (v) => JSON.stringify(sealing ? sealedPart(v) : v),
  fromDriver: (raw) => {
    const v = parse(raw);
    return isSealedPart(v) ? (openPart(v) ?? null) : v;
  },
});

/**
 * Keys of a message's props that carry what was said: a quoted reply, a quote, a plan, quick replies, file names, a page, a card and its answer. They are sealed one by one; the other keys
 * are flags queries filter on (queued, steering, retryAt) and stay as they are.
 */
export const CONTENT_PROPS = [
  'replyTo',
  'quote',
  'plan',
  'quickReplies',
  'files',
  'page',
  'card',
  'cardAnswer',
];

function sealProps(v: Record<string, unknown>): Record<string, unknown> {
  if (!sealing) return v;
  const out: Record<string, unknown> = { ...v };
  for (const k of CONTENT_PROPS) if (k in out && !isSealedPart(out[k])) out[k] = sealedPart(out[k]);
  return out;
}

/** A message's props with its content keys opened; undefined when one cannot be opened. */
export function openProps(raw: unknown): Record<string, unknown> | undefined {
  const v = parse(raw) as Record<string, unknown>;
  if (!v || typeof v !== 'object') return v;
  let out: Record<string, unknown> | null = null;
  for (const k of CONTENT_PROPS) {
    if (!isSealedPart(v[k])) continue;
    const opened = openPart(v[k]);
    if (opened === undefined) return undefined;
    out ??= { ...v };
    out[k] = opened;
  }
  return out ?? v;
}

/** A message's props, with the keys that carry content sealed while sealing is on. */
export const sealedProps = customType<{ data: Record<string, unknown>; driverData: string }>({
  dataType: () => 'jsonb',
  toDriver: (v) => JSON.stringify(sealProps(v)),
  fromDriver: (raw) => {
    const opened = openProps(raw);
    if (opened) return opened;
    // A part sealed with another key: it is left out rather than shown as something it is not.
    const v = parse(raw) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(v).filter(([, x]) => !isSealedPart(x)));
  },
});

export type SealKind = 'text' | 'json' | 'props';

/**
 * The rows of a column that are not stored as the switch says: plain where it should be sealed,
 * or sealed where it should be plain. Written as SQL literals, so no value goes through the column
 * type on the way in.
 */
export function staleWhere(kind: SealKind, c: PgColumn, on: boolean): SQL {
  const sealedText = sql.raw(SHAPE_SQL);
  if (kind === 'text') return on ? sql`${c} <> '' and ${c} !~ ${sealedText}` : sql`${c} ~ ${sealedText}`;
  if (kind === 'json') {
    const whole = sql`(jsonb_typeof(${c}) = 'object' and ${c} ? ${sql.raw(`'${MARK}'`)})`;
    return on ? sql`not ${whole}` : whole;
  }
  const parts = CONTENT_PROPS.map((k) => {
    const part = sql`(jsonb_typeof(${c}->${sql.raw(`'${k}'`)}) = 'object' and ${c}->${sql.raw(`'${k}'`)} ? ${sql.raw(`'${MARK}'`)})`;
    return on ? sql`(${c} ? ${sql.raw(`'${k}'`)} and not ${part})` : part;
  });
  return sql`(${sql.join(parts, sql` or `)})`;
}

/**
 * A stored value (as text) opened into what the column holds, to be written back under the
 * current switch; undefined when some part of it cannot be opened, so it is left as it is.
 */
export function openStored(kind: SealKind, raw: string): unknown {
  if (kind === 'text') return tryOpenText(raw) ?? undefined;
  if (kind === 'props') return openProps(raw);
  const v = parse(raw);
  return isSealedPart(v) ? openPart(v) : v;
}
