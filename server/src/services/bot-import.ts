import {
  Avatar,
  DEFAULT_AVATAR,
  BOT_IMPORT_FORMAT,
  OLD_BOT_IMPORT_FORMAT,
  BOT_IMPORT_LIMITS,
  BotImportFile,
  BotImportMemory,
  BotImportNote,
  BotImportRef,
  BotImportRoutine,
  BotImportSkill,
  BOT_IMPORT_VERSION,
  newBotEngine,
  skillWarnings,
  type BotImportPlan,
  type BotImportResult,
  type BotImportWarning,
} from '@leafbot/shared';
import { and, asc, eq, inArray, isNull, max } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { HttpError, newId } from '../util';
import { readGrokChat, type GrokChatReason } from './grok-chat';
import { snapshotSteps } from './routine-steps';
import type { SettingsService } from './settings';

const NAME_MAX = 60;
/** Who made the records, in the memory history. */
const ACTOR = 'import';

/** The first bytes of each image type an avatar may be. */
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  webp: (b) =>
    b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

/**
 * One of the app's own objects, or a data URL whose bytes are the image type it names. An old shape,
 * from an export made before shapes were dropped, comes back as the round object.
 */
function validAvatar(value: unknown): string | null {
  const parsed = Avatar.safeParse(value);
  if (!parsed.success) return null;
  const avatar = parsed.data;
  if (avatar.startsWith('object:')) return avatar;
  const type = /^data:image\/(png|jpeg|webp);base64,/.exec(avatar)?.[1];
  if (!type) return null;
  const bytes = Buffer.from(avatar.slice(avatar.indexOf(',') + 1), 'base64');
  return MAGIC[type]!(bytes) ? avatar : null;
}

/** `name`, or `name (2)`, `name (3)`, … the first one not in `taken`, within the name limit. */
function freeName(name: string, taken: Set<string>): string {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : ` (${n})`;
    const candidate = name.slice(0, NAME_MAX - suffix.length).trimEnd() + suffix;
    if (!taken.has(candidate.toLowerCase())) {
      taken.add(candidate.toLowerCase());
      return candidate;
    }
  }
}

interface Prepared {
  plan: BotImportPlan;
  /** Each planned bot's checked avatar, in the plan's order. */
  avatars: (string | null)[];
  /** The skills to create, by name; the ones already here are linked instead. */
  newSkills: Map<string, BotImportSkill>;
}

/** A name the file can use to refer to a bot: lowercase words joined by hyphens. */
function refOf(name: string, taken: Set<string>): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/ı/g, 'i')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 56)
      .replace(/-+$/, '') || 'bot';
  for (let n = 1; ; n++) {
    const ref = n === 1 ? base : `${base}-${n}`;
    if (!taken.has(ref)) {
      taken.add(ref);
      return ref;
    }
  }
}

/**
 * Creates bots from an import file. The file was written by a model in another app, so it is
 * treated as untrusted input: nothing existing is changed, permissions, engine and folders are
 * decided here rather than read from it and routines are created disabled (the originals may
 * still be running elsewhere). Memories go straight into the bot's memory, as the instructions do:
 * the person read both in the preview and confirmed the import.
 */
export class BotImportService {
  constructor(
    private ctx: Ctx,
    private settings: SettingsService,
  ) {}

