import { readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import {
  questionItems,
  quoteExcerpt,
  titleFrom,
  typedPicks,
  type Approval,
  type Message,
  type MessageFile,
  type ReplyQuote,
} from '@leafbot/shared';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { attachedFiles, moveIntoThread, promptWithFiles, promptWithReply, stagingDir } from '../uploads';
import { asOutsideData } from '../runtime/outside';
import { HttpError, isStopRequest, truncate } from '../util';
import { workspacePaths } from '../workspace';
import { MAX_AUDIO_BYTES } from './transcribe';
import type { Services } from './index';

/** A voice note as the chat apps name it (`voice-<id>.ogg`). */
const VOICE_NOTE = /^voice-.*\.(ogg|oga|opus|m4a|mp3|wav|webm)$/i;
const audioType = (name: string) =>
  ({ '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.webm': 'audio/webm' })[
    extname(name).toLowerCase()
  ] ?? 'audio/ogg';

/** How much of the answered message goes into the bot's prompt. */
const MAX_QUOTED = 2000;

const fileNames = (m: Message) =>
  Array.isArray(m.props.files) ? (m.props.files as MessageFile[]).map((f) => f.name).join(', ') : '';

/** What a reply keeps of the message it answers, for the page to show above it. */
export const replyQuote = (m: Message): ReplyQuote => ({
  id: m.id,
  text: quoteExcerpt(m.text || fileNames(m)),
});

/**
 * What the person writes to a bot, from the app or from a chat app: the one path a message takes
 * into a conversation, so a stop word, an answer to a waiting card and a queued message behave the
 * same wherever it was typed.
 */
/** What a typed reply answers on a one-question card: for several picks, option numbers become the options. */
function typedAnswer(card: Approval, text: string): string {
  const q = questionItems(card).items[0];
  return q?.multi ? typedPicks(q.options, text) : text;
}

export class Inbox {
  constructor(
    private ctx: Ctx,
    private services: Services,
  ) {}

  /** The conversation folder of a bot's thread. */
  threadDir(bot: { id: string; groupId: string | null }, threadId: string) {
    return workspacePaths(this.ctx.config.dataDir, bot.id, threadId, bot.groupId).threadDir;
  }

  /** What was said in the voice notes among `files`; a note that cannot be written out is left out. */
  private async heard(dir: string, files: { name: string; size: number }[]): Promise<string[]> {
    const notes = files.filter((f) => VOICE_NOTE.test(f.name) && f.size <= MAX_AUDIO_BYTES);
    if (!notes.length || !(await this.services.transcribe.available())) return [];
    const locale = await this.services.settings.locale();
    const out: string[] = [];
    for (const f of notes) {
      try {
        const audio = await readFile(join(dir, f.name));
        const words = await this.services.transcribe.transcribe(audio, audioType(f.name), locale);
        if (words) out.push(words);
      } catch (err) {
        console.warn(`Voice note ${f.name} could not be written out: ${String(err)}`);
      }
    }
    return out;
  }

  /** How a person is called, for lines several people write. */
  private async nameOf(userId: string): Promise<string> {
    const [row] = await this.ctx.db
      .select({ displayName: schema.users.displayName, username: schema.users.username })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    return (row?.displayName || row?.username || '').slice(0, 80);
  }

  /** The prompt a person's message becomes: the quoted message first, the attached files after. */
  async prompt(text: string, dir: string, files: { name: string }[], answered?: Message) {
    const t = await this.services.settings.translator();
    const quoted = answered ? truncate(answered.text || fileNames(answered), MAX_QUOTED) : undefined;
    return promptWithFiles(promptWithReply(text, quoted, t), dir, files, t);
  }

  /**
   * Adds the person's message to a bot's conversation and starts the bot on it. `files` are names
   * waiting in the conversation's staging folder; they move into the conversation folder.
   * `created` is false for a repeat of a message already sent (the same `clientId`).
   */
  async send(
    threadId: string,
    input: {
      text: string;
      files?: string[];
      clientId?: string;
      replyTo?: string;
      /** Kept on the message, e.g. which chat app it came from. */
      props?: Record<string, unknown>;
      /** The person writing. */
      userId?: string | null;
      /** Earlier lines of the chat app's thread, `Name: text` each; read by the bot as outside text. */
      history?: string;
      /** Who wrote it, when that is not `userId`: a person of a chat app with no account here. */
      author?: string;
      /**
       * Written by someone with no account here: the turn talks with the bot and no more, at the
       * strictest of its level and "ask", and the "always allow" rules do not count.
       */
      guest?: boolean;
      /**
       * Whether the words may stop the bot or answer its cards; false for someone who did not ask
       * for the work under way, whose words then wait their turn.
       */
      answers?: boolean;
      /** Read by the bot after the message and not shown, e.g. what a card's press asks for. */
      forBot?: string;
    },
  ): Promise<{ message: Message; created: boolean }> {
    const s = this.services;
    const thread = await s.threads.row(threadId);
    const bot = await s.bots.get(thread.botId);
    if (bot.archivedAt) throw new HttpError(409, 'error.botArchived');
    // A repeat of a message already sent: its files have moved on, so answer with it as it is.
    const earlier = input.clientId ? await s.threads.byClientId(threadId, input.clientId) : null;
    if (earlier) return { message: earlier, created: false };
    // The message answered must be in this conversation; its text is read here, not taken from the page.
    const answered = input.replyTo ? await s.threads.message(input.replyTo) : undefined;
    if (answered && answered.threadId !== threadId) throw new HttpError(404, 'error.notFound.message');
    const dir = this.threadDir(bot, threadId);
    const staging = stagingDir(this.ctx.config.dataDir, threadId);
    const staged = attachedFiles(staging, input.files ?? []);
    const root = resolve(this.ctx.config.dataDir, 'workspaces');
    const files = (await moveIntoThread(staging, dir, staged)).map((f) => ({
      ...f,
      path: relative(root, join(dir, f.name)),
    }));
    const extra = input.props ?? {};
    // A voice note from a chat app is written out when a speech service is at hand, so the bot
    // reads what was said; the recording stays attached.
    let text = input.text;
    if (extra.via && files.length) {
      const heard = await this.heard(dir, files);
      if (heard.length) text = [text, ...heard.map((h) => `🎤 ${h}`)].filter(Boolean).join('\n\n');
    }
    const plain = {
      threadId,
      role: 'user' as const,
      author: 'user',
      text,
      clientId: input.clientId,
      userId: input.userId ?? null,
    };
    // Sent while the bot is busy: it waits its turn, and until then the person may change it.
    const queued = (await s.threads.state(threadId)) !== 'idle';
    // A message forwarded from someone else is their words, not the person's: it neither stops the
    // bot nor answers its card.
    const forwarded = extra.outside === 'forward';
    // An answer from someone a bot wrote to on WhatsApp is likewise theirs, not the person's.
    const chatAnswer = extra.outside === 'whatsapp';
    const bare = queued && !files.length && !answered && !forwarded && !chatAnswer && input.answers !== false;
    // A bare "stop" while it works stops it, as the Stop button does, instead of waiting behind it.
    if (bare && isStopRequest(input.text)) {
      const { message } = await s.threads.addMessage({ ...plain, props: extra });
      await s.turns.interrupt(threadId);
      await s.jobs.stopFrom(threadId);
      return { message, created: true };
    }
    // Typed while the bot waits on its question card. In a team conversation only from whoever may
    // answer it; anyone else's words wait their turn.
    const typedCard = bare ? await s.approvals.waitingQuestion(threadId) : null;
    const card =
      typedCard && (await s.approvals.mayAnswer(typedCard, input.userId ?? null)) ? typedCard : null;
    // A card of several questions, or one asking for a secret, cannot take the words as its answer:
    // it steps aside once the message is handed to the bot, which reads it at its next step.
    const aside = card && !s.approvals.typedAnswerable(card) ? card : null;
    // One question: the words are the answer to it.
    if (card && !aside) {
      const { message } = await s.threads.addMessage({ ...plain, props: extra });
      await s.approvals.answer(
        card.id,
        // On a question that takes several picks, "1, 3" names options.
        { decision: 'allow', answer: typedAnswer(card, input.text), remember: false },
        input.userId ?? null,
      );
      return { message, created: true };
    }
    // Typed while the bot waits on a step or sign-in card: the person chose to say something else
    // instead of pressing a button. The cards give way and the bot goes on with their words.
    const waiting: Approval[] = [];
    for (const c of bare ? await s.approvals.redirectable(threadId) : []) {
      if (await s.approvals.mayAnswer(c, input.userId ?? null)) waiting.push(c);
    }
    if (waiting.length) {
      const { message } = await s.threads.addMessage({ ...plain, props: extra });
      for (const c of waiting) await s.approvals.redirect(c.id, input.text, input.userId ?? null);
      return { message, created: true };
    }
    // A reply a routine's run waits for: the run takes it, and it starts no turn of its own.
    const answersRun = answered?.props.routineRunId;
    const taken =
      !input.guest &&
      !forwarded &&
      (await s.routines.takeChatReply({
        threadId,
        botId: bot.id,
        text,
        userId: input.userId ?? null,
        via: typeof extra.via === 'string' ? extra.via : null,
        outside: chatAnswer ? 'whatsapp' : null,
        answersRun: typeof answersRun === 'string' ? answersRun : null,
        inMain: thread.kind === 'user' && !!input.userId && thread.userId === input.userId,
        from:
          typeof extra.whatsappReply === 'string'
            ? extra.whatsappReply
            : input.author?.trim() || (input.userId ? await this.nameOf(input.userId) : ''),
      }));
    const { message, created } = await s.threads.addMessage({
      ...plain,
      props: {
        ...extra,
        ...(files.length ? { files } : {}),
        ...(answered ? { replyTo: replyQuote(answered) } : {}),
        ...(queued && !taken ? { queued: true } : {}),
      },
    });
    if (taken) return { message, created };
    if (!created) return { message, created };
    // A conversation is named after the words its first message opens with.
    if (!thread.title) await s.threads.rename(threadId, titleFrom(text) || files[0]!.name.slice(0, 60), true);
    const t = await s.settings.translator();
    const from = typeof extra.forwardedFrom === 'string' ? extra.forwardedFrom : '';
    const lead = chatAnswer && typeof extra.lead === 'string' ? `${extra.lead}\n\n` : '';
    const written = forwarded
      ? asOutsideData(from ? t('outside.forwardFrom', { name: from }) : t('outside.forward'), text, t)
      : chatAnswer
        ? `${lead}${asOutsideData(t('outside.whatsapp'), text, t)}`
        : text;
    // In a team conversation several people write: the bot reads who said it.
    const name =
      input.author?.trim() || (thread.kind === 'team' && input.userId ? await this.nameOf(input.userId) : '');
    // Earlier lines of a chat app's thread the bot was called into: others' words, read as data.
    const history = input.history?.trim()
      ? `${asOutsideData(t('outside.chatHistory'), input.history.trim(), t)}\n\n`
      : '';
    const said = `${history}${name ? `${name}: ` : ''}${written}`;
    // Said aloud in a call, and the answer will be read aloud: the bot is told to keep it speakable.
    const spoken = extra.spoken === true ? `\n\n${t('inbox.spoken')}` : '';
    // Checklist items the person ticked since the bot's last turn here, as they now stand.
    const ticked = await s.chatCards.ticksForBot(threadId, t);
    const forBot = [input.forBot, ticked]
      .filter(Boolean)
      .map((x) => `\n\n${x}`)
      .join('');
    const prompt = `${await this.prompt(said, dir, files, answered)}${spoken}${forBot}`;
    const turn = await s.turns.enqueue({
      threadId,
      botId: bot.id,
      source: 'user',
      prompt,
      outside: forwarded || history ? 'forward' : chatAnswer ? 'whatsapp' : null,
      userId: input.userId ?? null,
      ...(input.guest && { guest: true, modeCap: 'ask' as const }),
      messageId: message.id,
    });
    // Written while the bot answers the person: it reads the new words at its next step instead of
    // after the answer, as the person would when talking. When the turn takes no more steps, or is
    // not the person's own, the message keeps its own turn after it.
    if (queued && !forwarded && !chatAnswer && !input.guest && input.answers !== false) {
      await s.turns.steer(threadId, turn.id, message.id, true);
    }
    if (aside) await s.approvals.stepAside(aside.id, input.userId ?? null);
    return { message: { ...message, turnId: turn.id }, created };
  }
}
