import type {
  ClientToServerEvents,
  NoticeEvent,
  RefreshScope,
  ServerToClientEvents,
  TurnState,
} from '@leafbot/shared';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { io, type Socket } from 'socket.io-client';
import { locale } from '@/i18n';
import { apiFor } from './api';
import { answerPhone, offeredKinds, onShareChange, sharedKinds } from './phone';
import { expoDevice } from './phoneDevice';
import { usePush } from './push';
import { useServer } from './server';
import { appendStream, dropStream, type Stream, type Streams } from './stream';

/** What the socket has said that is not saved on the server yet: replies being written and turn states. */
class LiveStore {
  streams: Streams = {};
  states: Readonly<Record<string, TurnState>> = {};
  tools: Readonly<Record<string, string | null>> = {};
  /** How much of its turn's streaming text had arrived when each card (by message id) did. */
  cardCuts: Readonly<Record<string, number>> = {};
  connected = false;
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  private emit() {
    for (const fn of this.listeners) fn();
  }

  append(threadId: string, turnId: string, text: string) {
    this.streams = appendStream(this.streams, threadId, turnId, text);
    this.emit();
  }

  drop(threadId: string, turnId?: string) {
    const next = dropStream(this.streams, threadId, turnId);
    if (next === this.streams) return;
    this.streams = next;
    this.emit();
  }

  setState(threadId: string, state: TurnState) {
    this.states = { ...this.states, [threadId]: state };
    this.emit();
  }

  setTool(threadId: string, tool: string | null) {
    if ((this.tools[threadId] ?? null) === tool) return;
    this.tools = { ...this.tools, [threadId]: tool };
    this.emit();
  }

  /** Notes where cards were asked in their turn's text; a card's first note stays. */
  markCards = (cuts: Record<string, number>) => {
    this.cardCuts = { ...cuts, ...this.cardCuts };
    this.emit();
  };

  setConnected(on: boolean) {
    this.connected = on;
    this.emit();
  }

  reset() {
    this.streams = {};
    this.states = {};
    this.tools = {};
    this.cardCuts = {};
    this.emit();
  }
}

const LiveContext = createContext<LiveStore | null>(null);

function useLive(): LiveStore {
  const store = useContext(LiveContext);
  if (!store) throw new Error('useLive outside RealtimeProvider');
  return store;
}

/** The reply being written in a conversation right now, if any. */
export function useStream(threadId: string | undefined): Stream | undefined {
  const store = useLive();
  return useSyncExternalStore(store.subscribe, () => (threadId ? store.streams[threadId] : undefined));
}

/** A conversation's turn state as the socket last told it; undefined before it said anything. */
export function useLiveState(threadId: string | undefined): TurnState | undefined {
  const store = useLive();
  return useSyncExternalStore(store.subscribe, () => (threadId ? store.states[threadId] : undefined));
}

/** The tool a running turn uses now (`Bash`, `mcp__notion__search`), null when none. */
export function useLiveTool(threadId: string | undefined): string | null {
  const store = useLive();
  return useSyncExternalStore(store.subscribe, () => (threadId ? (store.tools[threadId] ?? null) : null));
}

/** Where the cards of streaming turns were asked, and how to note new ones. */
export function useCardCuts(): [Readonly<Record<string, number>>, (cuts: Record<string, number>) => void] {
  const store = useLive();
  const cuts = useSyncExternalStore(store.subscribe, () => store.cardCuts);
  return [cuts, store.markCards];
}

/** Whether the socket to the server is up, for the connection dot. */
export function useConnected(): boolean {
  const store = useLive();
  return useSyncExternalStore(store.subscribe, () => store.connected);
}

const notices = new Set<(e: NoticeEvent) => void>();

/** Hears every notice the server sends (a reply, a card that waits, a failed turn). */
export function onNotice(fn: (e: NoticeEvent) => void): () => void {
  notices.add(fn);
  return () => void notices.delete(fn);
}

