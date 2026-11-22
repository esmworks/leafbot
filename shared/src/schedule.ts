import { z } from 'zod';
import { createTranslator, DEFAULT_LOCALE, INTL_LOCALE, type Catalog, type Locale } from './i18n';
import { cronDay, parseCron } from './cron';
import { patchOf } from './patch';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'validation.time');

/** The shortest time between two runs of a routine, as `interval` allows it. */
export const MIN_RUN_GAP_MINUTES = 5;

export const Schedule = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hourly'), minute: z.number().int().min(0).max(59) }),
  z.object({ type: z.literal('daily'), time }),
  z.object({ type: z.literal('weekdays'), time }),
  z.object({
    type: z.literal('weekly'),
    /** 0 = Sunday ... 6 = Saturday */
    days: z.array(z.number().int().min(0).max(6)).min(1),
    time,
  }),
  z.object({ type: z.literal('monthly'), day: z.number().int().min(1).max(31), time }),
  z
    .object({
      type: z.literal('interval'),
      minutes: z
        .number()
        .int()
        .min(MIN_RUN_GAP_MINUTES)
        .max(7 * 24 * 60),
      /** Only on these weekdays (0 = Sunday); every day when left out. */
      days: z.array(z.number().int().min(0).max(6)).min(1).optional(),
      /** Only between these local times, both included; all day when left out. */
      from: time.optional(),
      to: time.optional(),
    })
    .refine((s) => !s.from === !s.to && (!s.from || s.from < s.to!), 'validation.timeWindow'),
  /** A five-field cron expression (`0 9 * * 1-5`), read in the routine's time zone. */
  z.object({
    type: z.literal('cron'),
    expr: z
      .string()
      .trim()
      .max(120)
      .refine((e) => parseCron(e) !== null, 'validation.cron'),
  }),
  /** One run at a local date and time; the routine turns itself off after it. */
  z.object({
    type: z.literal('once'),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'validation.date'),
    time,
  }),
]);
export type Schedule = z.infer<typeof Schedule>;

/**
 * A connected app's read-only tool called before each scheduled run, with no AI: the bot runs only
 * when the tool's answer differs from the last check (a new email, a new issue), and gets that
 * answer. A quiet tick then costs nothing.
 */
export const RoutineCheck = z.object({
  connectionId: z.string().min(1).max(64),
  /** The tool's own name on the app's server. */
  tool: z.string().min(1).max(200),
  args: z.record(z.string(), z.unknown()).default({}),
});
export type RoutineCheck = z.infer<typeof RoutineCheck>;

/** The most steps a routine may have after its own instruction. */
export const ROUTINE_STEP_MAX = 10;

const stepId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);

/** The tool name of the card an approval step asks the person on. */
export const ROUTINE_APPROVAL_TOOL = 'routine_approval';

/** The longest an approval step waits for the person, in days. */
export const ROUTINE_APPROVAL_MAX_DAYS = 30;
/** The longest a step waits for a time, in minutes: as long as the longest wait for the person. */
export const ROUTINE_WAIT_MAX_MINUTES = ROUTINE_APPROVAL_MAX_DAYS * 24 * 60;
/** How many values a run keeps for its wait steps, and how long each may be. */
export const ROUTINE_VARS_MAX = 20;
export const ROUTINE_VAR_MAX = 500;
/** A value's name, as a wait step's filter writes it between `{{` and `}}`. */
export const ROUTINE_VAR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** The names of the values a filter puts in, each once, in order. */
export function filterVars(filter: string): string[] {
  return [...new Set([...filter.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]{0,39})\s*\}\}/g)].map((m) => m[1]!))];
}

/**
 * A wait step's filter with the run's values put in. Null when one it names has none: an empty
 * value would make a line such as `title~={{x}}` match every event, so the wait never starts.
 */
export function fillFilter(filter: string, vars: Readonly<Record<string, string>>): string | null {
  let missing = false;
  const filled = filter.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]{0,39})\s*\}\}/g, (_, name: string) => {
    const v = vars[name]?.trim();
    if (!v) missing = true;
    return v ?? '';
  });
  return missing ? null : filled;
}