  /**
   * The bots as an import file, so they can move to another LeafBot or come back later: their
   * instructions, avatar, routines, own memories, skills and groups. Engine, model, permissions,
   * folders and conversations stay here; the file names them as left out.
   */
  async export(ids?: string[]): Promise<BotImportFile> {
    const db = this.ctx.db;
    const rows = await db
      .select()
      .from(schema.bots)
      .where(ids ? inArray(schema.bots.id, ids) : isNull(schema.bots.archivedAt))
      .orderBy(asc(schema.bots.position), asc(schema.bots.createdAt));
    const bots = rows.slice(0, BOT_IMPORT_LIMITS.bots);
    if (!bots.length) throw new HttpError(400, 'error.exportEmpty');
    const botIds = bots.map((b) => b.id);
    const routines = await db
      .select()
      .from(schema.routines)
      .where(inArray(schema.routines.botId, botIds))
      .orderBy(asc(schema.routines.createdAt));
    const memories = await db
      .select()
      .from(schema.memories)
      .where(inArray(schema.memories.botId, botIds))
      .orderBy(asc(schema.memories.createdAt));
    const links = await db.select().from(schema.botSkills).where(inArray(schema.botSkills.botId, botIds));
    const skills = await db.select().from(schema.skills).orderBy(asc(schema.skills.name));
    const groups = await db.select().from(schema.groups).orderBy(asc(schema.groups.position));
    const taken = new Set<string>();
    const refs = new Map(bots.map((b) => [b.id, refOf(b.name, taken)]));
    const notImported: { bot?: string; what: string; reason: string }[] = [];
    const t = await this.settings.translator();
    return {
      format: BOT_IMPORT_FORMAT,
      version: BOT_IMPORT_VERSION,
      source: 'LeafBot',
      exportedAt: new Date().toISOString(),
      bots: bots.map((b) => {
        const ref = refs.get(b.id)!;
        if (b.projectDir)
          notImported.push({ bot: ref, what: t('export.folder'), reason: t('export.folderWhy') });
        return {
          ref,
          name: b.name,
          description: b.description,
          instructions: b.instructions,
          avatar: b.avatar,
          routines: routines
            .filter((r) => r.botId === b.id)
            .slice(0, BOT_IMPORT_LIMITS.routinesPerBot)
            .map((r) => {
              const steps = snapshotSteps(r.steps) ?? [];
              return {
                name: r.name,
                prompt: r.prompt,
                ...(steps.length && { steps }),
                schedule: r.schedule,
                timezone: r.timezone,
                enabled: r.enabled,
                reportOnly: r.reportOnly,
              };
            }),
          memories: memories
            .filter((m) => m.botId === b.id && m.scope === 'bot' && !m.site)
            .slice(0, BOT_IMPORT_LIMITS.memoriesPerBot)
            .map((m) => m.content),
          skills: skills
            .filter((k) => links.some((l) => l.botId === b.id && l.skillId === k.id))
            .slice(0, BOT_IMPORT_LIMITS.skillsPerBot)
            .map((k) => ({ name: k.name, description: k.description, body: k.body })),
        };
      }),
      groups: groups
        .map((g) => ({
          name: g.name,
          members: bots.filter((b) => b.groupId === g.id).map((b) => refs.get(b.id)!),
        }))
        .filter((g) => g.members.length > 0),
      notImported: [
        ...notImported,
        { what: t('export.settings'), reason: t('export.settingsWhy') },
        { what: t('export.chats'), reason: t('export.chatsWhy') },
      ],
    };
  }

  /** What importing `raw` would make, without saving anything. */
  async preview(raw: unknown): Promise<BotImportPlan> {
    return (await this.prepare(raw)).plan;
  }

  /**
   * Saves everything the file holds at once; nothing is kept when any part fails. A manager bot's
   * plan sets whose the bots and routines are, starts them off the internet as a bot it creates
   * does, puts them in its section, and names the bots its card showed: one taken meanwhile would
   * be renamed, so nothing is saved instead.
   */
  async commit(
    raw: unknown,
    o: { owner?: string; internet?: boolean; groupId?: string | null; names?: string[] } = {},
  ): Promise<BotImportResult> {
    const { plan, avatars, newSkills } = await this.prepare(raw);
    if (o.names && plan.bots.map((b) => b.name).join('\n') !== o.names.join('\n'))
      throw new HttpError(409, 'error.botPlanChanged');
    const settings = await this.settings.all();
    const engine = newBotEngine(settings);
    const botIds = await this.ctx.db.transaction(async (tx) => {
      const [last] = await tx.select({ n: max(schema.bots.position) }).from(schema.bots);
      let position = (last?.n ?? -1) + 1;
      const [lastGroup] = await tx.select({ n: max(schema.groups.position) }).from(schema.groups);
      let groupPosition = (lastGroup?.n ?? -1) + 1;
      const groupIds = new Map<string, string>();
      for (const group of plan.groups) {
        const id = newId();
        await tx.insert(schema.groups).values({ id, name: group.name, position: groupPosition++ });
        groupIds.set(group.name, id);
      }
      const skillIds = new Map(
        (await tx.select({ id: schema.skills.id, name: schema.skills.name }).from(schema.skills)).map(
          (k) => [k.name, k.id] as const,
        ),
      );
      for (const [name, k] of newSkills) {
        const id = newId();
        await tx.insert(schema.skills).values({ id, name, description: k.description, body: k.body });
        skillIds.set(name, id);
      }
      const ids: string[] = [];
      for (const [i, bot] of plan.bots.entries()) {
        const id = newId();
        ids.push(id);
        await tx.insert(schema.bots).values({
          id,
          name: bot.name,
          description: bot.description,
          instructions: bot.instructions,
          ...engine,
          avatar: avatars[i] ?? DEFAULT_AVATAR,
          groupId: bot.group ? groupIds.get(bot.group)! : (o.groupId ?? null),
          ...(o.owner ? { ownerUserId: o.owner } : {}),
          position: position++,
          // Set here, never read from the file.
          isManager: false,
          pinned: false,
          // The level a bot the person creates starts at, whatever the file says.
          permissionMode: 'auto',
          // What every new bot starts with; the file cannot turn it off or on.
          internet: o.internet ?? true,
          projectDir: null,
          memory: true,
          effort: '',
        });
        for (const k of bot.skills) {
          // A new skill whose text hides something is brought in but left off until the person reads it.
          if (k.held) continue;
          await tx
            .insert(schema.botSkills)
            .values({ botId: id, skillId: skillIds.get(k.name)! })
            .onConflictDoNothing();
        }
        for (const r of bot.routines) {
          await tx.insert(schema.routines).values({
            id: newId(),
            botId: id,
            name: r.name,
            prompt: r.prompt,
            steps: r.steps,
            schedule: r.schedule,
            timezone: r.timezone,
            reportOnly: r.reportOnly,
            enabled: false,
            nextRunAt: null,
            ...(o.owner ? { createdByUserId: o.owner } : {}),
          });
        }
        for (const content of bot.memories) {
          const memoryId = newId();
          await tx.insert(schema.memories).values({
            id: memoryId,
            scope: 'bot',
            botId: id,
            content,
            source: ACTOR,
          });
          await tx.insert(schema.auditLog).values({
            id: newId(),
            actor: ACTOR,
            action: 'create',
            targetType: 'memory',
            targetId: memoryId,
            before: null,
            after: content,
          });
        }
      }
      return ids;
    });
    for (const scope of ['bots', 'groups', 'routines', 'memory', 'skills'] as const) {
      this.ctx.bus.refresh({ scope });
    }
    return { plan, botIds };
  }

