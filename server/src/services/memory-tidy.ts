import type { Bot, Memory } from '@leafbot/shared';
import { eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { Engine } from '../engine/types';
import { translator, type T } from '../i18n';
import { HttpError, newId, truncate } from '../util';
import type { FlagRow } from './memory-flags';
import { pageText } from './routines';
import { redactSecrets } from './secrets';
import { fetchPublic, type PublicResponse } from './skill-link';
import type { Services } from './index';

/** How long a set of notes is left alone after a tidy-up. */
export const TIDY_EVERY_MS = 7 * 86_400_000;
/** A set with fewer notes than this has nothing worth a call to the model. */
export const TIDY_MIN_NOTES = 5;
/** What of the notes goes into one request; a note left out is one the tidy-up cannot touch. */
const NOTE_CHARS = 600;
const NOTES_CHARS = 40_000;
/** The most changes one tidy-up of a set makes. */
const MAX_OPERATIONS = 30;
/**
 * The most notes one tidy-up of a set may delete, as a share of the set: a model that misreads its
 * task takes some notes, never the whole memory. A merge counts the notes it folds away.
 */
const MAX_DELETE_SHARE = 0.3;
const MIN_DELETES = 3;
/** Who the history names for a change the tidy-up made. */
export const TIDY_ACTOR = 'tidy';
/**
 * A note that came from a page is read against the page again this long after the last look, once
 * it is this old: a note just written was read from the page moments ago. One pass reads at most
 * this many pages, so a memory full of links is gone through over a few weeks.
 */
const SOURCE_EVERY_MS = 30 * 86_400_000;
const SOURCE_FRESH_MS = 7 * 86_400_000;
const SOURCES_PER_PASS = 10;
/** What of a page is read, and what of its text goes to the model. */
const PAGE_MAX = 1024 * 1024;
const PAGE_CHARS = 30_000;
const PAGE_TIMEOUT_MS = 15_000;
const USER_AGENT = 'Mozilla/5.0 (compatible; LeafBot memory check)';

/** What the model says of a note against its page; anything unclear is "unclear". */
export function parseVerdict(text: string): { verdict: 'same' | 'changed' | 'unclear'; content?: string } {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return { verdict: 'unclear' };
  try {
    const v = JSON.parse(json) as { verdict?: unknown; content?: unknown };
    if (v.verdict === 'same') return { verdict: 'same' };
    if (v.verdict === 'changed' && typeof v.content === 'string' && v.content.trim())
      return { verdict: 'changed', content: v.content.trim() };
  } catch {
    // Read as unclear below.
  }
  return { verdict: 'unclear' };
}

/** The answer the model read on a flag's page, or null when the page does not plainly give one. */
export function parseFlagAnswer(text: string): string | null {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  try {
    const v = JSON.parse(json) as { answer?: unknown };
    return typeof v.answer === 'string' && v.answer.trim() ? v.answer.trim() : null;
  } catch {
    return null;
  }
}

/** The readable text of what a page served, or null for what is not text (a picture, a file). */
export function servedText(res: Pick<PublicResponse, 'body' | 'contentType'>): string | null {
  const type = res.contentType.toLowerCase();
  const raw = res.body.toString('utf8');
  if (/html|xml/.test(type)) return pageText(raw);
  if (!type || /^text\/|json/.test(type)) return raw.replace(/\s+/g, ' ').trim();
  return null;
}
const ranAtKey = (group: string) => `memoryTidy.ranAt.${group}`;

/** One change as the model asks for it; a malformed one is dropped, not fatal. */
const Operation = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('merge'),
    ids: z.array(z.string().min(1).max(100)).min(2).max(20),
    content: z.string(),
  }),
  z.object({ op: z.literal('update'), id: z.string().min(1).max(100), content: z.string() }),
  z.object({ op: z.literal('forget'), id: z.string().min(1).max(100) }),
]);
export type TidyOperation = z.infer<typeof Operation>;

