import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { BotAccess, Schedule, TaughtStep } from '@leafbot/shared';
import { sealedJson, sealedProps, sealedText } from './sealed';

/** The outside text a run can read, as `OUTSIDE_TRIGGERS` in the shared package names it. */
const OUTSIDE_TRIGGERS = ['watch', 'webhook', 'email', 'whatsapp', 'web', 'forward', 'stored'] as const;

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const created = () => ts('created_at').notNull().defaultNow();

/**
 * A team space, whose bots are open to its members, or with an owner, a folder in that person's
 * Private, which opens nothing to anyone. A bot in neither is its owner's alone. A space is `open`
 * (everyone sees it and may join), `closed` (everyone sees it and asks to join) or `secret` (only
 * its members know of it). Groups made before spaces are secret spaces with nobody in them, so
 * nobody reaches a bot through one until someone is put in it.
 */
export const groups = pgTable('groups', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Order of the groups in the sidebar. */
  position: integer('position').notNull().default(0),
  /** Set while every bot of the group is paused: none of them starts work until it is cleared. */
  pausedAt: ts('paused_at'),
  /** Whose Private folder this is; null for a team space. */
  ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['open', 'closed', 'secret'] })
    .notNull()
    .default('secret'),
  /** Whether its members may also change its bots; otherwise they talk with them. */
  membersEdit: boolean('members_edit').notNull().default(false),
  createdAt: created(),
});

/** Who is in a team space. Those who look after the server reach every bot without being in one. */
export const groupMembers = pgTable(
  'group_members',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] }), index('group_members_user_idx').on(t.userId)],
);

/** Someone asking to join a closed team space, until one of those who look after the server answers. */
export const spaceRequests = pgTable(
  'space_requests',
  {
    id: text('id').primaryKey(),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: created(),
  },
  (t) => [uniqueIndex('space_requests_group_user_idx').on(t.groupId, t.userId)],
);

export const bots = pgTable('bots', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  instructions: text('instructions').notNull().default(''),
  engine: text('engine', { enum: ['claude', 'pi', 'acp'] })
    .notNull()
    .default('claude'),
  model: text('model').notNull().default(''),
  isManager: boolean('is_manager').notNull().default(false),
  /** Shown at the top of the sidebar. Only a place in the list; grants nothing. */
  pinned: boolean('pinned').notNull().default(false),
  /** Order within its sidebar section (the pinned bots, or a group). */
  position: integer('position').notNull().default(0),
  groupId: text('group_id').references(() => groups.id, { onDelete: 'set null' }),
  color: text('color').notNull().default('#4f6bed'),
  avatar: text('avatar').notNull().default('object:circle'),
  /** How an object avatar's body is finished: a plain fill, a coat of fur or tinted glass. */
  material: text('material', { enum: ['flat', 'fluffy', 'glass'] })
    .notNull()
    .default('flat'),
  permissionMode: text('permission_mode', { enum: ['ask', 'review', 'auto', 'readonly'] })
    .notNull()
    .default('ask'),
  /** No longer read: kept so the lists set before the internet switch are not lost. */
  allowedDomains: jsonb('allowed_domains').$type<string[]>().notNull().default([]),
  /** Whether the bot may reach the internet: web search, reading pages, its browser and desktop. */
  internet: boolean('internet').notNull().default(true),
  /** Whether the bot may use the person's own Mac in their own work. */
  personComputer: boolean('person_computer').notNull().default(false),
  /** The second model that reads outgoing mail and data on a card: `claude` or `provider/model`; null is none. */
  reviewer: text('reviewer'),
  projectDir: text('project_dir'),
  /** Whether the bot reads and keeps memory; off, it works from each conversation alone. */
  memory: boolean('memory').notNull().default(true),
  /** How hard a Claude bot thinks; empty takes the server-wide setting. */
  effort: text('effort').notNull().default(''),
  /** Which tools the bot gets (`ToolSelection`); null for every tool. */
  toolSelection: jsonb('tool_selection'),
  /**
   * A document the instructions are kept in, read now and then. What it says reaches the bot only
   * after the person accepts it: a change waits in `instructionsPending` until then.
   */
  instructionsUrl: text('instructions_url'),
  /** The document's text that differs from the instructions and waits for the person; kept as they are. */
  instructionsPending: text('instructions_pending'),
  /** The fingerprint of the document's text the person last accepted or turned down. */
  instructionsDocHash: text('instructions_doc_hash'),
  instructionsCheckedAt: ts('instructions_checked_at'),
  /** Why the document could not be read the last time; null when it was. */
  instructionsError: text('instructions_error'),
  archivedAt: ts('archived_at'),
  /**
   * Set while the bot is paused: it starts no work (a person's message waits, a routine is
   * skipped, another bot's request is refused) until it is cleared.
   */
  pausedAt: ts('paused_at'),
  /** The most this bot may spend in a day of the server's time zone, in US dollars; 0 for no limit. */
  dailyLimitUsd: doublePrecision('daily_limit_usd').notNull().default(0),
  /** The most this bot may spend in a calendar month, in US dollars; 0 for no limit. */
  monthlyLimitUsd: doublePrecision('monthly_limit_usd').notNull().default(0),
  createdAt: created(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  /** The person who made the bot, or was handed it; they may always change and share it. */
  ownerUserId: text('owner_user_id')
    .notNull()
    .default('owner')
    .references(() => users.id),
  /** Who else may use it (`BotAccess`); nobody but its owner and the admins until it is shared. */
  access: jsonb('access').$type<BotAccess>().notNull().default({ everyone: 'none', people: {} }),
});

export const threads = pgTable(
  'threads',
  {
    id: text('id').primaryKey(),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    title: sealedText('title').notNull().default(''),
    /**
     * The title was made from the opening words of the first message, not chosen by the person: once
     * the first answer is in, a model may write a better one.
     */
    titleAuto: boolean('title_auto').notNull().default(false),
    // `room`: a conversation of the person with several bots; `botId` is then only its first member.
    // `ticket`: a bot's work on a ticket of the board; listed only while it needs the person.
    // `team`: a conversation of the team (a Slack channel's thread); everyone who may talk with the
    // bot sees it, and its turns use only what the team shares, never one person's own data.
    // `rehearsal`: where a routine is tried without doing anything; in no list, shown from the
    // routine, and removed after a week.
    kind: text('kind', { enum: ['user', 'bot', 'routine', 'api', 'room', 'ticket', 'team', 'rehearsal'] })
      .notNull()
      .default('user'),
    /**
     * The person whose conversation this is; only they see it. Null for the bot's own work (with
     * other bots, routines, tickets), which those who may change the bot see.
     */
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** For bot-to-bot threads: the other bot. */
    peerBotId: text('peer_bot_id').references(() => bots.id, { onDelete: 'set null' }),
    engineSessionId: text('engine_session_id'),
    /** What the engine session had cost by its last run; the next run's cost is what it adds. */
    engineSessionCostUsd: doublePrecision('engine_session_cost_usd'),
    /** How full the engine session's context was after its last run, in tokens; null when unknown. */
    engineSessionTokens: integer('engine_session_tokens'),
    /**
     * Outside text the engine session has read (a mail, a webhook's body or post, a watched page,
     * or a report written from one); null when it has read none. A turn nobody watches that goes
     * on in such a session changes nothing without a card. A new session starts it again.
     */
    outsideSession: text('outside_session', { enum: OUTSIDE_TRIGGERS }),
    /** What the conversation is for, set by the person; every turn in it sees it. */
    goal: text('goal').notNull().default(''),
    /** One message the person pinned above the conversation; null for none. */
    pinnedMessageId: text('pinned_message_id'),
    /** Put away from the conversation list until the person brings it back or writes in it. */
    archivedAt: ts('archived_at'),
    /** Out of the list until this time, or until any new message in it, whichever comes first. */
    snoozedUntil: ts('snoozed_until'),
    /** Kept at the top of the conversation list since then; null when not. */
    pinnedAt: ts('pinned_at'),
    /** An emoji the person gave the conversation, to tell it apart in the list; '' when none. */
    icon: text('icon').notNull().default(''),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('threads_bot_idx').on(t.botId, t.updatedAt),
    index('threads_user_idx').on(t.userId, t.botId),
    // One exchange between two bots for each person it is done for: what one person asked through
    // a bot is not in the engine session another person's request continues.
    uniqueIndex('threads_peer_uq')
      .on(t.botId, t.peerBotId, t.userId)
      .where(sql`${t.kind} = 'bot'`),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant', 'system', 'marker', 'approval', 'error'] }).notNull(),
    author: text('author').notNull(),
    /** The person who wrote a `user` message; null for bots, outside text and older rows. */
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    text: sealedText('text').notNull().default(''),
    props: sealedProps('props').notNull().default({}),
    clientId: text('client_id'),
    turnId: text('turn_id'),
    createdAt: created(),
  },
  (t) => [
    index('messages_thread_idx').on(t.threadId, t.createdAt),
    uniqueIndex('messages_client_uq')
      .on(t.threadId, t.clientId)
      .where(sql`${t.clientId} is not null`),
  ],
);

/**
 * A room: one thread where the person and several bots talk, one speaker at a time. The row shares
 * its id with the thread. The `*Left` columns are the budget of the exchange under way; each message
 * of the person sets them again, so bots talking among themselves always come to a stop.
 */
export const rooms = pgTable('rooms', {
  id: text('id')
    .primaryKey()
    .references(() => threads.id, { onDelete: 'cascade' }),
  /** Who answers a message that names no one: every member in turn, or nobody. */
  responders: text('responders', { enum: ['everyone', 'mentions'] })
    .notNull()
    .default('everyone'),
  /** Rounds the bots go on talking among themselves after answering the person. */
  rounds: integer('rounds').notNull().default(0),
  roundsLeft: integer('rounds_left').notNull().default(0),
  /** Whether anyone said something in the round under way; a silent round ends the discussion. */
  roundSpoke: boolean('round_spoke').notNull().default(false),
  /** Turns bots may still start for one another (mentions and rounds) in this exchange. */
  botTurnsLeft: integer('bot_turns_left').notNull().default(0),
  /** Whether a talk after a pause is asked about, always kept as a meeting, or never. */
  minutes: text('minutes', { enum: ['ask', 'always', 'never'] })
    .notNull()
    .default('ask'),
  createdAt: created(),
});

/**
 * A meeting held in a room. Its lines are the room's messages from `fromAt` to `toAt`; the times
 * are compared in the database, which keeps the microseconds a Date loses. Once its minutes are
 * approved, the bots chosen get a note of what concerns them.
 */
export const meetings = pgTable(
  'meetings',
  {
    id: text('id').primaryKey(),
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    status: text('status', {
      enum: ['asked', 'active', 'writing', 'draft', 'saved', 'declined', 'failed'],
    }).notNull(),
    fromAt: ts('from_at').notNull(),
    /** Where its lines end; null while it goes on. */
    toAt: ts('to_at'),
    /** The minutes as written, then as the person approved them. */
    minutes: sealedJson('minutes'),
    error: text('error'),
    /** The bots that were told, and whether each note waits for the bot's owner. */
    sentTo: jsonb('sent_to').$type<{ botId: string; waiting: boolean }[]>().notNull().default([]),
    /** The reminders set for its tasks: follow-ups on a task's day (routines, for older meetings). */
    reminders: sealedJson('reminders')
      .$type<
        { followUpId?: string; routineId?: string; botId: string; task: string; date: string; time: string }[]
      >()
      .notNull()
      .default([]),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('meetings_room_idx').on(t.roomId, t.createdAt)],
);