/**
 * A step of a routine after its own instruction, done once the step before it ended well.
 * `agent`: the bot works on another instruction, with the step before it as what it builds on, on a
 * model of its own when one is named (empty for the routine's). `approval`: the run waits for the
 * person to answer `question` about what the step before it ended with; they let it go on, turn it
 * down (the run stops), or write what to change (the step before it is done again with that). Left
 * unanswered for `timeoutDays`, the run ends. `wait`: the run waits `minutes`, or for the routine's
 * webhook to be called or a mail to come to the bot whose content passes `filter` (the run's saved
 * values put in for `{{name}}`); what came is handed to the next step. No event in `timeoutDays`
 * ends the run. `notify`: with no AI, `text` (the run's saved values put in for `{{name}}`) and,
 * with `withBefore`, what the step before it ended with go where the routine reports.
 */
export const RoutineStep = z.discriminatedUnion('kind', [
  z.object({
    id: stepId,
    kind: z.literal('agent'),
    prompt: z.string().trim().min(1, 'validation.stepPrompt').max(20_000),
    model: z.string().trim().max(200).default(''),
  }),
  z.object({
    id: stepId,
    kind: z.literal('approval'),
    question: z.string().trim().min(1, 'validation.stepQuestion').max(2000),
    timeoutDays: z.number().int().min(1).max(ROUTINE_APPROVAL_MAX_DAYS).default(7),
  }),
  z.object({
    id: stepId,
    kind: z.literal('notify'),
    text: z.string().trim().max(4000).default(''),
    withBefore: z.boolean().default(true),
  }),
  z.object({
    id: stepId,
    kind: z.literal('wait'),
    on: z.enum(['time', 'webhook', 'email']),
    minutes: z.number().int().min(1).max(ROUTINE_WAIT_MAX_MINUTES).default(60),
    filter: z.string().max(2000).default(''),
    timeoutDays: z.number().int().min(1).max(ROUTINE_APPROVAL_MAX_DAYS).default(7),
  }),
]);
export type RoutineStep = z.infer<typeof RoutineStep>;
export type RoutineStepKind = RoutineStep['kind'];

