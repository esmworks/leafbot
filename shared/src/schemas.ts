import { z } from 'zod';
import { patchOf } from './patch';
import { ALL_TOOLS, ToolSelection } from './tool-selection';
import { internalHost } from './ai-endpoints';
import { luhn } from './secret-shapes';
import { Schedule } from './schedule';

/**
 * The app's own green, a darker shade of its icon's so white text on it reads well: the accent of the
 * app's screens and the colour a new bot starts with.
 */
export const BRAND_COLOR = '#2b8152';

export const Id = z.string().min(1).max(64);

/**
 * `claude`: Claude through its agent SDK. `pi`: another provider's model with the app's own tools.
 * `acp`: another coding agent's command-line tool on the server's computer (Gemini CLI, Codex…),
 * the bot's model naming which one.
 */
export const EngineKind = z.enum(['claude', 'pi', 'acp']);
export type EngineKind = z.infer<typeof EngineKind>;

/** The coding agents a bot may run on, by their command-line tools' protocol mode. */
export const ACP_AGENTS = [
  { id: 'gemini', name: 'Gemini CLI' },
  { id: 'codex', name: 'Codex' },
  { id: 'opencode', name: 'OpenCode' },
  { id: 'kimi', name: 'Kimi Code' },
] as const;
export type AcpAgentId = (typeof ACP_AGENTS)[number]['id'];

/** One of the coding agents, and whether its tool is installed where the server runs. */
export const AcpAgentState = z.object({ id: z.string(), name: z.string(), installed: z.boolean() });
export type AcpAgentState = z.infer<typeof AcpAgentState>;

/**
 * How freely a bot acts: `readonly` only reads, `ask` asks before each change, `auto` goes ahead by
 * itself. `review` is kept for bots saved with it and counts as `auto`.
 */
export const PermissionMode = z.enum(['ask', 'review', 'auto', 'readonly']);
/**
 * Outside text a run reads: what started a routine run (a mail, a webhook's body, a watched page
 * or an app's new answer, WhatsApp messages a routine reads), or what the run read on its way: a
 * page, an API's or a connected app's answer (`web`), a message the person forwarded from someone else (`forward`), or text kept here
 * that came from outside before (`stored`). The text reaches the bot marked as data; it does not
 * change the bot's level.
 */
export const OUTSIDE_TRIGGERS = [
  'watch',
  'webhook',
  'email',
  'whatsapp',
  'web',
  'forward',
  'stored',
] as const;
export type OutsideTrigger = (typeof OUTSIDE_TRIGGERS)[number];
/** The outside trigger a card's `outside` prop names, if it names one. */
export const outsideTrigger = (value: unknown): OutsideTrigger | undefined =>
  OUTSIDE_TRIGGERS.find((x) => x === value);
/**
 * The outside text a message carries into a conversation: one marked so (an outside run's
 * instruction, a report written in one), or a webhook's post.
 */
export const outsideIn = (props: Record<string, unknown>): OutsideTrigger | undefined =>
  outsideTrigger(props.outside) ?? (props.posted ? 'webhook' : undefined);
/**
 * The levels a person picks from, from the strictest to the freest: read only, ask first, full access. "review" (a model judging each
 * step) is retired; a bot still saved with it works and shows as full access (`shownMode`).
 */
export const PERMISSION_MODES = ['readonly', 'ask', 'auto'] as const;
export type ShownMode = (typeof PERMISSION_MODES)[number];
export const shownMode = (mode: PermissionMode): ShownMode => (mode === 'review' ? 'auto' : mode);
export type PermissionMode = z.infer<typeof PermissionMode>;