/** The changes in the model's answer: a list, or an object holding one; anything unclear is none. */
export function parseTidy(text: string): TidyOperation[] {
  const json = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/)?.[0];
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : (raw as { operations?: unknown } | null)?.operations;
  if (!Array.isArray(list)) return [];
  return list
    .flatMap((item) => {
      const parsed = Operation.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    })
    .slice(0, MAX_OPERATIONS);
}

/** Keeps the data from closing or opening a tag of its own inside the request. */
const data = (s: string) => s.replace(/</g, '\\u003c');

/** A note the person wrote or pinned is theirs: the tidy-up reads it, and never changes it. */
const theirs = (m: Memory) => !!m.pinned || m.source === 'user';

/** The bot that wrote a note, from its source (`bot:<id>`); null for a person's. */
const writerOf = (m: Memory) => (m.source.startsWith('bot:') ? m.source.slice(4) : null);

/** What one tidy-up did, counted. */
export interface TidyCount {
  merged: number;
  updated: number;
  forgot: number;
}
export interface TidyPass extends TidyCount {
  at: string;
  /** Notes read against the page they came from. */
  checked: number;
  /** Sets of notes looked at in the pass. */
  sets: number;
}

/** A set of notes that are read together: a bot's own, a person's about themselves, or a place's. */
interface NoteSet {
  key: string;
  notes: Memory[];
}

/**
 * The notes whose words the tidy-up changes and reads together, by set, in the order they are
 * looked at: each set holds the notes that reach the same prompts, so two that say the same or
 * disagree are side by side. A note past its date waits for the person in its own list and is left
 * out, as is a set too small to be worth a call.
 */
export function noteSets(notes: Memory[], now: Date): NoteSet[] {
  const sets = new Map<string, Memory[]>();
  for (const m of notes) {
    if (m.validUntil && new Date(m.validUntil).getTime() <= now.getTime()) continue;
    const key =
      m.scope === 'bot'
        ? m.botId && `bot:${m.botId}`
        : m.scope === 'user'
          ? `user:${m.userId ?? ''}`
          : m.place && `room:${m.place}`;
    if (!key) continue;
    sets.set(key, [...(sets.get(key) ?? []), m]);
  }
  return [...sets]
    .filter(([, list]) => list.length >= TIDY_MIN_NOTES)
    .map(([key, list]) => ({ key, notes: list }));
}

/**
 * The background curator of the notes. Bots write notes while they work, one conversation at a
 * time, so the same fact ends up in several notes and an old one stays beside the new one that
 * contradicts it. Once a week, for each set of notes that changed since it was last looked at, one
 * call to the small model reads the whole set and merges what repeats, settles what disagrees in
 * favour of the newer note or the person's own, and drops what is plainly over. Changes are made at
 * once, as the bots' own are, and each shows in the memory history as the tidy-up's; the person's
 * own and pinned notes are read, never changed. It is no turn: it adds no message and reaches no
 * chat app.
 */
export class MemoryTidyService {
  private pass: Promise<TidyPass | null> | null = null;
  private current = new Set<AbortController>();
  private stopped = false;
  /** How a page is read; tests put a stand-in here. */
  readPage: (url: URL) => Promise<PublicResponse> = (url) =>
    fetchPublic(url, PAGE_MAX, {
      start: true,
      redirects: 3,
      timeoutMs: PAGE_TIMEOUT_MS,
      userAgent: USER_AGENT,
      accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
    });

  constructor(
    private ctx: Ctx,
    private services: Services,
    private engineFor: (bot: Bot) => Engine,
    private clock: () => Date = () => new Date(),
  ) {}

