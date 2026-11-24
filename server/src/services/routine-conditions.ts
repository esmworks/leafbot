import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import {
  NUMBER_BASELINE_MIN,
  NUMBER_WINDOW_MAX,
  passesFilter,
  valueAt,
  wallClock,
  zonedTime,
  type Routine,
  type RoutineCondition,
  type RoutineConditionCheck,
  type RoutineStepWhen,
} from '@leafbot/shared';
import { and, desc, eq, gte, inArray, ne } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { T } from '../i18n';
import { errorText, newId, truncate } from '../util';
import type { Services } from '.';
import { pageText } from './routines';
import { fetchPublicText } from './skill-link';

/** How a check went: it holds, it does not, or what it looks at could not be read. */
export type CheckResult = { holds: boolean; note?: string } | { unreadable: string };

/** What the whole condition says now, with a line for each check that did not hold or could not be read. */
export interface ConditionResult {
  /** `holds`: every check holds; `fails`: one does not; `unreadable`: none failed but one could not be read. */
  outcome: 'holds' | 'fails' | 'unreadable';
  lines: string[];
  /** What the checks that held read, in a line each, for the run to start from (a number and its average). */
  found: string[];
}

/** How many folders deep, and how many entries in all, a file check looks before it stops. */
const WALK_DEPTH = 6;
const WALK_ENTRIES = 5000;
/** How many mails or WhatsApp messages of the window a check reads at most, newest first. */
const READ_ROWS = 2000;
/** The longest page a page check reads. */
const PAGE_MAX = 2 * 1024 * 1024;