export const Group = z.object({
  id: Id,
  name: z.string(),
  /** Set while every bot of the group is paused. Missing from older servers. */
  pausedAt: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type Group = z.infer<typeof Group>;

/**
 * What a person may do with a bot: nothing (they do not see it), talk with it in conversations of
 * their own, or also change it, share it and look after what it learns.
 */
export const BotLevel = z.enum(['none', 'chat', 'edit']);
export type BotLevel = z.infer<typeof BotLevel>;
export const BOT_LEVELS = BotLevel.options;
/** Who may use a bot besides its owner: everyone on the server at one level, and named people. */
export const BotAccess = z.object({
  everyone: BotLevel,
  people: z.record(z.string(), BotLevel.exclude(['none'])),
});
export type BotAccess = z.infer<typeof BotAccess>;

/**
 * How the body of an object avatar is finished: a plain fill, or a coat of fur with the eyes set into
 * it. Only an object avatar has a body to finish; an uploaded picture ignores it. Where fur can't be
 * drawn (the phone, a browser without WebGL2) the body is drawn flat.
 */
export const BOT_MATERIALS = ['flat', 'fluffy'] as const;
export const BotMaterial = z.enum(BOT_MATERIALS);
export type BotMaterial = z.infer<typeof BotMaterial>;

export const Bot = z.object({
  id: Id,
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  engine: EngineKind,
  model: z.string(),
  isManager: z.boolean(),
  /** Shown at the top of the sidebar; a place in the list, not a permission. */
  pinned: z.boolean(),
  /** Order within its sidebar section. */
  position: z.number().int(),
  groupId: Id.nullable(),
  color: z.string(),
  avatar: z.string(),
  /** How the body of an object avatar is finished; missing on older servers, which draw it flat. */
  material: BotMaterial.default('flat'),
  permissionMode: PermissionMode,
  /** Whether the bot may reach the internet: web search, reading pages, its browser and desktop. */
  internet: z.boolean(),
  /**
   * Whether the bot may use the person's own Mac (its screen, mouse and keyboard) in their own work;
   * only where the server runs on that Mac. Missing on older servers.
   */
  personComputer: z.boolean().optional(),
  /**
   * A second model that reads a mail about to go out, or data about to leave, while its card waits,
   * and adds a line to the card when something looks wrong: `claude`, or `provider/model` from a
   * connected provider. Null is none. Missing on older servers.
   */
  reviewer: z.string().nullable().optional(),
  projectDir: z.string().nullable(),
  /** Whether the bot reads and keeps memory; off, it sees none and gets no memory tools. */
  memory: z.boolean(),
  /** Effort for this Claude bot; empty uses the setting for all bots. */
  effort: z.string(),
  /** Which tools the bot gets (see `ToolSelection`). */
  toolSelection: ToolSelection,
  /**
   * A document the instructions are kept in. Its text reaches the bot only once the person
   * accepts it; until then a change waits in `instructionsPending`. Missing from older servers.
   */
  instructionsUrl: z.string().nullable().optional(),
  instructionsPending: z.string().nullable().optional(),
  instructionsCheckedAt: z.string().nullable().optional(),
  /** Why the document could not be read the last time it was looked at. */
  instructionsError: z.string().nullable().optional(),
  archivedAt: z.string().nullable(),
  /**
   * Set while the bot itself is paused; it also starts no work while its group is. Missing from
   * older servers.
   */
  pausedAt: z.string().nullable().optional(),
  /** The bot's own spending limits in US dollars, 0 for none. Missing from older servers. */
  dailyLimitUsd: z.number().optional(),
  monthlyLimitUsd: z.number().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** The person who made the bot (or was given it). Missing from older servers. */
  ownerUserId: z.string().optional(),
  /** Who else may use it; sent only to those who may change it. Missing from older servers. */
  access: BotAccess.optional(),
  /** What the person asking may do with it. Missing from older servers, where it is `edit`. */
  yourLevel: BotLevel.optional(),
});
export type Bot = z.infer<typeof Bot>;

const botName = z.string().trim().min(1).max(60);

/**
 * Shapes bots could once take, as `shape:<name>`, drawn as felt plushes. They are no longer offered or
 * drawn: each is read as `DEFAULT_AVATAR`, so a bot that had one, an older phone app that still sends
 * one and an export made before keep working and get the round object.
 */
export const OLD_AVATAR_SHAPES = [
  'blob',
  'pebble',
  'squircle',
  'capsule',
  'drop',
  'square',
  'diamond',
  'hexagon',
  'pentagon',
  'triangle',
  'cloud',
  'clover',
  'star',
  'shield',
  'leaf',
  'bolt',
  'moon',
] as const;
export type AvatarShape = (typeof OLD_AVATAR_SHAPES)[number];
const KNOWN_SHAPES: readonly string[] = OLD_AVATAR_SHAPES;

/** The avatar a bot gets when none is chosen, and the one every old shape becomes. */
export const DEFAULT_AVATAR = 'object:circle';

/**
 * Object avatars a bot can take, as `object:<id>`: things with eyes (a mug, a lightbulb), drawn
 * with volume by the app. Only ids the app ships a drawing for are accepted, so a stored value
 * always names something the web app and the phone can draw.
 */
export const OBJECT_AVATARS = [
  'circle',
  'square',
  'triangle',
  'pill',
  'diamond',
  'hexagon',
  'heart',
  'cloud',
  'leaf',
  'drop',
  'star',
  'controller',
  'barbell',
  'mug',
  'lightbulb',
  'chat',
  'sprout',
  'watering-can',
] as const;
export type ObjectAvatar = (typeof OBJECT_AVATARS)[number];
const KNOWN_OBJECTS: readonly string[] = OBJECT_AVATARS;

/**
 * `object:<id>` or an uploaded raster image as a data URL (SVG is not accepted). An old `shape:<name>`
 * is still accepted and comes out as `DEFAULT_AVATAR`.
 */
export const Avatar = z
  .string()
  .max(400_000)
  .refine(
    (v) =>
      (v.startsWith('shape:') && KNOWN_SHAPES.includes(v.slice(6))) ||
      (v.startsWith('object:') && KNOWN_OBJECTS.includes(v.slice(7))) ||
      /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(v),
    'validation.avatar',
  )
  .transform((v) => (v.startsWith('shape:') ? DEFAULT_AVATAR : v));
/** A spending limit in US dollars, to the cent; 0 for none. */
const SpendLimit = z.number().min(0).max(1_000_000);

export const BotCreate = z.object({
  name: botName,
  description: z.string().max(500).default(''),
  instructions: z.string().max(20_000).default(''),
  engine: EngineKind.default('claude'),
  model: z.string().max(100).default(''),
  isManager: z.boolean().default(false),
  groupId: Id.nullable().default(null),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .default(BRAND_COLOR),
  avatar: Avatar.default(DEFAULT_AVATAR),
  material: BotMaterial.default('flat'),
  permissionMode: PermissionMode.default('auto'),
  internet: z.boolean().default(true),
  personComputer: z.boolean().default(false),
  reviewer: z
    .string()
    .trim()
    .max(200)
    .regex(/^(?:claude|[^/\s]+\/\S+)$/)
    .nullable()
    .default(null),
  projectDir: z.string().max(1000).nullable().default(null),
  memory: z.boolean().default(true),
  effort: z.union([z.enum(['low', 'medium', 'high', 'xhigh', 'max']), z.literal('')]).default(''),
  /** Which tools the bot gets; by default every tool its settings allow. */
  toolSelection: ToolSelection.default(ALL_TOOLS),
  /** The most the bot may spend in a day, in US dollars; 0 for no limit of its own. */
  dailyLimitUsd: SpendLimit.default(0),
  /** The most the bot may spend in a calendar month, in US dollars; 0 for no limit of its own. */
  monthlyLimitUsd: SpendLimit.default(0),
  /** A document (https) the instructions are kept in; null for instructions written here. */
  instructionsUrl: z
    .string()
    .trim()
    .max(1000)
    .refine((v) => /^https:\/\/[^\s]+$/i.test(v), 'validation.instructionsUrl')
    .nullable()
    .default(null),
});
export type BotCreate = z.infer<typeof BotCreate>;

export const BotUpdate = patchOf(BotCreate);
export type BotUpdate = z.infer<typeof BotUpdate>;

/**
 * Moves a bot in the sidebar: to the pinned bots at the top, or into a group (null:
 * ungrouped), before `beforeId` or at the end. Pinning keeps the bot's group.
 */
export const BotMove = z.object({
  pinned: z.boolean(),
  groupId: Id.nullable(),
  beforeId: Id.nullable(),
});
export type BotMove = z.infer<typeof BotMove>;

/** The engine and model a bot runs on; for another provider the model is `provider/model`. */
export interface BotEngineChoice {
  engine: z.infer<typeof EngineKind>;
  model: string;
}

/** What new bots start with: the provider picked in the settings, else Claude. */
export function newBotEngine(settings?: { defaultEngine?: string; piModel?: string }): BotEngineChoice {
  return settings?.defaultEngine === 'pi' && settings.piModel
    ? { engine: 'pi', model: settings.piModel }
    : { engine: 'claude', model: '' };
}

/**
 * Whether moving the existing bots to what new bots start with changes this one. A bot already
 * on Claude keeps its own Claude model; a bot on another provider takes the new model.
 */
export function leavesForEngine(bot: BotEngineChoice, target: BotEngineChoice): boolean {
  return bot.engine !== target.engine || (target.engine === 'pi' && bot.model !== target.model);
}

export const GroupCreate = z.object({ name: z.string().trim().min(1).max(60) });

/** Moves a group in the sidebar, before `beforeId` or to the end. */
export const GroupMove = z.object({ beforeId: Id.nullable() });
export type GroupMove = z.infer<typeof GroupMove>;

/** `api`: messages sent to the bot from a script or another app through its API. */
export const ThreadKind = z.enum(['user', 'bot', 'routine', 'api', 'room', 'ticket', 'team', 'rehearsal']);
export type ThreadKind = z.infer<typeof ThreadKind>;

export const TurnState = z.enum(['idle', 'queued', 'running', 'waiting']);
export type TurnState = z.infer<typeof TurnState>;

export const Thread = z.object({
  id: Id,
  botId: Id,
  title: z.string(),
  kind: ThreadKind,
  peerBotId: Id.nullable(),
  /** The person whose conversation it is; null for the bot's own work. Missing on older servers. */
  userId: z.string().nullable().optional(),
  /** What the conversation is for, set by the person; empty when none. Missing on older servers. */
  goal: z.string().optional(),
  /** The message pinned above the conversation, with its start; missing or null for none. */
  pinned: z.object({ id: Id, text: z.string() }).nullable().optional(),
  /** When it was put away from the list; null while it is listed. Missing on older servers. */
  archivedAt: z.string().nullable().optional(),
  /** Out of the list until then, or until a new message in it; null when not. Missing on older servers. */
  snoozedUntil: z.string().nullable().optional(),
  /** Kept at the top of the list since then; null when not. Missing on older servers. */
  pinnedAt: z.string().nullable().optional(),
  /** An emoji the person gave it; '' when none. Missing on older servers. */
  icon: z.string().optional(),
  state: TurnState,
  preview: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Thread = z.infer<typeof Thread>;

/** Sidebar line for a bot: latest user-thread preview and activity. */
export const BotSummary = z.object({
  botId: Id,
  threadId: Id.nullable(),
  preview: z.string().nullable(),
  previewAt: z.string().nullable(),
  /** When the bot last wrote in any of its conversations; the app marks it unread after that. */
  repliedAt: z.string().nullable(),
  /** The conversation that reply is in, which may not be the one the bot opens to. */
  repliedThreadId: Id.nullable(),
  state: TurnState,
  pendingApprovals: z.number(),
  /** A routine of the bot whose latest run failed, by name; null when none did. */
  failedRoutine: z.string().nullable(),
  /** Every routine of the bot whose latest run failed, newest failure first. */
  failedRoutines: z.array(Id),
  /** The oldest card the bot waits on the person for, if any. */
  waiting: z
    .object({ kind: z.enum(['tool', 'question', 'login']), summary: z.string(), threadId: Id })
    .nullable(),
});
export type BotSummary = z.infer<typeof BotSummary>;

export const MessageRole = z.enum(['user', 'assistant', 'system', 'marker', 'approval', 'error']);
export type MessageRole = z.infer<typeof MessageRole>;

/** Author of a message: the human user, a bot (`bot:<id>`), a routine (`routine:<id>`) or the system. */
export const Message = z.object({
  id: Id,
  threadId: Id,
  role: MessageRole,
  author: z.string(),
  text: z.string(),
  props: z.record(z.string(), z.unknown()),
  clientId: z.string().nullable(),
  /** Turn that produced the message; lets the client drop its streaming buffer. */
  turnId: Id.nullable(),
  createdAt: z.string(),
});
export type Message = z.infer<typeof Message>;

/** Largest file the person can attach to a message. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_MESSAGE_FILES = 20;

/** A file name as stored in a conversation's folder: one plain name, no folders. */
export const FileName = z
  .string()
  .min(1)
  .max(200)
  .refine((v) => v !== '.' && v !== '..' && !/[/\\\0]/.test(v), 'validation.fileName');

/** A file the person attached; `path` is relative to the workspaces root, as the library lists it. */
export const MessageFile = z.object({ name: FileName, size: z.number().int().min(0), path: z.string() });
export type MessageFile = z.infer<typeof MessageFile>;

export const SendMessage = z
  .object({
    clientId: z.string().min(8).max(64),
    text: z.string().trim().max(100_000).default(''),
    /** Files uploaded to the conversation's folder beforehand. */
    files: z.array(FileName).max(MAX_MESSAGE_FILES).default([]),
    /** The id of an earlier message in the same conversation this one answers. */
    replyTo: z.string().min(1).max(64).optional(),
    /** Written while the app had no connection, and sent once it was back. */
    offline: z.boolean().optional(),
    /** Said aloud in a voice call: the answer is read aloud, so it is kept short and plain. */
    spoken: z.boolean().optional(),
  })
  .refine((m) => m.text.length > 0 || m.files.length > 0, {
    message: 'validation.emptyMessage',
    path: ['text'],
  });
export type SendMessage = z.infer<typeof SendMessage>;

/** The person's emoji on a bot message; null takes it off. The server checks it is one emoji. */
export const MessageReaction = z.object({ emoji: z.string().trim().min(1).max(32).nullable() });

/** A press on a bot's card: the part pressed, the card's revision it was made on, and the field values. */
export const CardAnswer = z.object({
  node: z.string().min(1).max(16),
  rev: z.number().int().min(1),
  values: z.record(z.string().max(64), z.union([z.string().max(4000), z.boolean(), z.number()])).default({}),
});
export type CardAnswer = z.infer<typeof CardAnswer>;

/** What a reply keeps of the message it answers, to show above it. */
export interface ReplyQuote {
  id: string;
  text: string;
}

export const ThreadCreate = z.object({ title: z.string().trim().max(120).optional() });

/** Most bots in one room, and most rounds they may talk among themselves after answering. */
export const MAX_ROOM_MEMBERS = 12;
export const MAX_ROOM_ROUNDS = 5;

/** Who answers a message in a room that names no one: every member in turn, or nobody. */
export const RoomResponders = z.enum(['everyone', 'mentions']);
export type RoomResponders = z.infer<typeof RoomResponders>;

/**
 * Whether a room keeps minutes of its meetings: it asks when a talk starts after a pause, keeps
 * them for every such talk, or never keeps them (they can still be started by hand).
 */
export const RoomMinutes = z.enum(['ask', 'always', 'never']);
export type RoomMinutes = z.infer<typeof RoomMinutes>;

/**
 * Where a meeting's minutes are:
 * - `asked`: the room asked whether this is a meeting and waits for the answer;
 * - `active`: the meeting goes on and its lines are kept;
 * - `writing`: it ended and the minutes are being written;
 * - `draft`: the minutes wait for the person to read, change and approve them;
 * - `saved`: approved, and the bots chosen were told;
 * - `declined`: not a meeting, or the question went unanswered;
 * - `failed`: the minutes could not be written; they can be tried again.
 */
export const MeetingStatus = z.enum(['asked', 'active', 'writing', 'draft', 'saved', 'declined', 'failed']);
export type MeetingStatus = z.infer<typeof MeetingStatus>;
/** The meetings still under way or waiting for the person. */
export const OPEN_MEETING: MeetingStatus[] = ['asked', 'active', 'writing', 'draft', 'failed'];

/** Most lines in one list of the minutes. */
export const MAX_MINUTES_ITEMS = 50;
const MinutesLine = z.string().trim().min(1).max(1000);

/** Something to be done after the meeting: who takes it (a member bot, or a person by name) and by when. */
export const MeetingTask = z.object({
  text: MinutesLine,
  /** Who took it on, as named in the meeting; empty when no one did. */
  owner: z.string().trim().max(120).default(''),
  /** The member bot that took it on; null for a person or no one. */
  botId: Id.nullable().default(null),
  /** By when, as `YYYY-MM-DD`; null when no day was set. */
  due: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
});
export type MeetingTask = z.infer<typeof MeetingTask>;

export const MeetingMinutes = z.object({
  title: z.string().trim().max(200),
  /** What the meeting was about and how it went, in a few sentences. */
  summary: z.string().trim().max(6000),
  decisions: z.array(MinutesLine).max(MAX_MINUTES_ITEMS),
  tasks: z.array(MeetingTask).max(MAX_MINUTES_ITEMS),
  /** What was left open, for the next meeting. */
  questions: z.array(MinutesLine).max(MAX_MINUTES_ITEMS),
});
export type MeetingMinutes = z.infer<typeof MeetingMinutes>;

/** A bot the minutes went to: its note was saved, or waits for the bot's owner to accept it. */
export const MeetingRecipient = z.object({ botId: Id, waiting: z.boolean() });
export type MeetingRecipient = z.infer<typeof MeetingRecipient>;

/**
 * A reminder set for a task of the minutes: a routine that runs once on the task's day, in the
 * reminding bot's main conversation. The bot that took the task on looks at where it stands; a
 * person's task is brought up by a bot of the room.
 */
export const MeetingReminder = z.object({
  /** The follow-up that brings the task up; a meeting saved before follow-ups has a routine instead. */
  followUpId: Id.optional(),
  routineId: Id.optional(),
  botId: Id,
  task: z.string(),
  /** The local day and time it runs, as `YYYY-MM-DD` and `HH:MM`. */
  date: z.string(),
  time: z.string(),
});
export type MeetingReminder = z.infer<typeof MeetingReminder>;

/** A meeting in a room, and its minutes once written. */
export const Meeting = z.object({
  id: Id,
  roomId: Id,
  status: MeetingStatus,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  minutes: MeetingMinutes.nullable(),
  /** Why the minutes could not be written, for `failed`. */
  error: z.string().nullable(),
  sentTo: z.array(MeetingRecipient),
  reminders: z.array(MeetingReminder),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Meeting = z.infer<typeof Meeting>;

export const MeetingAnswer = z.object({ answer: z.enum(['yes', 'no', 'always', 'never']) });
export type MeetingAnswer = z.infer<typeof MeetingAnswer>;

/** The minutes as the person approved them, and the bots that are to know them. */
export const MeetingSave = z.object({
  minutes: MeetingMinutes,
  botIds: z.array(Id).max(100),
  /** The tasks, by their place in the list, to be reminded of on their day. */
  reminders: z.array(z.number().int().min(0)).max(MAX_MINUTES_ITEMS).default([]),
  /** The local time reminders run at on the task's day. */
  remindAt: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'validation.time')
    .default('09:00'),
});
export type MeetingSave = z.infer<typeof MeetingSave>;

/** A conversation of the person with several bots. Its id is also its thread's id. */
export const Room = z.object({
  id: Id,
  title: z.string(),
  /** What the room is for (its thread's goal); empty when none. */
  goal: z.string(),
  /** Member bot ids in speaking order. */
  members: z.array(Id),
  responders: RoomResponders,
  rounds: z.number().int(),
  /** Whether it keeps meeting minutes. Missing from older servers. */
  minutes: RoomMinutes.optional(),
  /** The latest meeting still under way or waiting for the person. Missing from older servers. */
  meeting: z.object({ id: Id, status: MeetingStatus }).nullable().optional(),
  state: TurnState,
  /** The bot speaking now, if any. */
  speakerId: Id.nullable(),
  preview: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Room = z.infer<typeof Room>;

export const RoomCreate = z.object({
  title: z.string().trim().min(1).max(120),
  botIds: z.array(Id).min(1).max(MAX_ROOM_MEMBERS),
  goal: z.string().trim().max(4000).optional(),
  responders: RoomResponders.optional(),
  rounds: z.number().int().min(0).max(MAX_ROOM_ROUNDS).optional(),
  minutes: RoomMinutes.optional(),
});
export type RoomCreate = z.infer<typeof RoomCreate>;

export const RoomUpdate = RoomCreate.partial();
export type RoomUpdate = z.infer<typeof RoomUpdate>;

export const RoomSend = z.object({
  clientId: z.string().min(8).max(64),
  text: z.string().trim().min(1, 'validation.emptyMessage').max(100_000),
  replyTo: z.string().min(1).max(64).optional(),
});
export type RoomSend = z.infer<typeof RoomSend>;

export const ApprovalStatus = z.enum(['pending', 'allowed', 'denied', 'expired']);
/** The answer of an `expired` card that no one answered while the person was away. */
export const APPROVAL_TIMED_OUT = 'timeout';
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const Approval = z.object({
  id: Id,
  threadId: Id,
  botId: Id,
  kind: z.enum(['tool', 'question', 'login']),
  toolName: z.string(),
  summary: z.string(),
  input: z.record(z.string(), z.unknown()),
  options: z.array(z.string()),
  status: ApprovalStatus,
  answer: z.string().nullable(),
  /** Allowed with "Hep izin ver": the bot now goes ahead by itself (full access). */
  remembered: z.boolean(),
  /**
   * An "always ask" rule wants two different people's yes. Once the first said yes the card stays
   * pending, `firstApprover` and `firstAt` say who and when, and it waits for the second. Missing
   * from older servers.
   */
  needsSecond: z.boolean().optional(),
  firstApprover: Id.nullable().optional(),
  firstAt: z.string().nullable().optional(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  /**
   * For a card asked in an exchange between bots, which the person does not open: the conversation
   * it is shown and answered in (where the work began), and the props of the card's own line, as a
   * card in that conversation would carry them. Missing for other cards and from older servers.
   */
  answerIn: z
    .object({ threadId: Id, botId: Id, props: z.record(z.string(), z.unknown()) })
    .nullable()
    .optional(),
});
export type Approval = z.infer<typeof Approval>;

/** Where a card is shown and answered: in its own conversation, or where the work that asked it began. */
export const cardPlace = (a: Pick<Approval, 'threadId' | 'botId' | 'answerIn'>) => ({
  threadId: a.answerIn?.threadId ?? a.threadId,
  botId: a.answerIn?.botId ?? a.botId,
});

/**
 * A step that waits for a second person's yes, as that person sees it: what it is and who said
 * yes first, without the conversation it comes from. People are given by id.
 */
export const SecondYes = z.object({
  id: Id,
  botId: Id,
  /** Whose request it is; null for the bot's own work (a routine, a hook). */
  askedBy: Id.nullable(),
  /** The card's words, and the step and its details as the card shows them under "What?". */
  summary: z.string(),
  step: z.string(),
  detail: z.string().nullable(),
  firstApprover: Id.nullable(),
  firstAt: z.string(),
  createdAt: z.string(),
});
export type SecondYes = z.infer<typeof SecondYes>;

/** A person who could give a second yes on a bot's steps. */
export const Approver = z.object({ id: Id, name: z.string() });
export type Approver = z.infer<typeof Approver>;

/**
 * A step that changes something which a bot was let through, and what let it: `card` the person,
 * `rule` an allow rule, `level` the bot's approval level, `review` the reviewer model.
 */
export const BotActionHow = z.enum(['card', 'rule', 'level', 'review']);
export type BotActionHow = z.infer<typeof BotActionHow>;
export const BotAction = z.object({
  id: Id,
  botId: Id,
  threadId: Id.nullable(),
  toolName: z.string(),
  summary: z.string(),
  how: BotActionHow,
  rule: z.string().nullable(),
  /** The people whose yes let the step through (two when it needed a second person). Missing from older servers. */
  approvedBy: z.array(Id).optional(),
  outside: z.boolean(),
  createdAt: z.string(),
});
export type BotAction = z.infer<typeof BotAction>;

/**
 * Ways to ask less, read from the person's own answers on a bot's cards: steps they always
 * allowed and never refused, and a bot in `ask` whose cards they nearly always allowed.
 */
export const PermissionSuggestions = z.object({
  rules: z.array(
    z.object({
      /** The "always allow" rule the step would become, as a card's "always allow" writes it. */
      pattern: z.string(),
      /** The step in words, as a card names it. */
      summary: z.string(),
      allowed: z.number().int(),
    }),
  ),
  mode: z.object({ to: z.literal('auto'), allowed: z.number().int(), denied: z.number().int() }).nullable(),
});
export type PermissionSuggestions = z.infer<typeof PermissionSuggestions>;
/** Turns down a suggestion: a rule's pattern, or `mode` for the level. */
export const SuggestionDismiss = z.object({ key: z.string().trim().min(1).max(300) });

export const ApprovalDecision = z.object({
  decision: z.enum(['allow', 'deny']),
  /** For question cards: the chosen option or free text. */
  answer: z.string().max(10_000).optional(),
  /** For cards with several questions: one answer per question, in order. */
  answers: z.array(z.string().max(5_000)).max(6).optional(),
  /**
   * With allow: an "always allow" rule for this tool. With deny: a block rule, so the tool is
   * refused from now on without asking.
   */
  remember: z.boolean().default(false),
  /** For sign-in cards: what the server types into the site; the bot never sees the password. */
  login: z
    .object({
      username: z.string().trim().max(500),
      password: z.string().min(1).max(500),
      save: z.boolean().default(true),
      /** Save it for the exact address only, not the whole site. */
      exact: z.boolean().default(false),
    })
    .optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

/** A domain like facebook.com: a full address is accepted and cut down to its host. */
export const VaultSite = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v) => {
    try {
      return new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(v) ? v : `https://${v}`).hostname.replace(/^www\./, '');
    } catch {
      return v;
    }
  })
  .pipe(z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'validation.domain'));

/** A saved sign-in as the app sees it: never the password. */
export const VaultLogin = z.object({
  id: Id,
  site: z.string(),
  username: z.string(),
  /** Whether it keeps an authenticator secret for two-step codes (the secret never leaves). */
  hasTotp: z.boolean(),
  /** The bots that may use it; null lets every bot. */
  botIds: z.array(Id).nullable(),
  /** Whose it is: a person's own, typed only for them; null for the team's. Missing on older servers. */
  userId: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type VaultLogin = z.infer<typeof VaultLogin>;

export const VaultLoginCreate = z.object({
  site: VaultSite,
  username: z.string().trim().max(500),
  password: z.string().min(1).max(500),
  /** The base32 text or `otpauth://` link of the site's authenticator setup. */
  totp: z.string().trim().max(1000).optional(),
  botIds: z.array(Id).max(500).nullable().optional(),
  /** For the whole team rather than the person saving it; only those who look after the server. */
  team: z.boolean().optional(),
});
export type VaultLoginCreate = z.input<typeof VaultLoginCreate>;

export const VaultLoginUpdate = z.object({
  site: VaultSite.optional(),
  username: z.string().trim().max(500).optional(),
  password: z.string().min(1).max(500).optional(),
  /** A new authenticator secret; empty removes it. */
  totp: z.string().trim().max(1000).optional(),
  botIds: z.array(Id).max(500).nullable().optional(),
  /** Moves it to the team, or back to the person changing it; only those who look after the server. */
  team: z.boolean().optional(),
});
export type VaultLoginUpdate = z.input<typeof VaultLoginUpdate>;

/** A password manager the vault reads sign-ins from. */
export const PasswordManagerKind = z.enum(['onepassword', 'bitwarden', 'protonpass']);
export type PasswordManagerKind = z.infer<typeof PasswordManagerKind>;

/** Why a password manager could not be read, the last time it was tried. */
export const PasswordManagerProblem = z.enum([
  // The token, key or master password was refused.
  'auth',
  // The vault or folder named is not there, or the account cannot see it.
  'scope',
  // The manager's command-line program is not installed on the server.
  'noCli',
  // Anything else: the service did not answer, or answered in a way not understood.
  'failed',
]);
export type PasswordManagerProblem = z.infer<typeof PasswordManagerProblem>;

/** A connected password manager as the app sees it: never what it is signed in with. */
export const PasswordManager = z.object({
  id: Id,
  kind: PasswordManagerKind,
  /** The vault or folder bots may read; empty for everything the account shows. */
  scope: z.string(),
  server: z.string().nullable(),
  botIds: z.array(Id).nullable(),
  userId: z.string().nullable(),
  problem: PasswordManagerProblem.nullable(),
  /** How many sign-ins it gave when last read; null before it was. */
  count: z.number().nullable(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});
export type PasswordManager = z.infer<typeof PasswordManager>;

const ManagerScope = z.string().trim().max(200).default('');
const ManagerShared = {
  botIds: z.array(Id).max(500).nullable().optional(),
  /** For the whole team rather than the person connecting it; only those who look after the server. */
  team: z.boolean().optional(),
};

/** What a password manager is connected with; sealed on the server, never sent back. */
export const PasswordManagerCreate = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('onepassword'),
    /** A service account's token, which sees only the vaults it was given. */
    token: z.string().trim().min(20).max(5000),
    scope: ManagerScope,
    ...ManagerShared,
  }),
  z.object({
    kind: z.literal('bitwarden'),
    /** A server of one's own, or the EU one; left out for the main one. */
    server: z.string().trim().url().max(500).startsWith('https://').optional(),
    clientId: z.string().trim().min(1).max(500),
    clientSecret: z.string().trim().min(1).max(500),
    password: z.string().min(1).max(1000),
    /** The folder bots may read; a folder is required, so the rest of the account stays out of reach. */
    scope: z.string().trim().min(1).max(200),
    ...ManagerShared,
  }),
  z.object({
    kind: z.literal('protonpass'),
    /** A personal access token, given access to the vaults bots may read. */
    token: z.string().trim().min(20).max(5000),
    scope: ManagerScope,
    ...ManagerShared,
  }),
]);
export type PasswordManagerCreate = z.input<typeof PasswordManagerCreate>;

export const PasswordManagerUpdate = z.object({
  scope: z.string().trim().max(200).optional(),
  botIds: z.array(Id).max(500).nullable().optional(),
  team: z.boolean().optional(),
});
export type PasswordManagerUpdate = z.input<typeof PasswordManagerUpdate>;

export const CardBrandSchema = z.enum(['visa', 'mastercard', 'amex', 'troy', 'discover', 'other']);

/**
 * A saved payment card as the app and the bots see it: never its number, security code or the
 * name on it. Bots fill it into a checkout page on the server, the way a password is typed.
 */
export const PaymentCard = z.object({
  id: Id,
  label: z.string(),
  brand: CardBrandSchema,
  last4: z.string(),
  expMonth: z.number(),
  expYear: z.number(),
  hasCvc: z.boolean(),
  /** The sites the person agreed it may be filled on without being asked again. */
  sites: z.array(z.string()),
  botIds: z.array(Id).nullable(),
  userId: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type PaymentCard = z.infer<typeof PaymentCard>;

const ExpMonth = z.coerce.number().int().min(1).max(12);
/** Two digits are taken as this century's. */
const ExpYear = z.coerce
  .number()
  .int()
  .min(0)
  .max(2100)
  .transform((y) => (y < 100 ? 2000 + y : y))
  .pipe(z.number().min(2000));
const Cvc = z
  .string()
  .trim()
  .regex(/^\d{3,4}$/, 'error.cardCvc');

export const PaymentCardCreate = z.object({
  label: z.string().trim().max(100).default(''),
  number: z
    .string()
    .transform((v) => v.replace(/[\s-]/g, ''))
    .refine((v) => /^\d{12,19}$/.test(v) && luhn(v), 'error.cardNumber'),
  expMonth: ExpMonth,
  expYear: ExpYear,
  cvc: Cvc.optional(),
  holder: z.string().trim().max(200).optional(),
  botIds: z.array(Id).max(500).nullable().optional(),
  team: z.boolean().optional(),
});
export type PaymentCardCreate = z.input<typeof PaymentCardCreate>;

export const PaymentCardUpdate = z.object({
  label: z.string().trim().max(100).optional(),
  expMonth: ExpMonth.optional(),
  expYear: ExpYear.optional(),
  /** Empty forgets it. */
  cvc: z.union([Cvc, z.literal('')]).optional(),
  holder: z.string().trim().max(200).optional(),
  botIds: z.array(Id).max(500).nullable().optional(),
  /** Sites to take back from those it may be filled on without asking; none can be added here. */
  forgetSites: z.array(z.string().max(300)).max(500).optional(),
  team: z.boolean().optional(),
});
export type PaymentCardUpdate = z.input<typeof PaymentCardUpdate>;

/**
 * The parts of a person's contact details, named after the browser's own autofill names. `region`
 * is a province or state (il), `city` the town or district within it (ilçe).
 */
export const CONTACT_PARTS = [
  'givenName',
  'familyName',
  'email',
  'phone',
  'organization',
  'address1',
  'address2',
  'city',
  'region',
  'postalCode',
  'country',
] as const;
export type ContactPart = (typeof CONTACT_PARTS)[number];

const contactValue = (max: number) => z.string().trim().max(max);
const contactValues = {
  givenName: contactValue(200),
  familyName: contactValue(200),
  email: z
    .string()
    .trim()
    .max(320)
    .refine((x) => x === '' || z.email().safeParse(x).success, 'error.contactEmail'),
  phone: contactValue(50),
  organization: contactValue(200),
  address1: contactValue(300),
  address2: contactValue(300),
  city: contactValue(100),
  region: contactValue(100),
  postalCode: contactValue(20),
  country: contactValue(100),
};

/**
 * A name, an email, a phone and an address a bot may fill into a form (a shipping address, a
 * sign-up), sealed on the server like the vault's passwords. Its owner sees it whole; a bot fills
 * it on a site the person agreed to, and reads it back from the page as it reads any other field.
 */
export const ContactDetails = z.object({
  id: Id,
  label: z.string(),
  givenName: z.string(),
  familyName: z.string(),
  email: z.string(),
  phone: z.string(),
  organization: z.string(),
  address1: z.string(),
  address2: z.string(),
  city: z.string(),
  region: z.string(),
  postalCode: z.string(),
  country: z.string(),
  /** The sites the person agreed it may be filled on without being asked again. */
  sites: z.array(z.string()),
  botIds: z.array(Id).nullable(),
  userId: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ContactDetails = z.infer<typeof ContactDetails>;

const v = contactValues;
export const ContactDetailsCreate = z
  .object({
    label: z.string().trim().max(100).default(''),
    givenName: v.givenName.default(''),
    familyName: v.familyName.default(''),
    email: v.email.default(''),
    phone: v.phone.default(''),
    organization: v.organization.default(''),
    address1: v.address1.default(''),
    address2: v.address2.default(''),
    city: v.city.default(''),
    region: v.region.default(''),
    postalCode: v.postalCode.default(''),
    country: v.country.default(''),
    botIds: z.array(Id).max(500).nullable().optional(),
    team: z.boolean().optional(),
  })
  .refine((c) => CONTACT_PARTS.some((p) => c[p]), 'error.contactEmpty');
export type ContactDetailsCreate = z.input<typeof ContactDetailsCreate>;

export const ContactDetailsUpdate = z.object({
  label: z.string().trim().max(100).optional(),
  givenName: v.givenName.optional(),
  familyName: v.familyName.optional(),
  email: v.email.optional(),
  phone: v.phone.optional(),
  organization: v.organization.optional(),
  address1: v.address1.optional(),
  address2: v.address2.optional(),
  city: v.city.optional(),
  region: v.region.optional(),
  postalCode: v.postalCode.optional(),
  country: v.country.optional(),
  botIds: z.array(Id).max(500).nullable().optional(),
  /** Sites to take back from those it may be filled on without asking; none can be added here. */
  forgetSites: z.array(z.string().max(300)).max(500).optional(),
  team: z.boolean().optional(),
});
export type ContactDetailsUpdate = z.input<typeof ContactDetailsUpdate>;

/** Why a line of an imported passwords file was not taken. */
export const VaultImportReason = z.enum([
  // A card, a note or another kind of item in a password manager's export.
  'notLogin',
  'noPassword',
  // No web address: an app's sign-in, or an empty address.
  'noSite',
  // Over plain http the bots neither type nor ask for a password.
  'notHttps',
  // The file has the same site and username more than once; the first is taken.
  'duplicate',
  // Already in the vault for the same owner: left as it is there.
  'exists',
  'tooLong',
]);
export type VaultImportReason = z.infer<typeof VaultImportReason>;

export const VaultImportSkip = z.object({
  line: z.number(),
  site: z.string(),
  username: z.string(),
  reason: VaultImportReason,
});
export type VaultImportSkip = z.infer<typeof VaultImportSkip>;

/**
 * A passwords file exported from a browser or a password manager. Without `apply` nothing is saved:
 * the answer says what would be added and what would be left out, and why.
 */
export const VaultImport = z.object({
  csv: z
    .string()
    .min(1)
    .max(4 * 1024 * 1024),
  apply: z.boolean().default(false),
  botIds: z.array(Id).max(500).nullable().optional(),
  /** For the whole team rather than the person importing; only those who look after the server. */
  team: z.boolean().optional(),
});
export type VaultImport = z.input<typeof VaultImport>;

export const VaultImportResult = z.object({
  add: z.array(z.object({ line: z.number(), site: z.string(), username: z.string(), hasTotp: z.boolean() })),
  skipped: z.array(VaultImportSkip),
  /** Sign-ins taken without their authenticator setup, which could not be read. */
  totpDropped: z.number(),
  /** How many were saved; 0 for a preview. */
  saved: z.number(),
});
export type VaultImportResult = z.infer<typeof VaultImportResult>;

/** `block`: refused in every mode, without a card; it outranks every other rule. */
export const RuleList = z.enum(['ask', 'allow', 'block']);
export const PermissionRule = z.object({
  id: Id,
  list: RuleList,
  pattern: z.string(),
  note: z.string(),
  /** The one bot the rule is for; null (or missing, from older servers) for every bot. */
  botId: Id.nullable().optional(),
  /**
   * An amount limit, both or neither: the dotted path of a number in the step's input and the
   * line. An allow rule covers a step at or under it; an ask or block rule one over it, or one
   * whose amount cannot be read. Missing from older servers.
   */
  field: z.string().nullable().optional(),
  limit: z.number().nullable().optional(),
  /**
   * An ask rule's step runs only after two different people said yes; `secondUserId` names the
   * second one, or anyone but the first who may change the bot when null. Missing from older servers.
   */
  secondPerson: z.boolean().optional(),
  secondUserId: Id.nullable().optional(),
  createdAt: z.string(),
});
export type PermissionRule = z.infer<typeof PermissionRule>;
/** The dotted path of a value in a step's input: `amount`, `refund.amount`. */
export const LIMIT_FIELD = /^[A-Za-z_$][\w$-]*(?:\.[A-Za-z_$][\w$-]*)*$/;
export const PermissionRuleCreate = z
  .object({
    list: RuleList,
    pattern: z.string().trim().min(1).max(200),
    note: z.string().max(200).default(''),
    botId: Id.nullable().optional(),
    field: z.string().trim().max(100).regex(LIMIT_FIELD, 'validation.limitField').optional(),
    limit: z.number().finite().nonnegative().optional(),
    secondPerson: z.boolean().optional(),
    secondUserId: Id.nullable().optional(),
  })
  .refine((r) => (r.field === undefined) === (r.limit === undefined), {
    message: 'validation.limitBoth',
    path: ['limit'],
  })
  .refine((r) => !r.secondPerson || r.list === 'ask', {
    message: 'validation.secondAsk',
    path: ['secondPerson'],
  })
  .refine((r) => !r.secondUserId || r.secondPerson, {
    message: 'validation.secondNamed',
    path: ['secondUserId'],
  });

/** `room`: a note about a place (a chat app channel, or a room), read only where it was written. */
export const MemoryScope = z.enum(['bot', 'user', 'room']);
export type MemoryScope = z.infer<typeof MemoryScope>;
export const Memory = z.object({
  id: Id,
  scope: MemoryScope,
  botId: Id.nullable(),
  /** Whose note about themselves it is; null for a bot's note. Missing on older servers. */
  userId: z.string().nullable().optional(),
  content: z.string(),
  /** The site the note is about (`example.com`); it reaches the bot when it opens that site. */
  site: z.string().nullable(),
  /** Always `active`: every note is in use. Kept for phone builds made when notes could wait for approval. */
  status: z.literal('active'),
  source: z.string(),
  /** When a bot last looked the note up (a search found it, or its site opened); null when never. */
  lastUsedAt: z.string().nullable(),
  /** How many times a bot looked the note up. */
  useCount: z.number().int(),
  /** The conversation a bot last wrote the note in; null for notes written by hand. Missing from older servers. */
  threadId: Id.nullable().optional(),
  /** The page the fact came from, as the bot gave it. Missing from older servers. */
  sourceUrl: z.string().nullable().optional(),
  /** A room note's place: `slack:<channel>`, `discord:<channel>` or `room:<id>`. Missing from older servers. */
  place: z.string().nullable().optional(),
  /** The person asked for the note to go into every prompt that reaches it. Missing from older servers. */
  pinned: z.boolean().optional(),
  /** Until when the note is true, as an ISO time; past it the note reaches no bot. Null: no end. Missing from older servers. */
  validUntil: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Memory = z.infer<typeof Memory>;

/**
 * How notes hang together, for the memory map: `site`, notes about the same site; `conversation`,
 * notes a bot wrote in the same conversation; `similar`, notes near each other in meaning, with
 * how near (0–1). The notes are the ones `GET /api/memory` lists.
 */
export const MemoryGraph = z.object({
  edges: z.array(
    z.object({
      a: Id,
      b: Id,
      kind: z.enum(['site', 'conversation', 'similar']),
      score: z.number().optional(),
    }),
  ),
  /** Search by meaning is on, so notes near in meaning are linked. */
  meaning: z.boolean(),
  /** There were more notes than the map links. */
  truncated: z.boolean(),
});
export type MemoryGraph = z.infer<typeof MemoryGraph>;

/**
 * A memory change a bot asked for while nobody watched (a routine, another bot's request); it
 * takes effect only once the person accepts it.
 */
export interface MemoryChange {
  id: string;
  action: 'write' | 'update' | 'forget';
  memoryId: string | null;
  scope: MemoryScope;
  botId: string | null;
  /** A room note's place. Missing on older servers. */
  place?: string | null;
  site: string | null;
  /** The words after the change; for a forget, the words that would go. */
  content: string;
  before: string | null;
  proposedBy: string;
  /**
   * `outside`: a run of the bot `name` that had read outside text, though the person was there.
   * `person`: someone who may talk with the bot but not change it asked for it; `name` is theirs.
   * `stopped`: a run of the bot `name` made it, then was stopped or failed; it was taken back.
   * `review`: the background review of a conversation of the bot `name` found it.
   * `flag`: a page the bot `name` named when it flagged a gap holds the answer.
   */
  origin: { kind: 'routine' | 'bot' | 'outside' | 'person' | 'stopped' | 'review' | 'flag'; name: string };
  /** The person the work was for. Missing on older servers. */
  userId?: string | null;
  threadId: string | null;
  /** The page the bot said the fact came from. */
  sourceUrl: string | null;
  /** Until when the bot said the fact is true. Missing on older servers. */
  validUntil?: string | null;
  createdAt: string;
}
/**
 * Something a bot found missing or wrong in what it knows without knowing the right answer, as
 * `GET /api/memory/flags` lists it: open ones, and those waiting on a memory change (`proposed`).
 */
export interface MemoryFlag {
  id: string;
  kind: 'missing' | 'wrong';
  scope: MemoryScope;
  botId: string;
  /** What the bot was looking for. */
  about: string;
  /** What it saw instead. */
  seen: string | null;
  /** The note it says is wrong, while it is there. */
  memoryId: string | null;
  /** That note's words, for the list to show. */
  note: string | null;
  /** The skill it says is wrong, by name. */
  skill: string | null;
  /** A page the bot says may hold the answer. */
  sourceUrl: string | null;
  /** Whether the bot had read outside text (a mail, a web page) when it raised it. */
  outside: boolean;
  /** The conversation it came up in; only for the person it was raised for. */
  threadId: string | null;
  count: number;
  status: 'open' | 'proposed';
  createdAt: string;
  lastSeenAt: string;
}
/** One thing that happened to a memory note, as `GET /api/memory-history` lists it (oldest first). */
export interface MemoryHistoryLine {
  id: string;
  /**
   * `user:<id>` for a person, `bot:<id>` for a bot, `tidy` for the weekly tidy-up; older lines hold
   * a bare `bot` or `person`.
   */
  actor: string;
  action: 'create' | 'update' | 'delete' | 'pin' | 'unpin';
  targetId: string;
  /** The words before; null for a new note, and for a deleted one (its text is not kept). */
  before: string | null;
  /** The words after; null for a deletion, a pin or an unpin. */
  after: string | null;
  /** Whose note it was: `user:<id>`, `bot:<id>` or `room:<place>`. Null on lines from before people came in. */
  owner: string | null;
  createdAt: string;
}
/**
 * Days after which a note that no prompt carries, and that no bot changed or looked up, is offered
 * to the user for deletion.
 */
export const STALE_MEMORY_DAYS = 30;
/**
 * How many finished turns of a conversation pass between two looks back at it for lasting facts
 * (the memory review); 0 turns the review off.
 */
export const MEMORY_REVIEW_STEPS = [0, 10, 20, 40] as const;
export type MemoryReviewEvery = (typeof MEMORY_REVIEW_STEPS)[number];
export const MemoryCreate = z.object({
  // A person writes their own notes and a bot's; a place's notes are written by the bots there.
  scope: z.enum(['bot', 'user']),
  botId: Id.nullable().default(null),
  content: z.string().trim().min(1).max(2000),
  /** The site a note is about (`example.com`), when it is a site note. */
  site: z.string().trim().max(253).nullable().optional(),
  /** Until when the note is true (an ISO time); left out for a note with no end. */
  validUntil: z.string().datetime({ offset: true }).nullable().optional(),
});
export const MemoryUpdate = z
  .object({
    content: z.string().trim().min(1).max(2000).optional(),
    /** Pin the note (it goes into the prompt first, before the rest) or let it go. */
    pinned: z.boolean().optional(),
    /** Until when the note is true (an ISO time); null clears it. */
    validUntil: z.string().datetime({ offset: true }).nullable().optional(),
    /**
     * The `updatedAt` of the note as the person began editing it. When the note has changed since,
     * the save is refused instead of overwriting the newer words. Older clients leave it out.
     */
    updatedAt: z.string().optional(),
  })
  .refine((u) => u.content !== undefined || u.pinned !== undefined || u.validUntil !== undefined, {
    message: 'validation.memoryUpdateEmpty',
  });
export type MemoryUpdate = z.infer<typeof MemoryUpdate>;

/** What a person may do on this server: the owner installed it; admins manage it with them. */
export const Role = z.enum(['owner', 'admin', 'member']);
export type Role = z.infer<typeof Role>;
/** Who a device is signed in as. */
export const SessionUser = z.object({ id: z.string(), username: z.string().nullable(), role: Role });
export type SessionUser = z.infer<typeof SessionUser>;

/** A person on the server, as the people list shows them. */
export const PersonInfo = z.object({
  id: z.string(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  role: Role,
  /** No longer able to sign in; their conversations and notes are kept. */
  disabled: z.boolean(),
  createdAt: z.string(),
});
export type PersonInfo = z.infer<typeof PersonInfo>;
/** The roles a person can be given; there is only ever one owner. */
export const GivenRole = z.enum(['admin', 'member']);
export const PersonCreate = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(200),
  displayName: z.string().trim().max(100).optional(),
  role: GivenRole.default('member'),
});
export type PersonCreate = z.input<typeof PersonCreate>;
export const PersonUpdate = z.object({
  displayName: z.string().trim().max(100).nullable().optional(),
  role: GivenRole.optional(),
  disabled: z.boolean().optional(),
  /** A new password, for someone who forgot theirs; their devices are signed out. */
  password: z.string().min(1).max(200).optional(),
});
export type PersonUpdate = z.input<typeof PersonUpdate>;

export const AccessRequest = z.object({ key: z.string().min(1).max(500) });
export const LoginRequest = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(200),
});
/** Makes the account, or changes it; a change needs the current password or the access key. */
export const AccountSet = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(200),
  current: z.string().max(500).optional(),
});
export type AccountSet = z.infer<typeof AccountSet>;

/** A device signed in to the server. */
export const SessionInfo = z.object({
  id: z.string(),
  userAgent: z.string().nullable(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  /** The device asking. */
  current: z.boolean(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const ServerInfo = z.object({
  name: z.literal('leafbot'),
  version: z.string(),
  bootId: z.string(),
  /** Changes when a new version is deployed; null without a built web app, missing on older servers. */
  buildId: z.string().nullable().optional(),
  claude: z.object({
    status: z.enum(['unknown', 'ok', 'logged-out', 'error']),
    /** A known cause, worded by the app in its own language; `detail` then holds the specifics. */
    reason: z.enum(['api-key', 'timeout']).optional(),
    detail: z.string().nullable(),
    /** How the server signs in to Claude; missing on older servers. */
    auth: z.enum(['login', 'token', 'apiKey']).optional(),
  }),
  /** Whether Claude bots can run Bash here: their commands only run inside the OS sandbox. */
  shellSandbox: z.object({
    status: z.enum(['unknown', 'ok', 'unavailable']),
    reason: z.enum(['platform', 'no-socat', 'no-bwrap', 'bwrap-failed']).optional(),
    detail: z.string().nullable(),
  }),
  /** Whether bots get their own browser: a Chrome, Edge or Chromium must be found on the server. */
  browser: z.object({
    status: z.enum(['ok', 'unavailable']),
    /** The browser program in use. */
    detail: z.string().nullable(),
    /** Whether it can open as an ordinary window on this computer; missing on older servers. */
    window: z.boolean().optional(),
  }),
  /**
   * Whether bots get their own desktop (a computer service next to the server). `off`: none is
   * configured, so bots use the server's own shell and browser.
   */
  computer: z.object({
    status: z.enum(['ok', 'off', 'unreachable']),
    detail: z.string().nullable(),
  }),
  /** The address set for other services to reach the server at; null or missing when none is. */
  publicUrl: z.string().nullable().optional(),
  /**
   * Whether the bots' browsers can reach the web through the person's own computer, and whether
   * one is connected for it. Missing when the server runs on that computer itself (or is older).
   */
  egress: z
    .object({
      enabled: z.boolean(),
      connected: z.boolean(),
      device: z.string().nullable(),
    })
    .optional(),
});
export type ServerInfo = z.infer<typeof ServerInfo>;

/** Where a viewer's pointer is, as a fraction of the browser view (0–1), so any screen size works. */
const fraction = z.number().min(0).max(1);
const MouseButton = z.enum(['left', 'right', 'middle']);

/** What a person does in a bot's browser after taking control. */
export const BrowserInput = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('mouse'),
    action: z.enum(['move', 'down', 'up']),
    x: fraction,
    y: fraction,
    button: MouseButton.default('left'),
  }),
  z.object({
    type: z.literal('wheel'),
    x: fraction,
    y: fraction,
    dx: z.number().min(-5000).max(5000),
    dy: z.number().min(-5000).max(5000),
  }),
  z.object({ type: z.literal('key'), action: z.enum(['down', 'up']), key: z.string().min(1).max(32) }),
  z.object({ type: z.literal('text'), text: z.string().min(1).max(5000) }),
  z.object({ type: z.literal('nav'), action: z.enum(['back', 'forward', 'reload']) }),
  z.object({ type: z.literal('open'), url: z.string().trim().min(1).max(2000) }),
]);
/** As sent: optional fields (the mouse button) may be left out. */
export type BrowserInput = z.input<typeof BrowserInput>;

export const BrowserInputEvent = z.object({ botId: Id, input: BrowserInput });
export const BrowserControlEvent = z.object({ botId: Id, on: z.boolean() });

/** An API-key provider for the Pi engine; the key itself never leaves the server. */
export const ProviderInfo = z.object({
  id: z.string(),
  configured: z.boolean(),
  hint: z.string().nullable(),
  /** Set for the person's own OpenAI-compatible endpoints. */
  custom: z.object({ name: z.string(), baseUrl: z.string() }).optional(),
  /** Set for a provider that takes a sign-in with the person's own plan (ChatGPT, Copilot). */
  signIn: z.object({ signedIn: z.boolean() }).optional(),
});
export type ProviderInfo = z.infer<typeof ProviderInfo>;

/** Where signing in to a provider with a plan stands, as the app shows it while the person signs in. */
export const ProviderSignIn = z.object({
  id: z.string(),
  provider: z.string(),
  status: z.enum(['starting', 'waiting', 'done', 'error', 'cancelled']),
  /** The page to sign in on, opened in the person's browser. */
  url: z.string().nullable(),
  /** A code the person types on `url` (a device-code sign-in). */
  userCode: z.string().nullable(),
  /** The browser could not hand the sign-in back by itself: the person pastes the address it ended on. */
  needsPaste: z.boolean(),
  error: z.string().nullable(),
  /** What the sign-in said after a pasted code while it still waits, such as why it did not take it. */
  message: z.string().nullable().optional(),
});
export type ProviderSignIn = z.infer<typeof ProviderSignIn>;
export const ProviderSignInStart = z.object({
  /** A GitHub Enterprise domain for Copilot; empty for github.com. */
  enterprise: z.string().trim().max(200).optional(),
});
export const ProviderKeyInput = z.object({ key: z.string().min(1).max(1000) });

/** An OpenAI-compatible endpoint; its models are asked from it unless named here. */
export const CustomEndpointCreate = z.object({
  name: z.string().trim().min(1).max(60),
  baseUrl: z.string().trim().min(1).max(500),
  key: z.string().max(1000).optional(),
  models: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
});
export type CustomEndpointCreate = z.infer<typeof CustomEndpointCreate>;
/** A change to a saved endpoint; an empty or missing key or model list keeps the saved one. */
export const CustomEndpointUpdate = CustomEndpointCreate.partial();
export type CustomEndpointUpdate = z.infer<typeof CustomEndpointUpdate>;

/** How the person mostly uses the assistant; asked when LeafBot is first opened. */
export const PROFILE_FOCUS = ['work', 'personal', 'both'] as const;
export type ProfileFocus = (typeof PROFILE_FOCUS)[number];

/** Kinds of work the person wants help with; each one suggests a starter bot. */
export const PROFILE_HELP = [
  'research',
  'writing',
  'documents',
  'web',
  'planning',
  'code',
  'learning',
] as const;
export type ProfileHelp = (typeof PROFILE_HELP)[number];

/** How much effort Claude puts into a reply, lowest first. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/** How the server signs in to Claude: the machine's Claude login, a subscription token, or an API key. */
export const CLAUDE_AUTH_KINDS = ['login', 'token', 'apiKey'] as const;
export type ClaudeAuthKind = (typeof CLAUDE_AUTH_KINDS)[number];

export const ClaudeAuthSet = z.object({
  kind: z.enum(['token', 'apiKey']),
  value: z.string().min(1).max(500),
  /** With an API key: an Anthropic-compatible gateway (LiteLLM, a company proxy) to send it to. */
  baseUrl: z.string().trim().max(500).optional(),
});
export type ClaudeAuthSet = z.infer<typeof ClaudeAuthSet>;

export interface ClaudeAuthStatus {
  kind: ClaudeAuthKind;
  /** The last characters of a saved token or key; the value itself never leaves the server. */
  hint: string | null;
  /** The gateway an API key is sent to, when one was given. */
  baseUrl?: string | null;
}

/** A Claude model the server can use, with the effort levels it accepts. */
export interface ClaudeModel {
  value: string;
  name: string;
  description: string;
  efforts: Effort[];
}

/** A model of another provider as the model picker shows it. */
export interface ModelInfo {
  /** What goes after `provider/`. */
  id: string;
  /** A readable name; the id when nothing better is known. */
  name: string;
  /** The thinking levels the model takes, lowest first; empty for one that does not think, null when unknown. */
  efforts: Effort[] | null;
  images: boolean;
  contextWindow: number | null;
  /** YYYY-MM-DD, when known. */
  released: string | null;
}

/** A subagent's card in the chat: what it was asked to do, how it stands and the steps it took. */
export interface SubagentCard {
  description: string;
  /** `waiting` until a free place lets it start, when the bot started more than run at once. */
  state: 'waiting' | 'running' | 'done' | 'failed' | 'stopped';
  steps: number;
  /** The tool it called last, by its engine name (`Bash`, `mcp__notion__search`). */
  tool: string | null;
  /** What it handed back to the bot, cut short; once it has ended. */
  result: string | null;
  /** When it started and, once it has, ended (ISO). */
  startedAt: string | null;
  endedAt: string | null;
}

const SUBAGENT_STATES = ['waiting', 'running', 'done', 'failed', 'stopped'] as const;

/** The subagent a message is the card of, or null. */
export function subagentOf(props: Record<string, unknown>): SubagentCard | null {
  return subagentCardOf(props.subagent);
}

/**
 * The subagents a bot started together, in the order they started, when a message is their group's
 * card; null otherwise. Such a message also carries `subagent`, one card that sums the group up, for
 * apps that show only that.
 */
export function subagentsOf(props: Record<string, unknown>): SubagentCard[] | null {
  if (!Array.isArray(props.subagents)) return null;
  const list = props.subagents.map(subagentCardOf).filter((s): s is SubagentCard => s !== null);
  return list.length ? list : null;
}

/** How many of a group stand at each state. */
export function subagentCounts(list: SubagentCard[]): Record<SubagentCard['state'], number> {
  const counts = { waiting: 0, running: 0, done: 0, failed: 0, stopped: 0 };
  for (const s of list) counts[s.state] += 1;
  return counts;
}

function subagentCardOf(raw: unknown): SubagentCard | null {
  const s = raw as Partial<SubagentCard> | undefined;
  if (!s || typeof s !== 'object') return null;
  const state = SUBAGENT_STATES.find((x) => x === s.state) ?? 'running';
  return {
    description: typeof s.description === 'string' ? s.description : '',
    state,
    steps: typeof s.steps === 'number' ? s.steps : 0,
    tool: typeof s.tool === 'string' ? s.tool : null,
    result: typeof s.result === 'string' ? s.result : null,
    startedAt: typeof s.startedAt === 'string' ? s.startedAt : null,
    endedAt: typeof s.endedAt === 'string' ? s.endedAt : null,
  };
}

/**
 * How many seconds a subagent has worked: until it ended, or while it runs until `now`. Null when
 * that is not known, as for a running one without `now`.
 */
export function subagentSeconds(sub: SubagentCard, now?: number): number | null {
  const from = sub.startedAt ? Date.parse(sub.startedAt) : NaN;
  const to = sub.endedAt ? Date.parse(sub.endedAt) : (now ?? NaN);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.max(0, Math.round((to - from) / 1000));
}

/**
 * How long a subagent has worked, in words: seconds under a minute, then minutes. `t` is the app's
 * translator; `now` counts a running one up to that moment.
 */
export function subagentTime(
  sub: SubagentCard,
  t: (key: 'message.subagentSeconds' | 'message.subagentMinutes', vars: { count: number }) => string,
  now?: number,
): string | null {
  const seconds = subagentSeconds(sub, now);
  if (seconds === null) return null;
  return seconds < 60
    ? t('message.subagentSeconds', { count: seconds })
    : t('message.subagentMinutes', { count: Math.floor(seconds / 60) });
}

/** How far back the usage report looks, in days. */
export const USAGE_RANGES = [7, 30, 90] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

/**
 * One window of a Claude plan's usage limit: `five_hour`, `seven_day`, a model's weekly window
 * (`seven_day_opus`) or one the account names itself (`label`). `used` runs from 0 to 1.
 */
export const PlanWindow = z.object({
  kind: z.string().max(60),
  label: z.string().max(60).optional(),
  used: z.number().min(0).max(1).nullable(),
  resetsAt: z.string().nullable(),
});
export type PlanWindow = z.infer<typeof PlanWindow>;

/** How long a plan window lasts, for the mark of how much of it has passed. */
export function planWindowMs(kind: string): number {
  return kind === 'five_hour' ? 5 * 3_600_000 : 7 * 86_400_000;
}

/**
 * How much of a window has passed (0–1) at `now`, from when it resets; null when that is not known.
 * Usage ahead of this spends the window faster than it lasts.
 */
export function planPace(w: Pick<PlanWindow, 'kind' | 'resetsAt'>, now: number): number | null {
  if (!w.resetsAt) return null;
  const left = Date.parse(w.resetsAt) - now;
  if (!Number.isFinite(left)) return null;
  const length = planWindowMs(w.kind);
  return Math.min(1, Math.max(0, 1 - left / length));
}

/**
 * How a plan window's use reads: `near` at 90% used and over, `ahead` when at least half is used
 * and faster than the window's time passes (it would run out before it resets), else `fine`. Early
 * in a window any use is ahead of its time, which says nothing yet, so half is the threshold.
 */
export type PlanTone = 'fine' | 'ahead' | 'near';
export function planTone(w: PlanWindow, now: number): PlanTone {
  const used = w.used ?? 0;
  if (used >= 0.9) return 'near';
  const pace = planPace(w, now);
  return used >= 0.5 && pace !== null && used > pace ? 'ahead' : 'fine';
}

/** The windows still running at `now`: what one said before its reset is no longer true. */
export function currentPlanWindows(windows: readonly PlanWindow[], now: number): PlanWindow[] {
  return windows.filter((w) => !w.resetsAt || !(Date.parse(w.resetsAt) <= now));
}

/**
 * The window that says how much of the plan is left: of the five-hour and the weekly windows
 * whose use is known, the fuller one. A model's own weekly window is left out, as it holds back
 * only the bots on that model; null when neither is known.
 */
export function planHeadline(windows: readonly PlanWindow[], now: number): PlanWindow | null {
  let fullest: PlanWindow | null = null;
  for (const w of currentPlanWindows(windows, now)) {
    if ((w.kind !== 'five_hour' && w.kind !== 'seven_day') || w.used === null) continue;
    if (!fullest || w.used > (fullest.used ?? 0)) fullest = w;
  }
  return fullest;
}

/** The whole percent of a window used, 0–100. */
export function planUsedPercent(w: Pick<PlanWindow, 'used'>): number {
  return Math.max(0, Math.min(100, Math.round((w.used ?? 0) * 100)));
}

/** Spending and work over a period, from the finished turns. */
const UsageTotals = z.object({
  /** Engine-reported cost in US dollars; for a Claude subscription an estimate at API prices. */
  costUsd: z.number(),
  turns: z.number().int(),
  /** Turns with no cost reported: stopped or failed ones, or an engine that does not tell. */
  unpriced: z.number().int(),
});

/** Whether this server is shared on the person's Tailscale network, and where. */
export const TailscaleState = z.object({
  installed: z.boolean(),
  running: z.boolean(),
  /** This machine's name on the tailnet (`laptop.tail1234.ts.net`). */
  name: z.string().nullable(),
  sharing: z.boolean(),
  url: z.string().nullable(),
});
export type TailscaleState = z.infer<typeof TailscaleState>;

/**
 * Whether bots can use the person's own Mac, and what macOS allows the app: moving the mouse and
 * typing (Accessibility) and seeing other apps' windows (Screen Recording).
 */
export const PersonComputerState = z.object({
  available: z.boolean(),
  accessibility: z.boolean(),
  screen: z.boolean(),
  /**
   * The Mac is (or would be) offered from afar by the person's desktop app, rather than being the
   * one the server runs on; turned on in that app's own menu.
   */
  remote: z.boolean().optional(),
  /** The name of the Mac offered from afar, while one is connected. */
  device: z.string().nullable().optional(),
});
export type PersonComputerState = z.infer<typeof PersonComputerState>;

/** What a web link shows on a hover; a GitHub pull request or issue also gives its state. */
export const LinkPreview = z.object({
  url: z.string(),
  site: z.string(),
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  github: z
    .object({
      kind: z.enum(['pr', 'issue']),
      repo: z.string(),
      number: z.number(),
      state: z.enum(['open', 'draft', 'merged', 'closed', 'notPlanned']),
      author: z.string().nullable(),
    })
    .optional(),
});
export type LinkPreview = z.infer<typeof LinkPreview>;

export const UsageReport = z.object({
  days: z.number().int(),
  timezone: z.string(),
  total: UsageTotals,
  /** Busiest first; archived bots stay in, so past spending adds up. */
  bots: z.array(UsageTotals.extend({ botId: Id, name: z.string(), archived: z.boolean() })),
  /**
   * Costliest first. `model` is null for turns from before the model was recorded, and for turns
   * that never started.
   */
  models: z.array(UsageTotals.extend({ engine: EngineKind.nullable(), model: z.string().nullable() })),
  /** What each routine's runs cost, costliest first; missing on older servers. */
  routines: z.array(UsageTotals.extend({ routineId: Id, name: z.string(), botId: Id.nullable() })).optional(),
  /** What rehearsals of each routine cost, costliest first; left out when there were none. */
  rehearsals: z
    .array(UsageTotals.extend({ routineId: Id, name: z.string(), botId: Id.nullable() }))
    .optional(),
  /** One entry per day in the bot owner's time zone, oldest first, quiet days included. */
  daily: z.array(z.object({ date: z.string(), costUsd: z.number(), turns: z.number().int() })),
  /** Spending so far in this calendar month and the limit set for it (0: none); missing on older servers. */
  month: z.object({ costUsd: z.number(), limitUsd: z.number() }).optional(),
  /** Spending so far today (the server's time zone) and the daily limit (0: none); missing on older servers. */
  day: z.object({ costUsd: z.number(), limitUsd: z.number() }).optional(),
  /**
   * How many turns may run at once: the person's choice (0 for the server's own) and the server's
   * own number; missing on older servers.
   */
  parallel: z.object({ max: z.number().int(), serverDefault: z.number().int() }).optional(),
  /**
   * The Claude plan's usage windows as the last Claude turn saw them, and when; missing when no
   * turn has seen them (an API key, or no Claude turn yet).
   */
  plan: z.object({ at: z.string(), windows: z.array(PlanWindow) }).optional(),
  /**
   * The routine pre-check over the period, when it looked at any run: what it cost, the runs it
   * would have skipped while only watching and what those runs cost, and the runs it did skip.
   */
  gate: z
    .object({
      checks: z.number().int(),
      costUsd: z.number(),
      skippable: z.number().int(),
      skippableCostUsd: z.number(),
      skipped: z.number().int(),
    })
    .optional(),
  /** The promise safety net over the period, when it looked at any reply: its looks, what they cost, the promises found. */
  promises: z.object({ checks: z.number().int(), costUsd: z.number(), found: z.number().int() }).optional(),
  /** The routine suggestions' looks at groups of requests over the period, when there were any: looks, cost, suggestions made. */
  suggestions: z
    .object({ checks: z.number().int(), costUsd: z.number(), found: z.number().int() })
    .optional(),
  /** The work offers' looks at conversations over the period, when there were any: looks, cost, offers made. */
  offers: z.object({ checks: z.number().int(), costUsd: z.number(), found: z.number().int() }).optional(),
  /**
   * The memory tidy-up's calls over the period, when it made any: sets of notes read, notes read
   * against their page, what the calls cost and the notes they changed.
   */
  tidy: z
    .object({
      sets: z.number().int(),
      sources: z.number().int(),
      costUsd: z.number(),
      changed: z.number().int(),
    })
    .optional(),
  /**
   * The other calls the server made to the bots' models in the background over the period, by kind
   * (the memory review, conversation titles, meeting minutes, follow-ups), when there were any.
   */
  background: z
    .array(
      z.object({
        kind: z.enum(['memoryReview', 'title', 'minutes', 'followUps', 'review', 'routineFix']),
        calls: z.number().int(),
        costUsd: z.number(),
      }),
    )
    .optional(),
  /** The skill suggestions' calls over the period, when there were any: calls, cost, skills written. */
  skillSuggestions: z
    .object({ checks: z.number().int(), costUsd: z.number(), found: z.number().int() })
    .optional(),
});
export type UsageReport = z.infer<typeof UsageReport>;

/**
 * A trip-wire that caught a bot steered by text it read: the bot repeated the private line of its
 * prompt (`prompt`) or touched a trap key (`key`). The bot was stopped and moved to "Ask".
 */
export const CanaryAlarm = z.object({
  id: Id,
  wire: z.enum(['prompt', 'key']),
  botId: Id,
  botName: z.string(),
  threadId: Id.nullable(),
  /** The tool that was refused, or `reply` for an answer that carried the private line. */
  tool: z.string(),
  /** For a trap key: its name. */
  keyName: z.string().nullable(),
  /** What the turn had read from outside before the trip (pages, mail, apps). */
  sources: z.array(z.string()),
  /** The level the bot had before it was moved to "Ask"; null when it was not changed. */
  movedFrom: z.string().nullable(),
  createdAt: z.string(),
  seenAt: z.string().nullable(),
});
export type CanaryAlarm = z.infer<typeof CanaryAlarm>;

/** What happened today, in the bot owner's time zone: what each bot did and what its routines ran. */
export const TodayReport = z.object({
  date: z.string(),
  costUsd: z.number(),
  bots: z.array(
    z.object({
      botId: Id,
      name: z.string(),
      /** Turns finished today. */
      turns: z.number().int(),
      /** Of those, the ones that ended in an error. */
      failed: z.number().int(),
      costUsd: z.number(),
    }),
  ),
  runs: z.array(
    z.object({
      routineId: Id,
      name: z.string(),
      botId: Id,
      status: z.enum(['running', 'done', 'error', 'stopped', 'skipped', 'waiting', 'queued']),
      threadId: Id.nullable(),
      startedAt: z.string(),
    }),
  ),
  /** Memory notes no bot uses any more, waiting for the user to keep or delete them. Missing from older servers. */
  staleMemory: z.number().int().optional(),
  /** Memory notes whose "true until" date has passed, kept for the user to delete or give a new date; not counted in `staleMemory`. Missing from older servers. */
  expiredMemory: z.number().int().optional(),
  /** Memory changes asked for while nobody watched, waiting for the user's yes. Missing from older servers. */
  pendingMemory: z.number().int().optional(),
  /** Changes bots found for skills the user owns, waiting for the user's review. Missing from older servers. */
  pendingSkills: z.number().int().optional(),
  /** Gaps bots found in what they know and could not fill, waiting for an answer. Missing from older servers. */
  openFlags: z.number().int().optional(),
  /** Trip-wire alarms the user has not marked seen. Missing from older servers. */
  canaryAlarms: z.array(CanaryAlarm).optional(),
});
export type TodayReport = z.infer<typeof TodayReport>;

/**
 * Something said it would be done later: a bot's promise to the person (`bot`) or the person's own
 * to someone else (`person`). Only the person it belongs to sees it.
 */
export const Pledge = z.object({
  id: Id,
  botId: Id,
  threadId: Id.nullable(),
  madeBy: z.enum(['bot', 'person']),
  text: z.string(),
  /** For the person's own promise: who it was made to. */
  toWhom: z.string(),
  /** When it falls due, or null; `dueHasTime` says whether that is a time of day or the end of a day. */
  dueAt: z.string().nullable(),
  dueHasTime: z.boolean(),
  /** What it waits for instead of a time; empty when none. */
  condition: z.string(),
  /** Whether a one-time routine is set to keep it. */
  scheduled: z.boolean(),
  status: z.enum(['open', 'done', 'dropped']),
  /** Open and past its time. */
  overdue: z.boolean(),
  createdAt: z.string(),
});
export type Pledge = z.infer<typeof Pledge>;

/** A reminder a bot keeps for itself, as the bot lists it. */
export const FollowUp = z.object({
  id: Id,
  botId: Id,
  /** What the bot brings up, and what it came from (a mail's sender and subject, say). */
  text: z.string(),
  context: z.string(),
  /** When the thing itself happens, when there is such a moment; null when none. */
  eventAt: z.string().nullable(),
  /** When the bot brings it up. */
  dueAt: z.string(),
  /** What set it: the bot keeping track, a person's promise, a meeting's task. */
  kind: z.enum(['bot', 'promise', 'meeting']),
  createdAt: z.string(),
});
export type FollowUp = z.infer<typeof FollowUp>;

/** What a turn changed that can be put back, by the kind of thing it was. */
export const TURN_CHANGE_KINDS = [
  'file',
  'table_row',
  'ticket',
  'routine',
  'skill',
  'bot',
  'memory',
] as const;
export type TurnChangeKind = (typeof TURN_CHANGE_KINDS)[number];

/** What became of a change when its turn was taken back. */
export const TurnChangeOutcome = z.enum(['restored', 'later', 'needsOwner', 'notUndoable', 'failed']);
export type TurnChangeOutcome = z.infer<typeof TurnChangeOutcome>;

/** One change a turn made, as the person sees it before and after taking the turn back. */
export const TurnChangeItem = z.object({
  id: Id,
  kind: z.enum(TURN_CHANGE_KINDS),
  op: z.enum(['create', 'update', 'delete']),
  /** A file name, a table and row, a routine's name. */
  label: z.string(),
  /** Why it cannot be put back, when it cannot (too large to keep, or deleted words that are not kept). */
  reason: z.enum(['tooBig', 'deleted']).nullable(),
  /** The person may not change what it belongs to; its owner has to put it back. */
  needsOwner: z.boolean(),
  /** After the turn was taken back: what became of it; null before. */
  outcome: TurnChangeOutcome.nullable(),
});
export type TurnChangeItem = z.infer<typeof TurnChangeItem>;

/** A step of the turn that reached outside and so cannot be taken back. */
export const TurnOutsideStep = z.object({ summary: z.string(), at: z.string() });
export type TurnOutsideStep = z.infer<typeof TurnOutsideStep>;

/** What taking a turn back would put back, and what no one can. */
export const TurnChanges = z.object({
  turnId: Id,
  /** The turn is still working: it cannot be taken back yet. */
  running: z.boolean(),
  /** The turn was already taken back. */
  undone: z.boolean(),
  items: z.array(TurnChangeItem),
  outside: z.array(TurnOutsideStep),
});
export type TurnChanges = z.infer<typeof TurnChanges>;

/** One turn in a conversation's action log: what it changed and reached, and when it was asked. */
export const TurnLogEntry = TurnChanges.extend({
  at: z.string(),
  /** The start of what the turn was asked. */
  request: z.string(),
});
export type TurnLogEntry = z.infer<typeof TurnLogEntry>;

/**
 * A routine proposed because the person keeps asking a bot for the same thing by hand. Only the
 * person it was written from sees it.
 */
export const RoutineSuggestion = z.object({
  id: Id,
  botId: Id,
  name: z.string(),
  /** What the routine would do; the person may change it before creating the routine. */
  instructions: z.string(),
  /** The rhythm the requests had, or null when they had none and the person picks. */
  schedule: Schedule.nullable(),
  timezone: z.string(),
  /** How many requests it was made from, and the local days (YYYY-MM-DD) they were made on. */
  requests: z.number().int(),
  days: z.array(z.string()),
  /** Whether the person may change the bot, which a routine of it needs. */
  canCreate: z.boolean(),
  createdAt: z.string(),
});
export type RoutineSuggestion = z.infer<typeof RoutineSuggestion>;

/** What the person settled on when creating the routine from a suggestion. */
export const RoutineSuggestionAccept = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  instructions: z.string().trim().min(1).max(20_000).optional(),
  schedule: Schedule.optional(),
});
export type RoutineSuggestionAccept = z.infer<typeof RoutineSuggestionAccept>;

/** A skill's name: what the bot asks for it by, in lower case with dashes (`weekly-report`). */
export const SkillName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'validation.skillName');

/** What a taught step was done to, as a person would name it (a button's words, a field's label). */
export const TaughtTarget = z.object({
  what: z.enum(['button', 'link', 'field', 'checkbox', 'menu', 'option', 'element']),
  label: z.string().max(200),
  secret: z.boolean(),
});
/**
 * One step of a task a person showed a bot in its browser. Kept with the skill written from it, so
 * the task can be done again step by step without the model; a step that no longer fits the page
 * is where the bot takes over.
 */
export const TaughtStep = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('open'), url: z.string().max(4000) }),
  z.object({ kind: z.literal('click'), target: TaughtTarget, url: z.string().max(4000) }),
  z.object({
    kind: z.literal('type'),
    target: TaughtTarget,
    text: z.string().max(10_000),
    secret: z.boolean(),
    url: z.string().max(4000),
  }),
  z.object({ kind: z.literal('key'), key: z.string().max(40), url: z.string().max(4000) }),
  z.object({
    kind: z.literal('nav'),
    action: z.enum(['back', 'forward', 'reload']),
    url: z.string().max(4000),
  }),
]);
export type TaughtStep = z.infer<typeof TaughtStep>;
export const TaughtSteps = z.array(TaughtStep).max(200);