export const Routine = z.object({
  /** The person whose work it runs as; null for the bot's owner. Missing on older servers. */
  createdByUserId: z.string().nullable().optional(),
  id: z.string(),
  botId: z.string(),
  name: z.string(),
  prompt: z.string(),
  /** What it does after its instruction, in order; empty for a routine of one instruction. Missing on older servers. */
  steps: z.array(RoutineStep).optional(),
  schedule: Schedule,
  timezone: z.string(),
  enabled: z.boolean(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  createdAt: z.string(),
  missed: z.enum(['run', 'skip']),
  /** Each run is given the previous run's report to build on. */
  carryReport: z.boolean(),
  /** Runs in the bot's main conversation instead of one of its own. */
  inMain: z.boolean(),
  /** The Slack channel its reports go to; it then works only with what the team shares. */
  slackChannel: z.string().nullable().optional(),
  /**
   * The Slack reaction (an emoji's name) that runs it on the message its person reacts to; empty
   * for none. Missing on older servers.
   */
  slackReaction: z.string().optional(),
  /** Also runs once each time the server starts. */
  onStartup: z.boolean(),
  /** A page checked before each scheduled run, without the AI; the bot runs only when it changed. */
  watchUrl: z.string().nullable(),
  /** A connected app's tool checked before each scheduled run; the bot runs only when its answer changed. */
  check: RoutineCheck.nullable(),
  /** Conditions a webhook call's JSON body must meet to start the routine, one per line. */
  webhookFilter: z.string(),
  /** A webhook call only posts what it carries, as the bot's message, with no AI turn. */
  webhookPost: z.boolean(),
  /** The model its runs use, on the bot's own engine; empty for the bot's model. */
  model: z.string(),
  /** Also runs when mail arrives at the bot's address. */
  emailTrigger: z.boolean(),
  /** Conditions a mail must meet to start it, one per line, on from, to, subject and text. */
  emailFilter: z.string(),
  /** The WhatsApp group whose new messages also start it; null for none. Missing on older servers. */
  whatsappGroup: z.string().nullable().optional(),
  /** Also runs when someone writes to the linked WhatsApp account. Missing on older servers. */
  whatsappPeople: z.boolean().optional(),
  /**
   * The bot's table whose rows, once the routine's person fills one in or changes it to meet
   * `tableFilter`, also start it; null for none. Missing on older servers.
   */
  tableTrigger: z.string().nullable().optional(),
  /** Conditions a new row's cells must meet to start it, one per line. Missing on older servers. */
  tableFilter: z.string().optional(),
  /**
   * The id of the connection a run found signed out: its scheduled runs are skipped until the
   * person signs in to it again. Null when nothing waits; missing on older servers.
   */
  signInWait: z.string().nullable().optional(),
  /**
   * The secret part of the address that starts the routine from another service (a webhook);
   * null when it has none.
   */
  webhookToken: z.string().nullable(),
});
export type Routine = z.infer<typeof Routine>;

export const RoutineCreate = z.object({
  botId: z.string(),
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(20_000),
  /** Steps done in order after the instruction, each once the one before it ended well. */
  steps: z
    .array(RoutineStep)
    .max(ROUTINE_STEP_MAX)
    .refine((s) => new Set(s.map((x) => x.id)).size === s.length, 'validation.stepIds')
    .default([]),
  schedule: Schedule,
  timezone: z.string().refine(isValidTimeZone, 'validation.timezone').default('Europe/Istanbul'),
  enabled: z.boolean().default(true),
  /**
   * What happens to a run that came due while the server was off: `run` runs it once when the
   * server is back, `skip` drops it and waits for the next one.
   */
  missed: z.enum(['run', 'skip']).default('run'),
  /** Each run is given the previous finished run's report, so it can say what changed since. */
  carryReport: z.boolean().default(false),
  /**
   * Runs in the bot's main conversation, where the person talks to it and with what was said there,
   * instead of a conversation of its own.
   */
  inMain: z.boolean().default(false),
  /**
   * The Slack channel's id (`C…`, `G…`) its reports are posted to; null for none. The routine then
   * runs as a team conversation, with no one's own notes, apps or sign-ins.
   */
  slackChannel: z
    .string()
    .trim()
    .regex(/^[CG][A-Z0-9]{6,20}$/, 'validation.slackChannel')
    .nullable()
    .default(null),
  /**
   * The emoji name (`eyes`, `white_check_mark`) whose reaction in Slack, by the routine's own person
   * on a message the bot can read, runs it on that message; empty for none.
   */
  slackReaction: z
    .string()
    .trim()
    .transform((v) => v.replace(/^:|:$/g, '').toLowerCase())
    .pipe(z.string().regex(/^[a-z0-9_+'-]{0,80}$/, 'validation.slackReaction'))
    .default(''),
  /** Also runs once each time the server starts: on a desktop, when the computer is turned on. */
  onStartup: z.boolean().default(false),
  /**
   * An https page read before each scheduled run, with no AI: the bot runs only when the page's
   * text changed since the last read, and gets the new text. Null for none.
   */
  watchUrl: z
    .string()
    .trim()
    .max(2000)
    .regex(/^https:\/\/\S+$/, 'validation.watchUrl')
    .nullable()
    .default(null),
  check: RoutineCheck.nullable().default(null),
  /** `field=value`, `field!=value` or `field` lines; a webhook call must meet all of them. */
  webhookFilter: z.string().max(2000).default(''),
  webhookPost: z.boolean().default(false),
  model: z.string().trim().max(200).default(''),
  emailTrigger: z.boolean().default(false),
  emailFilter: z.string().max(2000).default(''),
  /**
   * A WhatsApp group's address (`…@g.us`): its new messages, with their files, start a run a few
   * minutes after the group goes quiet. Only groups a routine follows are read; null for none.
   */
  whatsappGroup: z
    .string()
    .trim()
    .regex(/^[\d-]{5,60}@g\.us$/, 'validation.whatsappGroup')
    .nullable()
    .default(null),
  /**
   * Also runs when someone writes to the linked WhatsApp account in a chat of their own (not a
   * group, not the person's own chat with the bots): each chat's new messages start a run of its
   * own, a couple of minutes after the chat goes quiet.
   */
  whatsappPeople: z.boolean().default(false),
  /**
   * The id of one of the bot's tables: a row the routine's person adds or changes there in the app
   * starts a run with that row, once, the first time it has something in it and meets
   * `tableFilter`. A row the bot writes does not, so a run that fills the table cannot start itself
   * again, and nobody else's text steers a run that works with the person's apps and notes.
   */
  tableTrigger: z.string().min(1).max(64).nullable().default(null),
  /** `column=value`, `column!=value`, `column~=text` or `column` lines; a new row must meet all of them. */
  tableFilter: z.string().max(2000).default(''),
});
export type RoutineCreate = z.infer<typeof RoutineCreate>;
export const RoutineUpdate = patchOf(RoutineCreate.omit({ botId: true }));

/**
 * The pre-check before a routine run that a watched page change or a webhook started: `off` runs
 * every time, `shadow` asks a small model and only records what it said, `on` skips the runs it
 * says have nothing new to work on.
 */
export const ROUTINE_GATE_MODES = ['off', 'shadow', 'on'] as const;
export type RoutineGateMode = (typeof ROUTINE_GATE_MODES)[number];
export const RoutineGateDecision = z.enum(['run', 'skip']);

export const RoutineRunStatus = z.enum([
  'running',
  'done',
  'error',
  'stopped',
  'skipped',
  'waiting',
  'queued',
]);
export const RoutineRun = z.object({
  id: z.string(),
  routineId: z.string(),
  occurrence: z.string(),
  status: RoutineRunStatus,
  reason: z.string().nullable(),
  threadId: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  /**
   * What the small model said before the run, when the routine pre-check looked at it: `skip` means
   * the run looked like it had nothing new to work on. Null when no pre-check ran.
   */
  gate: z.object({ decision: RoutineGateDecision, reason: z.string() }).nullable(),
  /**
   * Each step of a run of a routine with steps, its own instruction first; missing for a run of a
   * routine with none, and on older servers.
   */
  steps: z.array(z.lazy(() => RoutineStepRun)).optional(),
});
export type RoutineRun = z.infer<typeof RoutineRun>;

/** How a step of a run went; `pending` has not started. */
export const RoutineStepRunStatus = z.enum([
  'pending',
  'running',
  'done',
  'error',
  'stopped',
  'skipped',
  'waiting',
]);
export const RoutineStepRun = z.object({
  /** 0 is the routine's own instruction, 1 the first step after it. */
  position: z.number().int().min(0),
  /** `prompt` for the routine's own instruction, otherwise the step's kind. */
  kind: z.string(),
  status: RoutineStepRunStatus,
  /** What the step ended with, cut short: the bot's answer, or the person's. */
  output: z.string().nullable(),
  reason: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** The card an approval step asks on; missing for other steps and on older servers. */
  approvalId: z.string().nullable().optional(),
  /** When a step waiting for the person or for something to happen gives up. */
  waitUntil: z.string().nullable().optional(),
});
export type RoutineStepRun = z.infer<typeof RoutineStepRun>;

/** An instruction a routine had, with when it was saved; the newest is the one it has now. */
export const RoutineRevision = z.object({
  id: z.string(),
  prompt: z.string(),
  createdAt: z.string(),
});
export type RoutineRevision = z.infer<typeof RoutineRevision>;

/** One step of a rehearsal, in order: `ran` only read and was done, `would` is what the bot would have done. */
export const RehearsalStep = z.object({
  kind: z.enum(['ran', 'would']),
  tool: z.string(),
  summary: z.string(),
  at: z.string(),
});
export type RehearsalStep = z.infer<typeof RehearsalStep>;

/** Starts a rehearsal: `prompt` is the instruction as typed (the saved one when left out); `replayRunId` a run whose input is replayed. */
export const RehearsalStart = z.object({
  prompt: z.string().min(1).max(20_000).optional(),
  replayRunId: z.string().min(1).max(64).optional(),
});
export type RehearsalStart = z.infer<typeof RehearsalStart>;

/** A routine tried once without doing anything, as its person reads it. */
export const Rehearsal = z.object({
  id: z.string(),
  routineId: z.string(),
  /** The instruction was the one typed in the dialog, not the saved one. */
  draft: z.boolean(),
  prompt: z.string(),
  status: z.enum(['running', 'done', 'error', 'stopped']),
  /** What the bot wrote at the end. */
  report: z.string(),
  steps: z.array(RehearsalStep),
  error: z.string().nullable(),
  /** Engine-reported cost in US dollars; null until it ends or when the engine does not tell. */
  costUsd: z.number().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  /** The run whose input was replayed, with the report it actually wrote; null when none was. */
  replay: z
    .object({
      runId: z.string(),
      startedAt: z.string(),
      status: RoutineRunStatus,
      report: z.string().nullable(),
    })
    .nullable(),
});
export type Rehearsal = z.infer<typeof Rehearsal>;

/** One of a routine's latest runs, and whether what started it was kept so it can be replayed. */
export const ReplayableRun = z.object({
  runId: z.string(),
  startedAt: z.string(),
  status: RoutineRunStatus,
  trigger: z.string().nullable(),
  replayable: z.boolean(),
});
export type ReplayableRun = z.infer<typeof ReplayableRun>;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function wallClock(date: Date, tz: string): WallClock {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday ?? 'Sun'] ?? 0,
  };
}

function parseTime(t: string): [number, number] {
  const [h, m] = t.split(':').map(Number);
  return [h ?? 0, m ?? 0];
}

function matches(s: Schedule, w: WallClock): boolean {
  switch (s.type) {
    case 'hourly':
      return w.minute === s.minute;
    case 'daily': {
      const [h, m] = parseTime(s.time);
      return w.hour === h && w.minute === m;
    }
    case 'weekdays': {
      const [h, m] = parseTime(s.time);
      return w.weekday >= 1 && w.weekday <= 5 && w.hour === h && w.minute === m;
    }
    case 'weekly': {
      const [h, m] = parseTime(s.time);
      return s.days.includes(w.weekday) && w.hour === h && w.minute === m;
    }
    case 'monthly': {
      const [h, m] = parseTime(s.time);
      return w.day === s.day && w.hour === h && w.minute === m;
    }
    case 'interval':
    case 'once':
    case 'cron':
      return false;
  }
}

/** The moment a local date and time in `tz` happens, as a UTC Date. */
export function zonedTime(date: string, time: string, tz: string): Date {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = parseTime(time);
  const wanted = Date.UTC(y, mo - 1, d, h, mi);
  // Start from the wall time read as UTC and correct by the zone's offset; twice covers a change.
  let at = wanted;
  for (let i = 0; i < 2; i++) {
    const w = wallClock(new Date(at), tz);
    at += wanted - Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  }
  return new Date(at);
}

const MINUTE = 60_000;

/**
 * Next run strictly after `after`, as a minute-aligned UTC Date.
 * For `interval`, runs are spaced from `lastRun` (or start one interval after `after`).
 * Returns null if nothing matches within ~62 days (e.g. monthly day 31 never appears).
 */
export function nextRun(s: Schedule, tz: string, after: Date, lastRun?: Date | null): Date | null {
  if (s.type === 'once') {
    const at = zonedTime(s.date, s.time, tz);
    // Its one slot: due until it has run, even when it went by while the server was off.
    return lastRun && lastRun.getTime() >= at.getTime() ? null : at;
  }
  if (s.type === 'interval') {
    const base = lastRun ?? after;
    let next = Math.floor(base.getTime() / MINUTE) * MINUTE + s.minutes * MINUTE;
    if (next <= after.getTime()) {
      const missed = Math.ceil((after.getTime() - next) / (s.minutes * MINUTE));
      next += missed * s.minutes * MINUTE;
      if (next <= after.getTime()) next += s.minutes * MINUTE;
    }
    return intoWindow(s, tz, new Date(next));
  }
  if (s.type === 'cron') return nextCron(s.expr, tz, after, lastRun);
  let t = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE;
  const limit = t + 62 * 24 * 60 * MINUTE;
  // Fast path: jump hour by hour while the hour cannot match (all schedules except hourly fix the hour).
  // When clocks fall back, the same wall time happens twice; run it only once.
  const last = lastRun ? wallClock(lastRun, tz) : null;
  const sameAsLast = (w: WallClock) =>
    !!last &&
    w.year === last.year &&
    w.month === last.month &&
    w.day === last.day &&
    w.hour === last.hour &&
    w.minute === last.minute;
  while (t < limit) {
    const w = wallClock(new Date(t), tz);
    if (matches(s, w) && !sameAsLast(w)) return new Date(t);
    if (s.type !== 'hourly') {
      const [h] = parseTime(s.time);
      if (w.hour !== h) {
        t += (60 - w.minute) * MINUTE;
        continue;
      }
    }
    t += MINUTE;
  }
  return null;
}

/**
 * The next minute after `after` a cron expression names in `tz`, looking up to a year and a bit
 * ahead. Whole months, days and hours that cannot match are skipped at once.
 */
function nextCron(expr: string, tz: string, after: Date, lastRun?: Date | null): Date | null {
  const c = parseCron(expr);
  if (!c) return null;
  const last = lastRun ? wallClock(lastRun, tz) : null;
  let t = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE;
  const limit = t + 370 * 24 * 60 * MINUTE;
  while (t < limit) {
    const w = wallClock(new Date(t), tz);
    if (!c.months.has(w.month)) {
      const next = new Date(Date.UTC(w.year, w.month, 1)).toISOString().slice(0, 10);
      t = Math.max(t + MINUTE, zonedTime(next, '00:00', tz).getTime());
      continue;
    }
    if (!cronDay(c, w.day, w.weekday)) {
      t = Math.max(t + MINUTE, zonedTime(dayAfter(w, 1), '00:00', tz).getTime());
      continue;
    }
    if (!c.hours.has(w.hour)) {
      t += (60 - w.minute) * MINUTE;
      continue;
    }
    const repeat =
      !!last &&
      last.year === w.year &&
      last.month === w.month &&
      last.day === w.day &&
      last.hour === w.hour &&
      last.minute === w.minute;
    if (c.minutes.has(w.minute) && !repeat) return new Date(t);
    t += MINUTE;
  }
  return null;
}

/**
 * Whether a cron expression runs closer together than routines may (`* * * * *`, `*\/2 9 * * *`).
 * Its next runs are worked out from a fixed day in UTC, enough of them to see a whole busy hour.
 */
export function cronTooOften(expr: string): boolean {
  let at = new Date(Date.UTC(2026, 0, 5));
  let last: Date | null = null;
  for (let i = 0; i < 70; i++) {
    const next = nextCron(expr, 'UTC', at, last);
    if (!next) return false;
    if (last && next.getTime() - last.getTime() < MIN_RUN_GAP_MINUTES * MINUTE) return true;
    last = next;
    at = next;
  }
  return false;
}

type IntervalSchedule = Extract<Schedule, { type: 'interval' }>;

/** The local date `days` after a wall clock's date, as YYYY-MM-DD. */
function dayAfter(w: WallClock, days: number): string {
  return new Date(Date.UTC(w.year, w.month - 1, w.day + days)).toISOString().slice(0, 10);
}

/**
 * The first moment at or after `at` that an interval routine's days and hours allow. The runs
 * that follow are spaced from it, so each allowed stretch starts at its first minute.
 */
function intoWindow(s: IntervalSchedule, tz: string, at: Date): Date {
  if (!s.days && !s.from) return at;
  const [fromH, fromM] = s.from ? parseTime(s.from) : [0, 0];
  const [toH, toM] = s.to ? parseTime(s.to) : [23, 59];
  const start = fromH * 60 + fromM;
  const end = toH * 60 + toM;
  let t = at;
  // A week ahead always holds an allowed day; one step per day at most.
  for (let i = 0; i < 9; i++) {
    const w = wallClock(t, tz);
    const minute = w.hour * 60 + w.minute;
    const dayOk = !s.days || s.days.includes(w.weekday);
    if (dayOk && minute >= start && minute <= end) return t;
    const startOf = (days: number) => zonedTime(dayAfter(w, days), s.from ?? '00:00', tz);
    t = dayOk && minute < start ? startOf(0) : startOf(1);
  }
  return t;
}

/** Stable key for one scheduled occurrence, so the same slot never runs twice. */
export function occurrenceKey(at: Date): string {
  return new Date(Math.floor(at.getTime() / MINUTE) * MINUTE).toISOString();
}

const DAY_NAMES: Record<Locale, string[]> = {
  tr: ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
};

/** Short weekday names, Sunday first (index = `Schedule` weekday number). */
export const SHORT_DAY_NAMES: Record<Locale, string[]> = {
  tr: ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
};

const SCHEDULE_TEXT: Record<Locale, Catalog> = {
  tr: {
    hourly: 'Her saat :{minute}',
    daily: 'Her gün {time}',
    weekdays: 'Hafta içi {time}',
    weekly: '{days} {time}',
    monthly: 'Her ayın {day}. günü {time}',
    once: '{date} {time} (bir kez)',
    hours: '{count} saatte bir',
    minutes: '{count} dakikada bir',
    between: '{from}–{to} arası',
    cron: 'Cron: {expr}',
  },
  en: {
    hourly: 'Every hour at :{minute}',
    daily: 'Every day at {time}',
    weekdays: 'Weekdays at {time}',
    weekly: '{days} at {time}',
    monthly: 'Monthly on day {day} at {time}',
    once: 'Once, on {date} at {time}',
    hours: { one: 'Every hour', other: 'Every {count} hours' },
    minutes: { one: 'Every minute', other: 'Every {count} minutes' },
    between: 'between {from} and {to}',
    cron: 'Cron: {expr}',
  },
};

export function describeSchedule(s: Schedule, locale: Locale = DEFAULT_LOCALE): string {
  const t = createTranslator(SCHEDULE_TEXT, locale);
  switch (s.type) {
    case 'hourly':
      return t('hourly', { minute: String(s.minute).padStart(2, '0') });
    case 'daily':
    case 'weekdays':
      return t(s.type, { time: s.time });
    case 'weekly': {
      const days = [...s.days].sort().map((d) => DAY_NAMES[locale][d]);
      return t('weekly', { days: days.join(', '), time: s.time });
    }
    case 'monthly':
      return t('monthly', { day: s.day, time: s.time });
    case 'interval': {
      const every =
        s.minutes % 60 === 0 ? t('hours', { count: s.minutes / 60 }) : t('minutes', { count: s.minutes });
      const parts = [every];
      if (s.days)
        parts.push(
          [...s.days]
            .sort()
            .map((d) => SHORT_DAY_NAMES[locale][d])
            .join(', '),
        );
      if (s.from && s.to) parts.push(t('between', { from: s.from, to: s.to }));
      return parts.join(', ');
    }
    case 'cron':
      return t('cron', { expr: s.expr });
    case 'once': {
      const [y, m, d] = s.date.split('-').map(Number) as [number, number, number];
      const date = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(INTL_LOCALE[locale], {
        timeZone: 'UTC',
        dateStyle: 'medium',
      });
      return t('once', { date, time: s.time });
    }
  }
}