export const roomMembers = pgTable(
  'room_members',
  {
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    /** Speaking order. */
    position: integer('position').notNull().default(0),
    /** Each member keeps its own engine session in the room. */
    engineSessionId: text('engine_session_id'),
    /** What that session had cost by its last run; the next run's cost is what it adds. */
    engineSessionCostUsd: doublePrecision('engine_session_cost_usd'),
    /** Time of the last room message this member has been shown; later ones are new to it. */
    seenAt: ts('seen_at'),
    createdAt: created(),
  },
  (t) => [uniqueIndex('room_members_uq').on(t.roomId, t.botId)],
);

/**
 * The people in a room besides the one who opened it (`threads.userId`), who manages it with the
 * admins among them. Once a room has anyone here, its bots use only what the team shares, never
 * one person's own apps, notes or sign-ins, since everyone in the room reads their answers.
 */
export const roomPeople = pgTable(
  'room_people',
  {
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Who put them in, told to them in the app; null when not known. */
    addedBy: text('added_by'),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.userId] }), index('room_people_user_idx').on(t.userId)],
);

/** One step of a turn as it is kept: the tool's short name, what it did, and what it was given. */
export interface TurnStep {
  tool: string;
  step: string;
  detail?: string;
}

export const turns = pgTable(
  'turns',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    // `reaction`: the person left an emoji on a bot message and the bot is told of it.
    // `ticket`: work on a ticket of the board, started by its assignment or a comment on it.
    // `upkeep`: the server's own work on a conversation (folding it while idle), kept for its cost;
    // it is written once done and never queued.
    // `followup`: a reminder the bot set itself came due (see `followUps`).
    source: text('source', {
      enum: ['user', 'reaction', 'routine', 'bot', 'ticket', 'upkeep', 'followup'],
    }).notNull(),
    /** The person the turn works for: who wrote, or whose request a bot passed on; null when nobody asked. */
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    status: text('status', {
      enum: ['queued', 'running', 'done', 'error', 'interrupted'],
    }).notNull(),
    prompt: sealedText('prompt').notNull(),
    jobId: text('job_id'),
    routineRunId: text('routine_run_id'),
    /**
     * The turn let through a step that is not a read, the app's own tools included: running it again
     * from the start would repeat what it did. Kept so that this is known after a server stop too.
     */
    changed: boolean('changed').notNull().default(false),
    /** The rehearsal this turn is: its steps that change something are recorded, not done. */
    rehearsalId: text('rehearsal_id'),
    error: text('error'),
    costUsd: real('cost_usd'),
    /** The engine and model the turn ran on, for the usage report; null until it starts. */
    engine: text('engine', { enum: ['claude', 'pi', 'acp'] }),
    model: text('model'),
    /**
     * Outside text the turn read, or was handed by the turn that started it (another bot's request
     * or answer, a room member naming it); null for none. Unattended, it changes nothing without
     * a card from then on.
     */
    outside: text('outside', { enum: OUTSIDE_TRIGGERS }),
    /**
     * The freest level the turn may act at, when a stricter bot started it (a room member naming
     * a bot allowed more than itself); null for the bot's own level.
     */
    modeCap: text('mode_cap', { enum: ['ask', 'review', 'auto', 'readonly'] }),
    /**
     * Asked by someone with no account here (a member of a Discord server): the turn may do no
     * more with its bot than talk with it, and the person's "always allow" rules do not count.
     */
    guest: boolean('guest').notNull().default(false),
    /**
     * The steps the bot took, in order: the tool and a short line of what it did, secrets taken
     * out. Read later to see how a bot goes about a kind of task (the skill suggestions); null for
     * a turn that took none, or ran before steps were kept.
     */
    steps: sealedJson('steps').$type<TurnStep[]>(),
    createdAt: created(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    index('turns_status_idx').on(t.status, t.createdAt),
    uniqueIndex('turns_one_running_uq')
      .on(t.threadId)
      .where(sql`${t.status} = 'running'`),
  ],
);

export const approvals = pgTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    turnId: text('turn_id'),
    /** The person who answered the card, when a person did. */
    decidedByUserId: text('decided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    kind: text('kind', { enum: ['tool', 'question', 'login'] }).notNull(),
    toolName: text('tool_name').notNull(),
    summary: sealedText('summary').notNull().default(''),
    input: sealedJson('input').$type<Record<string, unknown>>().notNull().default({}),
    options: jsonb('options').$type<string[]>().notNull().default([]),
    status: text('status', { enum: ['pending', 'allowed', 'denied', 'expired'] }).notNull(),
    answer: text('answer'),
    remembered: boolean('remembered').notNull().default(false),
    /** Asked in a run outside text started: "always allow" is not taken from it. */
    outside: boolean('outside').notNull().default(false),
    /**
     * Who closed the card: the person pressing a button, a rule they made on another card, or
     * their message in the chat in place of an answer. Null on cards from before it was kept.
     */
    decidedBy: text('decided_by', { enum: ['person', 'rule', 'typed'] }),
    /**
     * A manager bot that gave the answer for the person, in their words (`cards_answer`); null when
     * the person answered on the card itself.
     */
    answeredViaBotId: text('answered_via_bot_id').references(() => bots.id, { onDelete: 'set null' }),
    /**
     * An "always ask" rule asked for a second person's yes: the step runs only after two different
     * people allowed it. `secondUserId` is the one the rule named (anyone who may change the bot
     * when null), kept as the rule had it when the card was made.
     */
    needsSecond: boolean('needs_second').notNull().default(false),
    secondUserId: text('second_user_id'),
    /** The first yes of such a card: who gave it and when. The card stays pending until the second. */
    firstByUserId: text('first_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    firstAt: ts('first_at'),
    createdAt: created(),
    decidedAt: ts('decided_at'),
  },
  (t) => [index('approvals_status_idx').on(t.status)],
);

/**
 * A step that changes something which a bot was let through, and what let it: the person on a
 * card, a rule, the bot's level, or the reviewer. Reads are not kept.
 */
export const botActions = pgTable(
  'bot_actions',
  {
    id: text('id').primaryKey(),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').references(() => threads.id, { onDelete: 'set null' }),
    turnId: text('turn_id'),
    toolName: text('tool_name').notNull(),
    summary: sealedText('summary').notNull().default(''),
    how: text('how', { enum: ['card', 'rule', 'level', 'review'] }).notNull(),
    /** The rule that let it through, when one did. */
    rule: text('rule'),
    approvalId: text('approval_id'),
    /** The people whose yes on a card let it through: two for a step that needed a second person. */
    approvedBy: jsonb('approved_by').$type<string[]>().notNull().default([]),
    /** Taken in a run outside text started. */
    outside: boolean('outside').notNull().default(false),
    createdAt: created(),
  },
  (t) => [index('bot_actions_bot_idx').on(t.botId, t.createdAt)],
);

export const permissionRules = pgTable('permission_rules', {
  id: text('id').primaryKey(),
  list: text('list', { enum: ['ask', 'allow', 'block'] }).notNull(),
  pattern: text('pattern').notNull(),
  note: text('note').notNull().default(''),
  /**
   * The one bot the rule is for; null for every bot. "Always allow" on a card keeps the step for
   * the bot that asked, since another bot's work is another matter.
   */
  botId: text('bot_id').references(() => bots.id, { onDelete: 'cascade' }),
  /**
   * An amount limit, set both or neither: the dotted path of a number in the call's input
   * (`amount`), and the line. An allow rule covers a call at or under it; an ask or block rule one
   * over it, or one whose amount cannot be read.
   */
  field: text('field'),
  limit: doublePrecision('limit_value'),
  /**
   * An ask rule's step runs only after two different people said yes. `secondUserId` names the
   * second one; without it, anyone but the first who may change the bot. Not a reference: a
   * person who is gone leaves a rule nobody can answer, so the step is refused, not loosened.
   */
  secondPerson: boolean('second_person').notNull().default(false),
  secondUserId: text('second_user_id'),
  /**
   * The one person the rule is for; null for everyone. A command allowed on someone's own computer
   * runs there only: the same bot on another person's computer still asks them.
   */
  userId: text('user_id'),
  createdAt: created(),
});

/**
 * A command a bot runs on a person's own computer, through the desktop app. The id is the job's
 * on that computer too, so its progress finds the row whichever connection carries it.
 */
export const personJobs = pgTable(
  'person_jobs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    /** The card in the conversation that shows it. */
    messageId: text('message_id'),
    /** The computer's name, as its desktop app gives it. */
    device: text('device').notNull(),
    command: sealedText('command').notNull(),
    cwd: text('cwd').notNull(),
    /** `refused` when the computer would not start it; `lost` when it never said how it ended. */
    status: text('status', { enum: ['running', 'done', 'stopped', 'lost', 'refused'] })
      .notNull()
      .default('running'),
    exitCode: integer('exit_code'),
    /** The last of the output. */
    tail: sealedText('tail').notNull().default(''),
    /** Whether its bot is woken when it ends: the step that started it stopped waiting. */
    wake: boolean('wake').notNull().default(false),
    startedAt: ts('started_at').notNull().defaultNow(),
    endedAt: ts('ended_at'),
  },
  (t) => [index('person_jobs_user_idx').on(t.userId, t.status)],
);

export const memories = pgTable(
  'memories',
  {
    id: text('id').primaryKey(),
    // `room`: a note about a place (a chat app channel or a room), read by every bot that talks there
    // and by nobody anywhere else.
    scope: text('scope', { enum: ['bot', 'user', 'room', 'common'] }).notNull(),
    botId: text('bot_id').references(() => bots.id, { onDelete: 'cascade' }),
    /** For a note about the person, whose: each person's notes reach only bots working for them. */
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** For a room note, the place it belongs to: `slack:<channel>`, `discord:<channel>` or `room:<id>`. */
    place: text('place'),
    /** The person asked for this note to go into every prompt that reaches it, before the rest. */
    pinned: boolean('pinned').notNull().default(false),
    /**
     * A bot wrote it while outside text (a page, a mail, a command's output) was in its conversation,
     * so it may say what that text said rather than what is true. It reaches bots marked so, as
     * data; the person's own edit or a yes clears it.
     */
    unverified: boolean('unverified').notNull().default(false),
    content: sealedText('content').notNull(),
    /** A note on how a site works, given to the bot when it opens that site rather than every turn. */
    site: text('site'),
    source: text('source').notNull().default('user'),
    /**
     * When a bot last looked the note up: a search that found it, or the site it is about opened.
     * Being in the prompt does not count, or every note there would stay in use for good.
     */
    lastUsedAt: ts('last_used_at'),
    useCount: integer('use_count').notNull().default(0),
    /** The note's meaning as numbers, for search by meaning; null until it is indexed. */
    embedding: real('embedding').array(),
    /** Which model and words the embedding is of; a new model or a changed note indexes it again. */
    embeddingKey: text('embedding_key'),
    /** The conversation the bot wrote the note in last; it goes from the note when that does. */
    threadId: text('thread_id').references(() => threads.id, { onDelete: 'set null' }),
    /** The page the fact came from, as the bot gave it, so the person can check it. */
    sourceUrl: sealedText('source_url'),
    /**
     * Until when the note is true, for a fact that is only so for a while ("this week", "until
     * Friday"). From then on it goes into no prompt and no bot's search finds it; it stays here,
     * shown as expired, until the person deletes it or gives it a new date. Null: true until
     * someone says otherwise.
     */
    validUntil: ts('valid_until'),
    /** When the weekly tidy-up last read the page the note came from; null when it never did. */
    sourceCheckedAt: ts('source_checked_at'),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('memories_scope_idx').on(t.scope, t.botId),
    index('memories_user_idx').on(t.userId),
    index('memories_place_idx').on(t.place),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    before: sealedJson('before'),
    after: sealedJson('after'),
    /**
     * Whose the target was, for a memory note: `user:<id>` for a person's own, `bot:<id>` for a
     * bot's, `room:<place>` for a place's. Kept on the line, so a deleted note's history still goes only to those it was for.
     */
    owner: text('owner'),
    createdAt: created(),
  },
  (t) => [index('audit_target_idx').on(t.targetType, t.targetId)],
);