/** A file pattern as a regular expression over a path relative to its folder (`/` between names). */
export function patternRegex(pattern: string): RegExp {
  let out = '';
  const p = pattern.normalize('NFC');
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '*' && p[i + 1] === '*') {
      // `**/` matches no folder or any number of them; `**` at the end, anything below.
      if (p[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'i');
}

/** Midnight today in `tz`, or `hours` back from now. */
function since(now: Date, hours: number, tz: string): Date {
  if (hours > 0) return new Date(now.getTime() - hours * 3_600_000);
  const w = wallClock(now, tz);
  const p = (n: number) => String(n).padStart(2, '0');
  return zonedTime(`${w.year}-${p(w.month)}-${p(w.day)}`, '00:00', tz);
}

const lower = (v: string) => v.toLocaleLowerCase('tr').normalize('NFC');

/**
 * Looks at a routine's condition with no AI. A check that cannot be read never counts as "not
 * there": a failed call would otherwise send the "nothing came" note.
 */
export class RoutineConditions {
  constructor(
    private ctx: Ctx,
    private services: Services,
    private clock: () => Date = () => new Date(),
  ) {}

  /**
   * With `occurrence` (a scheduled slot) a number check keeps what it read for later averages;
   * without (looking at the condition now, a rehearsal) nothing is kept.
   */
  async evaluate(
    routine: Routine,
    condition: RoutineCondition,
    t: T,
    occurrence?: string,
  ): Promise<ConditionResult> {
    const lines: string[] = [];
    const found: string[] = [];
    let failed = false;
    let unreadable = false;
    for (const check of condition.checks) {
      let r: CheckResult;
      try {
        r = await this.check(routine, check, t, occurrence);
      } catch (err) {
        r = { unreadable: errorText(err, t) };
      }
      const described = describeCheck(check, t);
      const what = 'note' in r && r.note ? `${described}: ${r.note}` : described;
      if ('unreadable' in r) {
        unreadable = true;
        lines.push(t('routine.conditionUnreadable', { what, reason: truncate(r.unreadable, 300) }));
      } else if (r.holds !== !check.absent) {
        failed = true;
        lines.push(t('routine.conditionNotMet', { what }));
      } else if (r.note) found.push(what);
    }
    return { outcome: failed ? 'fails' : unreadable ? 'unreadable' : 'holds', lines, found };
  }

  /** Whether what the check looks for is there, before `absent` turns it around. */
  private async check(
    routine: Routine,
    c: RoutineConditionCheck,
    t: T,
    occurrence: string | undefined,
  ): Promise<CheckResult> {
    const now = this.clock();
    switch (c.kind) {
      case 'files': {
        const root = await this.folder(routine.botId, c.folder);
        if (!root) return { unreadable: 'no group' };
        const after = c.withinHours === null ? null : since(now, c.withinHours, routine.timezone).getTime();
        const found = await countFiles(root, patternRegex(c.pattern), after, c.min);
        return { holds: found >= c.min };
      }
      case 'email': {
        const rows = await this.ctx.db
          .select()
          .from(schema.emails)
          .where(
            and(
              eq(schema.emails.botId, routine.botId),
              gte(schema.emails.receivedAt, since(now, c.withinHours, routine.timezone)),
            ),
          )
          .orderBy(desc(schema.emails.receivedAt))
          .limit(READ_ROWS);
        return {
          holds: rows.some((m) =>
            passesFilter(
              c.filter,
              JSON.stringify({ from: m.from, to: m.to, subject: m.subject, text: m.text }),
            ),
          ),
        };
      }
      case 'whatsapp': {
        const rows = await this.ctx.db
          .select({
            text: schema.whatsappMessages.text,
            writer: schema.whatsappMessages.writer,
            fromMe: schema.whatsappMessages.fromMe,
            name: schema.whatsappChats.name,
            savedName: schema.whatsappChats.savedName,
          })
          .from(schema.whatsappMessages)
          .innerJoin(schema.whatsappChats, eq(schema.whatsappChats.jid, schema.whatsappMessages.chat))
          .where(gte(schema.whatsappMessages.at, since(now, c.withinHours, routine.timezone)))
          .orderBy(desc(schema.whatsappMessages.at))
          .limit(READ_ROWS);
        return {
          holds: rows.some((m) =>
            passesFilter(
              c.filter,
              JSON.stringify({
                chat: m.savedName || m.name,
                writer: m.writer,
                text: m.text,
                from_me: m.fromMe,
              }),
            ),
          ),
        };
      }
      case 'table': {
        const table = await this.services.tables.get(c.tableId).catch(() => null);
        if (table?.botId !== routine.botId) return { unreadable: 'table' };
        const rows = await this.ctx.db
          .select({ values: schema.botTableRows.values })
          .from(schema.botTableRows)
          .where(eq(schema.botTableRows.tableId, c.tableId));
        return { holds: rows.some((r) => passesFilter(c.filter, JSON.stringify(r.values))) };
      }
      case 'tool': {
        const person = routine.slackChannel ? null : await this.services.routines.personOf(routine);
        const { text } = await this.services.connections.callCheck(
          routine.botId,
          { connectionId: c.connectionId, tool: c.tool, args: c.args },
          person,
        );
        return { holds: toolAnswerHolds(text, c.filter, c.contains) };
      }
      case 'page': {
        const text = pageText(await fetchPublicText(new URL(c.url), PAGE_MAX));
        return { holds: lower(text).includes(lower(c.contains.trim())) };
      }
      case 'number':
        return this.number(routine, c, t, occurrence);
    }
  }

  /**
   * Reads a number check's number and compares it. Against the average, it is compared with the
   * readings of earlier slots only, and kept for later ones when read at a slot; a number that
   * could not be read is neither kept nor taken as zero.
   */
  private async number(
    routine: Routine,
    c: Extract<RoutineConditionCheck, { kind: 'number' }>,
    t: T,
    occurrence: string | undefined,
  ): Promise<CheckResult> {
    let text: string;
    if (c.from === 'tool') {
      const person = routine.slackChannel ? null : await this.services.routines.personOf(routine);
      text = (
        await this.services.connections.callCheck(
          routine.botId,
          { connectionId: c.connectionId, tool: c.tool, args: c.args },
          person,
        )
      ).text;
    } else {
      const raw = await fetchPublicText(new URL(c.url), PAGE_MAX);
      text = isJson(raw) ? raw : pageText(raw);
    }
    const value = numberIn(text, c.path);
    if (value === null) return { unreadable: t('routine.numberMissing') };
    const shown = showNumber(value);
    if (c.than === 'value')
      return {
        holds: c.op === 'above' ? value > c.threshold : value < c.threshold,
        note: t('routine.numberRead', { value: shown }),
      };
    const key = readingKey(c);
    const at = this.clock();
    const db = this.ctx.db;
    const past = await db
      .select({ value: schema.routineReadings.value })
      .from(schema.routineReadings)
      .where(
        and(
          eq(schema.routineReadings.routineId, routine.id),
          eq(schema.routineReadings.key, key),
          ...(occurrence ? [ne(schema.routineReadings.occurrence, occurrence)] : []),
        ),
      )
      .orderBy(desc(schema.routineReadings.at))
      .limit(c.window);
    if (occurrence) {
      await db
        .insert(schema.routineReadings)
        .values({ id: newId(), routineId: routine.id, key, occurrence, value, at })
        .onConflictDoNothing();
      // Only as many as the longest average reads are kept.
      const old = await db
        .select({ id: schema.routineReadings.id })
        .from(schema.routineReadings)
        .where(and(eq(schema.routineReadings.routineId, routine.id), eq(schema.routineReadings.key, key)))
        .orderBy(desc(schema.routineReadings.at))
        .offset(NUMBER_WINDOW_MAX);
      if (old.length)
        await db.delete(schema.routineReadings).where(
          inArray(
            schema.routineReadings.id,
            old.map((o) => o.id),
          ),
        );
    }
    if (past.length < NUMBER_BASELINE_MIN)
      return {
        holds: false,
        note: t('routine.numberLearning', {
          value: shown,
          have: String(past.length),
          need: String(NUMBER_BASELINE_MIN),
        }),
      };
    const average = past.reduce((sum, p) => sum + p.value, 0) / past.length;
    const change =
      average === 0
        ? value === 0
          ? 0
          : Math.sign(value) * Infinity
        : ((value - average) / Math.abs(average)) * 100;
    const holds =
      c.op === 'above'
        ? change > c.threshold
        : c.op === 'below'
          ? change < -c.threshold
          : Math.abs(change) > c.threshold;
    return {
      holds,
      note: t('routine.numberAverage', {
        value: shown,
        average: showNumber(average),
        count: String(past.length),
        change: Number.isFinite(change) ? `${change >= 0 ? '+' : ''}${showNumber(change)}%` : '∞',
      }),
    };
  }

  /** The bot's own folder, or its group's; null for a group folder of a bot in no group. */
  private async folder(botId: string, which: 'bot' | 'group'): Promise<string | null> {
    const root = resolve(this.ctx.config.dataDir, 'workspaces');
    if (which === 'bot') return join(root, 'bots', botId, 'files');
    const bot = await this.services.bots.get(botId);
    return bot.groupId ? join(root, 'groups', bot.groupId, 'files') : null;
  }
}

/**
 * Whether an app tool's answer is what the check looks for: its JSON meets `filter`, or its text
 * contains `contains`, or, with neither, it is something other than nothing, an empty list or an
 * empty object.
 */
export function toolAnswerHolds(text: string, filter: string, contains: string): boolean {
  if (filter.trim()) return passesFilter(filter, text);
  if (contains.trim()) return lower(text).includes(lower(contains.trim()));
  const bare = text.trim();
  if (!bare) return false;
  try {
    const json: unknown = JSON.parse(bare);
    if (json === null || json === false || json === 0 || json === '') return false;
    if (Array.isArray(json)) return json.length > 0;
    if (typeof json === 'object') return Object.keys(json).length > 0;
  } catch {
    // Not JSON: any text is an answer.
  }
  return true;
}

/**
 * Counts the files under `root` whose path from it matches, changed after `after` when given; it
 * stops once it has `enough`. Links are not followed, so nothing outside the folder is looked at.
 */
async function countFiles(root: string, re: RegExp, after: number | null, enough: number): Promise<number> {
  let found = 0;
  let seen = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (found >= enough || ++seen > WALK_ENTRIES) return;
      const full = join(dir, name);
      const st = await lstat(full).catch(() => null);
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (depth < WALK_DEPTH) await walk(full, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      const rel = relative(root, full).split(sep).join('/').normalize('NFC');
      if (!re.test(rel)) continue;
      if (after !== null && st.mtimeMs < after) continue;
      found++;
    }
  };
  await walk(root, 0);
  return found;
}

