import type { Message } from '@leafbot/shared';
import type { QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { create } from 'zustand';
import { api, ApiError, NoAnswerError } from './api';

/** A message written while the app could not reach the server, waiting to be sent. */
export interface Held {
  threadId: string;
  clientId: string;
  text: string;
  files: string[];
  replyTo?: string;
  /** As the conversation shows it until the server's copy arrives. */
  message: Message;
  /** Waiting for the connection (the default), or on its way now. */
  phase?: 'held' | 'sending';
}

interface Outbox {
  items: Held[];
  hold(item: Held): void;
  drop(clientId: string): void;
  setPhase(clientId: string, phase: 'held' | 'sending'): void;
}

/**
 * Messages held while the connection is down. They stay in their conversation, marked as waiting,
 * and go out on their own once the server answers again; their client id makes a second try of a
 * send that did reach the server count once. Kept for this window only; a new version waits for
 * them before reloading (see `useHoldReload`).
 */
export const useOutbox = create<Outbox>((set) => ({
  items: [],
  hold: (item) => set((s) => ({ items: [...s.items.filter((x) => x.clientId !== item.clientId), item] })),
  drop: (clientId) => set((s) => ({ items: s.items.filter((x) => x.clientId !== clientId) })),
  setPhase: (clientId, phase) =>
    set((s) => ({ items: s.items.map((x) => (x.clientId === clientId ? { ...x, phase } : x)) })),
}));

/** What a proxy in front of the server answers while the server is away (a restart, a redeploy). */
const AWAY = [502, 503, 504];

/**
 * A send that failed because the server could not be reached, not because it said no: no answer
 * came, or a proxy answered for a server that is away. Any other error is a mistake that a later
 * try would only repeat, so it is shown rather than held.
 */
export const isOffline = (err: unknown): boolean =>
  err instanceof NoAnswerError || (err instanceof ApiError && AWAY.includes(err.status) && !err.fromServer);

/** The pass that is running, if any. */
let running: Promise<void> | null = null;
/** Another flush was asked for while a pass ran: one more pass follows it. */
let again = false;
let heard: ((threadId: string) => void) | undefined;

/** Set while the app watches the connection: tries the held messages again now. */
let wake: (() => void) | null = null;

/** Tries the held messages again now, when the app is watching the connection. */
export function retryOutbox(): void {
  wake?.();
}

/** Whether a conversation has messages waiting: a new one there goes behind them, not before. */
export const holdsFor = (threadId: string): boolean =>
  useOutbox.getState().items.some((i) => i.threadId === threadId);

/**
 * Tries the held messages again, oldest first; stops at the first that still cannot reach the
 * server. One the server refuses is dropped and its reason shown. `sent` hears each that went.
 * Asked again while a pass runs, it makes one more pass after it: a message held meanwhile goes
 * out at once, and requests do not pile up into parallel sends.
 */
export function flushOutbox(sent?: (threadId: string) => void): Promise<void> {
  heard = sent ?? heard;
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        await pass();
      } while (again);
    } finally {
      running = null;
      heard = undefined;
    }
  })();
  return running;
}

async function pass(): Promise<void> {
  for (const item of [...useOutbox.getState().items]) {
    // Dropped or sent by another route while the pass was on an earlier one.
    if (!useOutbox.getState().items.some((x) => x.clientId === item.clientId)) continue;
    useOutbox.getState().setPhase(item.clientId, 'sending');
    try {
      await api.send(item.threadId, item.clientId, item.text, item.files, item.replyTo, true);
      useOutbox.getState().drop(item.clientId);
      heard?.(item.threadId);
    } catch (err) {
      if (isOffline(err)) {
        useOutbox.getState().setPhase(item.clientId, 'held');
        return;
      }
      useOutbox.getState().drop(item.clientId);
      toast.error((err as Error).message);
    }
  }
}

const RETRY_MS = 15_000;

/**
 * Sends the held messages when the connection is back: the browser saying it is online, the
 * realtime socket connecting again, and every little while in case neither is heard.
 */
export function watchOutbox(qc: QueryClient): { flush(): void; stop(): void } {
  const sent = (threadId: string) => void qc.invalidateQueries({ queryKey: ['messages', threadId] });
  const flush = () => {
    if (useOutbox.getState().items.length) void flushOutbox(sent);
  };
  window.addEventListener('online', flush);
  const timer = setInterval(flush, RETRY_MS);
  wake = flush;
  return {
    flush,
    stop: () => {
      window.removeEventListener('online', flush);
      clearInterval(timer);
      if (wake === flush) wake = null;
    },
  };
}