export const routines = pgTable('routines', {
  id: text('id').primaryKey(),
  botId: text('bot_id')
    .notNull()
    .references(() => bots.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  prompt: text('prompt').notNull(),
  /** What it does after its instruction, in order (`RoutineStep`); empty for one instruction. */
  steps: jsonb('steps').notNull().default([]),
  /** Where the flow view's boxes sit (`FlowLayout`); null places them in order. */
  flowLayout: jsonb('flow_layout'),
  flowNotes: jsonb('flow_notes').notNull().default([]),
  /** Values its instruction and steps write as {{name}}, with what a run takes by default. */
  inputs: jsonb('inputs').$type<Record<string, string>>().notNull().default({}),
  /** What must hold, with no AI, before a scheduled run starts (`RoutineCondition`); null for nothing. */
  condition: jsonb('condition'),
  schedule: jsonb('schedule').notNull(),
  timezone: text('timezone').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  nextRunAt: ts('next_run_at'),
  /**
   * The slot a retry was put in front of: once the retry has run, the schedule goes on from here,
   * so an interval routine keeps its rhythm instead of counting from the retry. Null when no retry
   * waits.
   */
  resumeAt: ts('resume_at'),
  lastRunAt: ts('last_run_at'),
  /**
   * When the person last opened the routine while its latest run had failed. A failure from before
   * it no longer marks the bot: runs a check skips leave no new result to clear it with.
   */
  failureSeenAt: ts('failure_seen_at'),
  /**
   * The person who set it up; its runs work for them. Null for routines from before people came
   * in, and for one whose person was removed: those work for the bot's owner.
   */
  createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: created(),
  /** Secret of the routine's webhook address; null when it has none. */
  webhookToken: text('webhook_token'),
  /**
   * The signing secret an app made for its calls (Stripe, Shopify, Linear, Sentry), pasted in by
   * the person; with it, a call must carry that app's valid signature. Never sent back to the app.
   */
  webhookSecret: text('webhook_secret'),
  /** A run that came due while the server was off: run it once when back, or skip it. */
  missed: text('missed', { enum: ['run', 'skip'] })
    .notNull()
    .default('run'),
  /** Each run gets the previous run's report, so recurring work builds on what came before. */
  carryReport: boolean('carry_report').notNull().default(false),
  /** Runs in the bot's main conversation, with its context, instead of a conversation of its own. */
  inMain: boolean('in_main').notNull().default(true),
  /**
   * The routine only looks and reports: every turn of its runs is held to reading (`modeCap` of
   * `readonly`), whatever the bot's own level is, so the person can let a bot watch something
   * without worrying what it might do. A step that would change something is refused, not asked.
   */
  reportOnly: boolean('report_only').notNull().default(false),
  /**
   * The Slack channel its reports go to; null for none. Such a routine runs in a team conversation:
   * what goes to a channel is written from what the team shares, never from one person's own data.
   */
  slackChannel: text('slack_channel'),
  /** The Slack reaction that runs the routine on the message its person reacts to; empty for none. */
  slackReaction: text('slack_reaction').notNull().default(''),
  /** Also runs once each time the server starts (the computer was turned on, the app opened). */
  onStartup: boolean('on_startup').notNull().default(false),
  /** A page checked before each scheduled run; the bot runs only when its text changed. */
  watchUrl: text('watch_url'),
  /** The fingerprint of the watched page's text when it was last read. */
  watchHash: text('watch_hash'),
  /** The watched page's text when it was last read, cut short, so a change can be shown as what changed. */
  watchText: text('watch_text'),
  /** A connected app's read-only tool called before each scheduled run (`RoutineCheck`); null for none. */
  check: jsonb('check'),
  /** The fingerprint of the check's answer when it was last called. */
  checkHash: text('check_hash'),
  /** Conditions a webhook call's JSON body must meet to start the routine; empty for none. */
  webhookFilter: text('webhook_filter').notNull().default(''),
  /** A webhook call only posts what it carries, as the bot's message, without running the bot. */
  webhookPost: boolean('webhook_post').notNull().default(false),
  /** The model its runs use, on the bot's own engine; empty for the bot's model. */
  model: text('model').notNull().default(''),
  /** Also runs when mail arrives at the bot's address. */
  emailTrigger: boolean('email_trigger').notNull().default(false),
  /** Conditions a mail must meet to start it (as the webhook filter, on from, to, subject, text). */
  emailFilter: text('email_filter').notNull().default(''),
  /** The WhatsApp group (`…@g.us`) whose new messages also start it; null for none. */
  whatsappGroup: text('whatsapp_group'),
  /** Also runs when someone writes to the linked WhatsApp account in a chat of their own. */
  whatsappPeople: boolean('whatsapp_people').notNull().default(false),
  /** The bot's table whose rows, filled in or changed by the routine's person, also start it; null for none. */
  tableTrigger: text('table_trigger').references(() => botTables.id, { onDelete: 'set null' }),
  /** Conditions a new row's cells must meet to start it (as the webhook filter, on column names). */
  tableFilter: text('table_filter').notNull().default(''),
  /**
   * The connection a run found signed out. Its scheduled runs are skipped while it stays signed
   * out, since each would only stop at the same sign-in card; the first run after the person signs
   * in again clears it. Null when nothing waits.
   */
  signInWait: text('sign_in_wait').references(() => connections.id, { onDelete: 'set null' }),
  /**
   * How many runs in a row have really failed (the run itself ended in error, or the bot said it
   * could not do its task). A run that did its work resets it; waits, skips, the person's stop, a
   * usage limit, a sign-in problem and a server restart leave it as it was. A counter beats
   * counting the last runs: those endings are told apart where they happen, not from the
   * run's stored reason text, which is in the person's language.
   */
  failureStreak: integer('failure_streak').notNull().default(0),
  /**
   * Why the routine was switched off by itself (`failures`: too many failed runs in a row;
   * `ended`: its last day went by); null when the person paused it, or when it is on. A routine
   * comes in paused from an import as well, and `enabled` alone cannot say which. Cleared when the
   * routine is turned on or off by hand.
   */
  pausedReason: text('paused_reason', { enum: ['failures', 'ended'] }),
  /**
   * The last day it may run (`YYYY-MM-DD` in `timezone`, that day included); null for no end. The
   * scheduler switches it off once the day is over, so no schedule or event starts it after.
   */
  endsOn: text('ends_on'),
});

export const routineRuns = pgTable(
  'routine_runs',
  {
    id: text('id').primaryKey(),
    routineId: text('routine_id')
      .notNull()
      .references(() => routines.id, { onDelete: 'cascade' }),
    occurrence: text('occurrence').notNull(),
    // `queued`: outside text that arrived while another run was going, kept until that one ends.
    // `paused`: a step waits for the person (or, later, for something to happen); no turn is
    // going, so it does not hold up the routine's other runs.
    status: text('status', {
      enum: ['running', 'done', 'error', 'stopped', 'skipped', 'waiting', 'queued', 'paused'],
    }).notNull(),
    reason: text('reason'),
    threadId: text('thread_id'),
    /** What a queued run carries in, kept until it starts. */
    payload: sealedText('payload'),
    /**
     * What started the run, as the bot was handed it (a mail, a webhook's body, what a page or an
     * app's answer changed, WhatsApp messages), cut short and kept as long as the run is, so a
     * rehearsal can replay it. Null for a run with nothing handed in, and for runs from before it
     * was kept.
     */
    triggerInput: sealedText('trigger_input'),
    promptSnapshot: text('prompt_snapshot').notNull(),
    /** The bot itself said the run could not do its task. */
    failedByBot: boolean('failed_by_bot').notNull().default(false),
    /** How many times the run went back to an earlier step, kept under `ROUTINE_BACK_MAX`. */
    backs: integer('backs').notNull().default(0),
    /**
     * How the run ended for the routine's health: `ok` did its work, `quiet` found nothing to
     * report, `failed` really failed. Null for every other ending (a wait, a skip, the person's
     * stop, a usage limit, a sign-in problem, a restart) and for runs from before it was kept.
     */
    outcome: text('outcome', { enum: ['ok', 'quiet', 'failed'] }),
    /** What the routine pre-check said before the run; null when none ran. */
    gateDecision: text('gate_decision', { enum: ['run', 'skip'] }),
    gateReason: text('gate_reason'),
    /** What the pre-check cost, as the engine reported it. */
    gateCostUsd: real('gate_cost_usd'),
    /**
     * For a run skipped because the one before was still going: how many slots in a row it stands
     * for. A run stuck for long leaves one line, not one per slot it held up.
     */
    busySkips: integer('busy_skips').notNull().default(0),
    /**
     * What outside text started the run (a mail, a webhook's body, a watched page or an app's new
     * answer); null for a scheduled or manual run. Such a run may change nothing without a card.
     */
    trigger: text('trigger', { enum: OUTSIDE_TRIGGERS }),
    /** Started by the routine's own schedule, not by hand, a mail, a webhook or the server's start. */
    scheduled: boolean('scheduled').notNull().default(false),
    /**
     * The routine's steps after its instruction as they were when the run started, so a routine
     * changed meanwhile does not change a run under way; null for a routine with none.
     */
    stepsSnapshot: jsonb('steps_snapshot'),
    /** The routine's version the run was started with; null for runs from before it was kept. */
    revisionId: text('revision_id').references((): AnyPgColumn => routineRevisions.id, {
      onDelete: 'set null',
    }),
    /** The model the step under way names; null for the routine's own. */
    stepModel: text('step_model'),
    /**
     * Values a bot step saved for a later step to wait on (an issue's number, a mail's subject), by
     * name; a wait step's filter names them as `{{name}}`.
     */
    vars: jsonb('vars').$type<Record<string, string>>().notNull().default({}),
    /**
     * The routine's inputs as this run was started with them: what the person typed or the
     * routine's defaults, kept apart from `vars`, which a step's output or the bot writes, so
     * only these are put into an instruction.
     */
    inputs: jsonb('inputs').$type<Record<string, string>>().notNull().default({}),
    startedAt: created(),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    uniqueIndex('routine_runs_occurrence_uq').on(t.routineId, t.occurrence),
    uniqueIndex('routine_runs_one_active_uq')
      .on(t.routineId)
      .where(sql`${t.status} in ('running', 'waiting')`),
  ],
);

/**
 * Each step of a run of a routine with steps, its own instruction at position 0. A step done again
 * (tried again after it failed) keeps its row.
 */
export const routineStepRuns = pgTable(
  'routine_step_runs',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => routineRuns.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    kind: text('kind').notNull(),
    status: text('status', {
      enum: ['running', 'done', 'error', 'stopped', 'skipped', 'waiting'],
    }).notNull(),
    /** What the step ended with: the bot's answer, or the person's. */
    output: sealedText('output'),
    reason: text('reason'),
    /** The bot's turn doing the step, while it is a bot's. */
    turnId: text('turn_id'),
    /** The card an approval step asks the person on. */
    approvalId: text('approval_id'),
    /** When a waiting step gives up, or, waiting for a time, goes on. */
    waitUntil: ts('wait_until'),
    /** The filter a step waiting for an event checks, with the run's values put in. */
    filter: text('filter'),
    /**
     * The event that ended a step's wait (a webhook delivery, a mail), kept so the same one sent
     * again does not start a run as well; what it carried is the step's output.
     */
    eventId: text('event_id'),
    startedAt: created(),
    finishedAt: ts('finished_at'),
  },
  (t) => [uniqueIndex('routine_step_runs_position_uq').on(t.runId, t.position)],
);