/** A check in a few words, for the run's reason and the bot. */
export function describeCheck(c: RoutineConditionCheck, t: T): string {
  const not = c.absent ? t('routine.conditionAbsent') : '';
  switch (c.kind) {
    case 'files':
      return t('routine.conditionFiles', {
        folder: t(c.folder === 'group' ? 'routine.conditionGroupFolder' : 'routine.conditionBotFolder'),
        pattern: c.pattern,
        min: String(c.min),
        not,
      });
    case 'email':
      return t('routine.conditionEmail', { filter: c.filter.trim().replace(/\n/g, ', ') || '*', not });
    case 'whatsapp':
      return t('routine.conditionWhatsapp', { filter: c.filter.trim().replace(/\n/g, ', ') || '*', not });
    case 'table':
      return t('routine.conditionTable', { filter: c.filter.trim().replace(/\n/g, ', ') || '*', not });
    case 'tool':
      return t('routine.conditionTool', {
        tool: c.tool,
        filter: c.filter.trim().replace(/\n/g, ', ') || c.contains.trim() || '*',
        not,
      });
    case 'page':
      return t('routine.conditionPage', { url: c.url, contains: c.contains, not });
    case 'number': {
      const source = (c.from === 'tool' ? c.tool : c.url) + (c.path ? ` (${c.path})` : '');
      return c.than === 'value'
        ? t('routine.conditionNumber', {
            source,
            op: t(`routine.conditionNumberOp.${c.op === 'below' ? 'below' : 'above'}`),
            threshold: showNumber(c.threshold),
          })
        : t('routine.conditionNumberAverage', {
            source,
            op: t(`routine.conditionNumberAway.${c.op}`),
            threshold: showNumber(c.threshold),
            window: String(c.window),
          });
    }
  }
}