  /**
   * A moved bot's recent chat from the Grok Bot app on this computer, as one new conversation of
   * the person's with the bot. It is a record only: nothing runs, replies, notifies or is learned
   * from it, and its messages keep their times in the app. Asked again, the conversation it made
   * is found and nothing is added. `name` is the bot's name in the app, before any renaming here.
   */
  async importGrokChat(o: {
    botId: string;
    name: string;
    userId: string;
    title: string;
    home: string;
  }): Promise<{ messages: number } | { reason: GrokChatReason }> {
    const earlier = await this.ctx.db
      .select({ id: schema.threads.id, title: schema.threads.title })
      .from(schema.threads)
      .where(
        and(
          eq(schema.threads.botId, o.botId),
          eq(schema.threads.userId, o.userId),
          eq(schema.threads.kind, 'user'),
        ),
      );
    for (const t of earlier.filter((t) => t.title === o.title)) {
      const kept = await this.ctx.db
        .select({ id: schema.messages.id })
        .from(schema.messages)
        .where(eq(schema.messages.threadId, t.id));
      if (kept.length) return { messages: kept.length };
    }
    const chat = readGrokChat(o.home, o.name);
    if ('reason' in chat) return chat;
    const threadId = newId();
    const last = chat.lines.at(-1)!.at;
    await this.ctx.db.transaction(async (tx) => {
      await tx.insert(schema.threads).values({
        id: threadId,
        botId: o.botId,
        userId: o.userId,
        kind: 'user',
        title: o.title,
        createdAt: chat.lines[0]!.at,
        updatedAt: last,
      });
      await tx.insert(schema.messages).values(
        chat.lines.map((line) => ({
          id: newId(),
          threadId,
          role: line.role,
          author: line.role === 'user' ? 'user' : `bot:${o.botId}`,
          userId: line.role === 'user' ? o.userId : null,
          text: line.text,
          props: {},
          clientId: `grok:${line.seq}`,
          createdAt: line.at,
        })),
      );
    });
    this.ctx.bus.refresh({ scope: 'threads', botId: o.botId });
    return { messages: chat.lines.length };
  }