/**
 * Each instruction a routine has had, newest last: written when a routine is made and whenever its
 * instruction changes, so an earlier one can be compared and brought back. Bringing one back
 * writes it again as the newest, so the history only grows.
 */
export const routineRevisions = pgTable(
  'routine_revisions',
  {
    id: text('id').primaryKey(),
    routineId: text('routine_id')
      .notNull()
      .references(() => routines.id, { onDelete: 'cascade' }),
    prompt: text('prompt').notNull(),
    /**
     * Steps, model and condition are kept with the instruction from here on; false for a version
     * from before, whose other parts are unknown rather than empty.
     */
    full: boolean('full').notNull().default(false),
    steps: jsonb('steps'),
    model: text('model'),
    condition: jsonb('condition'),
    createdAt: created(),
  },
  (t) => [index('routine_revisions_routine_idx').on(t.routineId, t.createdAt)],
);

/**
 * The numbers a routine's number check read at its scheduled slots, one per slot, so a reading can
 * be compared with the average of the ones before it. `key` names the check by what it reads, so
 * changing where it reads starts its history afresh. Only the newest few are kept.
 */
export const routineReadings = pgTable(
  'routine_readings',
  {
    id: text('id').primaryKey(),
    routineId: text('routine_id')
      .notNull()
      .references(() => routines.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    occurrence: text('occurrence').notNull(),
    value: doublePrecision('value').notNull(),
    at: ts('at').notNull(),
  },
  (t) => [
    uniqueIndex('routine_readings_slot_uq').on(t.routineId, t.key, t.occurrence),
    index('routine_readings_routine_idx').on(t.routineId, t.key, t.at),
  ],
);

/** Bot-to-bot requests. A job chain shares `rootId`; `depth` guards against loops. */
export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    rootId: text('root_id').notNull(),
    depth: integer('depth').notNull(),
    // `notify`: the sender expects no answer; the target's reply is not passed back.
    kind: text('kind', { enum: ['send', 'ask', 'notify'] }).notNull(),
    fromBotId: text('from_bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    toBotId: text('to_bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    fromThreadId: text('from_thread_id').notNull(),
    /** The sender's turn that made the request; replies to one turn come back together. */
    fromTurnId: text('from_turn_id'),
    toThreadId: text('to_thread_id').notNull(),
    /** Server-side approval record carried with the request, if any. */
    approvalId: text('approval_id'),
    request: sealedText('request').notNull(),
    reply: sealedText('reply'),
    status: text('status', { enum: ['pending', 'done', 'error', 'stopped'] }).notNull(),
    createdAt: created(),
    finishedAt: ts('finished_at'),
    /** When the reply was handed to the sender; replies wait for the others of their turn. */
    deliveredAt: ts('delivered_at'),
    /**
     * Files the target handed back with its answer, as the sender finds them: copies in the
     * sender's conversation folder.
     */
    replyFiles: jsonb('reply_files').$type<string[]>().notNull().default([]),
  },
  (t) => [
    index('jobs_root_idx').on(t.rootId),
    index('jobs_to_idx').on(t.toThreadId, t.status),
    index('jobs_from_turn_idx').on(t.fromTurnId),
  ],
);

/** A password as stored: a scrypt hash with its salt and the cost it was made at. */
export interface PasswordHash {
  salt: string;
  hash: string;
  N: number;
  r: number;
  p: number;
}

/**
 * The people who sign in to this server. There is always exactly one owner, with the fixed id
 * `owner`: it stands for whoever installed the server, so a restore that brings back an older
 * owner row still matches the sessions this server keeps across a restore.
 */
export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    /** As the person typed it; null for an owner who has only ever used the access key. */
    username: text('username'),
    /** The username folded the way sign-in compares it (trimmed, lower case), for lookup and uniqueness. */
    usernameKey: text('username_key'),
    displayName: text('display_name'),
    role: text('role', { enum: ['owner', 'admin', 'member'] }).notNull(),
    password: jsonb('password').$type<PasswordHash>(),
    createdAt: created(),
    /**
     * What the person told about themselves, which the bots read when they work for them (name,
     * how to address them, about me), and whether they went through the first-run questions.
     */
    profile: jsonb('profile').$type<Record<string, unknown>>().notNull().default({}),
    /** Set when the person may no longer sign in; their sessions stop working. */
    disabledAt: ts('disabled_at'),
    /**
     * When those who look after the server chose the team spaces of someone new. Null while a
     * newcomer waits for it, which shows them a card; everyone there before spaces counts as placed.
     */
    placedAt: ts('placed_at'),
  },
  (t) => [
    uniqueIndex('users_username_key_uq').on(t.usernameKey),
    uniqueIndex('users_one_owner_uq')
      .on(t.role)
      .where(sql`${t.role} = 'owner'`),
  ],
);

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  /** Who signed in on this device. */
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  createdAt: created(),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  /** The browser or app that signed in, so the person can tell their devices apart. */
  userAgent: text('user_agent'),
});

/**
 * Which account at the account service is which person on this server. A browser that reaches the
 * server through the tunnel proves its account; this says who that is here. One account is one
 * person, and a person has at most one account.
 */
export const accountLinks = pgTable('account_links', {
  /** The account user's id at the account service (a ticket's `sub`). */
  accountUserId: text('account_user_id').primaryKey(),
  /**
   * The person here; null once they were removed on this server. The row stays so the account is
   * not made a new person on its next visit: removing someone here keeps them out until they are
   * let back in.
   */
  userId: text('user_id')
    .unique()
    .references(() => users.id, { onDelete: 'set null' }),
  createdAt: created(),
});

/**
 * Phones that want notifications while the app is closed. A device belongs to the session that
 * registered it: once that session ends, the device gets nothing more.
 */
