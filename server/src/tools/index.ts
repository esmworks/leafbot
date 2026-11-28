import { ScreenWatch } from '../computer/screen-watch';
import {
  BRAND_COLOR,
  BotCreate,
  BotMaterial,
  DEFAULT_AVATAR,
  OBJECT_AVATARS,
  ALL_TOOLS,
  catalogEntry,
  CONNECTION_CATALOG,
  ConnectionCreate,
  describeSchedule,
  BOT_IMPORT_FORMAT,
  BOT_IMPORT_VERSION,
  BotImportMemory,
  BotImportSkill,
  Schedule,
  parseAnswers,
  PERMISSION_MODES,
  ROUTINE_VAR_MAX,
  ROUTINE_VAR_NAME,
  ROUTINE_VARS_MAX,
  ROUTINE_STEP_MAX,
  routesPastApproval,
  ROUTINE_CONDITION_MAX,
  RoutineCondition as ConditionSchema,
  type RoutineCondition,
  RoutineStep as StepSchema,
  type RoutineStep,
  type RoutineCheck,
  RoutineCreate,
  type RoutineUpdate,
  searchCatalog,
  skillSlug,
  type ApiSource,
  type Approval,
  type Bot,
  type BotLevel,
  type EngineKind,
  type Memory,
  outsideIn,
  problemReport,
  REPORT_LIMITS,
  type OutsideTrigger,
  type Routine,
  type Skill,
  type WhatsAppGroup,
  describeAction,
  questionItems,
  wallClock,
  zonedTime,
} from '@leafbot/shared';
import os from 'node:os';
import { and, desc, eq, gte, inArray, isNotNull, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../context';
import { schema } from '../db';
import { planItems, type AppTool, type PlanItem, type ToolResult } from '../engine/types';
import { attended, type TurnRow } from '../runtime/turns';
import { requestedBy } from '../runtime/owner-words';
import { managerMayNotAnswer, reportOnlyTurn, STRICTNESS } from '../services/approvals';
import type { Services } from '../services';
import { isServerKey, type T } from '../i18n';
import { errorText, HttpError, newId, notFound, truncate } from '../util';
import { replayHandOver, replaySteps } from '../browser/replay';
import { browserTools, type AskCard, type AskContact, type AskLogin } from './browser';
import { computerTools } from './computer';
import { personCommandTools } from './person-commands';
import { personComputerTools } from './person-computer';
import { callTools } from './calls';
import { personPhoneTools } from './person-phone';
import { personBrowserTools } from './person-browser';
import { handFiles, pageImageTool, sendFileTool, showPageTool } from './files';
import { imageTool } from './images';
import { videoTool } from './videos';
import { slidesTool } from './slides';
import { apiTools } from './api';
import { emailTools } from './email';
import { pickGroup, whatsappRoots, whatsappTools } from './whatsapp';
import { dashboardTools } from './dashboards';
import { tableTools } from './tables';
import { ticketTools } from './tickets';
import { FollowUpsFull, MAX_OPEN_FOLLOW_UPS, readMoment } from '../services/follow-ups';
import { placeOf, ROOM_NOTES_PER_PLACE, sourceOf } from '../services/memory';
import { FLAGS_PER_TURN, OPEN_FLAGS_PER_BOT } from '../services/memory-flags';
import { redactSecrets } from '../services/secrets';
import { NO_CARDS } from '../services/cards';
import { siteOf } from '../services/vault';
import { workspacePaths } from '../workspace';
import {
  noteShape,
  pickFields,
  routineShape,
  sig,
  skillShape,
  type ChangeNote,
} from '../services/turn-changes';
import { OWNER_ID } from '../users';
import { atLeast, managesServer, seesGroup } from '../services/access';
import { closestNames } from '../services/bots';
import { privateHost } from '../services/skill-link';

type ThreadRow = typeof schema.threads.$inferSelect;

/**
 * An answer a question card offers. Models often send `{label, description}` instead of a plain
 * string; both are taken, so a card is never refused over the shape of its choices.
 */
const Choice = z.union([
  z.string().min(1).max(200),
  z.object({ label: z.string().min(1).max(200), description: z.string().max(500).optional() }),
]);
const choiceLabel = (c: z.infer<typeof Choice>) => (typeof c === 'string' ? c : c.label);

/**
 * A routine step as a bot writes it: one flat shape for every kind, with only the fields its kind
 * reads, so a model fills it in without picking among schemas. `id` keeps an existing step (its
 * place in the flow view and its runs' history); a step without one is new.
 */
const StepInput = z.object({
  id: z.string().max(40).optional(),
  kind: z.enum(['agent', 'approval', 'notify', 'wait', 'fetch', 'extract']),
  prompt: z.string().max(20_000).optional(),
  model: z.string().trim().max(200).optional(),
  question: z.string().max(2000).optional(),
  timeout_days: z.number().int().optional(),
  text: z.string().max(4000).optional(),
  with_before: z.boolean().optional(),
  on: z.enum(['time', 'webhook', 'email', 'chat']).optional(),
  minutes: z.number().int().optional(),
  filter: z.string().max(2000).optional(),
  /** A fetch step's https address. */
  url: z.string().max(2000).optional(),
  /** An extract step's `name=path` lines. */
  fields: z.string().max(2000).optional(),
  /** Read with no AI in what reaches the step; the step runs only when it holds. */
  when: z
    .object({
      contains: z.string().max(500).optional(),
      filter: z.string().max(2000).optional(),
      absent: z.boolean().optional(),
      otherwise: z.enum(['skip', 'end', 'goto']).optional(),
      /** With `goto`: the id of another step the run goes on at; an earlier one goes back. */
      goto: z.string().max(40).optional(),
    })
    .optional(),
  /** After the step ended well: `end`, or the id of another step; none, the step after it. */
  next: z.string().max(40).optional(),
  /** An agent step another bot does, by its name: it works with its own settings and apps. */
  by_bot: z.string().max(200).optional(),
  /** An agent, fetch or extract step that fails goes on at this step's id instead of stopping the run. */
  on_error: z.string().max(40).optional(),
  /** An approval step the person turns down goes on at this step's id instead of stopping the run. */
  on_reject: z.string().max(40).optional(),
});
const StepsInput = z.array(StepInput).max(ROUTINE_STEP_MAX);

/**
 * A routine's condition as a bot writes it: each check in one flat shape, with a table by its name
 * and an app's tool by the name the bot sees it under. An empty `checks` removes the condition.
 */
const ConditionInput = z.object({
  checks: z
    .array(
      z.object({
        kind: z.enum(['files', 'email', 'whatsapp', 'table', 'tool', 'page', 'number']),
        folder: z.enum(['bot', 'group']).optional(),
        pattern: z.string().max(300).optional(),
        min: z.number().int().optional(),
        within_hours: z.number().int().optional(),
        filter: z.string().max(2000).optional(),
        table: z.string().max(200).optional(),
        tool: z.string().max(300).optional(),
        args: z.record(z.string(), z.unknown()).optional(),
        contains: z.string().max(500).optional(),
        url: z.string().max(2000).optional(),
        path: z.string().max(300).optional(),
        op: z.enum(['above', 'below', 'either']).optional(),
        than: z.enum(['value', 'average']).optional(),
        threshold: z.number().optional(),
        window: z.number().int().optional(),
        absent: z.boolean().optional(),
      }),
    )
    .max(ROUTINE_CONDITION_MAX),
  recheck_minutes: z.number().int().optional(),
  recheck_until: z.string().max(5).optional(),
  otherwise: z.string().max(2000).optional(),
});

/** A new step's id: short, unique within the routine, and of the letters the server takes. */
const newStepId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * The steps a bot wrote, as the routine keeps them, or why they cannot be: each step is checked
 * against the same schema the routine's window saves through.
 */
export function stepsFrom(input: z.infer<typeof StepsInput>, t: T): RoutineStep[] | string {
  const out: RoutineStep[] = [];
  const ids = new Set<string>();
  for (const [i, s] of input.entries()) {
    let id = s.id?.trim() || newStepId();
    while (ids.has(id) && !s.id) id = newStepId();
    if (ids.has(id)) return t('tool.routineStepSameId', { n: i + 1, id });
    ids.add(id);
    const when = s.when && {
      contains: s.when.contains ?? '',
      filter: s.when.filter ?? '',
      absent: s.when.absent ?? false,
      otherwise: s.when.otherwise ?? 'skip',
      ...(s.when.otherwise === 'goto' && { goto: s.when.goto?.trim() ?? '' }),
    };
    const next = s.next?.trim();
    const onError = s.on_error?.trim();
    const onReject = s.on_reject?.trim();
    const raw = {
      ...(s.kind === 'agent'
        ? {
            id,
            kind: s.kind,
            prompt: s.prompt ?? '',
            model: s.model ?? '',
            // A name until the tool finds the bot it means (`stepBotsFrom`).
            ...(s.by_bot?.trim() && { bot: s.by_bot.trim() }),
            ...(onError && { onError }),
          }
        : s.kind === 'approval'
          ? {
              id,
              kind: s.kind,
              question: s.question ?? '',
              timeoutDays: s.timeout_days,
              ...(onReject && { onReject }),
            }
          : s.kind === 'notify'
            ? { id, kind: s.kind, text: s.text ?? '', withBefore: s.with_before }
            : s.kind === 'fetch'
              ? { id, kind: s.kind, url: s.url ?? '', ...(onError && { onError }) }
              : s.kind === 'extract'
                ? { id, kind: s.kind, fields: s.fields ?? '', ...(onError && { onError }) }
                : {
                    id,
                    kind: s.kind,
                    on: s.on ?? 'time',
                    minutes: s.minutes,
                    filter: s.filter ?? '',
                    timeoutDays: s.timeout_days,
                  }),
      ...(when && { when }),
      ...(next && { next }),
    };
    const parsed = StepSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (x) => `${x.path.join('.') || s.kind}: ${isServerKey(x.message) ? t(x.message) : x.message}`,
      );
      return t('tool.routineBadStep', { n: i + 1, issues: issues.join('; ') });
    }
    out.push(parsed.data);
  }
  return out;
}

/** A Slack reaction as the routine keeps it (`:eyes:` becomes `eyes`); null when it is no emoji's name. */
const slackReaction = (raw: string): string | null => {
  const parsed = RoutineCreate.shape.slackReaction.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

/** The short model names the Claude engine takes. */
const CLAUDE_NAMES = new Set(['default', 'best', 'opus', 'sonnet', 'haiku', 'fable', 'opusplan']);
/**
 * Whether the Claude engine may take this model. A single word must be one of its names, which
 * catches a misspelt one; a longer id (a full model id, a cloud provider's) is left to the engine,
 * since a list here would turn away a new release. A `provider/model` is Pi's, not Claude's.
 */
const claudeModelOk = (model: string) => {
  if (model.includes('/')) return false;
  const bare = model.replace(/\[1m\]$/i, '');
  return !/^[a-z]+$/i.test(bare) || CLAUDE_NAMES.has(bare.toLowerCase());
};
/** The models a routine's own agent steps name; a step another bot does names one of that bot's. */
const stepModels = (steps: readonly RoutineStep[]) =>
  steps.flatMap((x) => (x.kind === 'agent' && x.model && !x.bot ? [x.model] : []));
/** Whether a step of the routine waits for its webhook to be called. */
const waitsOnHook = (steps: readonly RoutineStep[]) =>
  steps.some((x) => x.kind === 'wait' && x.on === 'webhook');

/**
 * A routine's steps in the shape `steps` takes, so a bot can read them and send them back changed.
 * A step another bot does names it as `names` has it, or by its id; both find it again.
 */
export function stepsOut(
  steps: readonly RoutineStep[],
  names: ReadonlyMap<string, string> = new Map(),
): Record<string, unknown>[] {
  return steps.map((s) => ({
    ...stepOut(s),
    ...(s.kind === 'agent' && s.bot && { by_bot: names.get(s.bot) ?? s.bot }),
    ...(s.when && {
      when: {
        ...(s.when.contains && { contains: s.when.contains }),
        ...(s.when.filter && { filter: s.when.filter }),
        ...(s.when.absent && { absent: true }),
        otherwise: s.when.otherwise,
        ...(s.when.otherwise === 'goto' && { goto: s.when.goto ?? '' }),
      },
    }),
    ...(s.next && { next: s.next }),
    ...('onError' in s && s.onError && { on_error: s.onError }),
    ...('onReject' in s && s.onReject && { on_reject: s.onReject }),
  }));
}

function stepOut(s: RoutineStep): Record<string, unknown> {
  return s.kind === 'agent'
    ? {
        id: s.id,
        kind: s.kind,
        prompt: s.prompt,
        ...(s.model && { model: s.model }),
      }
    : s.kind === 'approval'
      ? { id: s.id, kind: s.kind, question: s.question, timeout_days: s.timeoutDays }
      : s.kind === 'notify'
        ? { id: s.id, kind: s.kind, text: s.text, with_before: s.withBefore }
        : s.kind === 'fetch'
          ? { id: s.id, kind: s.kind, url: s.url }
          : s.kind === 'extract'
            ? { id: s.id, kind: s.kind, fields: s.fields }
            : {
                id: s.id,
                kind: s.kind,
                on: s.on,
                ...(s.on === 'time' ? { minutes: s.minutes } : { filter: s.filter }),
                timeout_days: s.timeoutDays,
              };
}

/** Query parameters that carry a sign-in or a signature rather than say which page it is. */
const SECRET_PARAM =
  /(?:^|[_.-])(?:token|secret|password|passwd|pwd|key|apikey|sig|signature|auth|session|sessionid|sid|credential|code)s?(?:$|[_.-])|^x-(?:amz|goog)-/i;

/**
 * The moment a bot says a note is true until, as an ISO time; null for none (an empty answer) and
 * undefined for something that is not a date. A date alone means the end of that day and a time
 * with no offset is the person's own clock, both read in `timezone`; a time with an offset
 * (`...Z`, `...+03:00`) is taken as it stands.
 */
export function noteUntil(text: string, timezone: string): string | null | undefined {
  const given = text.trim();
  if (!given) return null;
  const date = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/.exec(given);
  if (date) {
    const [, y, mo, d, h = '23', mi = '59'] = date;
    const real = new Date(Date.UTC(+y!, +mo! - 1, +d!));
    // A day that does not exist (the 31st of November) is no date.
    if (real.getUTCMonth() !== +mo! - 1 || +h > 23 || +mi > 59) return undefined;
    return zonedTime(`${y}-${mo}-${d}`, `${h}:${mi}`, timezone).toISOString();
  }
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(given))
    return undefined;
  const at = new Date(given.replace(' ', 'T'));
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

/**
 * The moment a bot gives for a follow-up, in the person's time zone: a day alone means `dayTime` on
 * it. Null for none, undefined for something that is not one.
 */
export function followUpTime(text: string, timezone: string, dayTime: string): string | null | undefined {
  const given = text.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(given)) return noteUntil(`${given} ${dayTime}`, timezone);
  return noteUntil(given, timezone);
}

/**
 * The page a bot says a fact came from, as a web address the person can open; null for none and
 * undefined for something that is not one. Whatever could sign someone in is taken out first: the
 * address is kept and shown, while what it held would leak with it.
 */