/** How a replay of taught steps went: how far it got, and the step that did not fit if it stopped. */
export const ReplayResult = z.object({
  ok: z.boolean(),
  done: z.number().int(),
  total: z.number().int(),
  /** The step it stopped at (from 1) and why, in the server's language. */
  failedAt: z.object({ step: z.number().int(), reason: z.string() }).optional(),
});
export type ReplayResult = z.infer<typeof ReplayResult>;

export const Skill = z.object({
  id: Id,
  name: z.string(),
  /** When the skill applies; the bot sees this before it decides to read the rest. */
  description: z.string(),
  body: z.string(),
  /** The steps a person showed, when the skill was taught in the browser; they can be replayed. */
  steps: TaughtSteps.nullable().optional(),
  /** Bots that have it on. */
  botIds: z.array(Id),
  /** How many times a bot read it for a task, and when it last did. */
  uses: z.number().int(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Skill = z.infer<typeof Skill>;

/**
 * A change to a skill a bot found while working for someone who may not change the skill; it
 * waits for the skill's owner to accept it.
 */
export const SkillChange = z.object({
  id: Id,
  skillId: Id,
  skillName: z.string(),
  /** The skill's description and text as they would be once accepted. */
  description: z.string(),
  body: z.string(),
  /** What the bot changed and why, in its own words. */
  reason: z.string().nullable(),
  /** The bot that found it, and the person it worked for. */
  proposedBy: Id,
  userId: Id.nullable(),
  /** That person's name, for the one who reviews it. */
  userName: z.string().nullable(),
  threadId: Id.nullable(),
  createdAt: z.string(),
});
export type SkillChange = z.infer<typeof SkillChange>;

export const SkillCreate = z.object({
  name: SkillName,
  description: z.string().trim().min(1).max(1024),
  body: z.string().max(50_000).default(''),
  steps: TaughtSteps.nullable().optional(),
  /** Bots to turn it on for at once. */
  botIds: z.array(Id).max(500).optional(),
});
export type SkillCreate = z.input<typeof SkillCreate>;
export const SkillUpdate = SkillCreate.omit({ botIds: true }).partial();
export type SkillUpdate = z.infer<typeof SkillUpdate>;

/** A skill offered from a kind of task the person asked a bot for again and again. */
export const SkillSuggestion = z.object({
  id: Id,
  botId: Id,
  /** The skill's name as a skill takes it (`weekly-sales-report`). */
  name: z.string(),
  description: z.string(),
  /** What the skill tells the bot; the person may change it before adding the skill. */
  body: z.string(),
  /** How many requests it was made from, and the local days (YYYY-MM-DD) they were made on. */
  requests: z.number().int(),
  days: z.array(z.string()),
  /** Whether the person may change the bot, which turning a skill on for it needs. */
  canCreate: z.boolean(),
  createdAt: z.string(),
});
export type SkillSuggestion = z.infer<typeof SkillSuggestion>;

/** What the person settled on when adding the skill from a suggestion. */
export const SkillSuggestionAccept = z.object({
  name: SkillName.optional(),
  description: z.string().trim().min(1).max(1024).optional(),
  body: z.string().trim().min(1).max(50_000).optional(),
});
export type SkillSuggestionAccept = z.infer<typeof SkillSuggestionAccept>;
export const SkillBot = z.object({ on: z.boolean() });

/** A message found by the search, with where it is. */
export const SearchHit = z.object({
  messageId: Id,
  threadId: Id,
  botId: Id,
  threadTitle: z.string(),
  threadKind: ThreadKind,
  role: z.enum(['user', 'assistant']),
  author: z.string(),
  /** The text around the first match. */
  excerpt: z.string(),
  createdAt: z.string(),
});
export type SearchHit = z.infer<typeof SearchHit>;

/** A link that opens a bot's page for anyone who has it, without signing in. */
export const PageShare = z.object({
  token: z.string(),
  botId: Id,
  path: z.string(),
  name: z.string(),
  createdAt: z.string(),
});
export type PageShare = z.infer<typeof PageShare>;
export const PageShareCreate = z.object({
  path: z.string().min(1).max(2000),
  name: z.string().trim().min(1).max(200),
});

/**
 * How a saved API key goes with a request: as a bearer token, in a header of the service's own,
 * as a query parameter, or as the password of basic authentication.
 */
export const ApiAuth = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bearer') }),
  z.object({
    type: z.literal('header'),
    header: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{1,64}$/, 'validation.headerName'),
  }),
  z.object({
    type: z.literal('query'),
    param: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_.-]{1,64}$/, 'validation.queryParam'),
  }),
  z.object({ type: z.literal('basic'), username: z.string().max(200) }),
]);
export type ApiAuth = z.infer<typeof ApiAuth>;

