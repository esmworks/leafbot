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

/** The most checks a routine's condition may have; all of them must hold. */
export const ROUTINE_CONDITION_MAX = 5;

/** How far back a check of mail or WhatsApp looks, in hours; 0 is since midnight in the routine's time zone. */
const withinHours = z
  .number()
  .int()
  .min(0)
  .max(24 * 30);
/** A path under a bot's or its group's folder, with `*`, `**` and `?`; never leaving the folder. */
const filePattern = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), 'validation.conditionPath');

/**
 * One thing a routine's condition looks at with no AI, holding when what it looks for is there
 * (or, with `absent`, when it is not). `files`: at least `min` files of the bot's (or its group's)
 * folder match `pattern`, changed within `withinHours` when given. `email`: a mail that came to the
 * bot meets `filter` (on from, to, subject, text). `whatsapp`: a message of a chat a routine follows
 * meets `filter` (on chat, writer, text). `table`: a row of the bot's table meets `filter`.
 * `tool`: a connected app's read-only tool answers so that its JSON meets `filter`, or its text
 * contains `contains`, or (with neither) it answers anything but an empty list or object. `page`:
 * an https page's text contains `contains`.
 */
export const RoutineConditionCheck = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('files'),
    folder: z.enum(['bot', 'group']).default('bot'),
    pattern: filePattern,
    min: z.number().int().min(1).max(1000).default(1),
    withinHours: withinHours.nullable().default(null),
    absent: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('email'),
    filter: z.string().max(2000).default(''),
    withinHours: withinHours.default(0),
    absent: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('whatsapp'),
    filter: z.string().max(2000).default(''),
    withinHours: withinHours.default(0),
    absent: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('table'),
    tableId: z.string().min(1).max(64),
    filter: z.string().max(2000).default(''),
    absent: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('tool'),
    connectionId: z.string().min(1).max(64),
    tool: z.string().min(1).max(200),
    args: z.record(z.string(), z.unknown()).default({}),
    filter: z.string().max(2000).default(''),
    contains: z.string().max(500).default(''),
    absent: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('page'),
    url: z
      .string()
      .trim()
      .max(2000)
      .regex(/^https:\/\/\S+$/, 'validation.watchUrl'),
    contains: z.string().trim().min(1).max(500),
    absent: z.boolean().default(false),
  }),
]);
export type RoutineConditionCheck = z.infer<typeof RoutineConditionCheck>;

/**
 * What must hold, looked at with no AI, before a scheduled run starts: every check. When it does
 * not, the run does not start and nothing is spent; it is looked at again every `recheckMinutes`
 * until `recheckUntil` (the same day, in the routine's time zone) when both are set, and at the
 * end `otherwise`, when written, goes where the routine reports, again with no AI. A run started
 * by hand or by an event (a mail, a webhook, a row) does not look at it.
 */
export const RoutineCondition = z
  .object({
    checks: z.array(RoutineConditionCheck).min(1).max(ROUTINE_CONDITION_MAX),
    recheckMinutes: z.number().int().min(0).max(180).default(0),
    recheckUntil: z.union([time, z.literal('')]).default(''),
    otherwise: z.string().trim().max(2000).default(''),
  })
  .refine((c) => !c.recheckMinutes === !c.recheckUntil, 'validation.conditionRecheck');
export type RoutineCondition = z.infer<typeof RoutineCondition>;

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
 * with `withBefore`, what the step before it ended with go where the routine reports. `fetch`: with
 * no AI, what an https address serves (a page as its text) is handed to the next step. `extract`:
 * with no AI, the values `fields` names are taken from the JSON that reached it, saved as the run's
 * values and handed on as a JSON object of them.
 */
/**
 * What must hold, read with no AI, for a step to run: looked at in what reaches it from the steps
 * before (the last bot step's answer, and what a wait step brought). With neither `contains` nor
 * `filter`, it holds when something reached the step at all.
 */
/**
 * Where a step's route goes: the id of a step after it, or `end` where the run may end there.
 * Empty takes the route's usual way. A route only goes forward, so a run cannot go round in a loop.
 */
