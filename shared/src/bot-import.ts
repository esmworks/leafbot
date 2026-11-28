import { z } from 'zod';
import { isValidTimeZone, ROUTINE_STEP_MAX, RoutineStep, Schedule } from './schedule';

/**
 * The bot import file (`leafbot-bot-import`, version 1). Another app produces it by following
 * `app/public/import/grok-bot-export.md`, so files written for version 1 must keep importing:
 * new fields have to be optional, and a field whose meaning changes needs version 2.
 *
 * Validation has two levels. What defines a bot (its id, name, description, instructions) and the
 * top-level shape must be right, or the file is refused with the path of the first bad field.
 * Everything else (avatars, routines, memories, group members, the left-out notes) is read item by
 * item on the server: a bad item is dropped or shortened and reported, since a model wrote the
 * file and one slip there should not cost the user every other bot.
 */
export const BOT_IMPORT_FORMAT = 'leafbot-bot-import';
/** The format's name in files written before the app was renamed; still read. */
export const OLD_BOT_IMPORT_FORMAT = 'yumakbot-bot-import';
export const BOT_IMPORT_VERSION = 1;
/** Upper bound on the file; fits fifty bots with full-size avatars. */
export const MAX_BOT_IMPORT_BYTES = 25 * 1024 * 1024;

export const BOT_IMPORT_LIMITS = {
  bots: 50,
  groups: 50,
  routinesPerBot: 32,
  memoriesPerBot: 50,
  skillsPerBot: 32,
  notImported: 200,
} as const;

/** Lowercase words joined by hyphens; how the file refers to its own bots. */
export const BotImportRef = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

/** Mirrors `RoutineCreate`, without the bot; `enabled` is only reported, never applied. */
export const BotImportRoutine = z.object({
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(20_000),
  /**
   * Its steps after the instruction. One of a kind this version does not know turns the routine
   * away: dropped, a step that waits for the person would let the next one go ahead unasked.
   */
  steps: z.array(RoutineStep).max(ROUTINE_STEP_MAX).default([]),
  schedule: Schedule,
  timezone: z.string().refine(isValidTimeZone, 'validation.timezone'),
  enabled: z.boolean().default(false),
  /** Only looks and reports; a file from before it existed has routines that act, as they did. */
  reportOnly: z.boolean().default(false),
  /** Its last day, so a routine set to end does not run on for ever once it is turned on here. */
  endsOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
});
export type BotImportRoutine = z.infer<typeof BotImportRoutine>;

/** Same bounds as a memory written in the app. */
export const BotImportMemory = z.string().trim().min(1).max(2000);

/** Mirrors `SkillCreate`, without the bots; the bot that lists it gets it on. */
export const BotImportSkill = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().min(1).max(1024),
  body: z.string().max(50_000).default(''),
});
export type BotImportSkill = z.infer<typeof BotImportSkill>;

/** A text cut to `max` characters instead of being refused for its length. */
const clipped = (max: number) =>
  z
    .string()
    .trim()
    .max(10_000)
    .transform((s) => s.slice(0, max).trimEnd());

/** A note about something the file does not carry; read leniently, item by item. */
export const BotImportNote = z.object({
  bot: z.unknown().optional(),
  what: clipped(200).pipe(z.string().min(1)),
  reason: clipped(500).default(''),
});

const BotImportBot = z.object({
  ref: BotImportRef,
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(500).default(''),
  instructions: z.string().trim().max(20_000).default(''),
  avatar: z.unknown().optional(),
  routines: z.array(z.unknown()).max(BOT_IMPORT_LIMITS.routinesPerBot).default([]),
  memories: z.array(z.unknown()).max(BOT_IMPORT_LIMITS.memoriesPerBot).default([]),
  /** Older files and other apps may leave it out. */
  skills: z.array(z.unknown()).max(BOT_IMPORT_LIMITS.skillsPerBot).default([]),
});

const BotImportGroup = z.object({
  name: clipped(60).pipe(z.string().min(1)),
  members: z.array(z.unknown()).min(1).max(BOT_IMPORT_LIMITS.bots),
});

export const BotImportFile = z
  .object({
    format: z.union([z.literal(BOT_IMPORT_FORMAT), z.literal(OLD_BOT_IMPORT_FORMAT)]),
    version: z.literal(BOT_IMPORT_VERSION),
    source: clipped(60).default(''),
    exportedAt: z.string().max(40).optional(),
    bots: z.array(BotImportBot).min(1).max(BOT_IMPORT_LIMITS.bots),
    groups: z.array(BotImportGroup).max(BOT_IMPORT_LIMITS.groups).default([]),
    notImported: z.array(z.unknown()).max(BOT_IMPORT_LIMITS.notImported).default([]),
  })
  .superRefine((file, ctx) => {
    const refs = file.bots.map((b) => b.ref);
    refs.forEach((ref, i) => {
      if (refs.indexOf(ref) !== i)
        ctx.addIssue({ code: 'custom', path: ['bots', i, 'ref'], message: 'duplicate' });
    });
  });
export type BotImportFile = z.infer<typeof BotImportFile>;