/** Which history a number check's readings belong to: what it reads and where in it. */
export function readingKey(c: Extract<RoutineConditionCheck, { kind: 'number' }>): string {
  const what = c.from === 'tool' ? [c.connectionId, c.tool, JSON.stringify(c.args)] : [c.url];
  return createHash('sha256')
    .update([c.from, ...what, c.path].join('\n'))
    .digest('hex')
    .slice(0, 32);
}

const isJson = (text: string) => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

/** A number as it is shown: at most two decimals, no trailing zeros. */
const showNumber = (n: number) => String(Math.round(n * 100) / 100);

/**
 * A number as it is written in text: `1.234,5` and `1,234.5` are both 1234.5; a lone separator
 * before exactly three digits groups thousands (`12.500`), any other is the decimal point.
 */
export function parseNumber(raw: string): number | null {
  const m = /[-−]?\d[\d.,]*/.exec(raw);
  if (!m) return null;
  let s = m[0].replace('−', '-').replace(/[.,]+$/, '');
  const dots = s.split('.').length - 1;
  const commas = s.split(',').length - 1;
  if (dots && commas) {
    const decimal = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    s = s
      .split(decimal === '.' ? ',' : '.')
      .join('')
      .replace(',', '.');
  } else if (dots + commas) {
    const sep = dots ? '.' : ',';
    const parts = s.split(sep);
    s = parts.length > 2 || parts[1]!.length === 3 ? parts.join('') : parts.join('.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * The number a check reads from an answer: at `path` in it when it is JSON (dots into objects,
 * numbers into lists), after the text `path` when it is not, or else the first number in it.
 */
export function numberIn(text: string, path: string): number | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    let rest = text;
    if (path) {
      // Turkish and English letters alike: SICAKLIK finds Sıcaklık, and PRICE finds price.
      const fold = (v: string) => v.toLocaleLowerCase('tr').replace(/ı/g, 'i');
      const folded = fold(text);
      let end: number;
      if (folded.length === text.length) {
        const at = folded.indexOf(fold(path));
        if (at < 0) return null;
        end = at + path.length;
      } else {
        // Lowering changed the length, so positions would not match: look for it as written.
        const m = new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu').exec(text);
        if (!m) return null;
        end = m.index + m[0].length;
      }
      rest = text.slice(end);
    }
    return parseNumber(rest);
  }
  const v = path ? valueAt(json, path.split('.').filter(Boolean)) : json;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return typeof v === 'string' ? parseNumber(v) : null;
}

/** Whether a step's condition holds for what reached it, read with no AI. */
export function stepWhenHolds(when: RoutineStepWhen, before: string | null): boolean {
  return toolAnswerHolds(before ?? '', when.filter, when.contains) !== when.absent;
}

/** A step's condition in a few words, for the step's line in the run. */
export function describeWhen(when: RoutineStepWhen, t: T): string {
  const not = when.absent ? t('routine.conditionAbsent') : '';
  if (when.filter.trim())
    return t('routine.stepWhenFilter', { filter: when.filter.trim().replace(/\n/g, ', '), not });
  if (when.contains.trim()) return t('routine.stepWhenContains', { text: when.contains.trim(), not });
  return t(when.absent ? 'routine.stepWhenNothing' : 'routine.stepWhenSomething');
}