export const pushDevices = pgTable('push_devices', {
  token: text('token').primaryKey(),
  platform: text('platform', { enum: ['ios'] }).notNull(),
  /** The registering session's id (a hash, like sessions.id); null when it came with the access key. */
  sessionId: text('session_id'),
  locale: text('locale').notNull(),
  level: text('level', { enum: ['all', 'needsYou', 'off'] }).notNull(),
  mutes: jsonb('mutes').$type<Record<string, number | null>>().notNull().default({}),
  /** Apple's test service answers for builds run from Xcode; learnt on the first send. */
  sandbox: boolean('sandbox'),
  /**
   * The bots unread on the phone, as it last said, plus those of notices sent since: the number on
   * the app's icon. Null for an app that keeps no such number; it is then sent none.
   */
  unread: jsonb('unread').$type<string[]>(),
  createdAt: created(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/**
 * The user's saved sign-ins. The password is encrypted with the vault key (see services/vault.ts);
 * bots never read it, the server types it into the matching site.
 */
export const vaultLogins = pgTable(
  'vault_logins',
  {
    id: text('id').primaryKey(),
    /** Whose sign-in it is: a person's own, typed only for them; null for the team's. */
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** Domain the sign-in belongs to, e.g. facebook.com; also used on its subdomains. */
    site: text('site').notNull(),
    username: text('username').notNull(),
    secret: text('secret').notNull(),
    /** The authenticator secret for two-step codes, sealed like the password; null when none. */
    totp: text('totp'),
    /** The bots that may use the sign-in; null lets every bot. */
    botIds: jsonb('bot_ids').$type<string[]>(),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    lastUsedAt: ts('last_used_at'),
  },
  // One sign-in per site and username for each person, and one for the team.
  (t) => [uniqueIndex('vault_logins_site_user_uq').on(t.site, t.username, sql`coalesce(${t.userId}, '')`)],
);

/**
 * A password manager the vault reads sign-ins from, besides its own. What it is signed in with (a
 * token, or an account's key and master password) is sealed bound to the row and the kind; the
 * sign-ins themselves stay in the manager and are read when a bot is about to use one.
 */
export const passwordManagers = pgTable(
  'password_managers',
  {
    id: text('id').primaryKey(),
    /** Whose it is: a person's own, read only for them; null for the team's. */
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** `onepassword`, `bitwarden` or `protonpass`. */
    kind: text('kind').notNull(),
    /** The vault or folder bots may read, by its name in the manager; empty for all it shows. */
    scope: text('scope').notNull().default(''),
    /** Where the account lives, for a manager that is not only on its maker's servers. */
    server: text('server'),
    secret: text('secret').notNull(),
    /** The bots that may use its sign-ins; null lets every bot. */
    botIds: jsonb('bot_ids').$type<string[]>(),
    /** Why reading it failed last, as a code (`PasswordManagerProblem`); null when it worked. */
    problem: text('problem'),
    /** How many sign-ins it gave the last time it was read. */
    count: integer('count'),
    readAt: ts('read_at'),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('password_managers_kind_user_uq').on(t.kind, sql`coalesce(${t.userId}, '')`)],
);

/**
 * Payment cards a bot may fill into a checkout page for the person they belong to. The number,
 * security code and name on the card are sealed together, bound to the row; so are the sites the
 * person agreed it may be used on, so no one who can only write to the database adds a site.
 */
export const paymentCards = pgTable('payment_cards', {
  id: text('id').primaryKey(),
  /** Whose it is; null for the team's, which only those who look after the server add. */
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  label: text('label').notNull().default(''),
  brand: text('brand').notNull(),
  last4: text('last4').notNull(),
  expMonth: integer('exp_month').notNull(),
  expYear: integer('exp_year').notNull(),
  /** Number, security code and name on the card, sealed bound to the row. */
  secret: text('secret').notNull(),
  /** Whether a security code is kept with it: shown without opening the sealed values. */
  hasCvc: boolean('has_cvc').notNull().default(false),
  /** The approved sites, sealed bound to the row; null before any. */
  sites: text('sites'),
  botIds: jsonb('bot_ids').$type<string[]>(),
  lastUsedAt: ts('last_used_at'),
  createdAt: created(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/**
 * Contact details (a name, an email, a phone, an address) a bot may fill into a form. Everything
 * but the label is sealed, bound to the row.
 */
export const contactDetails = pgTable('contact_details', {
  id: text('id').primaryKey(),
  /** Whose they are; null for the team's, which only those who look after the server add. */
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  label: text('label').notNull().default(''),
  secret: text('secret').notNull(),
  /** The approved sites, sealed bound to the row; null before any. */
  sites: text('sites'),
  botIds: jsonb('bot_ids').$type<string[]>(),
  lastUsedAt: ts('last_used_at'),
  createdAt: created(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const kv = pgTable('kv', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
});

/**
 * Remote MCP servers bots may use. `secrets` is sealed with the vault key (token, OAuth tokens and
 * client); `tools` is the server's tool list as last fetched, with the person's choices.
 */
export const connections = pgTable(
  'connections',
  {
    id: text('id').primaryKey(),
    /**
     * Whose it is: a person's own, used only when a bot works for them; null for the team's,
     * which those who look after the server set up for everyone.
     */
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    catalogId: text('catalog_id'),
    url: text('url').notNull(),
    auth: text('auth', { enum: ['oauth', 'token', 'none'] }).notNull(),
    status: text('status', { enum: ['connected', 'signed-out', 'error'] }).notNull(),
    error: text('error'),
    secrets: text('secrets'),
    tools: jsonb('tools').$type<StoredConnectionTool[]>().notNull().default([]),
    /** Open to every bot; when off, only the bots in bot_connections. */
    allBots: boolean('all_bots').notNull().default(true),
    /** A tool's own view (an MCP app) shows in the conversation when one is called. */
    showApps: boolean('show_apps').notNull().default(true),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('connections_slug_uq').on(t.slug)],
);

export interface StoredConnectionTool {
  name: string;
  title: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
  hinted: 'read' | 'write';
  /** The person's choice; null follows the hint. */
  kind: 'read' | 'write' | null;
  enabled: boolean;
  /** The tool's own view (`ui://…`), shown in the conversation when it is called. */
  ui?: string | null;
  /** Meant for its view alone: never given to a bot. */
  appOnly?: boolean;
  /**
   * A tool this server adds and runs itself, not one the connection's server listed. `gmailSend`
   * is how rows stored before the other Gmail tools came name it, until their next refresh.
   */
  local?: 'gmail' | 'gmailSend';
}

/** Which bots may use a connection that is not open to every bot. */
export const botConnections = pgTable(
  'bot_connections',
  {
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    createdAt: created(),
  },
  (t) => [uniqueIndex('bot_connections_uq').on(t.botId, t.connectionId)],
);

/** OAuth sign-ins under way: the state sent to the service, and its PKCE verifier (sealed). */
export const connectionSignins = pgTable('connection_signins', {
  state: text('state').primaryKey(),
  connectionId: text('connection_id')
    .notNull()
    .references(() => connections.id, { onDelete: 'cascade' }),
  verifier: text('verifier').notNull(),
  redirectUrl: text('redirect_url').notNull(),
  createdAt: created(),
});

/** Written instructions for a kind of task; a bot reads one when its task calls for it. */
export const skills = pgTable(
  'skills',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    body: text('body').notNull().default(''),
    /** The steps a person showed in the browser, when the skill was taught; replayed without the model. */
    steps: jsonb('steps').$type<TaughtStep[]>(),
    /** The person who added it; they may change it as well as the admins. Null when a bot or an import did. */
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** How many times a bot read it for a task, so the library shows which methods carry the work. */
    uses: integer('uses').notNull().default(0),
    lastUsedAt: ts('last_used_at'),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('skills_name_uq').on(t.name)],
);

/**
 * A better way to do a skill's task, found by a bot working for someone who may not change the
 * skill: a skill reaches every bot that has it, so the change waits here until the skill's owner
 * (or an admin, for a skill nobody owns) reads it and accepts it.
 */
export const skillChanges = pgTable(
  'skill_changes',
  {
    id: text('id').primaryKey(),
    skillId: text('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    /** The skill's description and text as the bot would have them. */
    description: text('description').notNull(),
    body: text('body').notNull(),
    /** What the bot changed and why, in its own words. */
    reason: text('reason'),
    /** The bot that found it. */
    proposedBy: text('proposed_by')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    /** The person the bot worked for when it found it. */
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    threadId: text('thread_id'),
    createdAt: created(),
  },
  (t) => [index('skill_changes_skill_idx').on(t.skillId)],
);

/** Which bots have a skill turned on. */
export const botSkills = pgTable(
  'bot_skills',
  {
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    skillId: text('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    createdAt: created(),
  },
  (t) => [uniqueIndex('bot_skills_uq').on(t.botId, t.skillId)],
);

/**
 * A chat app the person talks to bots through. Telegram: one row per bot, with that bot's own
 * Telegram bot (its token sealed with the vault key) and the one Telegram account paired with it.
 * WhatsApp: a single row for the linked number; `botId` is the bot its messages go to now.
 * Slack: a single row for the server's Slack app (its two tokens sealed together); `botId` is the
 * bot that answers when a message names none. Discord: a single row for the server's Discord bot
 * (its token sealed); `botId` is the bot that answers there, `settings.roles` who may use it.
 */
export const channels = pgTable(
  'channels',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['telegram', 'whatsapp', 'slack', 'discord', 'teams'] }).notNull(),
    botId: text('bot_id').references(() => bots.id, { onDelete: 'set null' }),
    /** Telegram: the bot token, sealed. */
    secret: text('secret'),
    /** What the chat app says about the account the server uses (Telegram bot name, linked number). */
    account: jsonb('account').$type<Record<string, unknown>>().notNull().default({}),
    /** The person here it was set up by; what comes in through it is written as theirs. */
    userId: text('user_id')
      .notNull()
      .default('owner')
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The person's id in the chat app; nobody else's messages are read. Null until paired. */
    owner: text('owner'),
    ownerName: text('owner_name'),
    /** Telegram: the code the person sends with /start to pair; good until `pairUntil`. */
    pairCode: text('pair_code'),
    pairUntil: ts('pair_until'),
    /** Choices of the person (WhatsApp: own number or a separate bot number). */
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    /** Telegram: the next update to read. */
    cursor: text('cursor'),
    /** Why the connection stopped working, in the chat app's words; null while it works. */
    error: text('error'),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('channels_telegram_bot_uq')
      .on(t.botId)
      .where(sql`${t.kind} = 'telegram'`),
    uniqueIndex('channels_whatsapp_uq')
      .on(t.kind)
      .where(sql`${t.kind} = 'whatsapp'`),
    uniqueIndex('channels_slack_uq')
      .on(t.kind)
      .where(sql`${t.kind} = 'slack'`),
    uniqueIndex('channels_discord_uq')
      .on(t.kind)
      .where(sql`${t.kind} = 'discord'`),
    uniqueIndex('channels_teams_uq')
      .on(t.kind)
      .where(sql`${t.kind} = 'teams'`),
  ],
);

/**
 * A Slack account linked to a person here: what it writes runs as theirs, and nobody else's
 * requests are run. Linked with a code the person gets in the app and sends to the Slack app.
 */
export const slackPeople = pgTable(
  'slack_people',
  {
    slackUserId: text('slack_user_id').primaryKey(),
    teamId: text('team_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** How Slack names them, for the app to show. */
    name: text('name').notNull().default(''),
    /** Their direct-message channel with the Slack app, once they wrote there. */
    dmChannel: text('dm_channel'),
    /** The bot their direct messages go to, the last one they named. */
    botId: text('bot_id').references(() => bots.id, { onDelete: 'set null' }),
    createdAt: created(),
  },
  (t) => [uniqueIndex('slack_people_user_uq').on(t.userId)],
);

/**
 * A Teams account linked to a person here: what it writes runs as theirs, and nobody else's
 * messages are read. Linked with a code the person gets in the app and sends to the Teams bot.
 */
export const teamsPeople = pgTable(
  'teams_people',
  {
    /** The account's id in the bot's conversations (`from.id`). */
    teamsUserId: text('teams_user_id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** How Teams names them, for the app to show. */
    name: text('name').notNull().default(''),
    /** Where replies go: the service Teams named and their personal chat with the bot. */
    serviceUrl: text('service_url'),
    conversationId: text('conversation_id'),
    /** The bot their messages go to, the last one they named. */
    botId: text('bot_id').references(() => bots.id, { onDelete: 'set null' }),
    createdAt: created(),
  },
  (t) => [uniqueIndex('teams_people_user_uq').on(t.userId)],
);

/** Which Slack thread a team conversation is, so its replies and later lines find each other. */
export const slackThreads = pgTable(
  'slack_threads',
  {
    threadId: text('thread_id')
      .primaryKey()
      .references(() => threads.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    /** The Slack thread's first message. */
    threadTs: text('thread_ts').notNull(),
    createdAt: created(),
  },
  (t) => [uniqueIndex('slack_threads_uq').on(t.channel, t.threadTs)],
);

/**
 * A team conversation that a Discord reply chain is. The bot replies to the chain's first message
 * with every post, so a reply to any of its posts names that message, and the conversation.
 */
export const discordThreads = pgTable(
  'discord_threads',
  {
    threadId: text('thread_id')
      .primaryKey()
      .references(() => threads.id, { onDelete: 'cascade' }),
    serverId: text('server_id').notNull(),
    channel: text('channel').notNull(),
    /** The first message of the reply chain. */
    rootId: text('root_id').notNull(),
    createdAt: created(),
  },
  (t) => [uniqueIndex('discord_threads_uq').on(t.channel, t.rootId)],
);

/** Which message in a chat app is which message here, so an answer to one finds its place. */
export const channelMessages = pgTable(
  'channel_messages',
  {
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('channel_messages_uq').on(t.channelId, t.externalId),
    index('channel_messages_message_idx').on(t.messageId),
  ],
);

/**
 * A request from a chat app that the bot is still working on, with what the chat shows for it
 * (a "working" post, a reaction, where to reply). Kept here rather than in memory so that, when the
 * server stops in the middle, the next start can tell the person the request was cut short and
 * clear what was left showing.
 */
export const channelRequests = pgTable(
  'channel_requests',
  {
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    /** What each chat app needs to find its posts again; its own shape per app. */
    place: jsonb('place').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.threadId] })],
);

/** The linked WhatsApp device's keys, each sealed with the vault key. */
export const whatsappKeys = pgTable('whatsapp_keys', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/**
 * A WhatsApp chat a routine reads: a person who wrote to the linked account, or a followed group.
 * `batchedSeq` is the last stored message already handed to the routines, so a restart neither
 * loses nor repeats a batch; `threads` keeps each routine's own conversation for this chat, so one
 * customer's exchange never becomes the context of another's.
 */
export const whatsappChats = pgTable('whatsapp_chats', {
  jid: text('jid').primaryKey(),
  kind: text('kind', { enum: ['person', 'group'] }).notNull(),
  name: sealedText('name').notNull().default(''),
  /** The name the person saved for the contact in their phone book; it wins over the name the contact gave. */
  savedName: sealedText('saved_name').notNull().default(''),
  batchedSeq: bigint('batched_seq', { mode: 'number' }).notNull().default(0),
  /**
   * The end of a batch a busy routine did not take: the next hand-over offers that same batch
   * again, so the routines that did take it know it by its name and do not run it twice.
   */
  heldSeq: bigint('held_seq', { mode: 'number' }),
  threads: jsonb('threads').$type<Record<string, string>>().notNull().default({}),
  lastAt: timestamp('last_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Names the person saved for contacts in their phone book, by chat address. WhatsApp tells them
 * once, when the device is linked, and later only when one changes, so they are kept for chats that
 * start long after.
 */
export const whatsappSavedNames = pgTable('whatsapp_saved_names', {
  jid: text('jid').primaryKey(),
  name: sealedText('name').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Messages of the chats routines read, kept 30 days so a bot answering one sees what was said
 * before. Codes, passwords and sign-in links are never written here.
 */
export const whatsappMessages = pgTable(
  'whatsapp_messages',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    chat: text('chat')
      .notNull()
      .references(() => whatsappChats.jid, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    fromMe: boolean('from_me').notNull().default(false),
    /** Left out as a code, a password or a sign-in link: only a line saying so is kept. */
    hidden: boolean('hidden').notNull().default(false),
    writer: sealedText('writer').notNull().default(''),
    text: sealedText('text').notNull().default(''),
    /** A file that came with it, saved under this name in each following bot's folder. */
    file: jsonb('file').$type<{ name: string; size: number } | { failed: string }>(),
    /**
     * Waits for the chat to go quiet before it reaches the bot that wrote to the person, or the bot
     * the chat is given to; kept here so a restart in between does not lose it.
     */
    awaiting: boolean('awaiting').notNull().default(false),
    at: timestamp('at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('whatsapp_messages_chat_external_uq').on(t.chat, t.externalId),
    index('whatsapp_messages_at_idx').on(t.at),
  ],
);

/**
 * What a bot wants to send on WhatsApp (a reply in a chat, or a Status post), waiting for the
 * person's answer on its card. It is kept here, not in a run's memory, so the card still works
 * after a restart; nothing is sent until the card is answered "send".
 */
export const whatsappDrafts = pgTable('whatsapp_drafts', {
  id: text('id').primaryKey(),
  /** Its card; empty for a message a bot sent at once, which the person let go without one. */
  approvalId: text('approval_id').notNull(),
  botId: text('bot_id')
    .notNull()
    .references(() => bots.id, { onDelete: 'cascade' }),
  threadId: text('thread_id').notNull(),
  kind: text('kind', { enum: ['message', 'status'] }).notNull(),
  /** The chat it answers; null for a Status post. */
  chat: text('chat'),
  text: sealedText('text').notNull().default(''),
  /** A file in the bot's own folder that goes along. */
  file: text('file'),
  /** The card's option that means "send". */
  approve: text('approve').notNull(),
  status: text('status', { enum: ['pending', 'sent', 'dropped', 'failed'] })
    .notNull()
    .default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** When it went out: the card may be answered long after it was drafted. */
  sentAt: timestamp('sent_at', { withTimezone: true }),
});

/**
 * A memory change a bot asked for while nobody was watching (a routine, another bot's request):
 * it waits here until the person accepts or rejects it, so what a webhook call or a page the bot
 * read says cannot turn into memory every later turn trusts.
 */
export const memoryChanges = pgTable(
  'memory_changes',
  {
    id: text('id').primaryKey(),
    action: text('action', { enum: ['write', 'update', 'forget'] }).notNull(),
    /** The note an update or a forget is about; the change goes when the note does. */
    memoryId: text('memory_id').references(() => memories.id, { onDelete: 'cascade' }),
    scope: text('scope', { enum: ['bot', 'user', 'room', 'common'] }).notNull(),
    botId: text('bot_id').references(() => bots.id, { onDelete: 'cascade' }),
    /** For a room note, its place (see `memories.place`). */
    place: text('place'),
    site: text('site'),
    /** The note's words after the change (for a forget, the words that would go). */
    content: sealedText('content').notNull(),
    /** The note's words before an update. */
    before: sealedText('before'),
    /** The bot that asked for it. */
    proposedBy: text('proposed_by')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    /**
     * Why it waits: a routine's run, another bot's request, outside text read, or a person who may
     * talk with the bot but not change it; or a turn the person stopped (or that failed) after it
     * had changed memory: those changes were taken back and wait here instead; or the background
     * review of a conversation; with its name.
     */
    origin: jsonb('origin')
      .$type<{
        kind: 'routine' | 'bot' | 'outside' | 'person' | 'stopped' | 'review' | 'flag';
        name: string;
      }>()
      .notNull(),
    /**
     * The person the work was for. A change to their own notes is theirs to accept; one to a
     * bot's notes, for those who may change the bot.
     */
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    threadId: text('thread_id'),
    /** The page the bot said the fact came from; kept on the note once accepted. */
    sourceUrl: sealedText('source_url'),
    /** The date the bot said the fact is true until; kept on the note once accepted (see `memories.validUntil`). */
    validUntil: ts('valid_until'),
    createdAt: created(),
  },
  (t) => [index('memory_changes_created_idx').on(t.createdAt)],
);

/**
 * Something a bot found missing or wrong in what it knows, while it did not know the right answer
 * itself: a fact its notes lack, or a note or skill that disagrees with what it saw. It waits for
 * someone who knows (the person, a later conversation, the page it names) to settle it, so the gap
 * is filled once instead of being met again in every task.
 */
export const memoryFlags = pgTable(
  'memory_flags',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['missing', 'wrong'] }).notNull(),
    /** Whose it is, as a note's (see `memories.scope`): it is seen by those who would see that note. */
    scope: text('scope', { enum: ['bot', 'user', 'room'] }).notNull(),
    /** The bot that raised it. */
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    /** The person the bot worked for; their conversation is the only one the flag links to. */
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    place: text('place'),
    /** The note it says is wrong; the flag stays, without it, when the note goes. */
    memoryId: text('memory_id').references(() => memories.id, { onDelete: 'set null' }),
    /** The skill it says is wrong. */
    skillId: text('skill_id').references(() => skills.id, { onDelete: 'cascade' }),
    /** What the bot was looking for. */
    about: sealedText('about').notNull(),
    /** What it saw instead, for a note or skill that disagrees with it. */
    seen: sealedText('seen'),
    /** A page the bot says may hold the answer. */
    sourceUrl: sealedText('source_url'),
    /** Outside text the turn had read when it raised the flag: its words then are not the person's. */
    outside: text('outside', { enum: OUTSIDE_TRIGGERS }),
    threadId: text('thread_id'),
    turnId: text('turn_id'),
    /** How many times the same gap was raised: a gap met again and again comes first. */
    count: integer('count').notNull().default(1),
    /** The later turns that met the same gap: undoing one of them counts it once less. */
    againTurns: jsonb('again_turns').$type<string[]>().notNull().default([]),
    status: text('status', { enum: ['open', 'proposed', 'resolved', 'dismissed', 'expired'] })
      .notNull()
      .default('open'),
    /** The memory change a proposed flag waits on. */
    changeId: text('change_id'),
    /** When its page was read; a flag's page is read once. */
    checkedAt: ts('checked_at'),
    /** How it was settled: the words written, or what happened. */
    resolution: sealedText('resolution'),
    /** Who settled it: `user:<id>`, `review`, `source` or `note-changed`. */
    resolvedBy: text('resolved_by'),
    resolvedAt: ts('resolved_at'),
    createdAt: created(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  },
  (t) => [
    index('memory_flags_bot_idx').on(t.botId, t.status),
    index('memory_flags_memory_idx').on(t.memoryId),
    index('memory_flags_turn_idx').on(t.turnId),
  ],
);

/**
 * How far the memory review has read each conversation: the last message it looked at, so that
 * after a restart only what came later is read. The message's time is kept too, for when the
 * message itself was deleted since.
 */
export const memoryReviews = pgTable('memory_reviews', {
  threadId: text('thread_id')
    .primaryKey()
    .references(() => threads.id, { onDelete: 'cascade' }),
  messageId: text('message_id').notNull(),
  messageAt: ts('message_at').notNull(),
  reviewedAt: ts('reviewed_at').notNull().defaultNow(),
});

/**
 * Pages a bot made that anyone with the link may open without signing in. The token is the whole
 * secret of the link; deleting the row turns the link off. The page is read fresh on every visit,
 * so the link shows the file as the bot last wrote it.
 */
export const pageShares = pgTable(
  'page_shares',
  {
    token: text('token').primaryKey(),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    /** The page's path in the bot's library, as its card in the conversation holds it. */
    path: text('path').notNull(),
    name: text('name').notNull(),
    createdAt: created(),
  },
  (t) => [uniqueIndex('page_shares_page_uq').on(t.botId, t.path)],
);

/**
 * Pages a person saved as apps of their own: opened by name from the apps page, or from a launcher
 * on their computer, without finding the conversation the bot showed it in. The page is read from
 * the bot's folder each time, so the app is always the page as it is now.
 */
export const pageApps = pgTable(
  'page_apps',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    /** The page's path in the bot's library, as its card in the conversation holds it. */
    path: text('path').notNull(),
    name: text('name').notNull(),
    /** The conversation the page was shown in, for "Go to chat"; it may be gone since. */
    threadId: text('thread_id'),
    createdAt: created(),
  },
  (t) => [uniqueIndex('page_apps_page_uq').on(t.userId, t.botId, t.path)],
);

/**
 * What a bot's page keeps for itself (`leafbot.state`): each person's own, per page, so the same
 * page shows the same data in its conversation and as a saved app.
 */
export const pageState = pgTable(
  'page_state',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    /** The page's path in the bot's library. */
    path: text('path').notNull(),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    /** The value's size as JSON, for the page's limit. */
    size: integer('size').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.botId, t.path, t.key] })],
);

/**
 * API keys the person saved for bots to call a service with. The value is sealed with the vault
 * key; bots know a key only by its name, and the server adds it to requests for its origin alone.
 */
export const apiCredentials = pgTable(
  'api_credentials',
  {
    id: text('id').primaryKey(),
    /**
     * Whose key it is: a person's own, sent only for turns that work for them; null for the team's.
     * A person's own key outranks the team's under the same name.
     */
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** The reference name bots use, e.g. `github` or `weather_api`. */
    name: text('name').notNull(),
    /** The only origin the key is sent to, e.g. `https://api.example.com`. */
    origin: text('origin').notNull(),
    /** How the key goes with a request (`ApiAuth`). */
    auth: jsonb('auth').$type<Record<string, unknown>>().notNull(),
    label: text('label').notNull().default(''),
    secret: text('secret').notNull(),
    /** The bots that may use it; null lets every bot. */
    botIds: jsonb('bot_ids').$type<string[]>(),
    /**
     * A trap key: it holds no real secret and no real service answers at its origin. It is shown
     * to bots like any other key, and any use of it is a sign that something a bot read is
     * steering it. Always a person's own.
     */
    trap: boolean('trap').notNull().default(false),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    lastUsedAt: ts('last_used_at'),
  },
  // One key per name for each person, and one for the team.
  (t) => [uniqueIndex('api_credentials_name_user_uq').on(t.name, sql`coalesce(${t.userId}, '')`)],
);

/**
 * Addresses bots receive mail at, under the domain set in the settings. A name is never given to
 * another bot, even once its bot is gone: mail meant for the old one must not reach a new one.
 */
export const emailAddresses = pgTable('email_addresses', {
  /** The part before the @, lowercase. */
  name: text('name').primaryKey(),
  /** Null once its bot gave it up or was deleted; the name stays taken. */
  botId: text('bot_id').references(() => bots.id, { onDelete: 'set null' }),
  /**
   * Whether the bot may take sign-in codes from mail to this address and type them into the site
   * that sent them; off until a person allows it.
   */
  signInCodes: boolean('sign_in_codes').notNull().default(false),
  createdAt: created(),
});

/** Mail that arrived at a bot's address: its inbox, which the bot reads when it needs to. */
export const emails = pgTable(
  'emails',
  {
    id: text('id').primaryKey(),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    /** The address it came to. */
    to: text('to').notNull(),
    from: text('from').notNull(),
    fromName: text('from_name').notNull().default(''),
    subject: sealedText('subject').notNull().default(''),
    /** The mail's text: its plain part, or its HTML part reduced to text. */
    text: sealedText('text').notNull().default(''),
    /** The sender's Message-ID; the same mail delivered twice is kept once. */
    messageId: text('message_id'),
    /** Attached files, saved in the bot's own folder (`{ name, size, path }`). */
    attachments: jsonb('attachments')
      .$type<{ name: string; size: number; path: string }[]>()
      .notNull()
      .default([]),
    receivedAt: created(),
    readAt: ts('read_at'),
  },
  (t) => [
    index('emails_bot_idx').on(t.botId, t.receivedAt),
    uniqueIndex('emails_message_uq')
      .on(t.botId, t.messageId)
      .where(sql`${t.messageId} is not null`),
  ],
);

/**
 * OpenAPI documents bots may call operations of. The operations are read from the document when
 * it is added; calls go through the API key named here, to the document's server only.
 */
export const apiSources = pgTable(
  'api_sources',
  {
    id: text('id').primaryKey(),
    /** The reference name bots use, e.g. `weather`. */
    name: text('name').notNull(),
    title: text('title').notNull().default(''),
    specUrl: text('spec_url'),
    /** Where the operations are called: the document's server, or the person's own address. */
    baseUrl: text('base_url').notNull(),
    /** The saved API key's name; null for an API that needs none. */
    credential: text('credential'),
    operations: jsonb('operations').$type<Record<string, unknown>[]>().notNull().default([]),
    botIds: jsonb('bot_ids').$type<string[]>(),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('api_sources_name_uq').on(t.name)],
);

/**
 * The board: tickets the person and the bots both work from. A ticket assigned to a bot starts it
 * on the work in a conversation of its own; what the bot reports comes back as a comment.
 */
export const tickets = pgTable(
  'tickets',
  {
    id: text('id').primaryKey(),
    /** Shown as #12; grows by one with each ticket. */
    number: integer('number').notNull(),
    /** The person who opened it; null when a bot did. */
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    title: sealedText('title').notNull(),
    description: sealedText('description').notNull().default(''),
    status: text('status', { enum: ['todo', 'in_progress', 'in_review', 'blocked', 'done', 'wont_do'] })
      .notNull()
      .default('todo'),
    priority: text('priority', { enum: ['low', 'normal', 'high', 'urgent'] })
      .notNull()
      .default('normal'),
    assigneeBotId: text('assignee_bot_id').references(() => bots.id, { onDelete: 'set null' }),
    /** `user`, or `bot:<id>` for a ticket a bot made. */
    createdBy: text('created_by').notNull(),
    /** The conversation the assignee works on it in; made on its first assignment. */
    threadId: text('thread_id').references(() => threads.id, { onDelete: 'set null' }),
    /**
     * Where it stands among the tickets of its column, smallest first. A fraction, so a ticket
     * moved between two others takes a place between theirs without the rest moving.
     */
    position: doublePrecision('position').notNull().default(0),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('tickets_number_uq').on(t.number), index('tickets_status_idx').on(t.status)],
);

export const ticketComments = pgTable(
  'ticket_comments',
  {
    id: text('id').primaryKey(),
    ticketId: text('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    /** `user` or `bot:<id>`. */
    author: text('author').notNull(),
    text: sealedText('text').notNull(),
    createdAt: created(),
  },
  (t) => [index('ticket_comments_ticket_idx').on(t.ticketId, t.createdAt)],
);

/**
 * A bot's tables: records it keeps in rows and columns, which the person can read, correct and
 * export. A name is unique per bot, so a bot finds its table by the name it gave it.
 */
export const botTables = pgTable(
  'bot_tables',
  {
    id: text('id').primaryKey(),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** The columns in order, each with its type (`TableColumn`). */
    columns: jsonb('columns')
      .$type<{ name: string; type: 'text' | 'number' | 'date' | 'bool' | 'url' }[]>()
      .notNull(),
    /** How the table is laid out on screen (`TableView`); null for the grid. */
    view: jsonb('view').$type<{ kind: 'grid' | 'board' | 'gallery' | 'list'; group: string | null }>(),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('bot_tables_name_uq').on(t.botId, t.name)],
);

/**
 * Tables another bot is let into: it reads the rows, and with `write` changes them. Goes with the
 * table and with the bot let in.
 */
export const botTableShares = pgTable(
  'bot_table_shares',
  {
    tableId: text('table_id')
      .notNull()
      .references(() => botTables.id, { onDelete: 'cascade' }),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    write: boolean('write').notNull().default(false),
    /** The person who shared it. */
    grantedBy: text('granted_by'),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.tableId, t.botId] }), index('bot_table_shares_bot_idx').on(t.botId)],
);

export const botTableRows = pgTable(
  'bot_table_rows',
  {
    id: text('id').primaryKey(),
    tableId: text('table_id')
      .notNull()
      .references(() => botTables.id, { onDelete: 'cascade' }),
    /** The row's values by column name; sealed with the conversations when sealing is on. */
    values: sealedJson('values').$type<Record<string, string | number | boolean | null>>().notNull(),
    /**
     * The person who wrote every cell of the row in the app; null once a bot, someone else or
     * taking a turn back wrote any of it. A routine the row starts takes it as that person's own
     * words only while it is theirs alone.
     */
    writtenBy: text('written_by'),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('bot_table_rows_table_idx').on(t.tableId, t.createdAt)],
);

/**
 * Dashboards: pages known by name across the server, filled with tiles by any bot. `nameKey` is
 * the name in lower case, so two bots naming the same page in other letters land on one.
 */
export const dashboards = pgTable(
  'dashboards',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    nameKey: text('name_key').notNull(),
    /** The bot that started the page; who sees it while it has no tile. Null once that bot is gone. */
    createdByBotId: text('created_by_bot_id').references(() => bots.id, { onDelete: 'set null' }),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('dashboards_name_uq').on(t.nameKey)],
);

/**
 * A dashboard's tiles, each the bot's own: it reads that bot's table (`spec`) or holds a card the
 * bot wrote. A bot changes its tile by writing one of the same title again.
 */
export const dashboardTiles = pgTable(
  'dashboard_tiles',
  {
    id: text('id').primaryKey(),
    dashboardId: text('dashboard_id')
      .notNull()
      .references(() => dashboards.id, { onDelete: 'cascade' }),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    titleKey: text('title_key').notNull(),
    /** What the tile shows and which rows it reads (`TileSpec`). */
    spec: jsonb('spec').$type<Record<string, unknown>>().notNull(),
    /** The card a `card` tile holds; sealed as conversations are, since a bot may put anything in it. */
    card: sealedJson('card'),
    position: integer('position').notNull().default(0),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('dashboard_tiles_title_uq').on(t.dashboardId, t.botId, t.titleKey),
    index('dashboard_tiles_bot_idx').on(t.botId),
  ],
);

/**
 * Trip-wires that caught a bot being steered by text it read: the bot repeated its private
 * canary token, or touched a trap key. Kept until the person marks the alarm seen. Holds no
 * input of the call that tripped it, so the token itself is never stored.
 */
export const canaryAlarms = pgTable(
  'canary_alarms',
  {
    id: text('id').primaryKey(),
    /** Which wire: the prompt's private token, or a trap key. */
    wire: text('wire', { enum: ['prompt', 'key'] }).notNull(),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').references(() => threads.id, { onDelete: 'set null' }),
    turnId: text('turn_id'),
    /** Whose turn it was; the alarm is theirs. Null when no one's own (a team conversation). */
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** The tool that was refused, or `reply` for an answer that carried the token. */
    tool: text('tool').notNull(),
    /** For a trap key: its name. */
    keyName: text('key_name'),
    /** What the turn had read from outside before the trip, as people name it. */
    sources: sealedJson('sources').$type<string[]>().notNull().default([]),
    /** The bot's approval level before it was moved to Ask; null when it was not changed. */
    movedFrom: text('moved_from'),
    createdAt: created(),
    seenAt: ts('seen_at'),
  },
  (t) => [index('canary_alarms_open_idx').on(t.seenAt, t.createdAt)],
);

/**
 * What someone said they would do later, kept where it cannot be forgotten: a promise a bot made in
 * a reply ("I'll tell you tomorrow") or one the person made to someone else that a bot noticed.
 * Only the person it belongs to sees it, admins included. Due promises have a one-time routine
 * that does the bot's part or reminds the person; it is removed with the promise.
 */
/**
 * A reminder a bot keeps for itself: at `dueAt` it brings `text` up with the person, in its main
 * conversation with them. Not a routine: nobody is asked before one is set, it is no standing job
 * and it shows in no list of routines. Something coming up the bot read about (a visit, a deadline),
 * its own promise to look again, a person's promise or a meeting's task each become one. One set
 * from outside text (a mail) keeps that mark, so the turn it starts changes nothing without a card.
 */
export const followUps = pgTable(
  'follow_ups',
  {
    id: text('id').primaryKey(),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    /**
     * The person it is for: it comes up in the bot's main conversation with them. A follow-up is the
     * person's: the same thing learned by two bots is kept once, by the bot that learned it first.
     */
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The conversation it was set in; null when none (a meeting, a promise net). */
    threadId: text('thread_id').references(() => threads.id, { onDelete: 'set null' }),
    /** What to bring up, and what it came from (a mail's sender and subject, say), as the bot wrote it. */
    text: sealedText('text').notNull(),
    context: sealedText('context').notNull().default(''),
    /** When the thing itself happens, when there is such a moment (the visit, the deadline). */
    eventAt: ts('event_at'),
    /** Whether `eventAt` names a time of day, or only the day (kept as that day's start). */
    eventHasTime: boolean('event_has_time').notNull().default(false),
    /** When the bot brings it up. */
    dueAt: ts('due_at').notNull(),
    /** What set it: the bot itself, a person's promise or a meeting's task. */
    kind: text('kind', { enum: ['bot', 'promise', 'meeting'] })
      .notNull()
      .default('bot'),
    /** Outside text the turn that set it had read; the turn it starts reads it as read. */
    outside: text('outside', { enum: OUTSIDE_TRIGGERS }),
    status: text('status', { enum: ['open', 'fired', 'dropped'] })
      .notNull()
      .default('open'),
    /** The turn it started, once due. */
    turnId: text('turn_id'),
    createdAt: created(),
    firedAt: ts('fired_at'),
  },
  (t) => [
    index('follow_ups_due_idx').on(t.status, t.dueAt),
    index('follow_ups_user_idx').on(t.userId, t.status),
  ],
);

export const promises = pgTable(
  'promises',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').references(() => threads.id, { onDelete: 'set null' }),
    /** Who promised: the bot (to the person) or the person (to someone else). */
    madeBy: text('made_by', { enum: ['bot', 'person'] }).notNull(),
    text: sealedText('text').notNull(),
    /** For the person's own promise, who it was made to. */
    toWhom: sealedText('to_whom').notNull().default(''),
    /** When it falls due; a promise with only a day is due at the end of that day. */
    dueAt: ts('due_at'),
    /** Whether `dueAt` is a time of day the promise named, or only the end of a day. */
    dueHasTime: boolean('due_has_time').notNull().default(false),
    /** What it waits for instead of a time ("when the price drops"); empty when it has none. */
    condition: sealedText('condition').notNull().default(''),
    /** The one-time routine that kept it, for a promise set before follow-ups; null for the rest. */
    routineId: text('routine_id').references(() => routines.id, { onDelete: 'set null' }),
    /** The follow-up that brings it up when it falls due; null when none was set (no time). */
    followUpId: text('follow_up_id').references(() => followUps.id, { onDelete: 'set null' }),
    status: text('status', { enum: ['open', 'done', 'dropped'] })
      .notNull()
      .default('open'),
    createdAt: created(),
    closedAt: ts('closed_at'),
  },
  (t) => [index('promises_user_status_idx').on(t.userId, t.status)],
);

/**
 * One look of the promise safety net at a bot's reply: what the small-model call cost, and whether
 * it found a promise. It lets the usage page show the net's cost beside the routine pre-check's.
 */
export const promiseChecks = pgTable(
  'promise_checks',
  {
    id: text('id').primaryKey(),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    costUsd: real('cost_usd'),
    found: boolean('found').notNull().default(false),
    createdAt: created(),
  },
  (t) => [index('promise_checks_created_idx').on(t.createdAt)],
);

/**
 * A routine proposed to a person because they keep asking a bot for the same thing by hand. It is
 * written from the person's own messages, so only they see it, admins included. A dismissed one
 * stays, so the same request is never offered again.
 */
export const routineSuggestions = pgTable(
  'routine_suggestions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    name: sealedText('name').notNull(),
    instructions: sealedText('instructions').notNull(),
    /** The rhythm the requests had, in the person's time zone; null when they had none. */
    schedule: jsonb('schedule').$type<Schedule | null>(),
    timezone: text('timezone').notNull(),
    /** How many requests there were, and the local days (YYYY-MM-DD) they were made on. */
    requests: integer('requests').notNull(),
    days: jsonb('days').$type<string[]>().notNull(),
    /** Identifies the request, so a later pass finds the same group again. */
    fingerprint: text('fingerprint').notNull(),
    /** The words the group's requests share; what a later pass compares a new group with. */
    signature: sealedText('signature').notNull().default(''),
    status: text('status', { enum: ['open', 'accepted', 'dismissed'] })
      .notNull()
      .default('open'),
    routineId: text('routine_id').references(() => routines.id, { onDelete: 'set null' }),
    createdAt: created(),
    decidedAt: ts('decided_at'),
  },
  (t) => [
    index('routine_suggestions_user_status_idx').on(t.userId, t.status),
    uniqueIndex('routine_suggestions_fingerprint_uq').on(t.userId, t.botId, t.fingerprint),
  ],
);

/**
 * A skill offered to a person: a kind of multi-step task they asked a bot for again and again,
 * written up from how the bot did it and what the person corrected. Theirs alone; Today shows it.
 */
export const skillSuggestions = pgTable(
  'skill_suggestions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: sealedText('description').notNull(),
    body: sealedText('body').notNull(),
    /** How many requests there were, and the local days (YYYY-MM-DD) they were made on. */
    requests: integer('requests').notNull(),
    days: jsonb('days').$type<string[]>().notNull(),
    /** Identifies the kind of task, so a later pass finds the same group again. */
    fingerprint: text('fingerprint').notNull(),
    /** The words the group's requests share; what a later pass compares a new group with. */
    signature: sealedText('signature').notNull().default(''),
    status: text('status', { enum: ['open', 'accepted', 'dismissed'] })
      .notNull()
      .default('open'),
    skillId: text('skill_id').references(() => skills.id, { onDelete: 'set null' }),
    createdAt: created(),
    decidedAt: ts('decided_at'),
  },
  (t) => [
    index('skill_suggestions_user_status_idx').on(t.userId, t.status),
    uniqueIndex('skill_suggestions_fingerprint_uq').on(t.userId, t.botId, t.fingerprint),
  ],
);

