import {
  connectionToolParts,
  describeAction,
  outsideTrigger,
  questionItems,
  type Approval,
  type Locale,
  type Message,
} from '@leafbot/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { T } from '../i18n';
import type { Services } from '../services';
import { redactSecrets } from '../services/secrets';
import type { VaultService } from '../services/vault';
import { truncate } from '../util';

/** A chat app a message can come from; kept on the person's message as `via`. */
export type Via = 'telegram' | 'whatsapp' | 'slack' | 'discord' | 'teams';

/**
 * Whether a saved secret can still be opened. It cannot when the server's secret key is not the one
 * it was sealed with; reading it again then changes nothing, so a channel in that state is shown as
 * not connected, with the reason, instead of failing in the background.
 */
export function canOpen(vault: Pick<VaultService, 'open'>, sealed: string): boolean {
  try {
    vault.open(sealed);
    return true;
  } catch {
    return false;
  }
}

/** The most of a step's detail a chat app's card shows; the app shows the rest. */
const DETAIL_MAX = 700;

/** One choice under a card; `data` is what comes back when it is pressed or typed. */
export interface CardButton {
  label: string;
  data: string;
}

/**
 * A card as a chat app shows it: its text (Markdown), and the choices that answer it there. A card
 * only the app can answer (a sign-in, a secret, several questions at once) has no choices and says
 * so; its text never holds what the person would type into it.
 */
export function cardView(
  a: Approval,
  props: Record<string, unknown>,
  t: T,
  locale?: Locale,
): { text: string; buttons: CardButton[] } {
  // The chat app's server keeps what is posted there: a key or password in a step stays here.
  const masked = (s: string) => redactSecrets(s, t('memory.redacted')).text;
  if (a.kind === 'tool') {
    const reason =
      typeof props.reviewReason === 'string' && props.reviewReason ? `\n_${masked(props.reviewReason)}_` : '';
    // A run outside text started takes no "always allow": the step was the text's choice.
    const outside = outsideTrigger(props.outside);
    const why = outside ? `\n_${t(`channel.outside.${outside}`)}_` : '';
    // A page address that imitates a site the person uses: warned first, and never "always allow".
    const copy =
      typeof props.resembles === 'string' && props.resembles
        ? `\n⚠️ **${t('channel.resembles', { site: props.resembles })}**`
        : '';
    // Nor a card that offers none: a guest's request, or a turn a stricter bot holds to its level.
    const always =
      !props.askRule && !props.heldBy && !outside && !copy && props.noAlways !== true && !a.needsSecond;
    // What the app shows under "What?": the command, file or address, so the step is not
    // allowed from the chat app without seeing it.
    const detail = describeAction(a.toolName, a.input ?? {}, {
      bot: '',
      locale,
      service: connectionToolParts(a.toolName)?.server,
    }).detail;
    const shown = detail
      ? `\n\`\`\`\n${truncate(masked(detail), DETAIL_MAX).replace(/```/g, "'''")}\n\`\`\``
      : '';
    // A step that needs two people's yes says so: the first says it here, the second elsewhere.
    const two = a.needsSecond ? `\n_${t('channel.needsSecond')}_` : '';
    return {
      text: `🔐 ${a.summary}${copy}${shown}${why}${two}${reason}`,
      buttons: [
        { label: t('channel.allow'), data: `a:${a.id}:y` },
        ...(always ? [{ label: t('channel.always'), data: `a:${a.id}:r` }] : []),
        { label: t('channel.deny'), data: `a:${a.id}:n` },
      ],
    };
  }
  if (a.kind === 'question') {
    const { title, items } = questionItems(a);
    const [q] = items;
    if (items.length === 1 && q && !q.secret) {
      const head = title ? `**${title}**\n` : '';
      const context = q.context ? `\n${q.context}` : '';
      const hint = `\n\n_${t(q.options.length ? 'channel.orType' : 'channel.typeAnswer')}_`;
      return {
        text: `❓ ${head}${q.question}${context}${hint}`,
        buttons: q.options.slice(0, 10).map((o, i) => ({ label: truncate(o, 60), data: `q:${a.id}:${i}` })),
      };
    }
  }
  return { text: `🔑 ${a.summary}\n\n${t('channel.inApp')}`, buttons: [] };
}