export const ROUTINE_STEP_END = 'end';
const stepTarget = z.union([z.literal(''), stepId]).optional();

export const RoutineStepWhen = z.object({
  /** Text that must be in it, any letter case. */
  contains: z.string().trim().max(500).default(''),
  /** Lines it must meet as JSON, written as a webhook's filter is. */
  filter: z.string().max(2000).default(''),
  /** The step runs when it is not there instead. */
  absent: z.boolean().default(false),
  /**
   * When it does not hold: the step is passed over and the one after it runs, the run ends there,
   * or the run goes on at the step `goto` names, passing over the ones in between.
   */
  otherwise: z.enum(['skip', 'end', 'goto']).default('skip'),
  /** The step the run goes on at with `goto`: one after this step. */
  goto: stepTarget,
});
export type RoutineStepWhen = z.infer<typeof RoutineStepWhen>;
const when = RoutineStepWhen.nullable().optional();
/**
 * Where the run goes once the step ended well: empty, the step after it; `end`, the run ends
 * there; or a later step's id, passing over the ones in between. A step its condition passed over
 * does not follow it: the step after it runs, as if it were not there.
 */
const next = stepTarget;

/**
 * A fetch step's address: https, with `{{name}}` for the run's saved values only after the host,
 * so a saved value (which may be outside text) never picks the server the request goes to.
 */
