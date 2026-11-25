import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../context';
import { schema } from '../db';
import { translator, type T } from '../i18n';
import {
  DEFAULT_LOCALE,
  EFFORTS,
  isLocale,
  isValidTimeZone,
  LOCALES,
  MEMORY_REVIEW_STEPS,
  patchOf,
  PROFILE_FOCUS,
  PROFILE_HELP,
  ROUTINE_GATE_MODES,
  type Locale,
} from '@leafbot/shared';
import { OWNER_ID } from '../users';

/** The most turns the person may let run at the same time. */
export const MAX_TURNS_LIMIT = 10;

export const Settings = z.object({
  userName: z.string().max(80).default(''),
  /** How bots should address the person, e.g. a first name. */
  addressAs: z.string().max(60).default(''),
  occupation: z.string().max(200).default(''),
  focus: z.enum(PROFILE_FOCUS).optional(),
  helpWith: z.array(z.enum(PROFILE_HELP)).max(PROFILE_HELP.length).default([]),
  /** Free text from the person that every bot reads. */
  aboutMe: z.string().max(2000).default(''),
  /** The first-run questions were answered or skipped. */
  onboarded: z.boolean().default(false),
  /** Model for Claude bots that do not name one; empty leaves it to the server's default. */
  defaultModel: z.string().trim().max(100).default(''),
  /** Effort for Claude bots; empty leaves it to the model. */
  effort: z.union([z.enum(EFFORTS), z.literal('')]).default(''),
  /** The engine new bots start with: Claude, or another provider through Pi. */
  defaultEngine: z.enum(['claude', 'pi']).default('claude'),
  /** `provider/model` new Pi bots start with; empty until one is picked. */
  piModel: z
    .union([
      z.literal(''),
      z
        .string()
        .trim()
        .max(100)
        .regex(/^[a-z0-9._-]+\/\S+$/i),
    ])
    .default(''),
  /**
   * `provider/model` that carries a turn when the usage limit of the bot's own model is spent;
   * empty waits for the limit to lift.
   */
  backupModel: z
    .union([
      z.literal(''),
      z
        .string()
        .trim()
        .max(100)
        .regex(/^[a-z0-9._-]+\/\S+$/i),
    ])
    .default(''),
  /**
   * `provider/model` that makes pictures (a bot's `image_create`, an avatar from a description);
   * empty picks one from the saved keys, starting with the bot's own provider.
   */
  imageModel: z
    .union([
      z.literal(''),
      z
        .string()
        .trim()
        .max(100)
        .regex(/^[a-z0-9._-]+\/\S+$/i),
    ])
    .default(''),
  /**
   * The conversation size, in tokens, at which a Claude bot folds the older part into a summary; 0
   * leaves it to Claude for each model, which for a model of a million-token window is near the
   * million. Smaller folds sooner: turns stay quick and cheap, and fewer details stay word for word.
   */
  claudeCompactWindow: z.union([z.literal(0), z.number().int().min(100_000).max(1_000_000)]).default(200_000),
  timezone: z.string().refine(isValidTimeZone).default('Europe/Istanbul'),
  /**
   * The most the bots may spend in a calendar month, in US dollars, as the engines report it; 0 for
   * no limit. Turns wait for the next month once it is reached.
   */
  monthlyLimitUsd: z.number().min(0).max(1_000_000).default(0),
  /**
   * The most the bots may spend in one day of the server's time zone, in US dollars; 0 for no
   * limit. A day that runs away (a routine in a loop) stops there instead of eating the month.
   */
  dailyLimitUsd: z.number().min(0).max(1_000_000).default(0),
  /**
   * The small-model check before a routine run that a watched page or a webhook started: off,
   * watching only (it records what it would do), or on (it skips runs with nothing new).
   */
  routineGate: z.enum(ROUTINE_GATE_MODES).default('off'),
  /**
   * How many finished turns of a conversation pass between two looks back at it for lasting facts
   * to remember (the memory review); 0 is off.
   */
  memoryReviewEvery: z
    .number()
    .int()
    .refine((n) => (MEMORY_REVIEW_STEPS as readonly number[]).includes(n))
    .default(20),
  /**
   * The promise safety net: after a reply that sounds like a promise of later action ("I'll tell
   * you tomorrow") with no routine set, a small model is asked, and a promise with a time gets a
   * one-time routine. Off stops the extra call.
   */
  promiseKeeper: z.boolean().default(true),
  /**
   * Once a day, the person's own messages to bots of the last weeks are looked at for a request
   * made again and again, and Today offers to make it a routine. Off stops the looking and the
   * model call; each person has their own.
   */
  routineSuggestions: z.boolean().default(true),
  /**
   * Once a day, at the person's reminder time, what has gone wrong and waits on them (a routine that
   * keeps failing or stands still, a card left unanswered, a signed-out connection) is looked at with
   * no AI, and when something is new a bot tells them. Off stops the looking; each person has their own.
   */
  checkIns: z.boolean().default(true),
  /** The time of day, in the person's time zone, that a reminder of their own promise arrives. */
  promiseRemindAt: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'validation.time')
    .default('09:00'),
  /**
   * A long conversation is folded into a summary while it is idle, before it reaches the size where
   * the next message would wait for the fold. Off by default: after a pause the model reads the
   * whole conversation again without its cache, which costs.
   */
  idleCompact: z.boolean().default(false),
  /**
   * A conversation's title is written by the bot's model once its first answer is in, instead of
   * staying the first message's opening words.
   */
  modelTitles: z.boolean().default(true),
  /**
   * After a person's message is answered, the bot's model looks at the conversation once more and
   * may offer one piece of follow-up work it could take on, on a card the person accepts or turns
   * down. Off by default: each look is a model call, and most find nothing to offer.
   */
  workOffers: z.boolean().default(false),
  /**
   * How many turns may run at the same time across every bot; 0 leaves it to the server's
   * `LEAFBOT_MAX_TURNS`. Fewer at once spends more slowly; more gets more done together.
   */
  maxTurns: z.number().int().min(0).max(MAX_TURNS_LIMIT).default(0),
  /**
   * The bots' browsers reach the web through the person's own computer while its desktop app is
   * connected, so sites see that connection instead of the server's; otherwise from the server.
   */
  browserViaComputer: z.boolean().default(false),
  /**
   * The domain bots receive mail at (`bots.example.com`), when a relay hands its mail to this
   * server; empty when mail is off.
   */
  emailDomain: z
    .union([
      z.literal(''),
      z
        .string()
        .trim()
        .toLowerCase()
        .max(200)
        .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'validation.domain'),
    ])
    .default(''),
  /** Unset until someone picks one; the app then stores the language it opened in. */
  language: z.enum(LOCALES).optional(),
});
export type Settings = z.infer<typeof Settings>;