/** One call the skill suggestions made to write a skill: what it cost and whether it wrote one. */
export const skillSuggestionChecks = pgTable(
  'skill_suggestion_checks',
  {
    id: text('id').primaryKey(),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    costUsd: real('cost_usd'),
    found: boolean('found').notNull().default(false),
    createdAt: created(),
  },
  (t) => [index('skill_suggestion_checks_created_idx').on(t.createdAt)],
);

/**
 * One call the memory tidy-up made: reading a set of notes, or a note against its page. What it
 * cost, and how many notes it changed.
 */
export const memoryTidyChecks = pgTable(
  'memory_tidy_checks',
  {
    id: text('id').primaryKey(),
    /** The bot whose model was asked. */
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['set', 'source'] }).notNull(),
    costUsd: real('cost_usd'),
    changed: integer('changed').notNull().default(0),
    createdAt: created(),
  },
  (t) => [index('memory_tidy_checks_created_idx').on(t.createdAt)],
);

/** The kinds of background call kept in `background_calls`. */
export const BACKGROUND_CALLS = [
  'memoryReview',
  'title',
  'minutes',
  'followUps',
  'review',
  'routineFix',
] as const;

/**
 * One call the server made to a bot's model in the background that has no table of its own: the
 * memory review of a conversation, a conversation's title, a meeting's minutes, the reading of a
 * turn for what is coming up (follow-ups), the reviewer's look at a card, a fix proposed for a
 * routine from its runs. What it cost, so it
 * shows on the usage page and counts toward the spending limits.
 */
