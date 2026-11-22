import type { Bot } from '@leafbot/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { Engine, TurnOutcome } from '../engine/types';
import { translator } from '../i18n';
import { asOutsideData } from '../runtime/outside';
import type { TurnRow } from '../runtime/turns';
import { truncate } from '../util';
import type { Services } from './index';

/** Conversations a person names: their own and the team's. A bot's own work keeps its name. */
const TITLED_KINDS = ['user', 'team'];
/** What of the opening exchange the model reads to name it. */
const READ_CHARS = 1500;
const MAX_TITLE = 80;
/** A title that has not come by then is left as it is. */
const WAIT_MS = 60_000;

/** The model's answer as a title: its first line, without quotes, a heading mark or a closing stop. */
export function cleanTitle(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line
    .replace(/^#+\s*/, '')
    .replace(/^(?:title|başlık)\s*:\s*/i, '')
    .replace(/^["'“”‘’«»`*]+|["'“”‘’«»`*]+$/g, '')
    .replace(/[.。]+$/, '')
    .trim()
    .slice(0, MAX_TITLE)
    .trim();
}

/**
 * Names a conversation by what it is about once its first answer is in, with the bot's own model,
 * in place of the first message's opening words. Only a title the person did not choose is
 * changed, once; a bot past its spending limit or paused is left with the words it had.
 */
export class TitleService {
  private pending = new Set<Promise<void>>();
  private controllers = new Set<AbortController>();
  private stopped = false;
  private tried = new Set<string>();

  constructor(
    private ctx: Ctx,
    private services: Services,
    private engineFor: (bot: Bot) => Engine,
  ) {}

  /** Named after the turn's hooks, so the turn ends without waiting on the model. */
  onTurnFinished(turn: TurnRow, outcome: TurnOutcome): Promise<void> {
    if (!outcome.ok || turn.source !== 'user' || this.stopped) return Promise.resolve();
    const work = this.name(turn.threadId, turn.botId).catch((err: unknown) =>
      console.warn(`Naming conversation ${turn.threadId} failed: ${(err as Error).message}`),
    );
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
    return Promise.resolve();
  }

  /** Waits for the names being written (tests, shutdown). */
  async idle() {
    await Promise.allSettled([...this.pending]);
  }

  async shutdown() {
    this.stopped = true;
    for (const c of this.controllers) c.abort();
    await this.idle();
  }

  private async name(threadId: string, botId: string) {
    const settings = await this.services.settings.all();
    if (!settings.modelTitles) return;
    const thread = await this.services.threads.row(threadId).catch(() => null);
    if (!thread?.titleAuto || !TITLED_KINDS.includes(thread.kind)) return;
    const bot = await this.services.bots.get(botId).catch(() => null);
    if (!bot || bot.archivedAt || (await this.services.bots.isPaused(bot))) return;
    if (await this.services.usage.reached(bot)) return;
    const engine = this.engineFor(bot);
    if (!engine.complete) return;
    // Asked once per conversation while the server runs: a model that fails is not asked on every turn.
    if (this.tried.has(threadId)) return;

    const said = await this.ctx.db
      .select({ role: schema.messages.role, text: schema.messages.text })
      .from(schema.messages)
      .where(
        and(eq(schema.messages.threadId, threadId), inArray(schema.messages.role, ['user', 'assistant'])),
      )
      .orderBy(asc(schema.messages.createdAt), asc(schema.messages.id))
      // Several messages may come before the first answer.
      .limit(20);
    const question = said.find((m) => m.role === 'user')?.text.trim();
    const answer = said.find((m) => m.role === 'assistant')?.text.trim();
    if (!question || !answer) return;
    this.tried.add(threadId);

    const locale =
      (await this.services.settings.all(thread.userId ?? undefined)).language ??
      (await this.services.settings.locale());
    const t = translator(locale);
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), WAIT_MS);
    let text: string;
    let costUsd: number | null;
    try {
      ({ text, costUsd } = await engine.complete({
        model:
          bot.model || (bot.engine === 'claude' ? settings.defaultModel : '') || this.ctx.config.claudeModel,
        system: t('title.system'),
        // What was said is the conversation's, read as data: a message cannot steer the naming.
        user: asOutsideData(
          t('title.source'),
          `${t('title.question')}\n${truncate(question, READ_CHARS)}\n\n${t('title.answer')}\n${truncate(answer, READ_CHARS)}`,
          t,
        ),
        signal: controller.signal,
        locale,
      }));
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
    await this.services.usage.background(bot.id, 'title', costUsd);
    const title = cleanTitle(text);
    if (!title || controller.signal.aborted) return;
    // Only if the person has not named it meanwhile.
    const [now] = await this.ctx.db
      .update(schema.threads)
      .set({ title, titleAuto: false })
      .where(and(eq(schema.threads.id, threadId), eq(schema.threads.titleAuto, true)))
      .returning({ botId: schema.threads.botId });
    if (now) this.ctx.bus.refresh({ scope: 'threads', botId: now.botId });
  }
}