/** A reference name a bot uses for a saved API key: lowercase, digits, - and _. */
export const ApiCredentialName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'validation.credentialName');

/**
 * Where a key may go: an https origin, or plain http to a host on this computer or the private
 * network (a service next to the server, such as `http://ollama:11434`). Anything after the host is
 * dropped: the key is good for the whole origin.
 */
export const ApiOrigin = z
  .string()
  .trim()
  .transform((v, ctx) => {
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`);
      const internal = internalHost(url.hostname);
      if (
        !url.username &&
        !url.password &&
        (url.protocol === 'https:' || (url.protocol === 'http:' && internal))
      )
        return url.origin;
    } catch {
      // Falls through to the message below.
    }
    ctx.addIssue({ code: 'custom', message: 'validation.apiOrigin' });
    return z.NEVER;
  });

/** A saved API key as the app and the bots see it: never its value. */
export const ApiCredential = z.object({
  id: Id,
  name: z.string(),
  origin: z.string(),
  auth: ApiAuth,
  /** What it is for, in the person's words or the bot's when it asked. */
  label: z.string(),
  /** The bots that may use it; null lets every bot. */
  botIds: z.array(Id).nullable(),
  /**
   * Whose it is: a person's own, sent only for turns that work for them; null for the team's.
   * Missing on older servers, where every key was the team's.
   */
  userId: z.string().nullable().optional(),
  /** A trap key (see `TrapKeyCreate`). Missing on older servers, where there were none. */
  trap: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type ApiCredential = z.infer<typeof ApiCredential>;

/**
 * A trap key: a name for a key that does not exist. It is offered to the bots like a real one, and
 * a bot that touches it is being steered by something it read, since nothing the person asks for
 * would use it. The server makes up its address.
 */
export const TrapKeyCreate = z.object({
  name: ApiCredentialName,
  /** The bots it is shown to; null shows it to every bot the person has. */
  botIds: z.array(Id).max(500).nullable().optional(),
});
export type TrapKeyCreate = z.input<typeof TrapKeyCreate>;

export const ApiCredentialCreate = z.object({
  name: ApiCredentialName,
  origin: ApiOrigin,
  auth: ApiAuth.default({ type: 'bearer' }),
  label: z.string().trim().max(200).default(''),
  value: z.string().min(1).max(8000),
  botIds: z.array(Id).max(500).nullable().optional(),
  /**
   * For the whole team rather than the person saving it; only those who look after the server.
   * Left out, it is the team's for them (as every key was before keys had owners) and the person's
   * own for everyone else.
   */
  team: z.boolean().optional(),
});
export type ApiCredentialCreate = z.input<typeof ApiCredentialCreate>;

export const ApiCredentialUpdate = z.object({
  origin: ApiOrigin.optional(),
  auth: ApiAuth.optional(),
  label: z.string().trim().max(200).optional(),
  /** A new value; left out keeps the saved one. */
  value: z.string().min(1).max(8000).optional(),
  botIds: z.array(Id).max(500).nullable().optional(),
  /** Moves it to the team, or back to the person changing it; only those who look after the server. */
  team: z.boolean().optional(),
});
export type ApiCredentialUpdate = z.input<typeof ApiCredentialUpdate>;

/**
 * API keys from a `.env` file. Without `keys` nothing is saved and the answer names the entries
 * (never their values); with them, the chosen entries are saved, each for the origin given.
 */
export const ApiKeyImport = z.object({
  env: z
    .string()
    .min(1)
    .max(256 * 1024),
  keys: z
    .array(
      z.object({
        /** The name in the file. */
        env: z.string().max(200),
        name: ApiCredentialName,
        origin: ApiOrigin,
        auth: ApiAuth.default({ type: 'bearer' }),
        label: z.string().trim().max(200).default(''),
      }),
    )
    .max(200)
    .optional(),
  botIds: z.array(Id).max(500).nullable().optional(),
  team: z.boolean().optional(),
});
export type ApiKeyImport = z.input<typeof ApiKeyImport>;

export const ApiKeyImportResult = z.object({
  /** The file's entries: where each is, its name there, and the key name it would get. */
  entries: z.array(z.object({ line: z.number(), env: z.string(), name: z.string() })),
  saved: z.array(z.string()),
  /** Entries asked for that were not saved: missing from the file, or a key name already used. */
  skipped: z.array(z.object({ env: z.string(), reason: z.enum(['missing', 'exists']) })),
});
export type ApiKeyImportResult = z.infer<typeof ApiKeyImportResult>;

/** A mail that arrived at a bot's address. */
export const BotEmail = z.object({
  id: Id,
  botId: Id,
  to: z.string(),
  from: z.string(),
  fromName: z.string(),
  subject: z.string(),
  text: z.string(),
  /** Saved in the bot's own folder; `path` is where the bot's tools find each one. */
  attachments: z.array(z.object({ name: z.string(), size: z.number(), path: z.string() })),
  receivedAt: z.string(),
  readAt: z.string().nullable(),
});
export type BotEmail = z.infer<typeof BotEmail>;

/** The bots' mail: the domain, the relay's secret, and which bot has which address. */
export const EmailSettings = z.object({
  domain: z.string(),
  /** What the relay sends as its bearer token; null until one is made. */
  secret: z.string().nullable(),
  addresses: z.array(
    z.object({
      botId: Id,
      name: z.string(),
      address: z.string().nullable(),
      /** Whether the bot may type sign-in codes from this mailbox into the site that sent them. */
      codes: z.boolean(),
    }),
  ),
});
export type EmailSettings = z.infer<typeof EmailSettings>;
export const EmailCodes = z.object({ on: z.boolean() });
export const EmailClaim = z.object({ name: z.string().trim().min(1).max(64) });

/** What a plugin would add, read before anything is installed. */
export const PluginPlan = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  /** Remote MCP servers; each becomes a connection. */
  servers: z.array(
    z.object({
      name: z.string(),
      url: z.string(),
      /** Its entry sends a token the person has to give (an Authorization header). */
      needsToken: z.boolean(),
      /** Already connected at this address: left as it is. */
      exists: z.boolean(),
    }),
  ),
  skills: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      /** A skill of this name is already saved: left as it is. */
      exists: z.boolean(),
      warnings: z.array(z.enum(['hidden', 'pipeShell', 'encoded'])),
    }),
  ),
  /** Parts not installed, with why: code that would run here, or a kind not supported. */
  leftOut: z.array(z.object({ part: z.string(), why: z.enum(['runsCode', 'local', 'unsupported']) })),
});
export type PluginPlan = z.infer<typeof PluginPlan>;

export const PluginInstall = z.object({
  url: z.string().trim().min(1).max(2000),
  /** Tokens for servers that need one, by server name. */
  tokens: z.record(z.string(), z.string().max(10_000)).default({}),
  /** Skill names and server names to leave out. */
  skip: z.array(z.string().max(200)).max(500).default([]),
});
export type PluginInstall = z.input<typeof PluginInstall>;
export const PluginInstallResult = z.object({ servers: z.number(), skills: z.number() });
export type PluginInstallResult = z.infer<typeof PluginInstallResult>;

/** One operation of an OpenAPI document, as a bot is shown it. */
export const ApiOperation = z.object({
  id: z.string(),
  method: z.string(),
  path: z.string(),
  summary: z.string(),
  /** Path, query and header parameters: name, where, required, and type. */
  params: z.array(z.object({ name: z.string(), in: z.string(), required: z.boolean(), type: z.string() })),
  /** The JSON request body's schema, shortened; empty when it takes none. */
  body: z.string(),
});
export type ApiOperation = z.infer<typeof ApiOperation>;

/** An OpenAPI document bots may call operations of, with an API key saved in the vault. */
export const ApiSource = z.object({
  id: Id,
  name: z.string(),
  title: z.string(),
  specUrl: z.string().nullable(),
  baseUrl: z.string(),
  /** The saved API key's name the calls go with; null for an API that needs none. */
  credential: z.string().nullable(),
  operations: z.number(),
  botIds: z.array(Id).nullable(),
  createdAt: z.string(),
});
export type ApiSource = z.infer<typeof ApiSource>;

export const ApiSourceCreate = z
  .object({
    name: ApiCredentialName,
    /** Where the document is read from; or `spec`, the document pasted in. */
    specUrl: z.string().trim().max(2000).optional(),
    spec: z
      .string()
      .max(4 * 1024 * 1024)
      .optional(),
    /** Overrides the document's own server address. */
    baseUrl: z.string().trim().max(2000).optional(),
    credential: ApiCredentialName.nullable().default(null),
    botIds: z.array(Id).max(500).nullable().optional(),
  })
  .refine((v) => !!v.specUrl || !!v.spec, 'validation.openapiSource');
export type ApiSourceCreate = z.input<typeof ApiSourceCreate>;

export const TICKET_STATUSES = ['todo', 'in_progress', 'in_review', 'blocked', 'done', 'wont_do'] as const;
export const TicketStatus = z.enum(TICKET_STATUSES);
export type TicketStatus = z.infer<typeof TicketStatus>;
export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const TicketPriority = z.enum(TICKET_PRIORITIES);
export type TicketPriority = z.infer<typeof TicketPriority>;

export const TicketComment = z.object({
  id: Id,
  author: z.string(),
  text: z.string(),
  createdAt: z.string(),
});
export type TicketComment = z.infer<typeof TicketComment>;

/** A ticket of the board. */
export const Ticket = z.object({
  id: Id,
  number: z.number(),
  title: z.string(),
  description: z.string(),
  status: TicketStatus,
  priority: TicketPriority,
  assigneeBotId: Id.nullable(),
  createdBy: z.string(),
  /** The person who opened it; null when a bot did. Missing on older servers. */
  createdByUserId: z.string().nullable().optional(),
  threadId: Id.nullable(),
  /** Its place among the tickets of its column, smallest first. */
  position: z.number(),
  /** Whether its bot is at work on it now, in the ticket's conversation. */
  turnState: TurnState,
  comments: z.array(TicketComment),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Ticket = z.infer<typeof Ticket>;

export const TicketCreate = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).default(''),
  priority: TicketPriority.default('normal'),
  assigneeBotId: Id.nullable().default(null),
});
export type TicketCreate = z.input<typeof TicketCreate>;
export const TicketUpdate = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(20_000).optional(),
  status: TicketStatus.optional(),
  priority: TicketPriority.optional(),
  assigneeBotId: Id.nullable().optional(),
  /** A new place in its column; left out, a ticket moved to another column goes to its top. */
  position: z.number().finite().optional(),
});
export type TicketUpdate = z.input<typeof TicketUpdate>;
export const TicketCommentCreate = z.object({ text: z.string().trim().min(1).max(20_000) });

/** What the server's own check looks at; each has its text in the app by this name. */
export const DOCTOR_CHECKS = ['stuckTurns', 'staleApprovals', 'strayFolders', 'unreadable', 'disk'] as const;
export const DoctorCheckId = z.enum(DOCTOR_CHECKS);
export type DoctorCheckId = z.infer<typeof DoctorCheckId>;
/** One finding of the server's check: how it stands, how many things it found, and if it can mend them. */
export const DoctorCheck = z.object({
  id: DoctorCheckId,
  status: z.enum(['ok', 'warn', 'error']),
  count: z.number().int(),
  /** Bytes it is about: what stray folders take, or the free disk space. */
  bytes: z.number().optional(),
  /** Whether a repair can mend it without losing anything. */
  repairable: z.boolean(),
});
export type DoctorCheck = z.infer<typeof DoctorCheck>;
export const DoctorReport = z.object({
  checkedAt: z.string(),
  checks: z.array(DoctorCheck),
  /** Where a repair put the folders it moved aside, when it moved any. */
  movedTo: z.string().optional(),
});
export type DoctorReport = z.infer<typeof DoctorReport>;
export const DoctorRepair = z.object({ checks: z.array(DoctorCheckId).min(1) });