/** The answer a pressed choice gives, or null when the data is not one of ours. */
export function parseChoice(data: string): { approvalId: string; kind: 'a' | 'q'; value: string } | null {
  const m = /^([aq]):([^:]+):(\w+)$/.exec(data);
  return m ? { kind: m[1] as 'a' | 'q', approvalId: m[2]!, value: m[3]! } : null;
}

/** Whether the person last wrote to this conversation from that chat app; its replies go back there. */
export async function lastWroteVia(ctx: Ctx, threadId: string, via: Via): Promise<boolean> {
  const [last] = await ctx.db
    .select({ props: schema.messages.props })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.threadId, threadId),
        eq(schema.messages.role, 'user'),
        eq(schema.messages.author, 'user'),
      ),
    )
    .orderBy(desc(schema.messages.createdAt))
    .limit(1);
  return (last?.props as { via?: unknown } | undefined)?.via === via;
}

/**
 * Notes that the bot is working on a request from a chat app, with what the chat shows for it, or
 * updates that note. Kept until `dropRequest`, so a start after a crash finds it with `heldRequests`.
 */
export async function holdRequest(
  ctx: Ctx,
  channelId: string,
  threadId: string,
  place: Record<string, unknown>,
): Promise<void> {
  await ctx.db
    .insert(schema.channelRequests)
    .values({ channelId, threadId, place })
    .onConflictDoUpdate({
      target: [schema.channelRequests.channelId, schema.channelRequests.threadId],
      set: { place },
    });
}

/** The request is over: answered, stopped, failed or settled after a restart. */
export async function dropRequest(ctx: Ctx, channelId: string, threadId: string): Promise<void> {
  await ctx.db
    .delete(schema.channelRequests)
    .where(
      and(eq(schema.channelRequests.channelId, channelId), eq(schema.channelRequests.threadId, threadId)),
    );
}

/** Requests a chat app still showed as under way when the server stopped, oldest first. */
export async function heldRequests(
  ctx: Ctx,
  channelId: string,
): Promise<{ threadId: string; place: Record<string, unknown>; createdAt: Date }[]> {
  return ctx.db
    .select({
      threadId: schema.channelRequests.threadId,
      place: schema.channelRequests.place,
      createdAt: schema.channelRequests.createdAt,
    })
    .from(schema.channelRequests)
    .where(eq(schema.channelRequests.channelId, channelId))
    .orderBy(schema.channelRequests.createdAt);
}

/**
 * Whether the conversation still has a turn waiting to run. Such a turn survives a restart and runs
 * after it, so the request it answers is not over.
 */
export async function queuedTurn(ctx: Ctx, threadId: string): Promise<boolean> {
  const [queued] = await ctx.db
    .select({ id: schema.turns.id })
    .from(schema.turns)
    .where(and(eq(schema.turns.threadId, threadId), eq(schema.turns.status, 'queued')))
    .limit(1);
  return !!queued;
}

/**
 * Whether the conversation's last turn, one the person started, ended well without leaving anything
 * to show: no words, no file, no card and no failure. The person would only see "typing…" stop.
 */
export async function saidNothing(ctx: Ctx, threadId: string): Promise<boolean> {
  const [turn] = await ctx.db
    .select()
    .from(schema.turns)
    .where(eq(schema.turns.threadId, threadId))
    .orderBy(desc(schema.turns.createdAt))
    .limit(1);
  if (!turn || turn.status !== 'done' || turn.source !== 'user') return false;
  const made = await ctx.db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.threadId, threadId), eq(schema.messages.turnId, turn.id)));
  return !made.some(
    (m) =>
      m.role === 'error' ||
      m.role === 'approval' ||
      (m.role === 'assistant' &&
        (m.text.trim() !== '' || (Array.isArray(m.props.files) && m.props.files.length > 0))),
  );
}