  /** Wait until no pass is running (tests). */
  async idle(): Promise<void> {
    while (this.pass) await this.pass.catch(() => {});
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const c of this.current) c.abort();
    await this.idle();
  }

  /** Called from the hourly sweep: the sets that are due. Not waited for. */
  runDue(): Promise<TidyPass | null> {
    return this.start(false);
  }

  /** A pass over every set, however recently it was looked at (tests); a pass running is joined. */
  runAll(): Promise<TidyPass | null> {
    return this.start(true);
  }

  private start(all: boolean): Promise<TidyPass | null> {
    if (this.stopped) return Promise.resolve(null);
    if (this.pass) return this.pass;
    const pass = this.run(all).finally(() => {
      if (this.pass === pass) this.pass = null;
    });
    this.pass = pass;
    return pass;
  }

  private async run(all: boolean): Promise<TidyPass | null> {
    const settings = await this.services.settings.all();
    const now = this.clock();
    const sets = noteSets(await this.services.memory.list(), now);
    const sum: TidyPass = { at: now.toISOString(), sets: 0, checked: 0, merged: 0, updated: 0, forgot: 0 };
    for (const set of sets) {
      if (this.stopped) break;
      if (!all && !(await this.due(set, now))) continue;
      // Marked first: a set whose tidy-up fails is not tried again every hour.
      await this.stamp(set.key, now);
      try {
        const done = await this.tidy(set, settings.defaultModel);
        // Marked again once its own changes are made, so they do not count as the set changing
        // since. Notes keep the database's time, which a clock set for a test does not move.
        await this.stamp(set.key, new Date(Math.max(this.clock().getTime(), Date.now())));
        if (!done) continue;
        sum.sets++;
        sum.merged += done.merged;
        sum.updated += done.updated;
        sum.forgot += done.forgot;
      } catch (err) {
        console.warn(`Memory tidy-up of ${set.key} failed: ${(err as Error).message}`);
      }
    }
    const sources = await this.checkSources(now, settings.defaultModel);
    sum.checked = sources.checked;
    sum.updated += sources.updated;
    // Flags are looked at every pass, not with the sets: a gap in a set that does not change (or is
    // too small to tidy) would otherwise wait for good.
    await this.checkFlagPages(settings.defaultModel).catch((err: unknown) =>
      console.warn(`Memory flag pages failed: ${String(err)}`),
    );
    await this.services.memoryFlags
      .expire()
      .catch((err: unknown) => console.warn(`Memory flag expiry failed: ${String(err)}`));
    if (sum.sets || sum.checked) this.ctx.bus.refresh({ scope: 'memory' });
    return sum;
  }

  /**
   * Reads notes that came from a page against the page as it is now, the longest unread first: a
   * price, a date or an address on a page changes after a bot wrote it down. The small model of the
   * bot that wrote the note says whether the page still says the same, and gives the note's new
   * words when the page now plainly says otherwise; the note keeps its page. A page that cannot be
   * read, or that says nothing clear, leaves the note as it was: a site being down is no reason to
   * doubt a note. Notes of a bot kept off the internet are not read, nor the person's own or pinned.
   */
  private async checkSources(now: Date, defaultModel: string): Promise<{ checked: number; updated: number }> {
    const out = { checked: 0, updated: 0 };
    const rows = await this.ctx.db
      .select({ id: schema.memories.id, at: schema.memories.sourceCheckedAt })
      .from(schema.memories)
      .where(isNotNull(schema.memories.sourceUrl));
    if (!rows.length) return out;
    const lastRead = new Map(rows.map((r) => [r.id, r.at?.getTime() ?? 0]));
    const due = (await this.services.memory.list())
      .filter(
        (m) =>
          m.sourceUrl &&
          !theirs(m) &&
          !(m.validUntil && Date.parse(m.validUntil) <= now.getTime()) &&
          Date.parse(m.updatedAt) <= now.getTime() - SOURCE_FRESH_MS &&
          (lastRead.get(m.id) ?? 0) <= now.getTime() - SOURCE_EVERY_MS,
      )
      .sort((a, b) => (lastRead.get(a.id) ?? 0) - (lastRead.get(b.id) ?? 0));
    for (const m of due) {
      if (this.stopped || out.checked >= SOURCES_PER_PASS) break;
      const botId = m.scope === 'bot' ? m.botId : writerOf(m);
      const bot = botId ? await this.services.bots.get(botId).catch(() => null) : null;
      if (!bot || !bot.memory || bot.archivedAt || !bot.internet || !this.engineFor(bot).complete) continue;
      if (await this.services.usage.reached(bot)) continue;
      // Marked first: a page that fails is not read again every hour.
      await this.ctx.db
        .update(schema.memories)
        .set({ sourceCheckedAt: now })
        .where(eq(schema.memories.id, m.id));
      try {
        out.checked++;
        if (await this.checkSource(m, bot, defaultModel)) out.updated++;
      } catch (err) {
        console.warn(`Memory source check of ${m.id} failed: ${(err as Error).message}`);
      }
    }
    return out;
  }

  /** One note against its page; whether its words were changed. */
  private async checkSource(m: Memory, bot: Bot, defaultModel: string): Promise<boolean> {
    const page = await this.pageText(m.sourceUrl!);
    if (!page) return false;
    const { url, text } = page;
    const locale =
      (await this.services.settings.all(m.scope === 'user' ? (m.userId ?? undefined) : undefined)).language ??
      (await this.services.settings.locale());
    const t = translator(locale);
    const controller = new AbortController();
    this.current.add(controller);
    let answer: string;
    let costUsd: number | null;
    try {
      ({ text: answer, costUsd } = await this.engineFor(bot).complete!({
        model: bot.model || (bot.engine === 'claude' ? defaultModel : '') || this.ctx.config.claudeModel,
        system: t('memoryTidy.sourceSystem', { today: this.clock().toISOString().slice(0, 10) }),
        user: `<note>${data(m.content)}</note>\n<page url="${data(url.href).replace(/"/g, '%22')}">${data(truncate(text, PAGE_CHARS))}</page>`,
        signal: controller.signal,
        locale,
      }));
    } finally {
      this.current.delete(controller);
    }
    if (controller.signal.aborted) return false;
    const changed = await this.correct(m, parseVerdict(answer), t);
    await this.spent(bot.id, 'source', costUsd, changed ? 1 : 0);
    return changed;
  }

  /** A page's readable text, read over https; null for an address or a page that gives none. */
  private async pageText(raw: string): Promise<{ url: URL; text: string } | null> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    // Read over https only: the read is the server's, and it does not go out in the clear.
    url.protocol = 'https:';
    url.hash = '';
    const text = servedText(
      await this.readPage(url).catch(() => ({ body: Buffer.from(''), contentType: 'none' })),
    );
    return text ? { url, text } : null;
  }

  /**
   * Reads the page a bot named when it flagged a gap, once per flag, and when the page plainly
   * answers it leaves the answer as a memory change for the person: the bot chose the page, which
   * may be wrong or written to mislead, and a note goes into every later prompt. A flag raised
   * after outside text is never read (see `withUnreadPage`), nor one about a note the person wrote
   * or pinned, nor one of a bot kept off the internet.
   */
  private async checkFlagPages(defaultModel: string): Promise<number> {
    let proposed = 0;
    let read = 0;
    // Bots whose pages cannot be read now are left out of the next look, so their flags, left
    // unread for a later pass, do not keep the others' from being read.
    const skip = new Set<string>();
    while (read < SOURCES_PER_PASS && !this.stopped) {
      const flags = await this.services.memoryFlags.withUnreadPage(SOURCES_PER_PASS - read, [...skip]);
      if (!flags.length) break;
      for (const f of flags) {
        if (this.stopped || read >= SOURCES_PER_PASS) break;
        if (skip.has(f.botId)) continue;
        const bot = await this.services.bots.get(f.botId).catch(() => null);
        if (
          !bot ||
          !bot.memory ||
          bot.archivedAt ||
          !bot.internet ||
          !this.engineFor(bot).complete ||
          (await this.services.usage.reached(bot))
        ) {
          skip.add(f.botId);
          continue;
        }
        read++;
        // Marked first: a page that fails is not read again.
        await this.services.memoryFlags.checked(f.id);
        try {
          if (await this.checkFlagPage(f, bot, defaultModel)) proposed++;
        } catch (err) {
          console.warn(`Memory flag page check of ${f.id} failed: ${(err as Error).message}`);
        }
      }
    }
    return proposed;
  }

  private async checkFlagPage(f: FlagRow, bot: Bot, defaultModel: string): Promise<boolean> {
    const note = f.memoryId ? await this.services.memory.get(f.memoryId).catch(() => null) : null;
    if (note && theirs(note)) return false;
    const page = await this.pageText(f.sourceUrl!);
    if (!page) return false;
    const locale =
      (await this.services.settings.all(f.userId ?? undefined)).language ??
      (await this.services.settings.locale());
    const t = translator(locale);
    const controller = new AbortController();
    this.current.add(controller);
    let answer: string;
    let costUsd: number | null;
    try {
      ({ text: answer, costUsd } = await this.engineFor(bot).complete!({
        model: bot.model || (bot.engine === 'claude' ? defaultModel : '') || this.ctx.config.claudeModel,
        system: t('memoryTidy.flagSystem', { today: this.clock().toISOString().slice(0, 10) }),
        user: [
          `<gap kind="${f.kind}">${data(f.about)}</gap>`,
          ...(f.seen ? [`<seen>${data(f.seen)}</seen>`] : []),
          ...(note ? [`<note>${data(note.content)}</note>`] : []),
          `<page url="${data(page.url.href).replace(/"/g, '%22')}">${data(truncate(page.text, PAGE_CHARS))}</page>`,
        ].join('\n'),
        signal: controller.signal,
        locale,
      }));
    } finally {
      this.current.delete(controller);
    }
    if (controller.signal.aborted) return false;
    await this.spent(bot.id, 'source', costUsd, 0);
    const found = parseFlagAnswer(answer);
    if (!found || found.length > 2000) return false;
    const content = redactSecrets(found, t('memory.redacted')).text;
    const change = await this.services.memory.propose({
      action: note ? 'update' : 'write',
      memoryId: note?.id ?? null,
      // A note's change is the note's owner's to take, which for a manager bot's flag on another
      // bot's note is that bot.
      scope: note?.scope ?? f.scope,
      botId: note ? note.botId : f.scope === 'bot' ? f.botId : null,
      place: note ? (note.place ?? null) : f.place,
      site: null,
      content,
      before: note?.content ?? null,
      proposedBy: f.botId,
      origin: { kind: 'flag', name: bot.name },
      userId: f.userId,
      threadId: f.threadId,
      sourceUrl: page.url.href,
      validUntil: null,
    });
    await this.services.memoryFlags.proposed(f.id, change.id);
    return true;
  }

  /** Gives a note the new words the model read on its page, when they are fit to take. */
  private async correct(m: Memory, v: ReturnType<typeof parseVerdict>, t: T): Promise<boolean> {
    if (v.verdict !== 'changed') return false;
    // The same fact in new words, about as long as the note: a page cannot grow a note into
    // something else through this.
    if (v.content!.length > Math.min(2000, m.content.length * 2 + 200)) return false;
    const content = redactSecrets(v.content!, t('memory.redacted')).text;
    if (content === m.content) return false;
    try {
      await this.services.memory.update(m.id, { content, expectedUpdatedAt: m.updatedAt }, TIDY_ACTOR);
      return true;
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) return false;
      throw err;
    }
  }

  /** Keeps what one call cost, and how many notes it changed, for the usage page. */
  private async spent(botId: string, kind: 'set' | 'source', costUsd: number | null, changed: number) {
    await this.ctx.db
      .insert(schema.memoryTidyChecks)
      .values({ id: newId(), botId, kind, costUsd, changed, createdAt: this.clock() })
      .catch((err: unknown) => console.warn(`Could not keep a memory tidy-up's cost: ${String(err)}`));
  }

  private async stamp(key: string, at: Date) {
    await this.ctx.db
      .insert(schema.kv)
      .values({ key: ranAtKey(key), value: at.toISOString() })
      .onConflictDoUpdate({ target: schema.kv.key, set: { value: at.toISOString() } });
  }

  /** Whether a set waited long enough and changed since it was last looked at. */
  private async due(set: NoteSet, now: Date): Promise<boolean> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.kv)
      .where(eq(schema.kv.key, ranAtKey(set.key)));
    const ranAt = typeof row?.value === 'string' ? Date.parse(row.value) : NaN;
    if (!Number.isFinite(ranAt)) return true;
    if (ranAt > now.getTime() - TIDY_EVERY_MS) return false;
    return set.notes.some((m) => Date.parse(m.updatedAt) > ranAt);
  }

  /**
   * The bot whose model reads a set: the bot itself for its own notes; otherwise the bot that wrote
   * most of the set's notes and still keeps a memory, so the notes go to no account they did not
   * already reach. A set no bot wrote is left alone.
   */
  private async writer(set: NoteSet): Promise<Bot | null> {
    const usable = async (id: string) => {
      const bot = await this.services.bots.get(id).catch(() => null);
      if (!bot || !bot.memory || bot.archivedAt || !this.engineFor(bot).complete) return null;
      // A spent limit stops the bot's background calls too: they are spent from its account.
      return (await this.services.usage.reached(bot)) ? null : bot;
    };
    if (set.key.startsWith('bot:')) return usable(set.key.slice(4));
    const counts = new Map<string, number>();
    for (const m of set.notes) {
      const id = writerOf(m);
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const [id] of [...counts].sort((a, b) => b[1] - a[1])) {
      const bot = await usable(id);
      if (bot) return bot;
    }
    return null;
  }

  /** One set: one call to the model, and the changes it asks for. Null when nothing was asked. */
  private async tidy(set: NoteSet, defaultModel: string): Promise<TidyCount | null> {
    // A set of only the person's own notes has nothing the tidy-up may change.
    if (!set.notes.some((m) => !theirs(m))) return null;
    const bot = await this.writer(set);
    if (!bot) return null;
    const engine = this.engineFor(bot);
    const locale = await this.localeOf(set);
    const t = translator(locale);
    const request = this.request(t, set.notes);
    const controller = new AbortController();
    this.current.add(controller);
    let text: string;
    let costUsd: number | null;
    try {
      ({ text, costUsd } = await engine.complete!({
        model: bot.model || (bot.engine === 'claude' ? defaultModel : '') || this.ctx.config.claudeModel,
        system: request.system,
        user: request.user,
        signal: controller.signal,
        locale,
      }));
    } finally {
      this.current.delete(controller);
    }
    if (controller.signal.aborted) return null;
    const shown = new Map(set.notes.filter((n) => request.shown.has(n.id)).map((n) => [n.id, n]));
    const done = await this.apply(parseTidy(text), shown, t);
    await this.spent(bot.id, 'set', costUsd, done.merged + done.updated + done.forgot);
    return done;
  }

  /** The language the notes of a set are most likely read in: their person's, or the server's. */
  private async localeOf(set: NoteSet) {
    const userId = set.key.startsWith('user:') ? set.key.slice(5) || undefined : undefined;
    return (await this.services.settings.all(userId)).language ?? (await this.services.settings.locale());
  }

  /** The two texts of the request, and the ids of the notes it shows (the only ones it may change). */
  private request(t: T, notes: Memory[]) {
    const system = t('memoryTidy.system', {
      pinned: t('memoryReview.markPinned'),
      byPerson: t('memoryReview.markPerson'),
      today: this.clock().toISOString().slice(0, 10),
    });
    const shown = new Set<string>();
    const lines: string[] = [];
    let used = 0;
    // Newest first, so a set too long for one request is read from its newest end.
    for (const n of [...notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
      const marks = [
        n.pinned ? `[${t('memoryReview.markPinned')}]` : '',
        n.source === 'user' ? `[${t('memoryReview.markPerson')}]` : '',
        n.site ? `(${n.site})` : '',
        n.validUntil ? `(${t('prompt.noteUntil', { date: n.validUntil.slice(0, 10) })})` : '',
      ].filter(Boolean);
      const line = `[${n.id}] ${n.updatedAt.slice(0, 10)}${marks.length ? ` ${marks.join(' ')}` : ''} ${data(truncate(n.content, NOTE_CHARS))}`;
      if (used + line.length > NOTES_CHARS) break;
      used += line.length;
      shown.add(n.id);
      lines.push(line);
    }
    return { system, user: `<notes>\n${lines.join('\n')}\n</notes>`, shown };
  }

  /**
   * Makes what the model asked for, straight away and with the checks the bots' own memory tools
   * make: only notes it was shown, never the person's own or pinned ones, each note in one change
   * at most, a merge only of notes about the same site and with the same date, and no more
   * deletions than the share allowed.
   */
  private async apply(ops: TidyOperation[], shown: Map<string, Memory>, t: T): Promise<TidyCount> {
    const { memory } = this.services;
    const count: TidyCount = { merged: 0, updated: 0, forgot: 0 };
    const touched = new Set<string>();
    let deletesLeft = Math.max(MIN_DELETES, Math.floor(shown.size * MAX_DELETE_SHARE));
    const free = (id: string) => {
      const m = shown.get(id);
      return m && !theirs(m) && !touched.has(id) ? m : null;
    };
    const words = (content: string) => {
      const text = content.trim();
      return text && text.length <= 2000 ? redactSecrets(text, t('memory.redacted')).text : null;
    };
    const rewrite = async (m: Memory, content: string) => {
      try {
        await memory.update(m.id, { content, expectedUpdatedAt: m.updatedAt }, TIDY_ACTOR);
        return true;
      } catch (err) {
        // Changed since it was read: the newer words stand.
        if (err instanceof HttpError && err.status === 409) return false;
        throw err;
      }
    };
    for (const op of ops) {
      try {
        if (op.op === 'forget') {
          const m = free(op.id);
          if (!m || deletesLeft < 1) continue;
          touched.add(m.id);
          await memory.remove(m.id, TIDY_ACTOR);
          deletesLeft--;
          count.forgot++;
        } else if (op.op === 'update') {
          const m = free(op.id);
          const content = words(op.content);
          if (!m || !content || content === m.content) continue;
          touched.add(m.id);
          if (await rewrite(m, content)) count.updated++;
        } else {
          const ids = [...new Set(op.ids)];
          const notes = ids.map(free);
          const content = words(op.content);
          if (ids.length < 2 || !content || notes.some((m) => !m)) continue;
          const list = notes as Memory[];
          const [keep, ...rest] = list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          if (list.some((m) => (m.site ?? null) !== (keep!.site ?? null))) continue;
          if (list.some((m) => (m.validUntil ?? null) !== (keep!.validUntil ?? null))) continue;
          if (rest.length > deletesLeft) continue;
          for (const m of list) touched.add(m.id);
          if (content !== keep!.content && !(await rewrite(keep!, content))) continue;
          await memory.removeMany(
            rest.map((m) => m.id),
            TIDY_ACTOR,
          );
          deletesLeft -= rest.length;
          count.merged += rest.length;
        }
      } catch (err) {
        console.warn(`Memory tidy-up change skipped: ${(err as Error).message}`);
      }
    }
    return count;
  }
}