export const ROUTINE_FETCH_URL = /^https:\/\/[^/?#{}\s]+(?:[/?#]\S*)?$/;

/** One line of an extract step: the value's name, `=`, and where it is in the JSON (dots between keys). */
const FIELD_LINE = /^([A-Za-z][A-Za-z0-9_]{0,39})\s*=\s*([^\s=]+)$/;

/**
 * The values an extract step takes, one `name=path` per line (blank lines and `#` notes left out);
 * null when a line is not of that form or a name comes twice.
 */
export function parseFields(text: string): { name: string; path: string[] }[] | null {
  const out: { name: string; path: string[] }[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = FIELD_LINE.exec(line);
    const path = m?.[2]!.split('.').filter(Boolean) ?? [];
    if (!m || !path.length || out.some((f) => f.name === m[1])) return null;
    out.push({ name: m[1]!, path });
  }
  return out;
}

/** The kinds of step that can fail on their own, and so may have a way to go when they do. */
export const ROUTINE_FAILING_STEPS = ['agent', 'fetch', 'extract'] as const;
const canFail = (kind: string) => (ROUTINE_FAILING_STEPS as readonly string[]).includes(kind);

export const RoutineStep = z.discriminatedUnion('kind', [
  z.object({
    id: stepId,
    kind: z.literal('agent'),
    when,
    next,
    /**
     * Where the run goes when the bot's work fails (or the bot says it could not do it): empty
     * stops the run there, to be tried again from this step; a later step's id goes on there with
     * why it failed.
     */
    onError: stepTarget,
    prompt: z.string().trim().min(1, 'validation.stepPrompt').max(20_000),
    model: z.string().trim().max(200).default(''),
  }),
  z.object({
    id: stepId,
    kind: z.literal('approval'),
    when,
    next,
    question: z.string().trim().min(1, 'validation.stepQuestion').max(2000),
    timeoutDays: z.number().int().min(1).max(ROUTINE_APPROVAL_MAX_DAYS).default(7),
  }),
  z.object({
    id: stepId,
    kind: z.literal('notify'),
    when,
    next,
    text: z.string().trim().max(4000).default(''),
    withBefore: z.boolean().default(true),
  }),
  z.object({
    id: stepId,
    kind: z.literal('wait'),
    when,
    next,
    on: z.enum(['time', 'webhook', 'email']),
    minutes: z.number().int().min(1).max(ROUTINE_WAIT_MAX_MINUTES).default(60),
    filter: z.string().max(2000).default(''),
    timeoutDays: z.number().int().min(1).max(ROUTINE_APPROVAL_MAX_DAYS).default(7),
  }),
  z.object({
    id: stepId,
    kind: z.literal('fetch'),
    when,
    next,
    /** As an agent step's: where the run goes when the address cannot be read. */
    onError: stepTarget,
    url: z.string().trim().max(2000).regex(ROUTINE_FETCH_URL, 'validation.fetchUrl'),
  }),
  z.object({
    id: stepId,
    kind: z.literal('extract'),
    when,
    next,
    /** As an agent step's: where the run goes when what reached it is not JSON or lacks a value. */
    onError: stepTarget,
    fields: z
      .string()
      .max(2000)
      .refine((v) => {
        const f = parseFields(v);
        return !!f && f.length >= 1 && f.length <= ROUTINE_VARS_MAX;
      }, 'validation.extractFields'),
  }),
]);
export type RoutineStep = z.infer<typeof RoutineStep>;
export type RoutineStepKind = RoutineStep['kind'];

/** What a step's routes need to be read: the routine's window and a bot's input both have it. */
type Routed = {
  id: string;
  kind: string;
  when?: { otherwise: string; goto?: string } | null;
  next?: string;
  onError?: string;
};

/** Which route of a step goes where: `otherwise` its condition's, `next` after it, `onError` on failure. */
export type StepRoute = { from: number; field: 'otherwise' | 'next' | 'onError'; to: string };

/** Every route of the steps that leaves the usual way, with the index of the step it starts at. */
export function stepRoutes(steps: readonly Routed[]): StepRoute[] {
  const out: StepRoute[] = [];
  steps.forEach((s, from) => {
    if (s.when?.otherwise === 'goto') out.push({ from, field: 'otherwise', to: s.when.goto ?? '' });
    if (s.next) out.push({ from, field: 'next', to: s.next });
    if (canFail(s.kind) && s.onError) out.push({ from, field: 'onError', to: s.onError });
  });
  return out;
}

/**
 * Why the steps' routes cannot be followed, as a message key, or null when each names a step
 * after its own (or ends the run, after a step ended well). `end` is kept for that, so no step
 * may have it as its id.
 */
export function stepRoutesProblem(steps: readonly Routed[]): string | null {
  if (steps.some((s) => s.id === ROUTINE_STEP_END)) return 'validation.stepIdEnd';
  for (const r of stepRoutes(steps)) {
    if (r.field === 'next' && r.to === ROUTINE_STEP_END) continue;
    const at = steps.findIndex((s) => s.id === r.to);
    if (at <= r.from) return 'validation.stepRoute';
  }
  return null;
}

/**
 * The routes that let the run pass over an approval step without the person: each from a step
 * before it to a step after it, as `from>field>to` by the steps' ids.
 */
export function routesPastApproval(steps: readonly Routed[]): string[] {
  return stepRoutes(steps).flatMap((r) => {
    const to = steps.findIndex((s) => s.id === r.to);
    const over = to > r.from + 1 && steps.slice(r.from + 1, to).some((s) => s.kind === 'approval');
    return over ? [`${steps[r.from]!.id}>${r.field}>${r.to}`] : [];
  });
}

/**
 * Where each box of a routine's flow view sits on its canvas, in pixels from the top left: steps by
 * their id, and `start` and `prompt` for what starts the routine and its own instruction. Only the
 * view reads it; a box missing from it is placed beside the one before.
 */
/** The furthest right or down a box of the flow view may sit. */
export const FLOW_LAYOUT_MAX = 20_000;
export const FlowLayout = z.record(
  z.string().min(1).max(64),
  z.object({
    x: z.number().int().min(0).max(FLOW_LAYOUT_MAX),
    y: z.number().int().min(0).max(FLOW_LAYOUT_MAX),
  }),
);
export type FlowLayout = z.infer<typeof FlowLayout>;

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
  /** Only looks and reports: a step that would change something is refused. Missing on older servers. */
  reportOnly: z.boolean().optional(),
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
  /** What must hold, with no AI, before a scheduled run starts; null for nothing. Missing on older servers. */
  condition: RoutineCondition.nullable().optional(),
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
   * Why it was switched off by itself (`failures`: too many failed runs in a row); null when it
   * is on or the person paused it. Missing on older servers.
   */
  pausedReason: z.enum(['failures']).nullable().optional(),
  /**
   * The secret part of the address that starts the routine from another service (a webhook);
   * null when it has none.
   */
  webhookToken: z.string().nullable(),
  /** Whether an app's own signing secret was pasted in for its calls. Missing on older servers. */
  webhookSecretSet: z.boolean().optional(),
  /** Where its flow view's boxes were placed; null until someone moves one. Missing on older servers. */
  flowLayout: FlowLayout.nullable().optional(),
});
export type Routine = z.infer<typeof Routine>;