/** The person's words with a note of the files that did not arrive, so the bot does not answer as if it had them. */
export function withMissingFiles(text: string, got: { failed: string[]; tooLarge: string[] }, t: T): string {
  return [
    text,
    got.failed.length && t('channel.filesMissing', { names: got.failed.join(', ') }),
    got.tooLarge.length && t('channel.filesTooLarge', { names: got.tooLarge.join(', ') }),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** How long to wait before trying a refused send again, at most this many times. */
export const SEND_TRIES = 3;
/** The longest a chat app's "slow down" is waited out before the send is given up. */
export const MAX_RATE_WAIT_MS = 60_000;

/** Waits `ms`, or fails at once when the signal aborts (the chat app is being stopped, say). */
export const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason as Error);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason as Error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Runs the sends of one chat in order, one at a time, so a reply never overtakes its file. */
export class SendQueue {
  private tails = new Map<string, Promise<unknown>>();

  /** Settles once every job asked for under `key` so far is done. */
  async after(key: string): Promise<void> {
    await this.tails.get(key);
  }

  /** Whether the job went through; a failure is logged, never thrown, so the next send still runs. */
  run(key: string, job: () => Promise<void>): Promise<boolean> {
    const next = (this.tails.get(key) ?? Promise.resolve()).then(job).then(
      () => true,
      (err: unknown) => {
        console.warn('chat app send', err);
        return false;
      },
    );
    this.tails.set(key, next);
    void next.finally(() => {
      if (this.tails.get(key) === next) this.tails.delete(key);
    });
    return next;
  }

  async drain() {
    await Promise.all(this.tails.values());
  }
}

/** A name for a file that came without one: the kind of file and its message. */
export function receivedName(kind: string, id: string, mime?: string, name?: string): string {
  if (name) return name;
  const ext =
    {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'audio/ogg': 'ogg',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'video/mp4': 'mp4',
      'application/pdf': 'pdf',
    }[mime?.split(';')[0]?.trim() ?? ''] ??
    { photo: 'jpg', voice: 'ogg', video: 'mp4', video_note: 'mp4', animation: 'mp4', audio: 'mp3' }[kind] ??
    'bin';
  return `${kind}-${id}.${ext}`;
}

/** The files a bot's message carries, where they are on disk. */
export function messageFiles(m: Message): { name: string; size: number; path: string }[] {
  return Array.isArray(m.props.files)
    ? (m.props.files as { name: string; size: number; path: string }[])
    : [];
}

/**
 * `/stop` and `/new` typed in a chat app: what they did, in a line to send back; null when the
 * text is not one of them (it then goes to the bot as written).
 */
export async function chatCommand(
  services: Services,
  threadId: string,
  text: string,
  t: T,
): Promise<string | null> {
  const command = /^\/(stop|new)(?:@\w+)?\s*$/i.exec(text.trim())?.[1]?.toLowerCase();
  if (command === 'stop') {
    const stopped = await services.turns.interrupt(threadId);
    const teammates = await services.jobs.stopFrom(threadId);
    return t(stopped || teammates ? 'channel.stopped' : 'channel.nothingToStop');
  }
  if (command === 'new') {
    if ((await services.threads.state(threadId)) !== 'idle') return t('channel.busy');
    await services.threads.resetContext(threadId, t);
    return t('channel.newChat');
  }
  return null;
}

/** The kind of file a name says it is, for chat apps that want one. */
export function mimeOf(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return (
    {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
      pdf: 'application/pdf',
      txt: 'text/plain',
      md: 'text/markdown',
      csv: 'text/csv',
      json: 'application/json',
      html: 'text/html',
      zip: 'application/zip',
      mp3: 'audio/mpeg',
      ogg: 'audio/ogg',
      m4a: 'audio/mp4',
      mp4: 'video/mp4',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    }[ext] ?? 'application/octet-stream'
  );
}