/** Why part of a bot was dropped: an app message key and the values it fills in. */
export interface BotImportWarning {
  key:
    | 'import.warn.avatar'
    | 'import.warn.routine'
    | 'import.warn.memory'
    | 'import.warn.skill'
    | 'import.warn.member'
    | 'import.warn.otherGroup';
  params: Record<string, string>;
}

/** The import as it will be (or was) saved; the app previews it before the person confirms. */
export interface BotImportPlan {
  source: string;
  bots: {
    ref: string;
    /** Final name, with a number added when it was already taken here. */
    name: string;
    nameInFile: string;
    description: string;
    instructions: string;
    hasAvatar: boolean;
    group: string | null;
    routines: {
      name: string;
      prompt: string;
      steps: RoutineStep[];
      schedule: Schedule;
      timezone: string;
      enabledInSource: boolean;
      reportOnly: boolean;
      endsOn: string | null;
    }[];
    memories: string[];
    /**
     * `existing`: a skill of that name is already here; the bot gets that one, unchanged, and
     * `body` is empty. `held`: the text hides something, so the skill is brought in but left off
     * for this bot until the person reads it.
     */
    skills: { name: string; description: string; body: string; existing: boolean; held: boolean }[];
  }[];
  groups: { name: string; members: string[] }[];
  notImported: { bot: string | null; what: string; reason: string }[];
  warnings: BotImportWarning[];
}

export interface BotImportResult {
  plan: BotImportPlan;
  botIds: string[];
}

/** The id in a Grok Bot share link: letters, digits, `_` and `-`. */
const GROK_TEMPLATE_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** The name a bot goes by in the Grok Bot marketplace address: letters, digits, `_` and `-`. */
const GROK_MARKETPLACE_SLUG = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * A Grok Bot link: a shared template, or a bot listed in the marketplace. The marketplace page
 * names the template it adds, so both lead to the same steps.
 */
export type GrokLink = { kind: 'template'; id: string } | { kind: 'marketplace'; slug: string };

/**
 * The Grok Bot link `input` names, or null. Takes the share page (`https://x.ai/bot/<id>`), the
 * address the share page hands to the app (`grokbot://app/v1/bot-template?id=<id>`) and the
 * marketplace page (`https://x.ai/bot/marketplace/bots/<name>`); anything else is refused so the
 * server only ever reads a page it builds from the id or name.
 */
export function parseGrokLink(input: string): GrokLink | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol === 'https:' && (url.hostname === 'x.ai' || url.hostname === 'www.x.ai')) {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'bot') return null;
    if (parts.length === 4 && parts[1] === 'marketplace' && parts[2] === 'bots') {
      return GROK_MARKETPLACE_SLUG.test(parts[3]!) ? { kind: 'marketplace', slug: parts[3]! } : null;
    }
    // `/bot/marketplace` is the marketplace's own page, not a template, though its name fits.
    if (parts.length === 2 && parts[1] !== 'marketplace' && GROK_TEMPLATE_ID.test(parts[1]!)) {
      return { kind: 'template', id: parts[1]! };
    }
  } else if (url.protocol === 'grokbot:') {
    // `grokbot://app/v1/bot-template`: the host is `app`, the rest is the path.
    const id =
      url.hostname === 'app' && url.pathname === '/v1/bot-template' ? url.searchParams.get('id') : null;
    if (id && GROK_TEMPLATE_ID.test(id)) return { kind: 'template', id };
  }
  return null;
}

/** The template id a Grok Bot share link names, or null; a marketplace link gives null. */
export function grokTemplateId(input: string): string | null {
  const link = parseGrokLink(input);
  return link?.kind === 'template' ? link.id : null;
}

/** The template id in a share page's own path (`/bot/<id>`), as the marketplace page links it. */
export function grokTemplatePathId(path: string): string | null {
  const m = /^\/bot\/([A-Za-z0-9_-]+)$/.exec(path);
  return m && m[1] !== 'marketplace' && GROK_TEMPLATE_ID.test(m[1]!) ? m[1]! : null;
}

/** The public page of a Grok Bot share link, built from its id. */
export const grokTemplatePage = (id: string) => `https://x.ai/bot/${id}`;

/** The marketplace page of a Grok Bot, built from its name there. */
export const grokMarketplacePage = (slug: string) => `https://x.ai/bot/marketplace/bots/${slug}`;

/** The page a Grok Bot link opens, where the bot is added to Grok Bot. */
export const grokLinkPage = (link: GrokLink) =>
  link.kind === 'template' ? grokTemplatePage(link.id) : grokMarketplacePage(link.slug);

/**
 * What a Grok Bot share page shows to anyone: the bot's name, who shared it, its description and
 * look. Its instructions, memory, skills and routines are only handed to the Grok Bot app, so the
 * import still goes through the file that app writes; this card names the bot to export.
 */
export interface GrokTemplateCard {
  /**
   * The page to add the bot in Grok Bot from is `grokLinkPage(link)`: the template's share page,
   * or the marketplace page when it did not name its template.
   */
  link: GrokLink;
  /** Null when the page could not be read; the steps still work with the link alone. */
  name: string | null;
  sharer: string | null;
  description: string | null;
}