/** An app's signing secret for a routine's webhook; null removes it. */
export const RoutineWebhookSecret = z.object({ secret: z.string().trim().min(8).max(500).nullable() });

export const RoutineCreate = z.object({
  botId: z.string(),
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(20_000),
  /**
   * Steps done in order after the instruction, each once the one before it ended well, unless a
   * step's route goes on at a later one.
   */
  steps: z
    .array(RoutineStep)
    .max(ROUTINE_STEP_MAX)
    .refine((s) => new Set(s.map((x) => x.id)).size === s.length, 'validation.stepIds')
    .superRefine((s, ctx) => {
      const problem = stepRoutesProblem(s);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    })
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
   * instead of a conversation of its own. On unless asked otherwise: a routine is the bot's own work,
   * which the person follows and talks about where they talk to it.
   */
  inMain: z.boolean().default(true),
  /**
   * Only looks and reports, whatever the bot's permission level is: a step that would change
   * something is refused (not asked), and the bot is told to report what it found instead.
   */
  reportOnly: z.boolean().default(false),
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
  condition: RoutineCondition.nullable().default(null),
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
  /** Where its flow view's boxes sit; null places them in order. */
  flowLayout: FlowLayout.nullable().default(null),
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
  /**
   * The id of the step, as the run had it; missing for the instruction and on older servers. A
   * step taken out and another put in its place since has another id, so it is not shown this run.
   */
  stepId: z.string().optional(),
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

/**
 * A moment as ISO 8601 in `tz`'s wall time with its offset, such as `2026-11-24T15:13:56+03:00`.
 * A bot shown UTC (`…T12:13:56Z`) tends to repeat 12:13 as the local time, three hours off.
 */
export function localStamp(date: Date, tz: string): string {
  const w = wallClock(date, tz);
  const minute = Math.floor(date.getTime() / MINUTE) * MINUTE;
  const offset = Math.round((Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - minute) / MINUTE);
  const two = (n: number) => String(n).padStart(2, '0');
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  const seconds = two(Math.floor((date.getTime() - minute) / 1000));
  return (
    `${w.year}-${two(w.month)}-${two(w.day)}T${two(w.hour)}:${two(w.minute)}:${seconds}` +
    `${sign}${two(Math.floor(abs / 60))}:${two(abs % 60)}`
  );
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
  de: ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'],
  ar: ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'],
  es: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
  fr: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'],
  hi: ['रविवार', 'सोमवार', 'मंगलवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार'],
  id: ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'],
  it: ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'],
  pl: ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'],
  pt: ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'],
  ru: ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'],
  uk: ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', 'п’ятниця', 'субота'],
  vi: ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'],
  zh: ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'],
};

/** Short weekday names, Sunday first (index = `Schedule` weekday number). */
export const SHORT_DAY_NAMES: Record<Locale, string[]> = {
  tr: ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  de: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
  ar: ['أحد', 'اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'],
  es: ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'],
  fr: ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'],
  hi: ['रवि', 'सोम', 'मंगल', 'बुध', 'गुरु', 'शुक्र', 'शनि'],
  id: ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'],
  it: ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'],
  pl: ['niedz.', 'pon.', 'wt.', 'śr.', 'czw.', 'pt.', 'sob.'],
  pt: ['dom.', 'seg.', 'ter.', 'qua.', 'qui.', 'sex.', 'sáb.'],
  ru: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'],
  uk: ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'],
  vi: ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'],
  zh: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
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
  de: {
    hourly: 'Jede Stunde um :{minute}',
    daily: 'Täglich um {time}',
    weekdays: 'Werktags um {time}',
    weekly: '{days} um {time}',
    monthly: 'Monatlich am {day}. um {time}',
    once: 'Einmal, am {date} um {time}',
    hours: { one: 'Jede Stunde', other: 'Alle {count} Stunden' },
    minutes: { one: 'Jede Minute', other: 'Alle {count} Minuten' },
    between: 'zwischen {from} und {to}',
    cron: 'Cron: {expr}',
  },
  ar: {
    hourly: 'كل ساعة عند :{minute}',
    daily: 'كل يوم الساعة {time}',
    weekdays: 'أيام العمل الساعة {time}',
    weekly: '{days} الساعة {time}',
    monthly: 'شهريًا في اليوم {day} الساعة {time}',
    once: 'مرة واحدة، في {date} الساعة {time}',
    hours: {
      zero: 'كل {count} ساعة',
      one: 'كل ساعة',
      two: 'كل ساعتين',
      few: 'كل {count} ساعات',
      many: 'كل {count} ساعة',
      other: 'كل {count} ساعة',
    },
    minutes: {
      zero: 'كل {count} دقيقة',
      one: 'كل دقيقة',
      two: 'كل دقيقتين',
      few: 'كل {count} دقائق',
      many: 'كل {count} دقيقة',
      other: 'كل {count} دقيقة',
    },
    between: 'بين {from} و{to}',
    cron: 'Cron: {expr}',
  },
  es: {
    hourly: 'Cada hora a las :{minute}',
    daily: 'Todos los días a las {time}',
    weekdays: 'De lunes a viernes a las {time}',
    weekly: '{days} a las {time}',
    monthly: 'Cada mes el día {day} a las {time}',
    once: 'Una vez, el {date} a las {time}',
    hours: { one: 'Cada hora', other: 'Cada {count} horas' },
    minutes: { one: 'Cada minuto', other: 'Cada {count} minutos' },
    between: 'entre {from} y {to}',
    cron: 'Cron: {expr}',
  },
  fr: {
    hourly: 'Chaque heure à :{minute}',
    daily: 'Tous les jours à {time}',
    weekdays: 'Du lundi au vendredi à {time}',
    weekly: '{days} à {time}',
    monthly: 'Chaque mois le {day} à {time}',
    once: 'Une fois, le {date} à {time}',
    hours: { one: 'Chaque heure', other: 'Toutes les {count} heures' },
    minutes: { one: 'Chaque minute', other: 'Toutes les {count} minutes' },
    between: 'entre {from} et {to}',
    cron: 'Cron : {expr}',
  },
  hi: {
    hourly: 'हर घंटे :{minute} पर',
    daily: 'हर दिन {time} बजे',
    weekdays: 'कार्यदिवसों में {time} बजे',
    weekly: '{days} को {time} बजे',
    monthly: 'हर महीने की {day} तारीख़ को {time} बजे',
    once: 'एक बार, {date} को {time} बजे',
    hours: { one: 'हर घंटे', other: 'हर {count} घंटे' },
    minutes: { one: 'हर मिनट', other: 'हर {count} मिनट' },
    between: '{from} से {to} के बीच',
    cron: 'Cron: {expr}',
  },
  id: {
    hourly: 'Setiap jam pada :{minute}',
    daily: 'Setiap hari pukul {time}',
    weekdays: 'Hari kerja pukul {time}',
    weekly: '{days} pukul {time}',
    monthly: 'Setiap bulan tanggal {day} pukul {time}',
    once: 'Sekali, pada {date} pukul {time}',
    hours: { other: 'Setiap {count} jam' },
    minutes: { other: 'Setiap {count} menit' },
    between: 'antara {from} dan {to}',
    cron: 'Cron: {expr}',
  },
  it: {
    hourly: 'Ogni ora alle :{minute}',
    daily: 'Ogni giorno alle {time}',
    weekdays: 'Nei giorni feriali alle {time}',
    weekly: '{days} alle {time}',
    monthly: 'Ogni mese il giorno {day} alle {time}',
    once: 'Una volta, il {date} alle {time}',
    hours: { one: 'Ogni ora', other: 'Ogni {count} ore' },
    minutes: { one: 'Ogni minuto', other: 'Ogni {count} minuti' },
    between: 'tra {from} e {to}',
    cron: 'Cron: {expr}',
  },
  pl: {
    hourly: 'Co godzinę o :{minute}',
    daily: 'Codziennie o {time}',
    weekdays: 'W dni robocze o {time}',
    weekly: '{days} o {time}',
    monthly: 'Co miesiąc {day}. dnia o {time}',
    once: 'Raz, {date} o {time}',
    hours: {
      one: 'Co godzinę',
      few: 'Co {count} godziny',
      many: 'Co {count} godzin',
      other: 'Co {count} godziny',
    },
    minutes: {
      one: 'Co minutę',
      few: 'Co {count} minuty',
      many: 'Co {count} minut',
      other: 'Co {count} minuty',
    },
    between: 'między {from} a {to}',
    cron: 'Cron: {expr}',
  },
  pt: {
    hourly: 'A cada hora, aos :{minute}',
    daily: 'Todos os dias às {time}',
    weekdays: 'De segunda a sexta às {time}',
    weekly: '{days} às {time}',
    monthly: 'Todo mês no dia {day} às {time}',
    once: 'Uma vez, em {date} às {time}',
    hours: { one: 'A cada hora', other: 'A cada {count} horas' },
    minutes: { one: 'A cada minuto', other: 'A cada {count} minutos' },
    between: 'entre {from} e {to}',
    cron: 'Cron: {expr}',
  },
  ru: {
    hourly: 'Каждый час в :{minute}',
    daily: 'Каждый день в {time}',
    weekdays: 'По будням в {time}',
    weekly: '{days} в {time}',
    monthly: 'Каждый месяц {day}-го в {time}',
    once: 'Один раз, {date} в {time}',
    hours: {
      one: 'Каждый час',
      few: 'Каждые {count} часа',
      many: 'Каждые {count} часов',
      other: 'Каждые {count} часа',
    },
    minutes: {
      one: 'Каждую минуту',
      few: 'Каждые {count} минуты',
      many: 'Каждые {count} минут',
      other: 'Каждые {count} минуты',
    },
    between: 'с {from} до {to}',
    cron: 'Cron: {expr}',
  },
  uk: {
    hourly: 'Щогодини о :{minute}',
    daily: 'Щодня о {time}',
    weekdays: 'У будні о {time}',
    weekly: '{days} о {time}',
    monthly: 'Щомісяця {day}-го о {time}',
    once: 'Один раз, {date} о {time}',
    hours: {
      one: 'Щогодини',
      few: 'Що {count} години',
      many: 'Що {count} годин',
      other: 'Що {count} години',
    },
    minutes: {
      one: 'Щохвилини',
      few: 'Що {count} хвилини',
      many: 'Що {count} хвилин',
      other: 'Що {count} хвилини',
    },
    between: 'між {from} і {to}',
    cron: 'Cron: {expr}',
  },
  vi: {
    hourly: 'Mỗi giờ vào phút :{minute}',
    daily: 'Mỗi ngày lúc {time}',
    weekdays: 'Các ngày trong tuần lúc {time}',
    weekly: '{days} lúc {time}',
    monthly: 'Mỗi tháng vào ngày {day} lúc {time}',
    once: 'Một lần, vào {date} lúc {time}',
    hours: { other: 'Mỗi {count} giờ' },
    minutes: { other: 'Mỗi {count} phút' },
    between: 'giữa {from} và {to}',
    cron: 'Cron: {expr}',
  },
  zh: {
    hourly: '每小时第 :{minute} 分',
    daily: '每天 {time}',
    weekdays: '工作日 {time}',
    weekly: '{days} {time}',
    monthly: '每月 {day} 日 {time}',
    once: '{date} {time}（一次）',
    hours: { other: '每 {count} 小时' },
    minutes: { other: '每 {count} 分钟' },
    between: '{from} 到 {to} 之间',
    cron: 'Cron：{expr}',
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