/** The language the server writes in: thread lines, bot prompts and tool texts. */
export async function serverLocale(ctx: Ctx): Promise<Locale> {
  const [row] = await ctx.db.select().from(schema.kv).where(eq(schema.kv.key, 'setting.language')).limit(1);
  return isLocale(row?.value) ? row.value : DEFAULT_LOCALE;
}

export async function serverTranslator(ctx: Ctx): Promise<T> {
  return translator(await serverLocale(ctx));
}

/** Settings each person has for themselves; the rest are the server's. */
export const PERSONAL_SETTINGS = [
  'userName',
  'addressAs',
  'occupation',
  'focus',
  'helpWith',
  'aboutMe',
  'onboarded',
  'promiseRemindAt',
  'routineSuggestions',
  'checkIns',
  // The language the app and the bots speak with the person.
  'language',
] as const satisfies readonly (keyof Settings)[];
export type Profile = Pick<Settings, (typeof PERSONAL_SETTINGS)[number]>;
const Profile = Settings.pick({
  userName: true,
  addressAs: true,
  occupation: true,
  focus: true,
  helpWith: true,
  aboutMe: true,
  onboarded: true,
  promiseRemindAt: true,
  routineSuggestions: true,
  checkIns: true,
  language: true,
});

/** Whether a setting is one each person has for themselves. */
export const isPersonal = (key: string) => (PERSONAL_SETTINGS as readonly string[]).includes(key);

export class SettingsService {
  constructor(private ctx: Ctx) {}