export const backgroundCalls = pgTable(
  'background_calls',
  {
    id: text('id').primaryKey(),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: BACKGROUND_CALLS }).notNull(),
    costUsd: real('cost_usd'),
    createdAt: created(),
  },
  (t) => [index('background_calls_created_idx').on(t.createdAt)],
);

/** One look of the routine suggestions at a group of requests: what the small-model call cost. */
/** Each look the work offers took at a conversation after an answer: what it cost and whether it offered. */
export const workOfferChecks = pgTable(
  'work_offer_checks',
  {
    id: text('id').primaryKey(),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    costUsd: real('cost_usd'),
    found: boolean('found').notNull().default(false),
    createdAt: created(),
  },
  (t) => [index('work_offer_checks_created_idx').on(t.createdAt)],
);

export const routineSuggestionChecks = pgTable(
  'routine_suggestion_checks',
  {
    id: text('id').primaryKey(),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    costUsd: real('cost_usd'),
    found: boolean('found').notNull().default(false),
    createdAt: created(),
  },
  (t) => [index('routine_suggestion_checks_created_idx').on(t.createdAt)],
);

/**
 * What one turn changed in the bot's own world, with the state before each change, so the person
 * can take the whole turn back. A line is written only once the step went through. Kept for 30
 * days. It belongs to the person whose turn it was, admins included. Each line holds words and
 * file contents from conversations, so those are sealed with the rest.
 */