  private async prepare(raw: unknown): Promise<Prepared> {
    const file = parseFile(raw);
    const warnings: BotImportWarning[] = [];
    const existing = await this.ctx.db.select({ name: schema.bots.name }).from(schema.bots);
    const takenBots = new Set(existing.map((b) => b.name.toLowerCase()));
    const existingGroups = await this.ctx.db.select({ name: schema.groups.name }).from(schema.groups);
    const takenGroups = new Set(existingGroups.map((g) => g.name.toLowerCase()));

    // A bot is in at most one group here; the first group chat that names it wins.
    const groupOf = new Map<string, string>();
    const known = new Set(file.bots.map((b) => b.ref));
    const groups: BotImportPlan['groups'] = [];
    for (const group of file.groups) {
      const name = freeName(group.name, takenGroups);
      const members: string[] = [];
      for (const member of group.members) {
        const ref = BotImportRef.safeParse(member);
        if (!ref.success || !known.has(ref.data)) {
          warnings.push({ key: 'import.warn.member', params: { group: group.name, ref: String(member) } });
        } else if (groupOf.has(ref.data)) {
          if (groupOf.get(ref.data) !== name && !members.includes(ref.data)) {
            warnings.push({ key: 'import.warn.otherGroup', params: { bot: ref.data, group: group.name } });
          }
        } else {
          groupOf.set(ref.data, name);
          members.push(ref.data);
        }
      }
      if (members.length) groups.push({ name, members });
      else takenGroups.delete(name.toLowerCase());
    }

    const avatars: (string | null)[] = [];
    const planned: BotImportPlan['bots'] = [];
    const here = new Set(
      (await this.ctx.db.select({ name: schema.skills.name }).from(schema.skills)).map((k) => k.name),
    );
    const newSkills = new Map<string, BotImportSkill>();
    for (const bot of file.bots) {
      const name = freeName(bot.name, takenBots);
      const avatar = bot.avatar == null ? null : validAvatar(bot.avatar);
      if (bot.avatar != null && !avatar) warnings.push({ key: 'import.warn.avatar', params: { bot: name } });
      const routines: BotImportPlan['bots'][number]['routines'] = [];
      for (const item of bot.routines) {
        const r = BotImportRoutine.safeParse(item);
        if (!r.success) {
          const label = (item as { name?: unknown } | null)?.name;
          warnings.push({
            key: 'import.warn.routine',
            params: { bot: name, routine: typeof label === 'string' ? label.slice(0, 80) : '?' },
          });
          continue;
        }
        routines.push({
          name: r.data.name,
          prompt: r.data.prompt,
          steps: r.data.steps,
          schedule: r.data.schedule,
          timezone: r.data.timezone,
          enabledInSource: r.data.enabled,
          reportOnly: r.data.reportOnly,
        });
      }
      const memories: string[] = [];
      let skipped = 0;
      for (const item of bot.memories) {
        const m = BotImportMemory.safeParse(item);
        if (m.success) memories.push(m.data);
        else skipped++;
      }
      if (skipped)
        warnings.push({ key: 'import.warn.memory', params: { bot: name, count: String(skipped) } });
      const skills: BotImportPlan['bots'][number]['skills'] = [];
      for (const item of bot.skills) {
        const k = BotImportSkill.safeParse(item);
        if (!k.success) {
          const label = (item as { name?: unknown } | null)?.name;
          warnings.push({
            key: 'import.warn.skill',
            params: { bot: name, skill: typeof label === 'string' ? label.slice(0, 64) : '?' },
          });
          continue;
        }
        if (skills.some((s) => s.name === k.data.name)) continue;
        const existing = here.has(k.data.name);
        if (!existing && !newSkills.has(k.data.name)) newSkills.set(k.data.name, k.data);
        // Two bots naming one skill share the first copy, so that is the one shown and checked.
        const made = newSkills.get(k.data.name);
        skills.push({
          name: k.data.name,
          description: made?.description ?? k.data.description,
          body: made?.body ?? '',
          existing,
          held: !!made && skillWarnings(`${made.description}\n${made.body}`).length > 0,
        });
      }
      avatars.push(avatar);
      planned.push({
        ref: bot.ref,
        name,
        nameInFile: bot.name,
        description: bot.description,
        instructions: bot.instructions,
        hasAvatar: !!avatar,
        group: groupOf.get(bot.ref) ?? null,
        routines,
        memories,
        skills,
      });
    }
    return {
      plan: {
        source: file.source,
        bots: planned,
        groups,
        notImported: notes(file.notImported, known),
        warnings,
      },
      avatars,
      newSkills,
    };
  }
}

/** The readable notes; one naming an unknown bot is kept without the bot. */
function notes(items: unknown[], known: Set<string>): BotImportPlan['notImported'] {
  return items.flatMap((item) => {
    const note = BotImportNote.safeParse(item);
    if (!note.success) return [];
    const bot = typeof note.data.bot === 'string' && known.has(note.data.bot) ? note.data.bot : null;
    return [{ bot, what: note.data.what, reason: note.data.reason }];
  });
}

/** The file's structure, or an error that names the first field that is wrong. */
function parseFile(raw: unknown): BotImportFile {
  const format = (raw as { format?: unknown } | null)?.format;
  if (format !== BOT_IMPORT_FORMAT && format !== OLD_BOT_IMPORT_FORMAT) {
    throw new HttpError(400, 'error.importFormat');
  }
  const parsed = BotImportFile.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  throw new HttpError(400, 'error.importInvalid', { path: issue.path.join('.') || '-' });
}