  /** What a person told about themselves; what does not parse reads as unset. */
  async profile(userId: string): Promise<Profile> {
    const [row] = await this.ctx.db
      .select({ profile: schema.users.profile })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    const obj: Record<string, unknown> = { ...(row?.profile ?? {}) };
    // What it helps with keeps the choices this version still offers.
    if (Array.isArray(obj.helpWith)) {
      obj.helpWith = obj.helpWith.filter((h) => (PROFILE_HELP as readonly unknown[]).includes(h));
    }
    for (const [key, field] of Object.entries(Profile.shape)) {
      if (key in obj && !(field as z.ZodType).safeParse(obj[key]).success) delete obj[key];
    }
    return Profile.parse(obj);
  }

  /**
   * The server's settings; with `userId`, with that person's own in place of the personal ones.
   * Without, the personal ones are the owner's from before people came in.
   */
  async all(userId?: string): Promise<Settings> {
    const server = await this.server();
    if (!userId) return server;
    // The owner's own, kept with the server's for what runs for nobody in particular, are not
    // another person's: only the language stands in until they choose their own.
    const base: Record<string, unknown> = { ...server };
    for (const key of PERSONAL_SETTINGS) if (key !== 'language') delete base[key];
    const own = await this.profile(userId);
    if (!own.userName && userId !== OWNER_ID) {
      // Until they say their name, they are called what they are called here.
      const [row] = await this.ctx.db
        .select({ displayName: schema.users.displayName, username: schema.users.username })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      own.userName = (row?.displayName || row?.username || '').slice(0, 80);
    }
    return Settings.parse({ ...base, ...own });
  }

  /**
   * The server's settings with no one's own in them, for a team conversation: its turns are not
   * any one person's, so no profile goes in; the server's language stands in.
   */
  async team(): Promise<Settings> {
    const base: Record<string, unknown> = { ...(await this.server()) };
    for (const key of PERSONAL_SETTINGS) if (key !== 'language') delete base[key];
    return Settings.parse(base);
  }

  private async server(): Promise<Settings> {
    const rows = await this.ctx.db.select().from(schema.kv);
    const obj: Record<string, unknown> = {};
    for (const r of rows) if (r.key.startsWith('setting.')) obj[r.key.slice(8)] = r.value;
    if (Array.isArray(obj.helpWith)) {
      obj.helpWith = obj.helpWith.filter((h) => (PROFILE_HELP as readonly unknown[]).includes(h));
    }
    // A stored value this version does not accept (an option that is no longer offered, a
    // longer text from another version) reads as unset instead of failing every request.
    for (const [key, field] of Object.entries(Settings.shape)) {
      if (key in obj && !(field as z.ZodType).safeParse(obj[key]).success) delete obj[key];
    }
    return Settings.parse(obj);
  }

  async get<K extends keyof Settings>(key: K): Promise<Settings[K] | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.kv)
      .where(eq(schema.kv.key, `setting.${key}`))
      .limit(1);
    return row ? (row.value as Settings[K]) : null;
  }

  locale(): Promise<Locale> {
    return serverLocale(this.ctx);
  }

  translator(): Promise<T> {
    return serverTranslator(this.ctx);
  }

  /** Saves settings: the personal ones for `userId`, the rest for the server. */
  async update(patch: Partial<Settings>, userId: string = OWNER_ID): Promise<Settings> {
    const valid = patchOf(Settings).parse(patch);
    const personal = Object.fromEntries(
      Object.entries(valid).filter(([k, v]) => isPersonal(k) && v !== undefined),
    );
    if (Object.keys(personal).length) {
      // Merged by the database in one write: two changes made at once both stay.
      await this.ctx.db
        .update(schema.users)
        .set({ profile: sql`${schema.users.profile} || ${JSON.stringify(personal)}::jsonb` })
        .where(eq(schema.users.id, userId));
    }
    for (const [k, v] of Object.entries(valid)) {
      // The owner's own are also the server's, for what runs for nobody in particular.
      if (v === undefined || (isPersonal(k) && userId !== OWNER_ID)) continue;
      await this.ctx.db
        .insert(schema.kv)
        .values({ key: `setting.${k}`, value: v })
        .onConflictDoUpdate({ target: schema.kv.key, set: { value: v } });
    }
    this.ctx.bus.refresh({ scope: 'info' });
    return this.all(userId);
  }
}