/**
 * Keeps the socket to the server open while signed in. Pushes only say what changed; anything
 * lasting is refetched over HTTP. The session cookie in the phone's cookie store signs it in.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { origin } = useServer();
  const qc = useQueryClient();
  const [store] = useState(() => new LiveStore());
  const session = useQuery({
    queryKey: ['session', origin],
    queryFn: () => apiFor(origin!).session(),
    enabled: !!origin,
  });
  const signedIn = session.data?.authenticated === true;
  usePush(origin, signedIn);

  useEffect(() => {
    if (!origin || !signedIn) return;
    return connect(origin, qc, store);
  }, [origin, signedIn, qc, store]);

  return <LiveContext.Provider value={store}>{children}</LiveContext.Provider>;
}

function connect(origin: string, qc: QueryClient, store: LiveStore): () => void {
  const s: Socket<ServerToClientEvents, ClientToServerEvents> = io(origin, {
    path: '/socket.io',
    transports: ['websocket'],
    withCredentials: true,
    // The server words its refusals in the language the app asks in.
    extraHeaders: { 'accept-language': locale },
  });
  let bootId: string | null = null;
  const inv = (...queryKey: unknown[]) => void qc.invalidateQueries({ queryKey });

  // What the person lets bots read from this phone, said again whenever it may have changed: on
  // every connect, when a switch changes, and when the app comes back (a permission may be gone).
  const offer = () =>
    void sharedKinds(origin)
      .then((shared) => offeredKinds(shared, expoDevice))
      .then((kinds) => s.emit('phone:offer', kinds))
      .catch(() => undefined);
  const offShare = onShareChange(offer);
  const offActive = AppState.addEventListener('change', (state) => {
    if (state === 'active' && s.connected) offer();
  });
  s.on('phone:ask', (ask, ack) => {
    if (typeof ack !== 'function') return;
    void sharedKinds(origin)
      .then((shared) => answerPhone(ask, shared, expoDevice))
      .then(ack, () => ack({ ok: false, reason: 'failed' }));
  });

  s.on('connect', () => {
    store.setConnected(true);
    offer();
  });
  s.on('disconnect', (reason) => {
    store.setConnected(false);
    // A server that shuts down drops every socket itself, and Socket.IO does not retry that alone.
    if (reason === 'io server disconnect') s.connect();
  });
  s.on('hello', (e) => {
    // A reconnect may have missed events, so nothing live is trusted after one.
    if (bootId !== null) store.reset();
    bootId = e.bootId;
    void qc.invalidateQueries();
  });
  s.on('refresh', (e) => refresh(origin, e, inv));
  s.on('delta', (e) => store.append(e.threadId, e.turnId, e.text));
  s.on('tool', (e) => store.setTool(e.threadId, e.tool));
  s.on('notice', (e) => notices.forEach((fn) => fn(e)));
  s.on('turn', (e) => {
    store.setState(e.threadId, e.state);
    if (e.state !== 'running') store.setTool(e.threadId, null);
    inv('summaries', origin);
    inv('threads', origin, e.botId);
    // Who speaks in a room changes with every turn there.
    inv('rooms', origin);
    if (e.state === 'idle') {
      inv('main-thread', origin, e.botId);
      inv('library', origin, e.botId);
      inv('file-text', origin, e.botId);
      inv('today', origin);
      // The stream goes once the saved reply is in the cache, so the text never blinks out.
      const stream = store.streams[e.threadId];
      void qc.refetchQueries({ queryKey: ['messages', origin, e.threadId] }).then(() => {
        if (stream) store.drop(e.threadId, stream.turnId);
      });
    }
  });
  s.on('connect_error', (err) => {
    // Refused for want of a sign-in (worded in either language): find out whether it ended.
    if (/anahtar|access key/i.test(err.message)) inv('session', origin);
  });

  return () => {
    offShare();
    offActive.remove();
    s.removeAllListeners();
    s.close();
    store.setConnected(false);
    store.reset();
  };
}

function refresh(origin: string, e: RefreshScope, inv: (...key: unknown[]) => void) {
  switch (e.scope) {
    case 'bots':
      inv('bots', origin);
      inv('summaries', origin);
      break;
    case 'groups':
      inv('groups', origin);
      break;
    case 'rooms':
      inv('rooms', origin);
      break;
    case 'threads':
      inv('threads', origin, e.botId);
      inv('summaries', origin);
      break;
    case 'thread':
      // A room's list entry shows its latest line and who speaks.
      inv('rooms', origin);
      inv('messages', origin, e.threadId);
      inv('turn-changes', origin, e.threadId);
      inv('thread', origin, e.threadId);
      inv('main-thread', origin, e.botId);
      inv('threads', origin, e.botId);
      inv('summaries', origin);
      inv('job', origin);
      break;
    case 'approvals':
      inv('approvals', origin);
      inv('second-yes', origin);
      inv('summaries', origin);
      break;
    case 'promises':
      inv('promises', origin);
      break;
    case 'routineSuggestions':
      inv('routine-suggestions', origin);
      break;
    case 'skillSuggestions':
      inv('skill-suggestions', origin);
      break;
    case 'memory':
      inv('memory', origin);
      break;
    case 'routines':
      inv('routines', origin);
      // A routine's instruction may have changed, by a bot or on another device.
      inv('routine-rehearsals', origin);
      inv('routine-replayable', origin);
      inv('summaries', origin);
      break;
    case 'rules':
      inv('rules', origin);
      break;
    case 'vault':
      inv('vault', origin);
      break;
    case 'skills':
      inv('skills', origin);
      break;
    case 'connections':
      inv('connections', origin);
      break;
    case 'channels':
      inv('telegram', origin);
      inv('whatsapp', origin);
      break;
    case 'info':
      inv('info', origin);
      inv('providers', origin);
      break;
  }
}