export function sourceAddress(from: string): string | null | undefined {
  try {
    const url = new URL(from.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    url.username = '';
    url.password = '';
    // A fragment is where sign-in pages hand over their tokens; it never names another page.
    url.hash = '';
    for (const [name, value] of [...url.searchParams]) {
      if (SECRET_PARAM.test(name) || redactSecrets(value, '').redacted) url.searchParams.delete(name);
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

/** The most a bot factory's plan sets up at once, so its card lists all of it. */
const FACTORY_MAX = { bots: 5, routines: 5, skills: 5, notes: 10 } as const;

const MEMORY_TOOLS = new Set<string>([
  'memory_search',
  'memory_write',
  'memory_update',
  'memory_forget',
  'memory_flag',
]);
const MANAGER_MEMORY_TOOLS = new Set<string>(['memory_search', 'memory_update', 'memory_forget']);
/**
 * Tools a team conversation does without: each reaches what is one person's (their apps, their
 * conversations, routines run for them) or hands the work to a bot that would work for them.
 */
const TEAM_OFF = new Set<string>([
  'app_add',
  // A card is a person's own, filled only for them; so are their contact details.
  'browser_card',
  'browser_contact',
  'credential_request',
  'routine_create',
  'routine_read',
  'routine_update',
  'routine_delete',
  'routine_run',
  // The person's own promises to others: a team or a chat app's stranger has none to keep here.
  'promise_track',
  // A follow-up comes up in a person's own conversation: a team conversation has no one to tell.
  'followup_add',
  'followup_list',
  'followup_drop',
  'my_activity',
  'conversations_search',
  'message_read',
  'open_conversation',
  'bot_send',
  'bot_status',
  'bot_requests',
  'bot_stop',
]);

/**
 * Tools a turn asked by someone with no account here does without: each starts work that later
 * goes on for the person the turn acts for, with all they may do.
 */
const GUEST_OFF = new Set<string>([
  // A problem report carries the server's version, system and recent errors.
  'report_problem',
  // A flag asks the person to fill a gap; a stranger's question is no gap in what the bot knows.
  'memory_flag',
  'ticket_create',
  'ticket_update',
  'ticket_delete',
  'skill_save',
  'browser_card',
  'browser_contact',
  'promise_track',
  'followup_add',
  'followup_list',
  'followup_drop',
  // Signing in with the vault's password, its two-step code or a code mailed to the bot runs
  // without a card: someone with no account here would get into the person's accounts by asking.
  'browser_login',
  'browser_code',
  'browser_email_code',
  // The cards waiting on the person are theirs to see and answer, not a stranger's.
  'cards_waiting',
  'cards_answer',
]);

/** Tool builder for one turn: descriptions and results are written in the turn's language. */
const definer =
  (t: T) =>
  <S extends z.ZodRawShape>(
    name: ToolName,
    input: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>,
    access: 'read' | 'internal' | 'gated' = 'gated',
    gated?: (args: z.infer<z.ZodObject<S>>) => Promise<boolean>,
  ): AppTool => {
    const parser = z.object(input);
    return {
      name,
      description: t(`tool.${name}`),
      input,
      readOnly: access === 'read',
      internal: access !== 'gated',
      ...(gated && {
        gated: async (raw: Record<string, unknown>) => {
          const parsed = parser.safeParse(raw);
          return parsed.success ? gated(parsed.data) : false;
        },
      }),
      handler: async (raw) => {
        const parsed = parser.safeParse(raw);
        if (!parsed.success) {
          // A shared schema's own message is a key into the catalog.
          const issues = parsed.error.issues.map((i) => (isServerKey(i.message) ? t(i.message) : i.message));
          return t('tool.invalidInput', { issues: issues.join('; ') });
        }
        try {
          return await handler(parsed.data);
        } catch (err) {
          return t('tool.error', { message: errorText(err, t) });
        }
      },
    };
  };

/**
 * Exactly one emoji, including skin tones, joined sequences and flags (👍🏽, ❤️, 👨‍💻, 🇹🇷).
 * Built at runtime because the `v` flag is newer than the compile target.
 */
export const EMOJI = new RegExp('^\\p{RGI_Emoji}$', 'v');

export type Define = ReturnType<typeof definer>;

/** Conversations one turn may open with open_conversation. */
const MAX_OPENED = 5;

/** The version a problem report names. */
const LEAFBOT_VERSION = '0.10.2';
/** Errors of the conversation a problem report carries: the latest few of the last hour. */
const REPORT_ERRORS = 5;
const REPORT_ERRORS_MS = 60 * 60_000;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;

/**
 * Text that goes into a public issue: keys and passwords, email addresses and the server's home
 * folder (which holds the account's name) are taken out.
 */
function publicText(text: string, marker: string): string {
  const home = os.homedir();
  const clean = redactSecrets(text, marker).text.replace(EMAIL, marker);
  return home.length > 1 ? clean.replaceAll(home, '~') : clean;
}

export type ToolName =
  | 'ask_user'
  | 'react'
  | 'send_file'
  | 'show_page'
  | 'image_create'
  | 'video_create'
  | 'slides_create'
  | 'api_keys_list'
  | 'credential_request'
  | 'api_request'
  | 'api_operations'
  | 'api_call'
  | 'tickets_list'
  | 'ticket_read'
  | 'ticket_create'
  | 'ticket_update'
  | 'ticket_delete'
  | 'tables_list'
  | 'table_define'
  | 'table_rows'
  | 'table_add'
  | 'table_update'
  | 'table_delete_rows'
  | 'dashboards'
  | 'dashboard_define'
  | 'email_inbox'
  | 'email_read'
  | 'whatsapp_chats'
  | 'whatsapp_history'
  | 'whatsapp_send'
  | 'whatsapp_status'
  | 'whatsapp_follow'
  | 'whatsapp_suggest_route'
  | 'page_to_image'
  | 'browser_open'
  | 'browser_snapshot'
  | 'browser_click'
  | 'browser_hover'
  | 'browser_dialog'
  | 'browser_type'
  | 'browser_fill'
  | 'browser_code'
  | 'browser_card'
  | 'browser_contact'
  | 'browser_login'
  | 'browser_upload'
  | 'browser_select'
  | 'browser_press'
  | 'browser_scroll'
  | 'browser_history'
  | 'browser_tabs'
  | 'browser_screenshot'
  | 'browser_wait'
  | 'browser_drag'
  | 'browser_network'
  | 'browser_console'
  | 'memory_search'
  | 'conversations_search'
  | 'message_read'
  | 'skill_read'
  | 'skill_replay'
  | 'browser_email_code'
  | 'my_activity'
  | 'skill_save'
  | 'routine_create'
  | 'routine_read'
  | 'routine_update'
  | 'routine_delete'
  | 'routine_run'
  | 'promise_track'
  | 'followup_add'
  | 'followup_list'
  | 'followup_drop'
  | 'routine_failed'
  | 'routine_set'
  | 'routine_stop'
  | 'app_suggest'
  | 'quick_replies'
  | 'show_card'
  | 'report_problem'
  | 'app_add'
  | 'plan_update'
  | 'memory_write'
  | 'memory_update'
  | 'memory_forget'
  | 'memory_flag'
  | 'bots_list'
  | 'open_conversation'
  | 'bot_send'
  | 'bot_status'
  | 'bot_requests'
  | 'bot_stop'
  | 'reply_files'
  | 'bot_conversations_read'
  | 'cards_waiting'
  | 'cards_answer'
  | 'bot_create'
  | 'bot_factory'
  | 'models_list'
  | 'bot_update'
  | 'bot_profile'
  | 'bot_skill'
  | 'bot_archive'
  | 'computer_screenshot'
  | 'computer_click'
  | 'computer_type'
  | 'computer_key'
  | 'computer_scroll'
  | 'computer_drag'
  | 'run_command'
  | 'command_status'
  | 'person_computer_screenshot'
  | 'person_computer_click'
  | 'person_computer_type'
  | 'person_computer_key'
  | 'person_computer_scroll'
  | 'person_computer_drag'
  | 'person_command_run'
  | 'person_command_status'
  | 'person_command_stop'
  | 'person_phone_calendar'
  | 'person_phone_contacts'
  | 'person_phone_location'
  | 'person_browser_tabs'
  | 'person_browser_read'
  | 'call_listen'
  | 'call_status'
  | 'call_stop';

/**
 * Puts questions to the person on a card in the turn's conversation and waits for the answers,
 * one per question. Used by ask_user and by a connection that asks something during a call.
 */
export async function askPerson(
  s: Services,
  o: {
    bot: Bot;
    thread: { id: string };
    turn: { id: string };
    signal: AbortSignal;
    timeoutMs?: number;
    title?: string;
    items: { question: string; context?: string; options: string[]; secret?: boolean; multi?: boolean }[];
  },
) {
  const summary = o.title ?? o.items[0]!.question;
  const r = await s.approvals.ask({
    threadId: o.thread.id,
    botId: o.bot.id,
    turnId: o.turn.id,
    kind: 'question',
    toolName: 'ask_user',
    input: { ...(o.title ? { title: o.title } : {}), questions: o.items },
    summary,
    options: o.items.length === 1 ? o.items[0]!.options : [],
    signal: o.signal,
    timeoutMs: o.timeoutMs,
    onCreated: async (a) => {
      await s.threads.addMessage({
        threadId: o.thread.id,
        role: 'approval',
        author: `bot:${o.bot.id}`,
        text: summary,
        props: { approvalId: a.id },
        turnId: o.turn.id,
      });
    },
  });
  return { ...r, answers: parseAnswers(r.answer, o.items.length) };
}

export class ToolFactory {
  constructor(
    private ctx: Ctx,
    private services: Services,
    private clock: () => Date = () => new Date(),
  ) {}

  forTurn(opts: {
    bot: Bot;
    thread: ThreadRow;
    turn: TurnRow;
    signal: AbortSignal;
    t: T;
    skills?: Skill[];
    /** The bot's mail address; with one, it gets its inbox. */
    email?: string | null;
    /** Whether a person let the bot type sign-in codes from that mailbox into the site that sent them. */
    emailCodes?: boolean;
    /** OpenAPI documents the bot may call operations of. */
    apiSources?: ApiSource[];
    /** Shows the bot's plan in the chat; given to engines without a to-do tool of their own. */
    plan?: (items: PlanItem[]) => Promise<void>;
    /** Whether the bot keeps any table; without one it gets only the tools to start one. */
    hasTables?: boolean;
    /**
     * Whether whom the turn works for may change the bot; unset counts as yes. Without it a new
     * skill cannot be saved, so the bot is not led to offer one: the skill tool stays only to
     * suggest fixes to skills it has.
     */
    mayEditBot?: boolean;
    /** The outside text the turn has read so far, if any. */
    outside?: () => OutsideTrigger | null;
    /** Tells the turn a tool showed it outside text. */
    readOutside?: (kind: OutsideTrigger) => Promise<void>;
    /** Who linked WhatsApp; a turn working for them gets its chats and drafts. */
    whatsappOwner?: string | null;
    /** Whether a routine of the bot reads WhatsApp chats. */
    whatsappReader?: boolean;
    /** A WhatsApp chat the bot answers for the person: one given to it, or the front door. */
    contact?: 'route' | 'door';
    /** A room with more than one person in it: no one's own notes, apps or sign-ins. */
    shared?: boolean;
  }): AppTool[] {
    const { bot, thread, turn, signal, t, plan } = opts;
    const reads = () => opts.outside?.() ?? null;
    /** The outside text among messages a tool shows, if any: a mail, a webhook's post, a forward. */
    const shows = async (props: Record<string, unknown>[]) => {
      const kind = props.map(outsideIn).find(Boolean);
      if (kind) await opts.readOutside?.(kind);
    };
    const skills = opts.skills ?? [];
    const def = definer(t);
    // Conversations this turn opened; a few at most, so a looping bot cannot fill the list.
    let opened = 0;
    const s = this.services;
    // Whom the turn works for: who asked, else whose conversation it is, else the bot's owner.
    const person = turn.userId ?? thread.userId ?? bot.ownerUserId ?? OWNER_ID;
    /**
     * Puts a change the turn made in the bot's own world into the journal that takes the turn
     * back. Called once the step went through, and never fails the step it follows.
     */
    const journal = (c: ChangeNote) =>
      s.changes
        .record({ turnId: turn.id, threadId: thread.id, botId: bot.id, userId: person }, c)
        .catch((err: unknown) => console.warn(`Could not journal a change of a turn: ${String(err)}`));
    // A team conversation acts for who asked but uses no one's own notes, apps or sign-ins; so
    // does a WhatsApp chat a bot answers for the person, where someone else writes, and a room
    // more than one person is in.
    const team = thread.kind === 'team' || !!opts.contact || !!opts.shared;
    const own = team ? null : person;
    // Asked by someone with no account here (a Discord member): the turn acts for the person it
    // works for, but may do no more with the bots than talk with them.
    const guest = turn.guest;
    /** Another bot by name or id, if the person reaches it at `wanted`; this bot itself always. */
    const reachBot = async (ref: string, wanted: 'chat' | 'edit') => {
      if (guest && wanted === 'edit') throw notFound('bot');
      const target = await s.bots.resolve(ref, bot).catch(async (err: unknown) => {
        if (!(err instanceof HttpError) || err.key !== 'error.noBotNamed') throw err;
        // Only bots the person reaches are offered, so a wrong name never shows another's bot.
        const reachable = new Set(await s.access.botIds(await s.access.viewerOf(person), 'chat'));
        const names = (await s.bots.list()).filter((b) => b.id !== bot.id && reachable.has(b.id));
        const close = closestNames(
          ref,
          names.map((b) => b.name),
        );
        if (!close.length) throw err;
        throw new HttpError(404, 'error.noBotNamedDidYouMean', {
          ref,
          names: close.map((n) => `"${n}"`).join(', '),
        });
      });
      return s.access.reach(person, bot, target, wanted);
    };
    let levelHere: Promise<BotLevel> | undefined;
    /** What the person may do with this bot. */
    const personLevel = () =>
      (levelHere ??= s.access
        .viewerOf(person)
        .then((v) => s.access.level(v, bot.id))
        .then((level) => (guest && atLeast(level, 'edit') ? 'chat' : level)));
    const mayChange = async () => atLeast(await personLevel(), 'edit');
    /** This bot's conversations the person sees: theirs, and its own work when they may change it. */
    const seenHere = async () =>
      (await mayChange()) ? s.access.seenFrom(person) : eq(schema.threads.userId, person);
    /** The bots the person reaches at `wanted`. */
    const reachable = async (wanted: 'chat' | 'edit') =>
      guest && wanted === 'edit'
        ? new Set<string>()
        : new Set(await s.access.botIds(await s.access.viewerOf(person), wanted));
    // Only the person's own message or emoji has them there; a room member another bot named is not.
    const fromUser = attended(turn.source);
    // Nobody may be watching a routine's or another bot's turn: its cards close unanswered in time.
    const unattended = fromUser ? undefined : this.ctx.config.unattendedApprovalMs;
    /** A bot's table by name, for a routine to start on; the reason, listing its tables, when there is none. */
    const tableNamed = async (botId: string, name: string) => {
      const { found, names } = await s.tables.find(botId, name);
      if (found) return found;
      return names.length
        ? t('tool.tableMissing', { table: name, tables: names.join(', ') })
        : t('tool.tablesNone');
    };
    /**
     * The routine a bot names, by name or id: one of its own, or, for a manager, one of another
     * bot's too, but not another manager's. A reason when there is none or more than one.
     */
    const pickRoutine = async (
      ref: string,
      botRef?: string,
    ): Promise<{ routine: Routine; routines: Routine[] } | string> => {
      let owners: Bot[];
      if (botRef) {
        const target = await reachBot(botRef, 'edit');
        if (target.id !== bot.id && !bot.isManager) return t('tool.routineNotYours');
        if (target.id !== bot.id && target.isManager) return t('tool.otherManager');
        owners = [target];
      } else {
        const editable = await reachable('edit');
        owners = bot.isManager
          ? (await s.bots.list()).filter((b) => b.id === bot.id || (!b.isManager && editable.has(b.id)))
          : [bot];
      }
      const names = new Map(owners.map((b) => [b.id, b.name]));
      const routines = (await s.routines.list(owners.length === 1 ? owners[0]!.id : undefined)).filter((r) =>
        names.has(r.botId),
      );
      const wanted = ref.trim().toLowerCase();
      const named = routines.filter((r) => r.id === ref.trim() || r.name.toLowerCase() === wanted);
      // A routine of the bot's own wins over another bot's of the same name.
      const own = named.filter((r) => r.botId === bot.id);
      const hits = own.length ? own : named;
      const label = (r: Routine) => (r.botId === bot.id ? r.name : `${names.get(r.botId)} · ${r.name}`);
      if (hits.length === 1) return { routine: hits[0]!, routines };
      if (hits.length > 1) {
        return t('tool.routineAmbiguous', {
          name: ref,
          bots: hits.map((r) => names.get(r.botId)).join(', '),
        });
      }
      return t('tool.routineNotFound', { name: ref, names: routines.map(label).join(', ') || '-' });
    };
    /**
     * The bots whose own notes this bot may read and change, by id with their names: itself, and for
     * a manager every bot that is not a manager, archived ones too so their notes can be cleared.
     */
    // The clock a date a bot gives for a note is read on: the person's, or the team's in a team conversation.
    const zone = async () => (team ? await s.settings.team() : await s.settings.all(person)).timezone;
    // The place this conversation is in, for the notes about a place; null when it is in none.
    let placeHere: Promise<string | null> | undefined;
    const place = () => (placeHere ??= placeOf(this.ctx, thread));
    /**
     * A change to the notes for every bot: they reach every bot and everyone's conversations, so a
     * bot only proposes it, and those who look after the server decide on the memory screen.
     */
    const proposeCommon = async (c: {
      action: 'write' | 'update' | 'forget';
      memoryId: string | null;
      content: string;
      before: string | null;
      site: string | null;
      sourceUrl: string | null;
      validUntil: string | null;
    }) => {
      await s.memory.propose({
        ...c,
        scope: 'common',
        botId: null,
        place: null,
        proposedBy: bot.id,
        origin: { kind: reads() ? 'outside' : 'bot', name: bot.name },
        userId: person,
        threadId: thread.id,
      });
      return t('tool.memoryCommonProposed');
    };
    const memoryOwners = async (): Promise<Map<string, string>> => {
      if (!bot.isManager) return new Map([[bot.id, bot.name]]);
      const all = await s.bots.list({ includeArchived: true });
      // Another bot's notes only where the person may change that bot.
      const editable = await reachable('edit');
      return new Map(
        all.filter((b) => b.id === bot.id || (!b.isManager && editable.has(b.id))).map((b) => [b.id, b.name]),
      );
    };
    /**
     * Asks the person on a card in this conversation, at every permission level; true when they
     * approve, else what they wrote on the card instead of a button.
     */
    const askOnCard = async (summary: string, input: Record<string, unknown>, toolName: string) => {
      const approve = t('tool.approve');
      const r = await s.approvals.ask({
        threadId: thread.id,
        botId: bot.id,
        turnId: turn.id,
        kind: 'question',
        toolName,
        input,
        summary,
        options: [approve, t('tool.reject')],
        signal,
        timeoutMs: unattended,
        onCreated: async (ap) => {
          await s.threads.addMessage({
            threadId: thread.id,
            role: 'approval',
            author: `bot:${bot.id}`,
            text: ap.summary,
            props: { approvalId: ap.id },
            turnId: turn.id,
          });
        },
      });
      if (r.status === 'allowed' && (!r.answer || r.answer === approve)) return true;
      const words = r.status === 'allowed' && r.answer !== t('tool.reject') ? (r.answer?.trim() ?? '') : '';
      return { words };
    };
    const refusedOnCard = (message: string, r: { words: string }) =>
      r.words ? `${message}\n\n${t('tool.changeAnswered', { answer: r.words })}` : message;
    /**
     * Why the routine's or a step's models will not run on the routine's bot, or null when they
     * will. A misspelt model is caught here: at run time it would only fail, with nobody there.
     */
    const routineModelProblem = async (botId: string, models: string[]): Promise<string | null> => {
      const named = [...new Set(models.map((m) => m.trim()).filter(Boolean))];
      if (!named.length) return null;
      const owner = await s.bots.get(botId);
      // A coding agent of the computer names its own models.
      if (owner.engine === 'acp') return null;
      for (const model of named) {
        if (owner.engine === 'claude') {
          if (!claudeModelOk(model)) return t('tool.unknownModel', { model });
          continue;
        }
        const cut = model.indexOf('/');
        const [provider, id] = [model.slice(0, Math.max(cut, 0)), model.slice(cut + 1)];
        const known: string[] = provider ? await s.keys.models(provider).catch(() => []) : [];
        if (!provider || !id || !known.includes(id)) return t('tool.unknownModel', { model });
        if (!(await s.keys.credential(provider))) return t('tool.noModelKey', { provider });
      }
      return null;
    };
    /**
     * The steps another bot does, with that bot found by its name or id among those the person
     * reaches: the step keeps its id, and one naming the routine's own bot is its own again. A
     * model such a step names is that bot's, and is looked at on that bot's engine, unless the
     * routine already ran the step so (`kept`). Why not, when a model does not fit.
     */
    const stepBotsFrom = async (
      steps: RoutineStep[],
      ownerId: string,
      kept: readonly RoutineStep[] = [],
    ): Promise<RoutineStep[] | string> => {
      const out: RoutineStep[] = [];
      for (const x of steps) {
        if (x.kind !== 'agent' || !x.bot) {
          out.push(x);
          continue;
        }
        const target = await reachBot(x.bot, 'chat');
        const { bot: _named, ...own } = x;
        if (target.id === ownerId) {
          out.push(own);
          continue;
        }
        const had = kept.some((k) => k.kind === 'agent' && k.bot === target.id && k.model === x.model);
        if (x.model && !had) {
          const wrong = await routineModelProblem(target.id, [x.model]);
          if (wrong) return wrong;
        }
        out.push({ ...own, bot: target.id });
      }
      return out;
    };
    /**
     * A condition as a bot wrote it, as the routine keeps it: a table by its id, an app's tool by
     * its connection; why not, when a part names nothing it can reach or breaks the schema.
     */
    const conditionFrom = async (
      c: z.infer<typeof ConditionInput>,
      botId: string,
      name: string,
      before: RoutineCondition | null = null,
    ): Promise<RoutineCondition | null | string> => {
      if (!c.checks.length) return null;
      const checks: Record<string, unknown>[] = [];
      for (const x of c.checks) {
        const common = { kind: x.kind, absent: x.absent };
        if (x.kind === 'files')
          checks.push({
            ...common,
            folder: x.folder,
            pattern: x.pattern ?? '',
            min: x.min,
            withinHours: x.within_hours ?? null,
          });
        else if (x.kind === 'email' || x.kind === 'whatsapp')
          checks.push({ ...common, filter: x.filter, withinHours: x.within_hours });
        else if (x.kind === 'table') {
          const found = await tableNamed(botId, x.table ?? '');
          if (typeof found === 'string') return found;
          checks.push({ ...common, tableId: found.id, filter: x.filter });
        } else if (x.kind === 'tool') {
          const named = x.tool ? await s.connections.checkFromName(botId, x.tool, person) : null;
          if (!named) return t('tool.routineBadCheck', { tool: x.tool ?? '-' });
          checks.push({ ...common, ...named, args: x.args, filter: x.filter, contains: x.contains });
        } else if (x.kind === 'number') {
          const reading = { path: x.path, op: x.op, than: x.than, threshold: x.threshold, window: x.window };
          if (x.tool) {
            const named = await s.connections.checkFromName(botId, x.tool, person);
            if (!named) return t('tool.routineBadCheck', { tool: x.tool });
            checks.push({ kind: x.kind, from: 'tool', ...named, args: x.args, ...reading });
          } else checks.push({ kind: x.kind, from: 'page', url: x.url ?? '', ...reading });
        } else checks.push({ ...common, url: x.url ?? '', contains: x.contains ?? '' });
      }
      const parsed = ConditionSchema.safeParse({
        checks,
        recheckMinutes: c.recheck_minutes,
        recheckUntil: c.recheck_until,
        otherwise: c.otherwise,
      });
      if (parsed.success) {
        // WhatsApp messages are read only with the person's yes on a card, as whatsapp_follow
        // asks it; a check that reads them anew is asked about whatever the bot may do alone.
        const read = (x: RoutineCondition | null) =>
          (x?.checks ?? []).flatMap((k) => (k.kind === 'whatsapp' ? [`${k.filter}\n${k.withinHours}`] : []));
        const had = new Set(read(before));
        const fresh = parsed.data.checks.filter(
          (k) => k.kind === 'whatsapp' && !had.has(`${k.filter}\n${k.withinHours}`),
        );
        if (fresh.length) {
          const filters = fresh.map(
            (k) => (k.kind === 'whatsapp' && k.filter.trim().replace(/\n/g, ', ')) || '*',
          );
          const ok = await askOnCard(
            t('tool.routineConditionWhatsappAsk', { name, filter: filters.join('; ') }),
            { routine: name, condition: c },
            'routine_update',
          );
          if (ok !== true) return refusedOnCard(t('tool.routineConditionWhatsappNo'), ok);
        }
        return parsed.data;
      }
      const issues = parsed.error.issues.map(
        (i) => `${i.path.join('.')}: ${isServerKey(i.message) ? t(i.message) : i.message}`,
      );
      return t('tool.routineBadCondition', { issues: issues.join('; ') });
    };
    /** A routine's condition in the shape `condition` takes, so a bot can send it back changed. */
    const conditionOut = async (c: RoutineCondition, botId: string) => {
      const tables = c.checks.some((x) => x.kind === 'table')
        ? await s.tables.list(botId).catch(() => [])
        : [];
      return {
        checks: c.checks.map((x) => {
          const absent = x.absent ? { absent: true } : {};
          if (x.kind === 'files')
            return {
              kind: x.kind,
              folder: x.folder,
              pattern: x.pattern,
              min: x.min,
              ...(x.withinHours !== null && { within_hours: x.withinHours }),
              ...absent,
            };
          if (x.kind === 'email' || x.kind === 'whatsapp')
            return { kind: x.kind, filter: x.filter, within_hours: x.withinHours, ...absent };
          if (x.kind === 'table')
            return {
              kind: x.kind,
              table: tables.find((tb) => tb.id === x.tableId)?.name ?? x.tableId,
              filter: x.filter,
              ...absent,
            };
          if (x.kind === 'tool')
            return {
              kind: x.kind,
              tool: x.tool,
              args: x.args,
              ...(x.filter && { filter: x.filter }),
              ...(x.contains && { contains: x.contains }),
              ...absent,
            };
          if (x.kind === 'number')
            return {
              kind: x.kind,
              ...(x.from === 'tool' ? { tool: x.tool, args: x.args } : { url: x.url }),
              ...(x.path && { path: x.path }),
              op: x.op,
              than: x.than,
              threshold: x.threshold,
              ...(x.than === 'average' && { window: x.window }),
            };
          return { kind: x.kind, url: x.url, contains: x.contains, ...absent };
        }),
        ...(c.recheckMinutes && { recheck_minutes: c.recheckMinutes, recheck_until: c.recheckUntil }),
        ...(c.otherwise && { otherwise: c.otherwise }),
      };
    };
    const tools: AppTool[] = [
      def(
        'ask_user',
        {
          title: z.string().max(120).optional(),
          questions: z
            .array(
              z.object({
                question: z.string().min(1).max(500),
                context: z
                  .string()
                  .max(1000)
                  .optional()
                  .describe('A short line under the question: why you ask, or what the options mean'),
                options: z.array(Choice).max(8).optional(),
                secret: z.boolean().optional(),
                multi: z.boolean().optional(),
              }),
            )
            .min(1)
            .max(6)
            .optional(),
          question: z.string().min(1).max(500).optional(),
          options: z.array(Choice).max(8).optional(),
        },
        async ({ title, questions, question, options }) => {
          const items = (questions ?? (question ? [{ question, options, secret: undefined }] : [])).map(
            (q) => ({
              question: q.question,
              ...('context' in q && q.context ? { context: q.context } : {}),
              options: (q.options ?? []).map(choiceLabel),
              ...(q.secret ? { secret: true } : {}),
              ...('multi' in q && q.multi && !q.secret && q.options?.length ? { multi: true } : {}),
            }),
          );
          if (!items.length) return t('tool.noQuestion');
          const r = await askPerson(s, { bot, thread, turn, signal, timeoutMs: unattended, title, items });
          if (r.timedOut) return t('tool.questionTimedOut');
          if (r.status === 'expired') return t('tool.questionExpired');
          if (r.typed) return t('tool.questionTyped');
          if (r.status === 'denied') return t('tool.questionSkipped');
          const answers = r.answers;
          const lines = items.map((q, i) => {
            const given = answers[i] || t('tool.emptyAnswer');
            return `- ${q.question} → ${q.secret && answers[i] ? t('tool.secretAnswer', { answer: given }) : given}`;
          });
          const said = t('tool.answers', { lines: lines.join('\n'), id: r.approvalId });
          return r.via ? `${said}\n${t('approval.viaManager', { manager: r.via })}` : said;
        },
        'internal',
      ),
      ...(plan
        ? [
            def(
              'plan_update',
              {
                todos: z
                  .array(
                    z.object({
                      content: z.string().min(1).max(300),
                      status: z.enum(['pending', 'in_progress', 'completed']),
                    }),
                  )
                  .max(50),
              },
              async (a) => {
                await plan(planItems(a) ?? []);
                return t('tool.planShown');
              },
              'internal',
            ),
          ]
        : []),
      ...(skills.length
        ? [
            def(
              'skill_read',
              { name: z.string().min(1).max(100) },
              async ({ name }) => {
                const wanted = name.trim().toLowerCase();
                const skill = skills.find((k) => k.name === wanted);
                if (!skill) {
                  return t('tool.noSkill', { name, names: skills.map((k) => k.name).join(', ') });
                }
                await s.skills.markUsed(skill.id);
                return `# ${skill.name}\n${skill.description}\n\n${skill.body}`.trim();
              },
              'read',
            ),
          ]
        : []),
      def(
        'app_suggest',
        { app: z.string().min(1).max(80), reason: z.string().min(1).max(300) },
        async ({ app, reason }) => {
          const wanted = app.trim().toLowerCase();
          const entry =
            catalogEntry(wanted) ??
            CONNECTION_CATALOG.find((e) => e.name.toLowerCase() === wanted) ??
            searchCatalog(wanted, (c) => c)[0];
          if (!entry) return t('tool.appUnknown', { app });
          const there = (await s.connections.list(own)).filter(
            (c) => c.catalogId === entry.id && c.status === 'connected',
          );
          if (there.some((c) => c.allBots || c.botIds.includes(bot.id)))
            return t('tool.appConnected', { app: entry.name });
          // Connected already but closed to this bot: a second sign-in would only duplicate it.
          // Pointed to app_add only when app_add may open it, as it would otherwise just say so.
          const manages = managesServer((await s.access.viewerOf(person)).role);
          const closed = !team && there.find((c) => c.url && (c.userId ? c.userId === person : manages));
          if (closed) return t('tool.appClosed', { app: entry.name, url: closed.url });
          await s.threads.addMessage({
            threadId: thread.id,
            role: 'system',
            author: `bot:${bot.id}`,
            text: reason,
            props: { suggestApp: entry.id },
            turnId: turn.id,
          });
          return t('tool.appSuggested', { app: entry.name });
        },
        'internal',
      ),
      def(
        'quick_replies',
        { options: z.array(z.string().trim().min(1).max(80)).min(1).max(6) },
        async ({ options }) => {
          // Shown as buttons under the reply; a press sends that text as the person's next message.
          await s.threads.addMessage({
            threadId: thread.id,
            role: 'system',
            author: `bot:${bot.id}`,
            text: '',
            props: { quickReplies: [...new Set(options)] },
            turnId: turn.id,
          });
          return t('tool.quickRepliesShown');
        },
        'internal',
      ),
      def(
        'show_card',
        {
          card: z
            .unknown()
            .describe('The card: one JSON tree of ChatKit widget components, rooted at a Card or a ListView'),
          card_id: z
            .string()
            .max(64)
            .optional()
            .describe('Only to replace a card you showed and nobody has answered: the card_id it returned'),
        },
        ({ card, card_id }) => s.chatCards.show({ bot, thread, input: card, cardId: card_id, t }),
        'internal',
      ),
      def(
        'report_problem',
        {
          title: z.string().trim().min(1).max(REPORT_LIMITS.title),
          what_happened: z.string().trim().min(1).max(REPORT_LIMITS.description),
          steps: z.string().trim().max(REPORT_LIMITS.reproduction).optional(),
          asked: z.boolean().default(false),
        },
        async ({ title, what_happened, steps, asked }) => {
          // The report carries the server's version, system and errors: only for someone with an
          // account here, writing in this conversation, not a stranger in a chat app or a routine.
          if (!fromUser || guest || opts.contact) return t('tool.problemNotAllowed');
          if (NO_CARDS.includes(thread.kind)) return t('tool.cardNotHere');
          const hidden = t('memory.redacted');
          const errors = await this.ctx.db
            .select({ text: schema.messages.text, props: schema.messages.props })
            .from(schema.messages)
            .where(
              and(
                eq(schema.messages.threadId, thread.id),
                eq(schema.messages.role, 'error'),
                gte(schema.messages.createdAt, new Date(Date.now() - REPORT_ERRORS_MS)),
              ),
            )
            .orderBy(desc(schema.messages.createdAt))
            .limit(REPORT_ERRORS);
          // A sign-in or a provider's limit is for the person to fix, not a fault in Leaf Bot.
          const setup = (e: { props: Record<string, unknown> }) =>
            e.props.kind === 'auth' || e.props.kind === 'limit';
          if (!asked && errors.length && errors.every(setup)) return t('tool.problemIsSetup');
          const { report, url } = problemReport({
            title: publicText(title, hidden),
            description: publicText(what_happened, hidden),
            ...(steps && { reproduction: publicText(steps, hidden) }),
            errors: errors
              .filter((e) => !setup(e))
              .reverse()
              .map((e) => publicText(e.text, hidden).replace(/\s+/g, ' '))
              .join('\n'),
            version: LEAFBOT_VERSION,
            system: `${os.type()} ${os.release()} (${os.arch()})`,
            engine: [bot.engine, bot.model].filter(Boolean).join(' / '),
          });
          // The description and the steps read as Markdown, as GitHub shows them; the errors
          // stay plain, one per line, as the form shows them in a text block.
          const section = (label: string, text: string | undefined, markdown: boolean) =>
            text
              ? [
                  { type: 'Caption', value: label, weight: 'semibold' },
                  ...(markdown
                    ? [{ type: 'Markdown', value: text }]
                    : text.split('\n').map((line) => ({ type: 'Text', value: line, size: 'sm' }))),
                ]
              : [];
          const card = {
            type: 'Card',
            children: [
              {
                type: 'Row',
                children: [
                  { type: 'Icon', name: 'bug' },
                  { type: 'Title', value: t('problem.cardTitle') },
                ],
              },
              { type: 'Text', value: report.title ?? title, weight: 'semibold' },
              { type: 'Markdown', value: report.description ?? '' },
              ...section(t('problem.steps'), report.reproduction, true),
              ...section(t('problem.errors'), report.errors, false),
              {
                type: 'Caption',
                value: [`Leaf Bot ${report.version}`, report.system, report.engine]
                  .filter(Boolean)
                  .join(' · '),
              },
              { type: 'Caption', value: t('problem.note') },
              {
                type: 'Row',
                children: [
                  {
                    type: 'Button',
                    label: t('problem.notNow'),
                    style: 'secondary',
                    onClickAction: { type: 'report_not_now' },
                  },
                  {
                    type: 'Button',
                    label: t('problem.open'),
                    style: 'primary',
                    iconStart: 'external-link',
                    onClickAction: { type: 'open_url', payload: { url } },
                  },
                ],
              },
            ],
          };
          const shown = await s.chatCards.show({ bot, thread, input: card, t });
          return `${shown}\n\n${t('tool.problemShown')}`;
        },
        'internal',
      ),
      def(
        'app_add',
        { name: z.string().min(1).max(80), url: z.string().min(1).max(2000) },
        async ({ name, url }) => {
          // The bot changes itself only for someone who may change it.
          if (!(await mayChange())) return t('tool.changeNotAllowed');
          const input = ConnectionCreate.safeParse({ name, url, auth: 'none' });
          if (!input.success) return t('tool.appBadUrl', { url });
          const manages = managesServer((await s.access.viewerOf(person)).role);
          // Only those who look after the server point the server at itself or its network.
          if (!manages && (await privateHost(new URL(input.data.url).hostname)))
            return t('error.connectionPrivate');
          const known = (await s.connections.list(person)).find((c) => c.url === input.data.url);
          if (known) {
            // Already there but closed to this bot: the person may open it to the bot, since it
            // acts with their sign-in, which they are asked about whatever the bot may do alone.
            // A team connection is opened only by those who look after the server, as in the app.
            const open = known.allBots || known.botIds.includes(bot.id);
            const mayOpen = known.userId ? known.userId === person : manages;
            if (open || !mayOpen) return t('tool.appKnown', { name: known.name });
            const ok = await askOnCard(
              t('tool.appOpenAsk', { name: known.name, bot: bot.name }),
              { name, url },
              'app_add',
            );
            if (ok !== true) return refusedOnCard(t('tool.appNotOpened', { name: known.name }), ok);
            const c = await s.connections.setBots(known.id, {
              allBots: false,
              botIds: [...known.botIds, bot.id],
            });
            const tools = c.tools.map((x) => x.name).join(', ') || '-';
            return t('tool.appOpened', { name: c.name, tools });
          }
          // The person's own, open to this bot only; they can open it to others in the apps window.
          let c = await s.connections.create({ ...input.data, allBots: false, botIds: [bot.id] }, person);
          if (c.status === 'signed-out') {
            // The server wants a sign-in: it became an OAuth connection for the person to sign in
            // to, or, when it offers no sign-in and wants a key, one they enter the key for.
            const needsKey = c.auth === 'token';
            if (!needsKey && c.auth !== 'oauth') c = await s.connections.update(c.id, { auth: 'oauth' });
            await s.threads.addMessage({
              threadId: thread.id,
              role: 'system',
              author: `bot:${bot.id}`,
              text: t(needsKey ? 'connection.needsKeyCardText' : 'tool.appSignInCard', { name: c.name }),
              props: { connectionSignIn: c.id },
              turnId: turn.id,
            });
            return t(needsKey ? 'tool.appNeedsKey' : 'tool.appNeedsSignIn', { name: c.name });
          }
          if (c.status === 'error') return t('tool.appFailed', { name: c.name, message: c.error ?? '' });
          const tools = c.tools.map((x) => x.name).join(', ') || '-';
          return t('tool.appAdded', { name: c.name, tools });
        },
        // The person approves the new server on a card first.
      ),
      def(
        'routine_create',
        {
          name: z.string().min(1).max(80),
          /** For a manager: the bot whose routine it is, by name; left out for its own. */
          bot: z.string().min(1).max(200).optional(),
          prompt: z.string().min(1).max(20_000),
          schedule: Schedule,
          /** Its last day (`YYYY-MM-DD`, the person's time zone, that day included); it switches off after. */
          ends_on: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          missed: z.enum(['run', 'skip']).default('run'),
          /** Give each run the previous run's report, for "what changed since last time" routines. */
          carry_report: z.boolean().default(false),
          /** Run in the main conversation with the person, with its context, not one of its own. */
          in_main: z.boolean().default(true),
          /** Only look and report: every run is held to reading, so it can change nothing. */
          report_only: z.boolean().default(false),
          /** Also run once whenever the server starts (on a desktop: when the computer is turned on). */
          on_startup: z.boolean().default(false),
          /** An https page read before each run with no AI; the routine runs only when it changed. */
          watch_url: z
            .string()
            .regex(/^https:\/\/\S+$/)
            .max(2000)
            .optional(),
          /** A connected app's read-only tool called before each run with no AI; it runs only when the answer changed. */
          check_tool: z.string().min(1).max(300).optional(),
          check_args: z.record(z.string(), z.unknown()).optional(),
          /** Also give it a secret address another service can call to start it. */
          webhook: z.boolean().default(false),
          /** Conditions a webhook call's JSON body must meet to start it, one per line. */
          webhook_filter: z.string().max(2000).optional(),
          /** A webhook call only posts what it carries, with no AI turn. */
          webhook_post: z.boolean().optional(),
          /** What it does after its instruction, in order, each once the one before it ended well. */
          steps: StepsInput.optional(),
          /** What must hold, looked at with no AI, before a scheduled run starts. */
          condition: ConditionInput.optional(),
          /** The Slack channel (`C…`) its reports go to; it then runs as that team's conversation. */
          slack_channel: RoutineCreate.shape.slackChannel.unwrap().unwrap().optional(),
          /** An emoji's name: the person's reaction with it in Slack runs it on that message. */
          slack_reaction: z.string().max(82).optional(),
          /** Also run when mail arrives at the bot's address, when the mail meets `email_filter`. */
          on_email: z.boolean().default(false),
          email_filter: z.string().max(2000).optional(),
          /** The name of one of its tables: a row the person adds there in the app starts it. */
          on_table: z.string().min(1).max(200).optional(),
          table_filter: z.string().max(2000).optional(),
          /** The model its runs use, on the bot's own engine; left out for the bot's own model. */
          model: z.string().trim().max(200).optional(),
        },
        async (a) => {
          // The bot changes itself only for someone who may change it.
          if (!(await mayChange())) return t('tool.changeNotAllowed');
          // A manager sets one up for a bot it looks after, as it changes and removes theirs; never
          // for another manager, whose routines are its own to keep.
          const owner = a.bot ? await reachBot(a.bot, 'edit') : bot;
          if (owner.id !== bot.id && !bot.isManager) return t('tool.routineNotYours');
          if (owner.id !== bot.id && owner.isManager) return t('tool.otherManager');
          const own = await s.routines.list(owner.id);
          const same = own.find((r) => r.name.toLowerCase() === a.name.trim().toLowerCase());
          if (same) return t('tool.routineExists', { name: same.name });
          const check = a.check_tool
            ? await s.connections.checkFromName(owner.id, a.check_tool, person)
            : null;
          if (a.check_tool && !check) return t('tool.routineBadCheck', { tool: a.check_tool });
          const watched = a.on_table ? await tableNamed(owner.id, a.on_table) : null;
          if (typeof watched === 'string') return watched;
          const written = stepsFrom(a.steps ?? [], t);
          if (typeof written === 'string') return written;
          const steps = await stepBotsFrom(written, owner.id);
          if (typeof steps === 'string') return steps;
          const wrongModel = await routineModelProblem(owner.id, [a.model ?? '', ...stepModels(steps)]);
          if (wrongModel) return wrongModel;
          const reaction = slackReaction(a.slack_reaction ?? '');
          if (reaction === null) return t('tool.routineBadReaction', { reaction: a.slack_reaction ?? '' });
          const condition = a.condition ? await conditionFrom(a.condition, owner.id, a.name.trim()) : null;
          if (typeof condition === 'string') return condition;
          const settings = await s.settings.all();
          const r = await s.routines.create(
            {
              botId: owner.id,
              name: a.name.trim(),
              prompt: a.prompt.trim(),
              // The person sees each step on the card before the routine is made.
              steps,
              slackReaction: reaction,
              schedule: a.schedule,
              timezone: settings.timezone,
              enabled: true,
              endsOn: a.ends_on ?? null,
              missed: a.missed,
              carryReport: a.carry_report,
              inMain: a.in_main,
              reportOnly: a.report_only,
              slackChannel: a.slack_channel ?? null,
              onStartup: a.on_startup,
              watchUrl: a.watch_url ?? null,
              check: check && { ...check, args: a.check_args ?? {} },
              condition,
              webhookFilter: a.webhook_filter ?? '',
              webhookPost: a.webhook_post ?? false,
              model: a.model ?? '',
              emailTrigger: a.on_email,
              emailFilter: a.email_filter ?? '',
              // WhatsApp is turned on with whatsapp_follow, which asks the person on its own card.
              whatsappGroup: null,
              whatsappPeople: false,
              tableTrigger: watched?.id ?? null,
              tableFilter: a.table_filter ?? '',
              flowLayout: null,
              flowNotes: [],
              inputs: {},
            },
            person,
          );
          // What the bot promised is now set up: the promise safety net leaves this turn's reply alone.
          s.promises.routineTouched(turn.id);
          this.ctx.bus.refresh({
            scope: 'routineMade',
            threadId: turn.threadId,
            botId: r.botId,
            routineId: r.id,
            name: r.name,
          });
          await journal({
            kind: 'routine',
            op: 'create',
            targetId: r.id,
            label: r.name,
            scopeBotId: r.botId,
            after: { sig: sig(routineShape(r)) },
          });
          const made = t('tool.routineCreated', {
            name: r.name,
            when: describeSchedule(r.schedule, await s.settings.locale()),
            timezone: r.timezone,
          });
          // A step that waits for the routine's webhook needs its address to be called at.
          if (!a.webhook && !waitsOnHook(steps)) return made;
          const hooked = await s.routines.setWebhook(r.id, true);
          return `${made}\n${t('tool.routineWebhook', { path: `/api/hooks/routines/${r.id}/${hooked.webhookToken}` })}`;
        },
        // The person sees the routine and its schedule on a card before it is made.
      ),
      def(
        'routine_read',
        {
          routine: z.string().min(1).max(200),
          bot: z.string().min(1).max(200).optional(),
        },
        async (a) => {
          // Its instruction is the bot's own setup: shown to whoever may change it, as routine_update is.
          if (!(await mayChange())) return t('tool.changeNotAllowed');
          const found = await pickRoutine(a.routine, a.bot);
          if (typeof found === 'string') return found;
          const r = found.routine;
          const runs = await s.routines.runs(r.id, 3);
          const last = runs[0];
          // The fields as routine_update takes them, so the bot can send one back as it found it.
          const table = r.tableTrigger
            ? (await s.tables.list(r.botId).catch(() => [])).find((x) => x.id === r.tableTrigger)?.name
            : undefined;
          const settings = {
            ...(r.model && { model: r.model }),
            in_main: r.inMain,
            on_startup: r.onStartup,
            ...(r.endsOn && { ends_on: r.endsOn }),
            ...(r.watchUrl && { watch_url: r.watchUrl }),
            ...(r.check && { check_tool: r.check.tool, check_args: r.check.args }),
            ...(r.condition && { condition: await conditionOut(r.condition, r.botId) }),
            webhook: !!r.webhookToken,
            ...(r.webhookFilter && { webhook_filter: r.webhookFilter }),
            ...(r.webhookPost && { webhook_post: true }),
            on_email: r.emailTrigger,
            ...(r.emailFilter && { email_filter: r.emailFilter }),
            ...(r.tableTrigger && { on_table: table ?? r.tableTrigger }),
            ...(r.tableFilter && { table_filter: r.tableFilter }),
            ...(r.whatsappGroup && { whatsapp_group: r.whatsappGroup }),
            ...(r.whatsappPeople && { whatsapp_people: true }),
            ...(r.slackChannel && { slack_channel: r.slackChannel }),
            ...(r.pausedReason && { paused_reason: r.pausedReason }),
            ...(r.signInWait && { waits_for_sign_in: true }),
          };
          const steps = r.steps ?? [];
          // What the condition says now, read with no AI, so the bot sees whether what it built holds.
          const now = r.condition ? await s.routines.conditionNow(r.id).catch(() => null) : null;
          const conditionLine = now
            ? `\n${t('tool.routineReadCondition', {
                outcome: t(`tool.routineCondition_${now.outcome}`),
                lines: now.lines.join('; ') || '-',
              })}`
            : '';
          // How each step of the latest runs went: the bot sees where a routine it built stops.
          const runLines = runs.map((run) =>
            t('tool.routineReadRun', {
              status: run.status,
              at: run.startedAt,
              reason: run.reason ?? '-',
              steps:
                run.steps
                  ?.map((x) => `${x.position}:${x.kind}=${x.status}${x.reason ? ` (${x.reason})` : ''}`)
                  .join(', ') ?? '-',
            }),
          );
          return t('tool.routineRead', {
            name: r.name,
            state: t(r.enabled ? 'tool.routineOn' : 'tool.routineOff'),
            when: describeSchedule(r.schedule, await s.settings.locale()),
            timezone: r.timezone,
            missed: r.missed,
            carry: String(r.carryReport),
            // A bot changing such a routine's instruction must know its runs may only look and report.
            reportOnly: String(r.reportOnly),
            last: last
              ? t('tool.routineReadLast', {
                  status: last.status,
                  at: last.startedAt,
                  reason: last.reason ?? '-',
                })
              : t('tool.routineReadNoRun'),
            prompt: r.prompt,
            steps: [
              `\n${t('tool.routineReadSettings')}\n${JSON.stringify(settings)}`,
              conditionLine,
              steps.length
                ? `\n${t('tool.routineReadSteps')}\n${JSON.stringify(
                    stepsOut(steps, new Map((await s.bots.list()).map((b) => [b.id, b.name]))),
                    null,
                    1,
                  )}`
                : '',
              runLines.length > 1 || (runLines.length && steps.length)
                ? `\n${t('tool.routineReadRuns')}\n${runLines.join('\n')}`
                : '',
            ].join(''),
          });
        },
        'read',
      ),
      def(
        'routine_update',
        {
          routine: z.string().min(1).max(200),
          bot: z.string().min(1).max(200).optional(),
          enabled: z.boolean().optional(),
          name: z.string().min(1).max(80).optional(),
          prompt: z.string().min(1).max(20_000).optional(),
          schedule: Schedule.optional(),
          /** An empty string removes the last day. */
          ends_on: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal('')]).optional(),
          missed: z.enum(['run', 'skip']).optional(),
          carry_report: z.boolean().optional(),
          in_main: z.boolean().optional(),
          report_only: z.boolean().optional(),
          on_startup: z.boolean().optional(),
          /** An empty string stops watching the page. */
          watch_url: z
            .union([
              z
                .string()
                .regex(/^https:\/\/\S+$/)
                .max(2000),
              z.literal(''),
            ])
            .optional(),
          /** An empty string removes the check. */
          check_tool: z.string().max(300).optional(),
          check_args: z.record(z.string(), z.unknown()).optional(),
          /** An empty string goes back to the bot's own model. */
          model: z.string().trim().max(200).optional(),
          on_email: z.boolean().optional(),
          email_filter: z.string().max(2000).optional(),
          /** An empty string stops starting on the table's new rows. */
          on_table: z.string().max(200).optional(),
          table_filter: z.string().max(2000).optional(),
          /** true gives it a webhook address when it has none; false takes the address away. */
          webhook: z.boolean().optional(),
          webhook_filter: z.string().max(2000).optional(),
          webhook_post: z.boolean().optional(),
          /** Every step after the instruction, in order: the list replaces the routine's steps. */
          steps: StepsInput.optional(),
          /** The whole condition, replacing the one it has; an empty `checks` removes it. */
          condition: ConditionInput.optional(),
          /** An empty string stops posting to Slack. */
          slack_channel: z
            .union([RoutineCreate.shape.slackChannel.unwrap().unwrap(), z.literal('')])
            .optional(),
          /** An empty string stops starting on a reaction. */
          slack_reaction: z.string().max(82).optional(),
        },
        async (a) => {
          // The bot changes itself only for someone who may change it.
          if (!(await mayChange())) return t('tool.changeNotAllowed');
          const found = await pickRoutine(a.routine, a.bot);
          if (typeof found === 'string') return found;
          const { routine: r, routines } = found;
          let check: RoutineCheck | null | undefined;
          if (a.check_tool) {
            // The check runs as the routine's own bot, which may be another one for a manager.
            const named = await s.connections.checkFromName(r.botId, a.check_tool, person);
            if (!named) return t('tool.routineBadCheck', { tool: a.check_tool });
            check = { ...named, args: a.check_args ?? {} };
          } else if (a.check_tool === '') {
            check = null;
          } else if (a.check_args && r.check) {
            check = { ...r.check, args: a.check_args };
          }
          // The table is the routine's own bot's, which may be another one for a manager.
          const watched = a.on_table ? await tableNamed(r.botId, a.on_table) : null;
          if (typeof watched === 'string') return watched;
          const written = a.steps ? stepsFrom(a.steps, t) : undefined;
          if (typeof written === 'string') return written;
          const steps = written && (await stepBotsFrom(written, r.botId, r.steps ?? []));
          if (typeof steps === 'string') return steps;
          // Only a model the routine does not have yet is looked at: one it runs on already stays
          // usable, so a step kept as it was never blocks a change to another one.
          const had = new Set([r.model, ...stepModels(r.steps ?? [])]);
          const wrongModel = await routineModelProblem(
            r.botId,
            [a.model ?? '', ...stepModels(steps ?? [])].filter((m) => !had.has(m)),
          );
          if (wrongModel) return wrongModel;
          const reaction = a.slack_reaction === undefined ? undefined : slackReaction(a.slack_reaction);
          if (reaction === null) return t('tool.routineBadReaction', { reaction: a.slack_reaction ?? '' });
          // The condition reads the routine's own bot's tables and apps, which may be another one for a manager.
          const condition = a.condition
            ? await conditionFrom(a.condition, r.botId, r.name, r.condition ?? null)
            : undefined;
          if (typeof condition === 'string') return condition;
          if (a.webhook === false && waitsOnHook(steps ?? r.steps ?? [])) return t('tool.routineHookNeeded');
          // A step that asks the person is their hold on what the routine does: one taken away or
          // put elsewhere is asked about on a card, whatever the bot may do by itself.
          const held = (r.steps ?? []).filter((x) => x.kind === 'approval');
          const before = r.steps ?? [];
          const at = (id: string) => steps?.findIndex((y) => y.id === id) ?? -1;
          // Taken away, or with a step that came after it (and so waited for the person) now before it,
          // or given a condition that can pass it over and let the steps after it run unasked, or
          // with a new way from a step before it to one after it.
          const passedBefore = new Set(routesPastApproval(before));
          const loosened =
            steps &&
            (routesPastApproval(steps).some((k) => !passedBefore.has(k)) ||
              held.some((x) => {
                const now = steps.findIndex((y) => y.id === x.id && y.kind === 'approval');
                if (now < 0) return true;
                const when = steps[now]!.when;
                if (
                  when &&
                  when.otherwise !== 'end' &&
                  JSON.stringify(when) !== JSON.stringify(x.when ?? null)
                )
                  return true;
                return before.slice(before.indexOf(x) + 1).some((y) => {
                  const there = at(y.id);
                  return there >= 0 && there < now;
                });
              }));
          if (loosened) {
            const ok = await askOnCard(
              t('tool.routineApprovalDropped', { name: r.name }),
              { routine: r.name, steps: a.steps },
              'routine_update',
            );
            if (ok !== true) return refusedOnCard(t('tool.routineApprovalKept', { name: r.name }), ok);
          }
          const patch: z.infer<typeof RoutineUpdate> = {
            ...(a.enabled !== undefined && { enabled: a.enabled }),
            ...(a.name !== undefined && { name: a.name.trim() }),
            ...(a.prompt !== undefined && { prompt: a.prompt.trim() }),
            ...(a.schedule !== undefined && { schedule: a.schedule }),
            ...(a.ends_on !== undefined && { endsOn: a.ends_on || null }),
            ...(a.missed !== undefined && { missed: a.missed }),
            ...(a.carry_report !== undefined && { carryReport: a.carry_report }),
            ...(a.in_main !== undefined && { inMain: a.in_main }),
            ...(a.report_only !== undefined && { reportOnly: a.report_only }),
            ...(a.on_startup !== undefined && { onStartup: a.on_startup }),
            ...(a.watch_url !== undefined && { watchUrl: a.watch_url || null }),
            ...(check !== undefined && { check }),
            ...(a.model !== undefined && { model: a.model }),
            ...(a.on_email !== undefined && { emailTrigger: a.on_email }),
            ...(a.email_filter !== undefined && { emailFilter: a.email_filter }),
            ...(a.on_table !== undefined && { tableTrigger: watched?.id ?? null }),
            ...(a.table_filter !== undefined && { tableFilter: a.table_filter }),
            ...(a.webhook_filter !== undefined && { webhookFilter: a.webhook_filter }),
            ...(a.webhook_post !== undefined && { webhookPost: a.webhook_post }),
            ...(steps !== undefined && { steps }),
            ...(condition !== undefined && { condition }),
            ...(a.slack_channel !== undefined && { slackChannel: a.slack_channel || null }),
            ...(reaction !== undefined && { slackReaction: reaction }),
          };
          // The address is kept apart from the routine's fields: a routine that has one keeps it.
          const hookOn = (a.webhook === true || (steps && waitsOnHook(steps))) && !r.webhookToken;
          const hookOff = a.webhook === false && !!r.webhookToken;
          if (!Object.keys(patch).length && !hookOn && !hookOff) return t('tool.routineNoChange');
          const rename = patch.name?.toLowerCase();
          const taken =
            rename &&
            routines.find((x) => x.id !== r.id && x.botId === r.botId && x.name.toLowerCase() === rename);
          if (taken) return t('tool.routineExists', { name: taken.name });
          let updated = Object.keys(patch).length ? await s.routines.update(r.id, patch, person) : r;
          if (hookOn || hookOff) updated = await s.routines.setWebhook(r.id, !!hookOn);
          s.promises.routineTouched(turn.id);
          await journal({
            kind: 'routine',
            op: 'update',
            targetId: r.id,
            label: updated.name,
            scopeBotId: r.botId,
            before: { patch: pickFields(r, Object.keys(patch)) },
            after: { sig: sig(routineShape(updated)) },
          });
          const done = t('tool.routineUpdated', {
            name: updated.name,
            when: describeSchedule(updated.schedule, await s.settings.locale()),
            timezone: updated.timezone,
            state: t(updated.enabled ? 'tool.routineOn' : 'tool.routineOff'),
          });
          return hookOn && updated.webhookToken
            ? `${done}\n${t('tool.routineWebhook', { path: `/api/hooks/routines/${r.id}/${updated.webhookToken}` })}`
            : done;
        },
        // The person sees which routine changes, and how, on a card first.
      ),
      def(
        'promise_track',
        {
          what: z.string().trim().min(1).max(300),
          to: z.string().trim().max(100).default(''),
          /** The day it is due, YYYY-MM-DD in the person's time zone; left out when it has none. */
          due: z.string().trim().max(20).optional(),
        },
        async ({ what, to, due }) => {
          // The turn dealt with a promise itself: the safety net has nothing to add to its reply.
          s.promises.routineTouched(turn.id);
          const day = due?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
          if (due && (!day || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day))
            return t('tool.promiseBadDue', { due });
          const row = await s.promises.track({
            person,
            bot,
            threadId: thread.id,
            what,
            toWhom: to,
            day,
            t,
          });
          return t(row.followUpId ? 'tool.promiseTrackedRemind' : 'tool.promiseTracked', {
            what: row.text,
            day: day ?? '-',
          });
        },
        // The person sees and closes every promise on their Today page, and its reminder is a
        // follow-up, not a routine, so the bot notes it without a card.
        'internal',
      ),
      def(
        'followup_add',
        {
          what: z.string().trim().min(1).max(500),
          event: z.string().trim().max(40).optional(),
          when: z.string().trim().max(40).optional(),
          from: z.string().trim().max(500).optional(),
          replaces: z.string().trim().max(100).optional(),
        },
        async ({ what, event, when, from, replaces }) => {
          const settings = await s.settings.all(person);
          const now = s.followUps.now();
          const moment = event ? readMoment(event, settings.timezone) : null;
          if (event && !moment) return t('tool.followUpBadTime', { when: event });
          const due = when ? followUpTime(when, settings.timezone, settings.promiseRemindAt) : null;
          if (when && !due) return t('tool.followUpBadTime', { when });
          if (!moment && !due) return t('tool.followUpNeedsTime');
          if (due && new Date(due).getTime() <= now.getTime()) return t('tool.followUpPast');
          // The turn dealt with a promise itself: the safety net has nothing to add to its reply.
          s.promises.routineTouched(turn.id);
          try {
            const f = await s.followUps.add({
              bot,
              userId: person,
              threadId: thread.id,
              text: what,
              context: from,
              eventAt: moment?.at ?? null,
              eventHasTime: moment?.hasTime,
              dueAt: due ? new Date(due) : null,
              outside: reads(),
              present: fromUser,
              replaces,
              t,
            });
            if (!f) return t('tool.followUpTooLate');
            const w = wallClock(new Date(f.dueAt), settings.timezone);
            const p = (n: number) => String(n).padStart(2, '0');
            return t('tool.followUpAdded', {
              id: f.id,
              when: `${w.year}-${p(w.month)}-${p(w.day)} ${p(w.hour)}:${p(w.minute)}`,
            });
          } catch (err) {
            if (err instanceof FollowUpsFull) return t('tool.followUpsFull', { max: MAX_OPEN_FOLLOW_UPS });
            throw err;
          }
        },
        // The bot keeping track for itself: nobody is asked, and it is no routine. When it comes up the
        // turn works for nobody who asked just now, and one set from outside text keeps that mark, so
        // anything that would change something still waits for a card.
        'internal',
      ),
      def(
        'followup_list',
        {},
        async () => {
          const list = await s.followUps.list(person);
          if (!list.length) return t('tool.followUpsNone');
          return list
            .map(
              (f) =>
                `- [${f.id}] ${f.dueAt}${f.eventAt ? ` (${t('tool.followUpEvent', { at: f.eventAt })})` : ''}: ${f.text}${f.context ? ` — ${f.context}` : ''}`,
            )
            .join('\n');
        },
        'read',
      ),
      def(
        'followup_drop',
        { id: z.string().min(1).max(100) },
        async ({ id }) => {
          try {
            await s.followUps.drop(id, person);
          } catch {
            return t('tool.followUpNotFound');
          }
          return t('tool.followUpDropped');
        },
        'internal',
      ),
      def(
        'routine_run',
        {
          routine: z.string().min(1).max(200),
          bot: z.string().min(1).max(200).optional(),
          /** Try it once without doing anything: steps that would change something are only described. */
          rehearse: z.boolean().default(false),
        },
        async (a) => {
          // Running it spends and acts as its person: only for someone who may change the bot.
          if (!(await mayChange())) return t('tool.changeNotAllowed');
          const found = await pickRoutine(a.routine, a.bot);
          if (typeof found === 'string') return found;
          const r = found.routine;
          if (a.rehearse) {
            await s.rehearsals.start(r.id, person, {});
            return t('tool.routineRehearsing', { name: r.name });
          }
          // A run of the routine this turn is part of would wait for this very turn to end.
          if (turn.routineRunId) {
            const [own] = await this.ctx.db
              .select({ routineId: schema.routineRuns.routineId })
              .from(schema.routineRuns)
              .where(eq(schema.routineRuns.id, turn.routineRunId));
            if (own?.routineId === r.id) return t('tool.routineRunSelf');
          }
          const run = await s.routines.runNow(r.id);
          if (!run || run.status === 'skipped' || run.status === 'error')
            return [t('tool.routineRunNot', { name: r.name }), run?.reason].filter(Boolean).join(' ');
          return t('tool.routineRunStarted', { name: r.name });
        },
        // Run now does what the routine does, so it goes by the bot's level like any step that acts.
      ),
      def(
        'routine_delete',
        { routine: z.string().min(1).max(200), bot: z.string().min(1).max(200).optional() },
        async (a) => {
          // The bot changes itself only for someone who may change it.
          if (!(await mayChange())) return t('tool.changeNotAllowed');
          const found = await pickRoutine(a.routine, a.bot);
          if (typeof found === 'string') return found;
          await s.routines.remove(found.routine.id);
          await journal({
            kind: 'routine',
            op: 'delete',
            targetId: found.routine.id,
            label: found.routine.name,
            scopeBotId: found.routine.botId,
            before: {
              botId: found.routine.botId,
              createdBy: found.routine.createdByUserId,
              shape: routineShape(found.routine),
            },
          });
          return t('tool.routineDeleted', { name: found.routine.name });
        },
        // The person approves the deletion on a card first; the turn can be taken back from the app.
      ),
      ...(turn.routineRunId
        ? [
            def(
              'routine_stop',
              { reason: z.string().min(1).max(500) },
              async ({ reason }) => {
                // A bot that does one step of another bot's routine does not switch that routine off.
                const [own] = await this.ctx.db
                  .select({ botId: schema.routines.botId })
                  .from(schema.routineRuns)
                  .innerJoin(schema.routines, eq(schema.routines.id, schema.routineRuns.routineId))
                  .where(eq(schema.routineRuns.id, turn.routineRunId!));
                if (own && own.botId !== bot.id) return t('tool.routineStopOther');
                const name = await s.routines.stopFromRun(turn.routineRunId!, reason);
                return name ? t('tool.routineStopped', { name }) : t('tool.routineGone');
              },
              'internal',
            ),
            def(
              'routine_failed',
              { reason: z.string().min(1).max(500) },
              async ({ reason }) => {
                await s.routines.markFailed(turn.routineRunId!, reason);
                return t('tool.routineMarkedFailed');
              },
              'internal',
            ),
            def(
              'routine_set',
              {
                name: z.string().regex(ROUTINE_VAR_NAME),
                // One line: a wait step's filter is read line by line, so a value may not add one.
                value: z
                  .string()
                  .trim()
                  .min(1)
                  .max(ROUTINE_VAR_MAX)
                  .refine((v) => !/[\r\n]/.test(v)),
              },
              async ({ name, value }) => {
                const saved = await s.routines.setVar(turn.routineRunId!, name, value);
                if (saved === 'gone') return t('tool.routineGone');
                if (saved === 'full') return t('tool.routineValuesFull', { max: ROUTINE_VARS_MAX });
                return t('tool.routineValueSaved', { name });
              },
              'internal',
            ),
          ]
        : []),
      def(
        'skill_save',
        {
          name: z.string().min(1).max(64),
          description: z.string().min(1).max(1024),
          body: z.string().max(50_000),
          reason: z.string().max(1000).optional(),
        },
        async (a) => {
          const name = skillSlug(a.name);
          if (!name) return t('tool.skillBadName');
          const mine = skills.find((k) => k.name === name);
          if (mine) {
            // A skill reaches every bot that has it: a better way found for someone who may not
            // change the skill waits for its owner, and changes nothing until they accept it.
            if (!(await s.skills.mayChange(mine.id, await s.skills.reachOf(person)))) {
              await s.skills.propose({
                skillId: mine.id,
                description: a.description,
                body: a.body,
                reason: a.reason?.trim() || null,
                proposedBy: bot.id,
                userId: person,
                threadId: thread.id,
              });
              return t('tool.skillProposed', { name });
            }
            const updated = await s.skills.update(mine.id, { description: a.description, body: a.body });
            await journal({
              kind: 'skill',
              op: 'update',
              targetId: mine.id,
              label: name,
              scopeBotId: bot.id,
              before: skillShape(mine),
              after: { sig: sig(skillShape(updated)) },
            });
            return t('tool.skillUpdated', { name });
          }
          // A new skill changes the bot: only for someone who may change it.
          if (!(await mayChange())) return t('tool.changeNotAllowed');
          const taken = (await s.skills.list()).find((k) => k.name === name);
          if (taken) return t('tool.skillTaken', { name });
          const created = await s.skills.create(
            { name, description: a.description, body: a.body, botIds: [bot.id] },
            person,
          );
          await journal({
            kind: 'skill',
            op: 'create',
            targetId: created.id,
            label: name,
            scopeBotId: bot.id,
            after: { sig: sig(skillShape(created)) },
          });
          return t('tool.skillCreated', { name });
        },
        // The person sees the skill on a card before it is saved.
      ),
      def(
        'my_activity',
        { days: z.number().int().min(1).max(30).default(1), query: z.string().max(200).optional() },
        async ({ days, query }) => {
          const since = new Date(Date.now() - days * 86_400_000);
          const mine = (await s.threads.list(bot.id, { userId: person, botWork: await mayChange() })).filter(
            (th) => th.id !== thread.id && new Date(th.updatedAt) >= since,
          );
          const out: string[] = [];
          for (const th of mine.slice(0, 15)) {
            const msgs = (await s.threads.messages(th.id, { limit: 40 })).filter(
              (m) =>
                (m.role === 'user' || m.role === 'assistant') &&
                new Date(m.createdAt) >= since &&
                (!query || m.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
            );
            if (!msgs.length) continue;
            await shows(msgs.slice(-8).map((m) => m.props));
            out.push(t('tool.conversation', { title: th.title || th.kind, id: th.id }));
            for (const m of msgs.slice(-8))
              out.push(`[${m.createdAt.slice(0, 16)} ${m.role}] ${truncate(m.text, 300)}`);
          }
          return out.join('\n') || t('tool.noConversations');
        },
        'read',
      ),
      def(
        'conversations_search',
        { query: z.string().min(2).max(200), limit: z.number().int().min(1).max(50).default(15) },
        async ({ query, limit }) => {
          const hits = await s.threads.search(query, {
            botId: bot.id,
            limit,
            seen: await seenHere(),
          });
          if (!hits.length) return t('tool.notFound');
          const found = await Promise.all(hits.map((h) => s.threads.message(h.messageId).catch(() => null)));
          await shows(found.flatMap((m) => (m ? [m.props] : [])));
          return hits
            .map(
              (h) =>
                `- [${h.createdAt.slice(0, 16)} ${h.role}] ${t('tool.conversationRef', {
                  title: h.threadTitle || h.threadKind,
                  thread: h.threadId,
                  message: h.messageId,
                })}\n  ${h.excerpt}`,
            )
            .join('\n');
        },
        'read',
      ),
      def(
        'message_read',
        { message_id: z.string().min(1).max(64), around: z.number().int().min(0).max(10).default(2) },
        async ({ message_id, around }) => {
          const found = await s.threads.message(message_id).catch(() => null);
          const owner = found ? await s.threads.row(found.threadId).catch(() => null) : null;
          // Another bot's message reads as missing, so its existence is not given away.
          if (!found || owner?.botId !== bot.id) return t('tool.notFound');
          // Nor another person's conversation with it.
          if (owner.userId ? owner.userId !== person : !(await mayChange())) return t('tool.notFound');
          const page = [
            ...(around ? await s.threads.messages(found.threadId, { before: found.id, limit: around }) : []),
            found,
            ...(await s.threads.messagesAfter(found.threadId, found.id, around)),
          ].filter((m) => m.role === 'user' || m.role === 'assistant');
          await shows(page.map((m) => m.props));
          const out = [t('tool.conversation', { title: owner.title || owner.kind, id: owner.id })];
          for (const m of page) {
            const mark = m.id === found.id ? '>>' : '  ';
            out.push(
              `${mark} [${m.createdAt.slice(0, 16)} ${m.role}] ${truncate(m.text, m.id === found.id ? 8000 : 600)}`,
            );
          }
          return out.join('\n');
        },
        'read',
      ),
      def(
        'memory_search',
        { query: z.string().optional(), bot: z.string().optional() },
        async ({ query, bot: botRef }) => {
          const owners = await memoryOwners();
          let ids = [...owners.keys()];
          if (botRef?.trim()) {
            const ref = botRef.trim();
            ids = ids.filter((id) => id === ref || owners.get(id)!.toLowerCase() === ref.toLowerCase());
            if (!ids.length) return t('tool.memoryNotYours');
          }
          // Narrowed to one bot, the list is that bot's notes alone.
          const found = await s.memory.search(
            ids,
            own,
            query?.trim() || undefined,
            !botRef?.trim(),
            await place(),
            !guest && !opts.contact,
          );
          if (!found.length) return t('tool.notFound');
          const whose = (m: Memory) =>
            m.scope === 'user'
              ? t('tool.scopeUser')
              : m.scope === 'room'
                ? t('tool.scopeRoom')
                : m.scope === 'common'
                  ? t('tool.scopeCommon')
                  : m.botId === bot.id
                    ? t('tool.scopeBot')
                    : owners.get(m.botId!);
          return found
            .map(
              (m) =>
                `- [${m.id}] (${whose(m)}${m.site ? ` · ${m.site}` : ''}) ${m.unverified ? `${t('prompt.unverifiedNote')} ` : ''}${m.content}${m.sourceUrl ? ` (${t('tool.memorySource', { url: m.sourceUrl })})` : ''}${m.validUntil ? ` (${t('tool.memoryUntil', { date: m.validUntil })})` : ''}`,
            )
            .join('\n');
        },
        'read',
      ),
      def(
        'memory_write',
        {
          content: z.string().min(1).max(2000),
          scope: z.enum(['bot', 'user', 'room', 'common']).default('bot'),
          site: z.string().max(253).optional(),
          from: z.string().max(2000).optional(),
          until: z.string().max(40).optional(),
        },
        async ({ content, scope, site, from, until }) => {
          const sourceUrl = from?.trim() ? sourceAddress(from) : null;
          if (sourceUrl === undefined) return t('tool.memoryBadSource', { from: from! });
          const validUntil = until === undefined ? null : noteUntil(until, await zone());
          if (validUntil === undefined) return t('tool.memoryBadUntil', { until: until! });
          if (validUntil && new Date(validUntil).getTime() <= Date.now()) return t('tool.memoryUntilPast');
          let host: string | null = null;
          if (site) {
            try {
              host = siteOf(new URL(site.includes('://') ? site : `https://${site}`).hostname);
            } catch {
              return t('tool.memoryBadSite', { site });
            }
          }
          if (team && scope === 'user') return t('tool.memoryTeamPersonal');
          if (guest && scope === 'bot') return t('tool.memoryGuest');
          if (scope === 'common') {
            if (guest || opts.contact) return t('tool.memoryGuest');
            const clean = redactSecrets(content, t('memory.redacted'));
            return proposeCommon({
              action: 'write',
              memoryId: null,
              content: clean.text,
              before: null,
              site: host,
              sourceUrl,
              validUntil,
            });
          }
          const where = scope === 'room' ? await place() : null;
          if (scope === 'room' && !where) return t('tool.memoryNoPlace');
          const clean = redactSecrets(content, t('memory.redacted'));
          const note = {
            scope,
            botId: scope === 'bot' ? bot.id : null,
            userId: scope === 'user' ? person : null,
            place: where,
            content: clean.text,
            site: host,
          };
          const same = await s.memory.findSame(note);
          if (same) {
            // The fact came up again: the note is in use, though no new one is written.
            await s.memory.markUsed([same.id]);
            return t('tool.memoryAlreadySaved', { id: same.id });
          }
          if (where && (await s.memory.roomCount(where)) >= ROOM_NOTES_PER_PLACE)
            return t('tool.memoryRoomFull', { max: ROOM_NOTES_PER_PLACE });
          const m = await s.memory.create({
            ...note,
            source: `bot:${bot.id}`,
            threadId: thread.id,
            sourceUrl,
            validUntil,
            // Outside text in the conversation may be what the note repeats: it reaches bots as data.
            unverified: !!reads(),
          });
          await journal({
            kind: 'memory',
            op: 'create',
            targetId: m.id,
            label: truncate(m.content, 80),
            scopeBotId: m.scope === 'bot' ? m.botId : null,
            after: { sig: sig(noteShape(m)) },
          });
          const said = clean.redacted
            ? `${t('tool.memorySaved', { id: m.id })} ${t('tool.memoryRedacted')}`
            : t('tool.memorySaved', { id: m.id });
          // Someone who may only talk with the bot: its own notes reach everyone else who uses it.
          return m.scope === 'bot' && !(await mayChange()) ? `${said} ${t('tool.memorySharedNote')}` : said;
        },
        // The bot keeps its memory itself, whoever it works for: asking someone to approve each note
        // asks them to judge facts from conversations they were not in. Everything it writes shows in
        // the memory screen and its history, where those who may change the bot change or delete it,
        // and the weekly tidy-up settles duplicates and contradictions. A note written with outside
        // text in the conversation is marked: bots read it as data until the person vouches for it.
        'internal',
      ),
      def(
        'memory_update',
        {
          id: z.string(),
          content: z.string().trim().min(1).max(2000),
          from: z.string().max(2000).optional(),
          until: z.string().max(40).optional(),
        },
        async ({ id, content, from, until }) => {
          const sourceUrl = from?.trim() ? sourceAddress(from) : null;
          if (sourceUrl === undefined) return t('tool.memoryBadSource', { from: from! });
          // Left out, the note keeps its date; an empty answer takes it away.
          const validUntil = until === undefined ? undefined : noteUntil(until, await zone());
          if (validUntil === undefined && until !== undefined) return t('tool.memoryBadUntil', { until });
          if (validUntil && new Date(validUntil).getTime() <= Date.now()) return t('tool.memoryUntilPast');
          const m = await s.memory.get(id);
          if (m.scope === 'common') {
            if (guest || opts.contact) return t('tool.memoryGuest');
            const clean = redactSecrets(content, t('memory.redacted'));
            return proposeCommon({
              action: 'update',
              memoryId: m.id,
              content: clean.text,
              before: m.content,
              site: m.site,
              sourceUrl,
              validUntil: validUntil ?? null,
            });
          }
          const here = await place();
          if (
            (team && m.scope === 'user') ||
            !s.memory.canEdit(m, (await memoryOwners()).keys(), person, here ? [here] : [])
          ) {
            return t('tool.memoryNotYours');
          }
          // The bot's notes reach everyone who uses it; a stranger with no account here moves none.
          if (guest && m.scope === 'bot') return t('tool.memoryGuest');
          const clean = redactSecrets(content, t('memory.redacted'));
          // Written against the version read above, so a change made meanwhile is not written over.
          try {
            const u = await s.memory.update(
              id,
              {
                content: clean.text,
                expectedUpdatedAt: m.updatedAt,
                ...sourceOf({ threadId: thread.id, sourceUrl }),
                ...(validUntil !== undefined && { validUntil }),
                // New words from a conversation with outside text in it are marked; a bot never clears the mark.
                ...(reads() && { unverified: true }),
              },
              `bot:${bot.id}`,
            );
            await journal({
              kind: 'memory',
              op: 'update',
              targetId: id,
              label: truncate(u.content, 80),
              scopeBotId: m.scope === 'bot' ? m.botId : null,
              before: { content: m.content, validUntil: m.validUntil ?? null },
              after: { sig: sig(noteShape(u)) },
            });
          } catch (err) {
            if (err instanceof HttpError && err.status === 409) return t('tool.memoryChangedSince');
            // A pinned note may only grow as far as the pinned room left; the bot hears why.
            if (err instanceof HttpError && err.key === 'error.memoryPinnedFull')
              return t('tool.memoryPinnedFull');
            throw err;
          }
          return clean.redacted
            ? `${t('tool.memoryUpdated')} ${t('tool.memoryRedacted')}`
            : t('tool.memoryUpdated');
        },
        'internal',
      ),
      def(
        'memory_forget',
        { id: z.string() },
        async ({ id }) => {
          const m = await s.memory.get(id);
          if (m.scope === 'common') {
            if (guest || opts.contact) return t('tool.memoryGuest');
            return proposeCommon({
              action: 'forget',
              memoryId: m.id,
              content: m.content,
              before: null,
              site: m.site,
              sourceUrl: null,
              validUntil: null,
            });
          }
          const owners = await memoryOwners();
          const here = await place();
          if (
            (team && m.scope === 'user') ||
            !s.memory.canEdit(m, owners.keys(), person, here ? [here] : [])
          ) {
            return t('tool.memoryNotYours');
          }
          // The bot's notes reach everyone who uses it; a stranger with no account here moves none.
          if (guest && m.scope === 'bot') return t('tool.memoryGuest');
          await s.memory.remove(id, `bot:${bot.id}`);
          await journal({
            kind: 'memory',
            op: 'delete',
            targetId: id,
            label: '',
            scopeBotId: m.scope === 'bot' ? m.botId : null,
            // The words were deleted on purpose: none of them is kept, so it cannot be put back.
            reason: 'deleted',
          });
          // The words that went are in the answer, so the step shows what was forgotten. A manager
          // deleting another bot's note is told what that bot loses.
          const gone = t('tool.memoryForgot', { content: truncate(m.content, 200) });
          return m.botId && m.botId !== bot.id
            ? `${gone} ${t('tool.memoryForgotOther', { bot: owners.get(m.botId)! })}`
            : gone;
        },
        'internal',
      ),
      def(
        'memory_flag',
        {
          kind: z.enum(['missing', 'wrong']),
          about: z.string().trim().min(1).max(300),
          seen: z.string().trim().max(1000).optional(),
          note: z.string().max(100).optional(),
          skill: z.string().max(64).optional(),
          where: z.string().max(2000).optional(),
        },
        async ({ kind, about, seen, note, skill, where }) => {
          // A chat the bot answers for the person is someone else's words, as the review keeps it.
          if (opts.contact) return t('tool.flagNotHere');
          const sourceUrl = where?.trim() ? sourceAddress(where) : null;
          if (sourceUrl === undefined) return t('tool.memoryBadSource', { from: where! });
          let memoryId: string | null = null;
          if (note) {
            const m = await s.memory.get(note).catch(() => null);
            const here = await place();
            if (
              !m ||
              (team && m.scope === 'user') ||
              !s.memory.canEdit(m, (await memoryOwners()).keys(), person, here ? [here] : [])
            )
              return t('tool.memoryNotYours');
            memoryId = m.id;
          }
          let skillId: string | null = null;
          if (skill) {
            const found = skills.find((k) => k.name === skill);
            if (!found) return t('tool.flagNoSkill', { name: skill });
            skillId = found.id;
          }
          if (kind === 'wrong' && !memoryId && !skillId) return t('tool.flagWrongNeedsTarget');
          const clean = (text: string) => redactSecrets(text, t('memory.redacted')).text;
          const done = await s.memoryFlags.raise({
            kind,
            about: clean(about),
            seen: seen ? clean(seen) : null,
            memoryId,
            skillId,
            sourceUrl,
            botId: bot.id,
            userId: person,
            place: await place(),
            outside: turn.outside ?? reads(),
            threadId: thread.id,
            turnId: turn.id,
          });
          if (done.status === 'turnFull') return t('tool.flagTurnFull', { max: FLAGS_PER_TURN });
          if (done.status === 'botFull') return t('tool.flagBotFull', { max: OPEN_FLAGS_PER_BOT });
          return done.status === 'again' ? t('tool.flagAgain') : t('tool.flagRaised');
        },
        // It changes no note: it only asks whoever knows to fill the gap, on the memory screen.
        'internal',
      ),
      def(
        'bots_list',
        {},
        async () => {
          const all = await s.bots.list();
          const shared = await reachable('chat');
          const peers = all.filter((b) => s.bots.canMessage(bot, b) && shared.has(b.id));
          if (!peers.length) return t('tool.noPeers');
          const paused = await s.bots.pausedIds();
          return peers
            .map(
              (b) =>
                `- ${b.name}${b.isManager ? t('bot.managerTag') : ''}${paused.has(b.id) ? t('bot.pausedTag') : ''}${b.description ? `: ${b.description}` : ''}`,
            )
            .join('\n');
        },
        'read',
      ),
      // Splits work off into a conversation of the bot's own, which the person sees in its list.
      // Not while answering another bot: the person does not open that exchange, so a conversation
      // opened from it would be found nowhere. What the person should read goes in the answer, and
      // a question goes on a card, which shows where the work began.
      ...(thread.kind !== 'bot'
        ? [
            def(
              'open_conversation',
              { title: z.string().trim().min(1).max(80), message: z.string().trim().min(1).max(10_000) },
              async ({ title, message }) => {
                if (opened >= MAX_OPENED) return t('tool.conversationsCap', { max: MAX_OPENED });
                opened++;
                const fresh = await s.threads.create(bot.id, {
                  title: title.replace(/\s+/g, ' '),
                  userId: person,
                });
                // What this run had read goes along: the message may carry its words.
                const outside = reads();
                await s.threads.addMessage({
                  threadId: fresh.id,
                  role: 'user',
                  author: `bot:${bot.id}`,
                  text: message,
                  props: { openedFrom: thread.id, ...(outside && { outside }) },
                });
                // A turn of its own, as any message gets; the bot works there while this one goes on.
                await s.turns.enqueue({
                  threadId: fresh.id,
                  botId: bot.id,
                  source: 'bot',
                  prompt: t('prompt.openedBySelf', { message }),
                  outside,
                });
                await s.threads.addMessage({
                  threadId: thread.id,
                  role: 'system',
                  author: `bot:${bot.id}`,
                  text: t('thread.openedNote', { title: fresh.title }),
                  props: { openedThread: fresh.id },
                  turnId: turn.id,
                });
                return t('tool.conversationOpened', { title: fresh.title });
              },
              'internal',
            ),
          ]
        : []),
      def(
        'bot_send',
        {
          bot: z.string().min(1),
          message: z.string().min(1).max(20_000),
          expect_reply: z.boolean().default(true),
          approval_id: z.string().optional(),
          files: z.array(z.string().max(2000)).max(10).optional(),
        },
        async ({ bot: ref, message, expect_reply, approval_id, files }) => {
          const to = await reachBot(ref, 'chat');
          // A paused bot takes no work; the asking bot hears so and can tell its person.
          if (await s.bots.isPaused(to)) return t('tool.botPaused', { name: to.name });
          const dataDir = this.ctx.config.dataDir;
          const job = await s.jobs.send({
            ...(files?.length && {
              attach: (toThreadId: string) =>
                handFiles({ dataDir, from: bot, fromThreadId: thread.id, to, toThreadId, paths: files, t }),
            }),
            from: bot,
            fromThreadId: thread.id,
            fromTurnId: turn.id,
            parentJobId: turn.jobId,
            to,
            text: message,
            kind: expect_reply ? 'send' : 'notify',
            approvalId: approval_id ?? null,
            outside: reads(),
          });
          return t(expect_reply ? 'tool.sent' : 'tool.notified', { to: to.name, id: job.id });
        },
        // Handing work to another of the person's bots changes nothing by itself: that bot acts at
        // its own level, with what this run read marked on the work. So it goes like a read,
        // without a card, at every level.
        'read',
        // Asking a bot with looser permissions to act would bypass this bot's own limits.
        async ({ bot: ref }) => {
          // A run that only looks and reports hands nothing on: the answer would come back as a
          // turn of the same run, which is not held to reading.
          if (reportOnlyTurn(turn)) return true;
          const to = await reachBot(ref, 'chat').catch(() => null);
          return !!to && STRICTNESS[to.permissionMode] > STRICTNESS[bot.permissionMode];
        },
      ),
      def(
        'bot_status',
        { bot: z.string().min(1) },
        async ({ bot: ref }) => {
          const target = await reachBot(ref, 'chat');
          const st = await s.jobs.status(target.id);
          return st.busy
            ? t('tool.busy', { name: target.name, count: st.pendingJobs })
            : t('tool.idle', { name: target.name });
        },
        'read',
      ),
      // Answering another bot's request: files go back with the answer, to the bot that asked.
      ...(turn.jobId && thread.kind === 'bot'
        ? [
            def(
              'reply_files',
              { paths: z.array(z.string().max(2000)).min(1).max(10) },
              async ({ paths }) => {
                const names = await s.jobs.replyFiles(turn.jobId!, bot, thread.id, paths, t);
                return t('tool.replyFilesAdded', { names: names.join(', ') });
              },
              'internal',
            ),
          ]
        : []),
      def(
        'bot_requests',
        {},
        async () => {
          const rows = await s.jobs.requestsFrom(bot.id);
          if (!rows.length) return t('tool.requestsNone');
          const clock = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ');
          return rows
            .map((r) =>
              t(r.reply === null ? 'tool.requestLine' : 'tool.requestLineReply', {
                id: r.id,
                to: r.toBotName ?? '?',
                status: t(
                  `tool.requestStatus.${r.kind === 'notify' && r.status === 'done' ? 'notified' : r.status}`,
                ),
                at: clock(r.createdAt),
                request: truncate(r.request.replace(/\s+/g, ' '), 120),
                reply: truncate((r.reply ?? '').replace(/\s+/g, ' '), 160),
              }),
            )
            .join('\n');
        },
        'read',
      ),
      def(
        'bot_stop',
        { job_id: z.string() },
        async ({ job_id }) => {
          const job = await s.jobs.stop(job_id, bot);
          return t('tool.jobStopped', { id: job.id });
        },
        'internal',
      ),
    ];
    tools.push(
      sendFileTool({ def, services: s, dataDir: this.ctx.config.dataDir, bot, thread, t }),
      showPageTool({ def, services: s, dataDir: this.ctx.config.dataDir, bot, thread, t }),
      slidesTool({ def, services: s, dataDir: this.ctx.config.dataDir, bot, thread, t }),
    );
    // A page becomes a picture in a browser program on this server; without one there is none.
    const executable = this.ctx.browser.executable;
    if (executable) {
      tools.push(
        pageImageTool({
          def,
          services: s,
          dataDir: this.ctx.config.dataDir,
          bot,
          thread,
          browser: { executable, sandbox: this.ctx.config.browserSandbox },
          signal,
          t,
        }),
      );
    }
    // Only a message the person sent gets an emoji back; a turn about their emoji, or another bot's
    // reply, does not. The tool is listed in every turn all the same: the tool list opens the cached
    // prompt, and one that changes between turns of a conversation would reprice all of it.
    tools.push(
      def(
        'react',
        { emoji: z.string().trim().regex(EMOJI) },
        async ({ emoji }) => {
          // In a room every member answers the same message; one emoji would overwrite another's.
          if (turn.source !== 'user' || thread.kind === 'room') return t('tool.reactNotNow');
          const m = await s.threads.react(thread.id, turn.createdAt, emoji);
          return m ? t('tool.reacted', { emoji }) : t('tool.noUserMessage');
        },
        'internal',
      ),
    );
    // The description goes to an outside service, so a bot with the internet off makes no pictures.
    // Listed without a saved key too: the bot then tells the person which key to add.
    if (bot.internet) {
      tools.push(imageTool({ def, services: s, dataDir: this.ctx.config.dataDir, bot, thread, signal, t }));
      tools.push(videoTool({ def, services: s, dataDir: this.ctx.config.dataDir, bot, thread, signal, t }));
      tools.push(
        ...apiTools({
          def,
          services: s,
          bot,
          thread,
          turn,
          own,
          signal,
          unattended,
          t,
          sources: opts.apiSources,
        }),
      );
    }
    if (opts.email) tools.push(...emailTools({ def, services: s, bot, address: opts.email, t }));
    // The front door's one tool: the chat is its own, never one it names.
    if (opts.contact === 'door') {
      tools.push(
        def(
          'whatsapp_suggest_route',
          { bot: z.string().min(1).max(200), reason: z.string().min(1).max(1000) },
          async ({ bot: ref, reason }) =>
            s.whatsapp.suggestRoute({ threadId: thread.id, botId: bot.id, ref, reason }, t),
          'internal',
        ),
      );
    }
    let askedOnce: Promise<boolean> | null = null;
    // Someone's WhatsApp chats are theirs alone: not in a team conversation, nor for a guest.
    if (opts.whatsappOwner && opts.whatsappOwner === person && !team && !guest) {
      tools.push(
        ...whatsappTools({
          def,
          services: s,
          bot,
          person,
          threadId: thread.id,
          roots: whatsappRoots(this.ctx.config.dataDir, bot),
          cwd: bot.projectDir ?? workspacePaths(this.ctx.config.dataDir, bot.id, thread.id, null).threadDir,
          drafts: bot.permissionMode !== 'readonly',
          reader: !!opts.whatsappReader,
          // Every chat is reached only for the person's own message or a routine they saved, not
          // for a run a mail, a webhook, a watched page or a WhatsApp chat started.
          // Read once: a run that reads a chat is marked as outside text from then on, which must
          // not make the person's own work look like nobody asked for it.
          // A contact's answer comes in as a message in the conversation, but is their words, not
          // the person's.
          asked: () =>
            (askedOnce ??=
              turn.outside === 'whatsapp'
                ? Promise.resolve(false)
                : requestedBy(this.ctx, turn).then((x) => x !== null)),
          woken: () => s.whatsapp.wokenBy(turn),
          unattended: !attended(turn.source),
          unwatched: () => !attended(turn.source) && !!reads(),
          // Reading someone's chats starts only on the person's own word, whatever the bot's level.
          askOpen: async () => {
            const yes = t('tool.whatsappFollowYes');
            const c = await askPerson(s, {
              bot,
              thread,
              turn,
              signal,
              timeoutMs: unattended,
              title: t('tool.whatsappOpenTitle', { bot: bot.name }),
              items: [
                {
                  question: t('tool.whatsappOpenQuestion'),
                  context: t('tool.whatsappFollowKeep'),
                  options: [yes, t('tool.whatsappFollowNo')],
                },
              ],
            });
            if (c.timedOut) return 'timeout';
            return c.status === 'allowed' && c.answers[0] === yes ? 'yes' : 'no';
          },
          t,
        }),
        def(
          'whatsapp_follow',
          {
            routine: z.string().min(1).max(200),
            bot: z.string().min(1).max(200).optional(),
            /** A group's name or address; an empty string stops following one. */
            group: z.string().max(200).optional(),
            people: z.boolean().optional(),
          },
          async (a) => {
            if (!(await mayChange())) return t('tool.changeNotAllowed');
            const found = await pickRoutine(a.routine, a.bot);
            if (typeof found === 'string') return found;
            const r = found.routine;
            let group: WhatsAppGroup | null | undefined;
            if (a.group?.trim()) {
              const groups = await s.whatsapp.groups().catch(() => null);
              if (!groups) return t('tool.whatsappGroupsUnavailable');
              const picked = pickGroup(groups, a.group);
              if (!picked) {
                const names = groups.map((g) => g.name).join(', ') || '-';
                return t('tool.whatsappGroupNotFound', { group: a.group, names });
              }
              if ('many' in picked)
                return t('tool.whatsappGroupAmbiguous', { group: a.group, names: picked.many.join(', ') });
              group = picked.group;
            } else if (a.group !== undefined) {
              group = null;
            }
            const patch: z.infer<typeof RoutineUpdate> = {
              ...(group !== undefined &&
                group?.id !== r.whatsappGroup && { whatsappGroup: group?.id ?? null }),
              ...(a.people !== undefined && a.people !== !!r.whatsappPeople && { whatsappPeople: a.people }),
            };
            if (!Object.keys(patch).length) return t('tool.routineNoChange');
            // Reading someone's chats starts only on the person's own word, whatever the bot's level.
            if (patch.whatsappGroup || patch.whatsappPeople) {
              const yes = t('tool.whatsappFollowYes');
              const owner = r.botId === bot.id ? bot : await s.bots.get(r.botId);
              const c = await askPerson(s, {
                bot,
                thread,
                turn,
                signal,
                timeoutMs: unattended,
                title: t('tool.whatsappFollowTitle', { bot: owner.name, routine: r.name }),
                items: [
                  {
                    question: [
                      ...(patch.whatsappGroup ? [t('tool.whatsappFollowGroup', { group: group!.name })] : []),
                      ...(patch.whatsappPeople ? [t('tool.whatsappFollowPeople')] : []),
                    ].join(' '),
                    context: t('tool.whatsappFollowKeep'),
                    options: [yes, t('tool.whatsappFollowNo')],
                  },
                ],
              });
              if (c.timedOut) return t('tool.questionTimedOut');
              if (c.status !== 'allowed' || c.answers[0] !== yes) return t('tool.whatsappFollowSkipped');
            }
            const updated = await s.routines.update(r.id, patch, person);
            const groupName = updated.whatsappGroup
              ? ((group?.id === updated.whatsappGroup ? group.name : null) ??
                (await s.whatsapp.groups().catch(() => [])).find((g) => g.id === updated.whatsappGroup)
                  ?.name ??
                updated.whatsappGroup)
              : null;
            const what = [
              ...(groupName ? [t('tool.whatsappFollowWhatGroup', { group: groupName })] : []),
              ...(updated.whatsappPeople ? [t('tool.whatsappFollowWhatPeople')] : []),
            ];
            return what.length
              ? t('tool.whatsappFollowed', { routine: updated.name, what: what.join(', ') })
              : t('tool.whatsappFollowNone', { routine: updated.name });
          },
          // It asks the person on its own card before reading starts, at every level.
          'internal',
        ),
      );
    }
    tools.push(
      ...ticketTools({
        def,
        services: s,
        bot,
        turn,
        t,
        note: journal,
        reach: (ref) => reachBot(ref, 'chat'),
      }),
    );
    tools.push(
      ...tableTools({
        def,
        services: s,
        botId: bot.id,
        t,
        note: journal,
        hasTables: opts.hasTables ?? true,
        shared: !guest && !opts.contact,
      }),
      ...dashboardTools({ def, services: s, botId: bot.id, person, onlyOwn: team || guest, t }),
    );
    // With the internet off the bot gets neither its browser nor its desktop, which reach it too.
    if (this.ctx.browser.available && bot.internet) {
      const askLogin: AskLogin = async (site, host) => {
        const summary = t('browser.loginCard', { bot: bot.name, site });
        const r = await s.approvals.ask({
          threadId: thread.id,
          botId: bot.id,
          turnId: turn.id,
          kind: 'login',
          toolName: 'browser_login',
          input: { site, ...(host && host !== site ? { host } : {}) },
          summary,
          signal,
          timeoutMs: unattended,
          onCreated: async (a) => {
            await s.threads.addMessage({
              threadId: thread.id,
              role: 'approval',
              author: `bot:${bot.id}`,
              text: summary,
              props: { approvalId: a.id },
              turnId: turn.id,
            });
          },
        });
        if (r.status === 'allowed' && r.login) return { ok: true, login: r.login };
        return {
          ok: false,
          message: r.typed
            ? t('approval.typedInstead', { text: r.answer ?? '' })
            : r.timedOut
              ? t('tool.questionTimedOut')
              : r.status === 'expired'
                ? t('tool.questionExpired')
                : t('browser.loginSkipped'),
        };
      };
      const askCard: AskCard = async ({ card, site, frames, team: teamCard }) => {
        const once = t('browser.cardOnce');
        const always = t('browser.cardAlways', { site });
        // A team card is allowed on a site for good only by someone who looks after the server.
        const mayKeep = !teamCard || managesServer((await s.access.viewerOf(person)).role);
        const r = await askPerson(s, {
          bot,
          thread,
          turn,
          signal,
          timeoutMs: unattended,
          title: t('browser.cardTitle', { bot: bot.name }),
          items: [
            {
              question: frames.length
                ? t('browser.cardQuestionFrames', { bot: bot.name, card, site, frames: frames.join(', ') })
                : t('browser.cardQuestion', { bot: bot.name, card, site }),
              options: mayKeep ? [once, always, t('browser.cardRefuse')] : [once, t('browser.cardRefuse')],
            },
          ],
        });
        if (r.timedOut) return { message: t('tool.questionTimedOut') };
        if (r.status === 'expired') return { message: t('tool.questionExpired') };
        const pick = r.status === 'allowed' ? r.answers[0] : undefined;
        if (pick === once) return 'once';
        if (pick === always && mayKeep) return 'always';
        return { message: t('browser.cardRefused', { site }) };
      };
      const askContact: AskContact = async ({ contact, site, frames, parts, team: teamContact }) => {
        const once = t('browser.cardOnce');
        const always = t('browser.cardAlways', { site });
        // The team's details are allowed on a site for good only by someone who looks after the server.
        const mayKeep = !teamContact || managesServer((await s.access.viewerOf(person)).role);
        const r = await askPerson(s, {
          bot,
          thread,
          turn,
          signal,
          timeoutMs: unattended,
          title: t('browser.contactTitle', { bot: bot.name }),
          items: [
            {
              question: t(frames.length ? 'browser.contactQuestionFrames' : 'browser.contactQuestion', {
                bot: bot.name,
                contact,
                site,
                parts: parts.join(', '),
                frames: frames.join(', '),
              }),
              options: mayKeep ? [once, always, t('browser.cardRefuse')] : [once, t('browser.cardRefuse')],
            },
          ],
        });
        if (r.timedOut) return { message: t('tool.questionTimedOut') };
        if (r.status === 'expired') return { message: t('tool.questionExpired') };
        const pick = r.status === 'allowed' ? r.answers[0] : undefined;
        if (pick === once) return 'once';
        if (pick === always && mayKeep) return 'always';
        return { message: t('browser.contactRefused', { site }) };
      };
      const planted = new Set<string>();
      tools.push(
        ...browserTools({
          def,
          bot,
          dataDir: this.ctx.config.dataDir,
          threadId: thread.id,
          t,
          browser: this.ctx.browser,
          vault: s.vault,
          person: own,
          askLogin,
          cards: s.cards,
          askCard,
          contacts: s.contacts,
          askContact,
          // A card is filled only for the person who wrote this turn themselves, here and now: not
          // for a chat app's unknown sender, a guest, a routine or another bot.
          attended: attended(turn.source) && !!turn.userId && turn.userId === own && !turn.guest,
          ownRoutine: turn.source === 'routine' && !turn.guest,
          siteNotes: async (host) =>
            bot.memory
              ? (await s.memory.forSite(bot.id, host, own, await place())).map(
                  (m) => `${m.unverified ? `${t('prompt.unverifiedNote')} ` : ''}${m.content}`,
                )
              : [],
          exitNote: () => this.ctx.egress?.takeExitNote(bot.id) ?? null,
          signal,
          onPlanted: async (site) => {
            // Once per site in a turn: reading the same page again says nothing new.
            if (planted.has(site)) return;
            planted.add(site);
            await s.threads.addMessage({
              threadId: thread.id,
              role: 'system',
              author: `bot:${bot.id}`,
              text: t('browser.plantedNotice', { site, bot: bot.name }),
              props: { kind: 'planted', site },
              turnId: turn.id,
            });
          },
          ...(opts.email &&
            opts.emailCodes && {
              mailCode: {
                address: opts.email,
                wait: (site: string, waitMs: number) => s.email.waitForCode(bot.id, site, waitMs, signal),
                used: (id: string) => s.email.codeUsed(bot.id, id),
              },
            }),
        }),
      );
      const taught = skills.filter((k) => k.steps?.length);
      if (taught.length) {
        tools.push(
          def(
            'skill_replay',
            { name: z.string().min(1).max(100), from: z.number().int().min(1).max(200).optional() },
            async ({ name, from }) => {
              const skill = taught.find((k) => k.name === name.trim().toLowerCase());
              if (!skill) return t('tool.noTaught', { name, names: taught.map((k) => k.name).join(', ') });
              await s.skills.markUsed(skill.id);
              const steps = skill.steps!.slice((from ?? 1) - 1);
              // The replay names step kinds by key, as the lesson's own text does.
              const loose = t as unknown as Parameters<typeof replaySteps>[3];
              const result = await replaySteps(this.ctx.browser, bot.id, steps, loose);
              // Counted on the whole lesson, so the step numbers match the skill's own.
              const skipped = (from ?? 1) - 1;
              const whole = {
                ...result,
                done: result.done + skipped,
                total: result.total + skipped,
                ...(result.failedAt && {
                  failedAt: { ...result.failedAt, step: result.failedAt.step + skipped },
                }),
              };
              return replayHandOver(whole, skill.steps!, loose);
            },
          ),
        );
      }
    }
    // One watch over the screens this turn looks at, the desktop's and the person's computer's alike.
    const screens = new ScreenWatch();
    if (this.ctx.computer && bot.internet) {
      // Commands run in the thread's own work folder, which the desktop sees at the same path.
      const cwd = workspacePaths(this.ctx.config.dataDir, bot.id, thread.id, bot.groupId).threadDir;
      const desk = computerTools({
        def,
        bot,
        t,
        computer: this.ctx.computer,
        cwd,
        signal,
        watch: screens,
        // A person's own GitHub only for work their own message started in their own conversation,
        // or that another bot handed on from such a message with no outside text read on the way
        // (asked at each command, so a page read before it counts): a routine, a mail, a
        // follow-up or any other handed-on work uses the team's.
        own: async () => {
          if (guest || !own || turn.userId !== own) return null;
          if (turn.source === 'user') return own;
          if (turn.source !== 'bot' || !turn.jobId || turn.outside || reads()) return null;
          return (await s.jobs.startedByPerson(turn.jobId, own)) ? own : null;
        },
      });
      // A bot with its own project folder runs commands in this server's sandbox, where that
      // folder is; the desktop does not see it.
      tools.push(...(bot.projectDir ? desk.filter((x) => x.name !== 'run_command') : desk));
    }
    // The person who wrote the message, when the conversation is theirs.
    const writer = turn.userId && (!thread.userId || thread.userId === turn.userId) ? turn.userId : null;
    // The person's own Mac, for a bot they allowed to use it: only in work their own message
    // started (not a routine, a mail, a webhook, a follow-up or another bot), in their own
    // conversation (not a team chat, a guest's or someone else's), and not for a bot that may only
    // read. The owner's Mac is the one the server runs on, if it does; anyone else's, and the
    // owner's when the server runs elsewhere, is the one their desktop app offers from afar, which
    // asks on its own screen before a bot first uses it. A Mac offered from afar is used only in a
    // conversation that is the writer's own, since its screen shows in that conversation.
    const localMac = person === OWNER_ID ? (this.ctx.personComputer ?? null) : null;
    const ownThread = !!writer && (thread.userId === writer || (!thread.userId && writer === OWNER_ID));
    const mac = localMac ?? (ownThread && writer ? (this.ctx.macs?.for(writer) ?? null) : null);
    if (
      mac &&
      bot.personComputer &&
      turn.source === 'user' &&
      !team &&
      !turn.guest &&
      bot.permissionMode !== 'readonly'
    ) {
      tools.push(
        ...personComputerTools({ def, botId: bot.id, botName: bot.name, t, computer: mac, watch: screens }),
      );
    }
    // Commands on that person's computer, under the same conditions, when its desktop app lets
    // bots run them. Through the desktop app only, never the server's own helper: the switch that
    // allows commands is on that computer. Looked up at each step, so a reconnect does not matter.
    const commandsAt = ownThread && writer ? (this.ctx.macs?.commandsFor(writer) ?? null) : null;
    if (
      commandsAt &&
      writer &&
      bot.personComputer &&
      turn.source === 'user' &&
      !team &&
      !turn.guest &&
      bot.permissionMode !== 'readonly'
    ) {
      tools.push(
        ...personCommandTools({
          def,
          t,
          s,
          bot,
          threadId: thread.id,
          turn: { id: turn.id, rehearsalId: turn.rehearsalId ?? null },
          person: writer,
          signal,
          timeoutMs: unattended,
          computer: () => this.ctx.macs?.commandsFor(writer) ?? null,
        }),
      );
    }
    // The person's own phone, for what they switched on in the phone app: only in work their own
    // message started, in their own conversation, and not for a bot that may only read (it would
    // not be asked, and their phone is theirs to answer for). A guest has no phone here.
    // The phone is the one of the person who wrote the message, and the conversation must be theirs.
    const phoneKinds = this.ctx.phones && writer ? this.ctx.phones.kinds(writer) : null;
    if (
      phoneKinds?.size &&
      turn.source === 'user' &&
      !team &&
      !turn.guest &&
      !turn.rehearsalId &&
      bot.permissionMode !== 'readonly'
    ) {
      tools.push(
        ...personPhoneTools({
          def,
          t,
          phones: this.ctx.phones!,
          person: writer!,
          kinds: phoneKinds,
          now: this.clock,
        }),
      );
    }
    // The person's own Chrome, through the extension's side panel: only in work their own message
    // from that panel started (see `ChromeBridge`), in their own conversation, and not for a bot
    // that may only read. The panel shares Chrome only while it is open with sharing on.
    const chromes = this.ctx.chromes;
    if (
      chromes &&
      writer &&
      chromes.panelOf(turn.id, writer) &&
      turn.source === 'user' &&
      !team &&
      !turn.guest &&
      !turn.rehearsalId &&
      bot.permissionMode !== 'readonly'
    ) {
      tools.push(
        ...personBrowserTools({ def, t, chromes, person: writer, turnId: turn.id, botName: bot.name }),
      );
    }
    // Listening to a call in the bot's browser: the other people's voices go to the speech-to-text
    // service, so only in work the person's own message started, in their own conversation, and
    // not for a bot that may only read. Checking and stopping stay offered in the conversation the
    // call was started in while it is heard, whoever's work the turn is, so it can always be ended.
    const listen =
      this.ctx.browser.available &&
      bot.internet &&
      !!writer &&
      turn.source === 'user' &&
      !team &&
      !turn.guest &&
      !turn.rehearsalId &&
      bot.permissionMode !== 'readonly';
    if (listen || s.calls.listeningIn(bot.id, thread.id)) {
      tools.push(
        ...callTools({ def, t, calls: s.calls, bot, threadId: thread.id, person: writer ?? '', listen }),
      );
    }
    if (bot.isManager && !team) {
      tools.push(
        ...this.managerTools(bot, signal, t, unattended, person, (ref) => reachBot(ref, 'edit'), journal, {
          // The person's own words, in their own conversation, with nothing from outside read yet:
          // only then does the manager answer cards for them without asking first.
          clean: () =>
            turn.source === 'user' &&
            !turn.guest &&
            !turn.rehearsalId &&
            thread.kind === 'user' &&
            thread.userId === person &&
            !reads(),
          shows: async (kind) => {
            await opts.readOutside?.(kind);
          },
        }),
      );
      // A manager also reads and tidies the other bots' own notes.
      for (const x of tools) {
        if (MANAGER_MEMORY_TOOLS.has(x.name)) x.description = `${x.description} ${t('tool.memoryManager')}`;
      }
    }
    if (opts.mayEditBot === false) {
      const save = tools.find((x) => x.name === 'skill_save');
      if (save) save.description = `${save.description} ${t('tool.skillSaveFixOnly')}`;
    }
    // With memory off the bot can neither read nor write it.
    const kept = tools.filter(
      (x) =>
        !(team && TEAM_OFF.has(x.name)) &&
        !(guest && GUEST_OFF.has(x.name)) &&
        !(x.name === 'skill_save' && opts.mayEditBot === false && !skills.length),
    );
    return bot.memory ? kept : kept.filter((x) => !MEMORY_TOOLS.has(x.name));
  }

  private managerTools(
    manager: Bot,
    signal: AbortSignal,
    t: T,
    unattended: number | undefined,
    /** Whom the turn works for: they answer the manager's cards. */
    person: string,
    /** A bot the person may change, by name or id. */
    reach: (ref: string) => Promise<Bot>,
    /** Puts a change into the journal that takes the turn back. */
    note: (c: ChangeNote) => Promise<void>,
    inbox: {
      /** Whether the turn may answer the person's cards without a card of its own. */
      clean: () => boolean;
      /** Tells the turn it was shown outside text. */
      shows: (kind: OutsideTrigger) => Promise<void>;
    },
  ): AppTool[] {
    const def = definer(t);
    const s = this.services;
    const audit = async (action: string, targetId: string, before: unknown, after: unknown) => {
      await this.ctx.db.insert(schema.auditLog).values({
        id: newId(),
        actor: `bot:${manager.id}`,
        action,
        targetType: 'bot',
        targetId,
        before: before ?? null,
        after: after ?? null,
      });
    };
    /** Why a bot cannot run on this engine and model, or null when it can. */
    const modelProblem = async (engine: EngineKind, model: string): Promise<string | null> => {
      // Running on a coding agent of the computer is the owner's choice alone (see the bot routes).
      if (engine === 'acp') return t('tool.acpOwnerOnly');
      if (engine === 'claude') return model.includes('/') ? t('tool.unknownModel', { model }) : null;
      const cut = model.indexOf('/');
      const [provider, id] = [model.slice(0, Math.max(cut, 0)), model.slice(cut + 1)];
      const known: string[] = provider ? await s.keys.models(provider).catch(() => []) : [];
      if (!provider || !id || !known.includes(id)) return t('tool.unknownModel', { model: model || '-' });
      if (!(await s.keys.credential(provider))) return t('tool.noModelKey', { provider });
      return null;
    };
    /**
     * Asks the person on a card in the manager's main conversation; true when they approve. What
     * another bot is told, which files it shares and what it runs on change what that bot does
     * next, so the manager does not change them alone.
     */
    const confirm = async (summary: string, input: Record<string, unknown>, toolName: string) => {
      const approve = t('tool.approve');
      const thread = await s.threads.main(manager.id, person);
      const r = await s.approvals.ask({
        threadId: thread.id,
        botId: manager.id,
        turnId: null,
        kind: 'question',
        toolName,
        input,
        summary,
        options: [approve, t('tool.reject')],
        signal,
        timeoutMs: unattended,
        onCreated: async (ap) => {
          await s.threads.addMessage({
            threadId: thread.id,
            role: 'approval',
            author: `bot:${manager.id}`,
            text: ap.summary,
            props: { approvalId: ap.id },
          });
        },
      });
      if (r.status === 'allowed' && (!r.answer || r.answer === approve)) return true;
      // Words written on the card in place of a button reach the manager with the refusal.
      const words = r.status === 'allowed' && r.answer !== t('tool.reject') ? (r.answer?.trim() ?? '') : '';
      return { words };
    };
    /** What the manager is told when the person did not approve, with their words if they wrote any. */
    const refused = (message: string, r: { words: string }) =>
      r.words ? `${message}\n\n${t('tool.changeAnswered', { answer: r.words })}` : message;
    /**
     * A group the person sees, by id or name; a name they have none of becomes a folder in their
     * Private. With `own`, only their own folders: a new bot goes to their Private.
     */
    const groupId = async (name: string | undefined, own = false) => {
      if (!name) return undefined;
      const viewer = await s.access.viewerOf(person);
      const groups = (await s.bots.listGroups()).filter((g) =>
        own ? g.ownerUserId === person : seesGroup(viewer, g),
      );
      const g = groups.find((x) => x.id === name || x.name.toLowerCase() === name.toLowerCase());
      return g ? g.id : (await s.bots.createGroup(name, { ownerUserId: person })).id;
    };
    /** The manager's place, when it is a folder of the person's: where a bot made for them goes. */
    const home = async () => {
      if (!manager.groupId) return null;
      const g = await s.bots.getGroup(manager.groupId).catch(() => null);
      return g?.ownerUserId === person ? g.id : null;
    };
    /** The cards waiting on the person that they may answer, newest first. */
    const waiting = async () => {
      const viewer = await s.access.viewerOf(person);
      const { seen, answerable } = await s.access.summaryScope(viewer);
      return s.approvals.list({ status: 'pending', seen, answerable });
    };
    return [
      def(
        'cards_waiting',
        {},
        async () => {
          const cards = await waiting();
          if (!cards.length) return t('cards.none');
          const bots = await s.bots.list({ includeArchived: true });
          const names = new Map(bots.map((b) => [b.id, b.name]));
          const managers = new Set(bots.filter((b) => b.isManager).map((b) => b.id));
          const locale = await s.settings.locale();
          const now = Date.now();
          // A card's words may come from outside text (a mail, a page, a stranger) that the turn
          // asking it read: reading them counts so, and the manager then answers nothing unasked.
          const outside = await this.ctx.db
            .select({ id: schema.approvals.id })
            .from(schema.approvals)
            .leftJoin(schema.turns, eq(schema.turns.id, schema.approvals.turnId))
            .where(
              and(
                inArray(
                  schema.approvals.id,
                  cards.map((c) => c.id),
                ),
                or(
                  eq(schema.approvals.outside, true),
                  isNotNull(schema.turns.outside),
                  eq(schema.turns.guest, true),
                ),
              ),
            )
            .limit(1);
          if (outside.length) await inbox.shows('stored');
          const out: string[] = [];
          for (const c of cards.slice(0, 30)) {
            const bot = names.get(c.botId) ?? '?';
            const hours = Math.max(0, Math.round((now - Date.parse(c.createdAt)) / 3_600_000));
            out.push(t('cards.line', { id: c.id, bot, hours: String(hours) }));
            if (c.kind === 'question') {
              for (const q of questionItems(c).items)
                out.push(
                  t('cards.question', {
                    question: truncate(q.question, 400),
                    options: q.options.join(' | ') || '-',
                  }),
                );
            } else {
              const said = describeAction(c.toolName, c.input, { bot, locale });
              out.push(t('cards.step', { step: said.want, detail: truncate(said.detail ?? c.summary, 400) }));
            }
            const keep = managerMayNotAnswer(c, c.line ?? {}, manager.id, managers);
            if (keep) out.push(t('cards.keeps', { why: t(keep) }));
          }
          return out.join('\n');
        },
        'read',
      ),
      def(
        'cards_answer',
        {
          answers: z
            .array(
              z.object({
                card: z.string().min(1).max(64),
                bot: z.string().min(1).max(80),
                decision: z.enum(['yes', 'no']),
                answer: z.string().max(5_000).optional(),
                answers: z.array(z.string().max(5_000)).max(6).optional(),
              }),
            )
            .min(1)
            .max(10),
        },
        async ({ answers }) => {
          // An answer lets another bot act: a manager that may only look answers nothing.
          if (manager.permissionMode === 'readonly') return t('cards.readonly');
          const open = new Map((await waiting()).map((c) => [c.id, c]));
          const bots = await s.bots.list({ includeArchived: true });
          const names = new Map(bots.map((b) => [b.id, b.name]));
          const managers = new Set(bots.filter((b) => b.isManager).map((b) => b.id));
          const out: string[] = [];
          const go: { card: Approval; bot: string; yes: boolean; words?: string; answers?: string[] }[] = [];
          for (const a of answers) {
            const card = open.get(a.card);
            if (!card) {
              out.push(t('cards.notWaiting', { id: a.card }));
              continue;
            }
            const bot = names.get(card.botId) ?? '?';
            // The bot named beside the card is checked, so a mixed-up id answers nothing.
            if (bot.toLowerCase() !== a.bot.trim().toLowerCase()) {
              out.push(t('cards.wrongBot', { id: a.card, bot }));
              continue;
            }
            const keep = managerMayNotAnswer(card, card.line ?? {}, manager.id, managers);
            if (keep) {
              out.push(t('cards.kept', { id: a.card, bot, why: t(keep) }));
              continue;
            }
            const yes = a.decision === 'yes';
            // A step goes ahead as it is on a yes, so words reach its bot only with a no.
            const several = a.answers?.length ? a.answers : undefined;
            const words =
              several || (card.kind !== 'question' && yes) ? undefined : a.answer?.trim() || undefined;
            if (card.kind === 'question' && yes && !words && !several) {
              out.push(t('cards.needAnswer', { id: a.card, bot }));
              continue;
            }
            go.push({ card, bot, yes, words, answers: several });
          }
          // Answered without asking only on the person's own word, in their own conversation, with
          // nothing from outside read: otherwise they see every answer on one card first, at every
          // permission level, since the answers let other bots act, stricter ones among them.
          if (go.length && !inbox.clean()) {
            const lines = go.map(
              (g) =>
                `${g.bot} · ${truncate(g.card.summary, 120)}: ${g.yes ? '✓' : '✗'}` +
                (g.answers ? ` ${g.answers.join(' | ')}` : g.words ? ` ${g.words}` : ''),
            );
            const approve = t('tool.approve');
            const ok = await confirm(
              t('cards.ask', { count: String(go.length) }),
              {
                questions: [
                  {
                    question: t('cards.ask', { count: String(go.length) }),
                    context: lines.join('\n'),
                    options: [approve, t('tool.reject')],
                  },
                ],
              },
              'cards_answer',
            );
            if (ok !== true) return refused([...out, t('cards.refused')].join('\n'), ok);
          }
          for (const g of go) {
            const id = g.card.id;
            try {
              await s.approvals.answer(
                id,
                {
                  decision: g.yes ? 'allow' : 'deny',
                  ...(g.words !== undefined && { answer: g.words }),
                  ...(g.answers && { answers: g.answers }),
                  remember: false,
                },
                person,
                { via: { botId: manager.id, name: manager.name } },
              );
              out.push(t(g.yes ? 'cards.said' : 'cards.declined', { id, bot: g.bot }));
            } catch (err) {
              out.push(t('cards.failed', { id, bot: g.bot, message: errorText(err, t) }));
            }
          }
          return out.join('\n');
        },
        'internal',
      ),
      def(
        'bot_conversations_read',
        { bot: z.string().min(1), limit: z.number().int().min(1).max(100).default(30) },
        async ({ bot: ref, limit }) => {
          const target = await reach(ref);
          const threads = await this.ctx.db
            .select()
            .from(schema.threads)
            // The person's own conversations with it and its own work, not anyone else's.
            .where(and(eq(schema.threads.botId, target.id), s.access.seenFrom(person)))
            .orderBy(desc(schema.threads.updatedAt))
            .limit(5);
          const out: string[] = [];
          for (const th of threads) {
            const msgs = await s.threads.messages(th.id, { limit });
            out.push(t('tool.conversation', { title: th.title || th.kind, id: th.id }));
            for (const m of msgs) out.push(`[${m.role} ${m.author}] ${truncate(m.text, 500)}`);
          }
          return out.join('\n') || t('tool.noConversations');
        },
        'read',
      ),
      def(
        'bot_create',
        {
          name: z.string().min(1).max(60),
          description: z.string().max(500).default(''),
          instructions: z.string().max(20_000).default(''),
          group: z.string().optional(),
          color: z
            .string()
            .regex(/^#[0-9a-f]{6}$/i)
            .optional(),
          engine: z.enum(['claude', 'pi']).optional(),
          model: z.string().max(200).optional(),
          effort: BotCreate.shape.effort.unwrap().optional(),
          avatar: z.enum(OBJECT_AVATARS.map((x) => `object:${x}`) as [string, ...string[]]).optional(),
          material: BotMaterial.optional(),
        },
        async (a) => {
          // Without a choice the bot starts as the person set new bots to start.
          const settings = await s.settings.all();
          const engine = a.engine ?? settings.defaultEngine;
          const model = a.model?.trim() ?? (engine === 'pi' ? settings.piModel : '');
          const wrong = await modelProblem(engine, model);
          if (wrong) return wrong;
          const created = await s.bots.create(
            {
              name: a.name,
              description: a.description,
              instructions: a.instructions,
              engine,
              model,
              isManager: false,
              // A new bot goes to the person's Private: a folder of theirs named, or the manager's
              // when it is one of theirs.
              groupId: a.group !== undefined ? ((await groupId(a.group, true)) ?? null) : await home(),
              color: a.color ?? BRAND_COLOR,
              avatar: a.avatar ?? DEFAULT_AVATAR,
              material: a.material ?? 'flat',
              // The level a bot the person creates starts at, as one made in the app.
              permissionMode: 'auto',
              internet: false,
              // The person's Mac is theirs to open to a bot, never a manager bot's.
              personComputer: false,
              reviewer: null,
              projectDir: null,
              memory: true,
              effort: a.effort ?? '',
              toolSelection: ALL_TOOLS,
              instructionsUrl: null,
              // A bot's spending limits are the person's to set, never another bot's.
              dailyLimitUsd: 0,
              monthlyLimitUsd: 0,
            },
            // The bot is the person's the manager made it for.
            person,
          );
          await audit('create', created.id, null, created);
          return t('tool.created', { name: created.name, id: created.id });
        },
        // A new bot works by itself and starts off the internet; turning it on takes a card.
        'internal',
      ),
      def(
        'bot_factory',
        {
          purpose: z.string().trim().min(1).max(200),
          bots: z
            .array(
              z.object({
                name: z.string().trim().min(1).max(60),
                description: z.string().trim().max(500).default(''),
                instructions: z.string().trim().max(20_000).default(''),
                skills: z.array(BotImportSkill).max(FACTORY_MAX.skills).default([]),
                routines: z
                  .array(
                    z.object({
                      name: z.string().trim().min(1).max(80),
                      prompt: z.string().trim().min(1).max(20_000),
                      schedule: Schedule,
                      report_only: z.boolean().default(false),
                    }),
                  )
                  .max(FACTORY_MAX.routines)
                  .default([]),
                notes: z.array(BotImportMemory).max(FACTORY_MAX.notes).default([]),
              }),
            )
            .min(1)
            .max(FACTORY_MAX.bots),
        },
        async (a) => {
          // Names the card shows are the names the bots get: one taken is refused, not renamed.
          const taken = new Set((await s.bots.list()).map((b) => b.name.toLocaleLowerCase('tr')));
          const named = new Set<string>();
          for (const b of a.bots) {
            const key = b.name.toLocaleLowerCase('tr');
            if (taken.has(key) || named.has(key)) return t('tool.factoryNameTaken', { name: b.name });
            named.add(key);
          }
          const { timezone } = await s.settings.all(person);
          // The plan as an import file: saved at once in one go, or not at all.
          const file = {
            format: BOT_IMPORT_FORMAT,
            version: BOT_IMPORT_VERSION,
            source: '',
            bots: a.bots.map((b, i) => ({
              ref: `bot-${i + 1}`,
              name: b.name,
              description: b.description,
              instructions: b.instructions,
              skills: b.skills,
              memories: b.notes,
              routines: b.routines.map((r) => ({
                name: r.name,
                prompt: r.prompt,
                steps: [],
                schedule: r.schedule,
                timezone,
                enabled: false,
                reportOnly: r.report_only,
              })),
            })),
            groups: [],
            notImported: [],
          };
          let plan: Awaited<ReturnType<typeof s.botImport.preview>>;
          try {
            plan = await s.botImport.preview(file);
          } catch (err) {
            return t('tool.factoryInvalid', { issues: errorText(err, t) });
          }
          if (plan.warnings.length)
            return t('tool.factoryInvalid', {
              issues: plan.warnings.map((w) => Object.values(w.params ?? {}).join(' ')).join('; '),
            });
          const locale = await s.settings.locale();
          const lines: string[] = [];
          for (const b of plan.bots) {
            lines.push(`**${b.name}**${b.description ? ` — ${b.description}` : ''}`);
            if (b.instructions)
              lines.push(
                `- ${t('tool.factoryInstructions', { text: truncate(b.instructions.replace(/\s+/g, ' '), 300) })}`,
              );
            for (const k of b.skills)
              lines.push(
                `- ${t(k.held ? 'tool.factorySkillHeld' : k.existing ? 'tool.factorySkillLinked' : 'tool.factorySkill', { name: k.name, description: truncate(k.description, 200) })}`,
              );
            for (const r of b.routines)
              lines.push(
                `- ${t(r.reportOnly ? 'tool.factoryRoutineReport' : 'tool.factoryRoutine', { name: r.name, when: describeSchedule(r.schedule, locale) })}`,
              );
            if (b.memories.length) lines.push(`- ${t('tool.factoryNotes', { count: b.memories.length })}`);
          }
          const routines = plan.bots.reduce((n, b) => n + b.routines.length, 0);
          lines.push('', t('tool.factoryStarts'));
          if (routines) lines.push(t('tool.factoryRoutinesOff'));
          const approve = t('tool.approve');
          const ok = await confirm(
            t('tool.factoryAsk', { purpose: a.purpose }),
            {
              title: a.purpose,
              questions: [
                {
                  question: t('tool.factoryAsk', { purpose: a.purpose }),
                  context: lines.join('\n'),
                  options: [approve, t('tool.reject')],
                },
              ],
              plan: file,
            },
            'bot_factory',
          );
          if (ok !== true) return refused(t('tool.factoryNo'), ok);
          let made: Awaited<ReturnType<typeof s.botImport.commit>>;
          try {
            made = await s.botImport.commit(file, {
              owner: person,
              // As a bot the manager creates alone: off the internet, in the person's Private.
              internet: false,
              groupId: await home(),
              names: plan.bots.map((b) => b.name),
            });
          } catch (err) {
            return t('tool.factoryFailed', { reason: errorText(err, t) });
          }
          for (const [i, id] of made.botIds.entries())
            await audit('create', id, null, { name: made.plan.bots[i]!.name, factory: a.purpose });
          return t('tool.factoryDone', {
            bots: made.plan.bots.map((b) => b.name).join(', '),
            routines: String(routines),
          });
        },
        // It asks on its own card, at every level: what it sets up is too much to allow at once.
        'internal',
      ),
      def(
        'models_list',
        {},
        async () => {
          const providers = (await s.keys.list()).filter((p) => p.configured);
          const lines = [t('tool.modelsClaude')];
          for (const p of providers) {
            const models = await s.keys.models(p.id).catch(() => []);
            const shown = models.slice(0, 40).map((m) => `${p.id}/${m}`);
            lines.push(
              `- ${p.custom?.name ?? p.id}: ${shown.join(', ')}${models.length > shown.length ? ' …' : ''}`,
            );
          }
          if (!providers.length) lines.push(t('tool.modelsNoKeys'));
          return lines.join('\n');
        },
        'read',
      ),
      def(
        'bot_update',
        {
          bot: z.string().min(1),
          name: z.string().min(1).max(60).optional(),
          description: z.string().max(500).optional(),
          instructions: z.string().max(20_000).optional(),
          group: z.string().optional(),
          color: z
            .string()
            .regex(/^#[0-9a-f]{6}$/i)
            .optional(),
          permission_mode: z.enum(PERMISSION_MODES).optional(),
          internet: z.boolean().optional(),
          engine: z.enum(['claude', 'pi']).optional(),
          model: z.string().max(200).optional(),
          /** How hard a Claude bot thinks; empty for the setting all bots share. */
          effort: BotCreate.shape.effort.unwrap().optional(),
          /** Whether the bot reads and keeps notes; off, it sees none. */
          memory: z.boolean().optional(),
          /** One of the object avatars, `object:<id>`; an uploaded picture is the person's to choose. */
          avatar: z.enum(OBJECT_AVATARS.map((x) => `object:${x}`) as [string, ...string[]]).optional(),
          material: BotMaterial.optional(),
        },
        async (a) => {
          const target = await reach(a.bot);
          if (target.isManager && target.id !== manager.id) return t('tool.otherManager');
          // Instructions kept in a document change there, by whoever keeps the document.
          if (a.instructions !== undefined && target.instructionsUrl)
            return t('tool.instructionsLinked', { bot: target.name });
          let modelPatch = {};
          if (a.engine !== undefined || a.model !== undefined) {
            const engine = a.engine ?? target.engine;
            const settings = await s.settings.all();
            const model =
              a.model?.trim() ??
              (engine === target.engine ? target.model : engine === 'pi' ? settings.piModel : '');
            const wrong = await modelProblem(engine, model);
            if (wrong) return wrong;
            modelPatch = { engine, model };
          }
          const loosens =
            (a.permission_mode && STRICTNESS[a.permission_mode] > STRICTNESS[target.permissionMode]) ||
            (a.internet === true && !target.internet);
          // Another bot's instructions, its section (whose files it shares) and what it runs on.
          const other = target.id !== manager.id;
          const changes = other
            ? [
                a.instructions !== undefined && a.instructions !== target.instructions
                  ? t('tool.changeInstructions')
                  : '',
                a.group !== undefined ? t('tool.changeGroup') : '',
                a.engine !== undefined || a.model !== undefined ? t('tool.changeEngine') : '',
              ].filter(Boolean)
            : [];
          if (loosens && !changes.length) {
            const ok = await confirm(
              t('tool.loosenSummary', { manager: manager.name, target: target.name }),
              { bot: target.name, permission_mode: a.permission_mode, internet: a.internet },
              'bot_update',
            );
            if (ok !== true) return refused(t('tool.loosenDenied'), ok);
          } else if (changes.length) {
            if (loosens) changes.push(t('tool.changePermissions'));
            const said = t('tool.changeSummary', {
              manager: manager.name,
              target: target.name,
              what: changes.join(', '),
            });
            const ok = await confirm(
              a.instructions !== undefined ? `${said}\n\n${truncate(a.instructions, 600)}` : said,
              {
                bot: target.name,
                ...(a.instructions !== undefined && { instructions: a.instructions }),
                ...(a.group !== undefined && { group: a.group }),
                ...(a.engine !== undefined && { engine: a.engine }),
                ...(a.model !== undefined && { model: a.model }),
                ...(a.permission_mode !== undefined && { permission_mode: a.permission_mode }),
                ...(a.internet !== undefined && { internet: a.internet }),
              },
              'bot_update',
            );
            if (ok !== true) return refused(t('tool.changeDenied'), ok);
          }
          const patch = {
            ...(a.name !== undefined && { name: a.name }),
            ...(a.description !== undefined && { description: a.description }),
            ...(a.instructions !== undefined && { instructions: a.instructions }),
            ...(a.color !== undefined && { color: a.color }),
            ...(a.permission_mode !== undefined && { permissionMode: a.permission_mode }),
            ...(a.internet !== undefined && { internet: a.internet }),
            ...(a.group !== undefined && { groupId: (await groupId(a.group)) ?? null }),
            ...(a.effort !== undefined && { effort: a.effort }),
            ...(a.memory !== undefined && { memory: a.memory }),
            ...(a.avatar !== undefined && { avatar: a.avatar }),
            ...(a.material !== undefined && { material: a.material }),
            ...modelPatch,
          };
          const moved = patch.groupId !== undefined && patch.groupId !== target.groupId;
          // A bot goes where the person could put it themselves.
          if (moved)
            await s.access.checkPlace(await s.access.viewerOf(person), patch.groupId, target.ownerUserId);
          const updated = await s.bots.update(target.id, patch);
          if (moved) {
            s.access.forget();
            await s.approvals.refuseUnanswerable();
          }
          await audit('update', target.id, target, updated);
          const keys = Object.keys(patch);
          await note({
            kind: 'bot',
            op: 'update',
            targetId: target.id,
            label: updated.name,
            scopeBotId: target.id,
            before: { what: 'settings', patch: pickFields(target, keys) },
            after: { sig: sig(pickFields(updated, keys)) },
          });
          return t('tool.updated', { name: updated.name });
        },
        // Loosening a bot's limits, and changing another bot's instructions, section or engine, asks
        // inside the handler; other changes are recorded and undoable.
        'internal',
      ),
      def(
        'bot_profile',
        { bot: z.string().min(1) },
        async ({ bot: ref }) => {
          const target = await reach(ref);
          const groups = await s.bots.listGroups();
          const skills = (await s.skills.forBot(target.id)).map((k) => k.name);
          const routines = await s.routines.list(target.id);
          const apps = (await s.connections.list(person))
            .filter((c) => c.allBots || c.botIds.includes(target.id))
            .map((c) => c.name);
          return [
            t('tool.profileName', { name: target.name, id: target.id }),
            t('tool.profileDescription', { text: target.description || '-' }),
            t('tool.profileModel', {
              engine: target.engine,
              model: target.model || t('tool.profileDefaultModel'),
            }),
            t('tool.profileMode', { mode: target.permissionMode }),
            t('tool.profileLook', {
              effort: target.effort || '-',
              memory: String(target.memory),
              avatar: target.avatar.startsWith('data:') ? '-' : target.avatar,
              material: target.material,
            }),
            t(target.internet ? 'tool.profileInternetOn' : 'tool.profileInternetOff'),
            t('tool.profileGroup', { group: groups.find((g) => g.id === target.groupId)?.name ?? '-' }),
            t('tool.profileSkills', { skills: skills.join(', ') || '-' }),
            t('tool.profileRoutines', { routines: routines.map((r) => r.name).join(', ') || '-' }),
            t('tool.profileApps', { apps: apps.join(', ') || '-' }),
            t('tool.profileInstructions'),
            truncate(target.instructions || '-', 4000),
          ].join('\n');
        },
        'read',
      ),
      def(
        'bot_skill',
        { bot: z.string().min(1), skill: z.string().min(1), on: z.boolean() },
        async (a) => {
          const target = await reach(a.bot);
          if (target.isManager && target.id !== manager.id) return t('tool.otherManager');
          const all = await s.skills.list();
          const skill = all.find((k) => k.name === a.skill.trim().toLowerCase() || k.id === a.skill);
          if (!skill)
            return t('tool.noSuchSkill', { name: a.skill, names: all.map((k) => k.name).join(', ') || '-' });
          // A skill is instructions the bot reads: another bot's are the person's to give.
          if (target.id !== manager.id) {
            const said = t(a.on ? 'tool.skillOnSummary' : 'tool.skillOffSummary', {
              manager: manager.name,
              target: target.name,
              skill: skill.name,
            });
            const ok = await confirm(said, { bot: target.name, skill: skill.name, on: a.on }, 'bot_skill');
            if (ok !== true) return refused(t('tool.changeDenied'), ok);
          }
          const was = skill.botIds.includes(target.id);
          await s.skills.setBot(skill.id, target.id, a.on);
          await audit('skill', target.id, null, { skill: skill.name, on: a.on });
          if (was !== a.on) {
            await note({
              kind: 'bot',
              op: 'update',
              targetId: target.id,
              label: `${target.name} · ${skill.name}`,
              scopeBotId: target.id,
              before: { what: 'skill', skillId: skill.id, was },
              after: { on: a.on },
            });
          }
          return t(a.on ? 'tool.skillOn' : 'tool.skillOff', { skill: skill.name, name: target.name });
        },
        'internal',
      ),
      def(
        'bot_archive',
        { bot: z.string().min(1) },
        async ({ bot: ref }) => {
          const target = await reach(ref);
          if (target.isManager) return t('tool.managerArchive');
          const archived = await s.bots.archive(target.id);
          // Its running work stops as it does when the person archives it; not waited for here.
          void s.turns.stopBots([target.id], 'archived');
          await audit('archive', target.id, target, archived);
          await note({
            kind: 'bot',
            op: 'update',
            targetId: target.id,
            label: target.name,
            scopeBotId: target.id,
            before: { what: 'archive' },
            after: { archived: true },
          });
          return t('tool.archived', { name: target.name });
        },
        // Archiving can be undone from the app.
        'internal',
      ),
    ];
  }

  /** Manager change history (for the UI). */
  async auditFor(botId: string) {
    return this.ctx.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.targetType, 'bot'), eq(schema.auditLog.targetId, botId)))
      .orderBy(desc(schema.auditLog.createdAt))
      .limit(50);
  }
}
