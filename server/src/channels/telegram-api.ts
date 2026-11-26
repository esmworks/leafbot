import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebStream } from 'node:stream/web';
import { MAX_RATE_WAIT_MS, pause, SEND_TRIES } from './common';

/** How long a call may take before it is given up, so a stuck connection never holds a chat's sends. */
const CALL_MS = 30_000;
/** Uploads and downloads of files move more bytes, so they get longer. */
const FILE_MS = 120_000;

/** The caller's signal together with a time limit. */
const limited = (ms: number, signal?: AbortSignal) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

interface CallOptions {
  timeoutMs?: number;
  /** Wait out Telegram's "slow down" and try again; off for calls whose caller backs off itself. */
  retry?: boolean;
}

/** A refusal from Telegram's Bot API, with its own words and, when it limits us, how long to wait. */
export class TelegramError extends Error {
  constructor(
    readonly code: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(`Telegram ${code}: ${description}`);
  }
}

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TgFile {
  file_id: string;
  file_size?: number;
  file_name?: string;
  mime_type?: string;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: string };
  date: number;
  text?: string;
  caption?: string;
  photo?: (TgFile & { width: number; height: number })[];
  document?: TgFile;
  audio?: TgFile;
  voice?: TgFile;
  video?: TgFile;
  video_note?: TgFile;
  animation?: TgFile;
  /** The message this one answers, as Telegram sends it (without its own reply, one level only). */
  reply_to_message?: Omit<TgMessage, 'reply_to_message'>;
}

export interface TgCallback {
  id: string;
  from: TgUser;
  message?: { message_id: number; chat: { id: number } };
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallback;
  /** The bot's own standing in a chat changed: blocked, removed or let back in. */
  my_chat_member?: {
    chat: { id: number; type: string };
    from?: TgUser;
    new_chat_member: { status: string };
  };
}

export interface TgButton {
  text: string;
  callback_data: string;
}

/** Telegram's Bot API for one bot token, over HTTPS; `base` is the API's address. */
export class TelegramApi {
  constructor(
    private token: string,
    private base: string,
    /** Aborts when the chat app stops, so a wait for Telegram's "slow down" does not hold it up. */
    private stopping?: AbortSignal,
  ) {}

  /**
   * One method call; Telegram's refusal becomes a `TelegramError`. When Telegram asks to slow down
   * (429) a short wait is served and the call is made again, so the rest of a long reply is not lost.
   */
  async call<T>(
    method: string,
    params: Record<string, unknown> | FormData = {},
    signal?: AbortSignal,
    options: CallOptions = {},
  ): Promise<T> {
    const tries = options.retry === false ? 1 : SEND_TRIES;
    for (let n = 1; ; n++) {
      try {
        return await this.once<T>(method, params, limited(options.timeoutMs ?? CALL_MS, signal));
      } catch (err) {
        if (!(err instanceof TelegramError) || err.code !== 429 || n >= tries) throw err;
        const wait = (err.retryAfter ?? 1) * 1000;
        // A long ban is not waited out here; the send fails and the person is told.
        if (wait > MAX_RATE_WAIT_MS) throw err;
        await pause(wait, signal ?? this.stopping);
      }
    }
  }

  private async once<T>(
    method: string,
    params: Record<string, unknown> | FormData,
    signal: AbortSignal,
  ): Promise<T> {
    const form = params instanceof FormData;
    const res = await fetch(`${this.base}/bot${this.token}/${method}`, {
      method: 'POST',
      ...(form
        ? { body: params }
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) }),
      signal,
    });
    let body: {
      ok: boolean;
      result?: T;
      description?: string;
      error_code?: number;
      parameters?: { retry_after?: number };
    };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new TelegramError(res.status, res.statusText || 'unreadable answer');
    }
    if (!body.ok) {
      throw new TelegramError(
        body.error_code ?? res.status,
        body.description ?? '',
        body.parameters?.retry_after,
      );
    }
    return body.result as T;
  }

  getMe() {
    return this.call<TgUser>('getMe');
  }

  /** Waits up to `timeout` seconds for new updates after `offset`. */
  getUpdates(offset: number | undefined, timeout: number, signal: AbortSignal) {
    return this.call<TgUpdate[]>(
      'getUpdates',
      {
        ...(offset !== undefined && { offset }),
        timeout,
        allowed_updates: ['message', 'callback_query', 'my_chat_member'],
      },
      signal,
      // The poll loop backs off by itself; the limit is a little longer than Telegram's own wait.
      { retry: false, timeoutMs: (timeout + 30) * 1000 },
    );
  }

  sendMessage(chatId: number | string, text: string, extra: Record<string, unknown> = {}) {
    return this.call<TgMessage>('sendMessage', {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...extra,
    });
  }

  /** A file from the server's disk, as a document so Telegram keeps it as it is. */
  async sendDocument(
    chatId: number | string,
    path: string,
    caption?: string,
    extra: Record<string, unknown> = {},
  ) {
    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set('document', await openAsBlob(path), basename(path));
    if (caption) form.set('caption', caption);
    for (const [k, v] of Object.entries(extra)) form.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    return this.call<TgMessage>('sendDocument', form, undefined, { timeoutMs: FILE_MS });
  }

  async download(fileId: string, signal?: AbortSignal): Promise<Readable> {
    const file = await this.call<{ file_path?: string }>('getFile', { file_id: fileId }, signal);
    if (!file.file_path) throw new TelegramError(400, 'file is not available');
    const res = await fetch(`${this.base}/file/bot${this.token}/${file.file_path}`, {
      signal: limited(FILE_MS, signal),
    });
    if (!res.ok || !res.body) throw new TelegramError(res.status, res.statusText);
    return Readable.fromWeb(res.body as WebStream);
  }
}