export const turnChanges = pgTable(
  'turn_changes',
  {
    id: text('id').primaryKey(),
    turnId: text('turn_id').notNull(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    /** Whose turn it was: only they may take it back. */
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', {
      enum: ['file', 'table_row', 'ticket', 'routine', 'skill', 'bot', 'memory'],
    }).notNull(),
    op: text('op', { enum: ['create', 'update', 'delete'] }).notNull(),
    /** The file's path, or the id of the row, ticket, routine, skill, bot or note. */
    targetId: text('target_id').notNull(),
    /** What the person sees in the list: a file name, a table and row, a routine's name. */
    label: sealedText('label').notNull().default(''),
    /** The bot the target belongs to, when it is another than the turn's (a manager's change). */
    scopeBotId: text('scope_bot_id'),
    /** The state before the change; null when the target did not exist. */
    before: sealedJson('before'),
    /** What the target looked like right after the turn, to tell a later change from this one. */
    after: sealedJson('after'),
    /** Size of what was kept, for the cap on one turn. */
    bytes: integer('bytes').notNull().default(0),
    /** Why the change cannot be put back, when it cannot: too large to keep, or words deleted on purpose. */
    reason: text('reason', { enum: ['tooBig', 'deleted'] }),
    createdAt: created(),
    /** When the turn was taken back, and what became of this line then. */
    undoneAt: ts('undone_at'),
    outcome: text('outcome', {
      enum: ['restored', 'later', 'needsOwner', 'notUndoable', 'failed'],
    }),
  },
  (t) => [
    index('turn_changes_turn_idx').on(t.turnId, t.createdAt),
    index('turn_changes_created_idx').on(t.createdAt),
  ],
);

/**
 * A routine tried once without doing anything: what the bot would have done is written down, what
 * only reads is done. It works in a conversation of its own (kind `rehearsal`). After a week the
 * words of both are let go, but the conversation's turns stay without their words, since money
 * spent stays spent in the usage page and the monthly limit. Only the person who asked sees it.
 */
export const routineRehearsals = pgTable(
  'routine_rehearsals',
  {
    id: text('id').primaryKey(),
    routineId: text('routine_id')
      .notNull()
      .references(() => routines.id, { onDelete: 'cascade' }),
    /** Who asked, and whom the rehearsal worked for. */
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').references(() => threads.id, { onDelete: 'cascade' }),
    turnId: text('turn_id'),
    /** The instruction was the one typed in the dialog, not the saved one. */
    draft: boolean('draft').notNull().default(false),
    /** The run whose input was replayed; null when none was. */
    replayRunId: text('replay_run_id'),
    /** Rehearsals started together on the routine's last real inputs share it; null for one alone. */
    batchId: text('batch_id'),
    /** The model it was asked to run on, when models are compared; null for the routine's own. */
    model: text('model'),
    /** The instruction as it was rehearsed. */
    prompt: sealedText('prompt').notNull(),
    status: text('status', { enum: ['running', 'done', 'error', 'stopped'] })
      .notNull()
      .default('running'),
    /** What the bot wrote at the end. */
    report: sealedText('report').notNull().default(''),
    /** Each step in order: one that only read and was done, or one that would have changed something. */
    steps: sealedJson('steps')
      .$type<{ kind: 'ran' | 'would'; tool: string; summary: string; at: string }[]>()
      .notNull()
      .default([]),
    error: sealedText('error'),
    costUsd: real('cost_usd'),
    startedAt: created(),
    finishedAt: ts('finished_at'),
    /** When its words were let go (the row, its conversation's turns and their cost stay, so usage still adds up). */
    prunedAt: ts('pruned_at'),
  },
  (t) => [index('routine_rehearsals_routine_idx').on(t.routineId, t.startedAt)],
);

/**
 * A finding of a routine's health a person set aside. It shows again only when the runs after
 * `dismissedAt` meet it once more, so setting it aside is not forever, and each person's own.
 */
export const routineHealthDismissals = pgTable(
  'routine_health_dismissals',
  {
    routineId: text('routine_id')
      .notNull()
      .references(() => routines.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    finding: text('finding').notNull(),
    dismissedAt: ts('dismissed_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.routineId, t.userId, t.finding] })],
);
