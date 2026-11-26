import {
  type ClientToServerEvents,
  type RefreshScope,
  type ServerToClientEvents,
  streamEnded,
} from '@leafbot/shared';
import type { QueryClient } from '@tanstack/react-query';
import { io, type Socket, WebSocket as WebSocketTransport } from 'socket.io-client';
import { toast } from 'sonner';
import { getT } from '@/i18n';
import { browserSocketClosed, onBrowserReconnect, useBrowsers } from './browser';
import { computerSocketClosed, onComputerReconnect, useComputers } from './computer';
import { catchUp, catchUpWatched } from './liveCatchUp';
import { notice, watchAnswered } from './notify';
import { watchOutbox } from './outbox';
import { useUi } from './store';
import { restartTyping } from './typewriter';
import { currentTunnel } from './transport';
import { serverBuild } from './update';

/**
 * Realtime channel. Pushes only say what changed; lasting state is always refetched over HTTP.
 * The session cookie authenticates the connection (same origin).
 */
export function connectRealtime(qc: QueryClient, opts: { notices?: boolean } = {}): () => void {
  const tunnel = currentTunnel();
  // Through the tunnel each connection is a channel of its own; the server never sees this
  // origin's address or cookies.
  const s: Socket<ServerToClientEvents, ClientToServerEvents> = tunnel
    ? io({
        path: '/socket.io',
        transports: [
          class TunnelTransport extends WebSocketTransport {
            override createSocket() {
              return tunnel.realtime() as unknown as WebSocket;
            }
          },
        ],
      })
    : io({
        path: '/socket.io',
        transports: ['websocket'],
        withCredentials: true,
      });
  let bootId: string | null = null;
  const ui = useUi.getState;
  const stopWatching = watchAnswered(qc);
  const outbox = watchOutbox(qc);

  s.on('connect', () => {
    ui().setConnected(true);
    onBrowserReconnect(s);
    onComputerReconnect(s);
    outbox.flush();
  });
  s.on('disconnect', (reason) => {
    ui().setConnected(false);
    // A server shutting down (a restart, a redeploy) drops every socket itself, and Socket.IO does
    // not retry that on its own; reconnecting here falls into the usual backoff until it is back.
    if (reason === 'io server disconnect') s.connect();
  });
  s.on('hello', (e) => {
    // Reconnects can miss events; a new boot means every cached view is stale.
    if (bootId !== null) ui().resetLive();
    bootId = e.bootId;
    serverBuild(e.buildId);
    void qc.invalidateQueries();
    // A reply being written while the socket was down is brought in from where it is now.
    catchUpWatched();
  });
  s.on('refresh', (e) => refresh(qc, e));
  s.on('delta', (e) => {
    // The earlier attempt's words go: the new ones are typed from their own start.
    if (e.restart) restartTyping(e.turnId);
    // Words before these went missing: what the bot has written so far is fetched.
    if (ui().appendStream(e.threadId, e.turnId, e.text, e.restart, e.at)) catchUp(e.threadId);
    ui().markWriting(e.threadId);
  });
  s.on('tool', (e) => ui().setTool(e.threadId, e.tool));
  s.on('turn', (e) => {
    ui().setState(e.threadId, e.state);
    if (e.state !== 'running') ui().setTool(e.threadId, null);
    void qc.invalidateQueries({ queryKey: ['summaries'] });
    void qc.invalidateQueries({ queryKey: ['threads', e.botId] });
    // Who speaks in a room changes with every turn there.
    void qc.invalidateQueries({ queryKey: ['rooms'] });
    if (e.state === 'idle') {
      void qc.invalidateQueries({ queryKey: ['library', e.botId] });
      // A file open in the preview may have been rewritten by the turn that just ended.
      void qc.invalidateQueries({ queryKey: ['file-text', e.botId] });
    }
    // The streamed turn ended, though the next may already run: its text goes once the saved
    // message is in the cache. Left in place, it would stand for the next turn's reply and hide
    // that the bot is at work.
    const stream = ui().streams[e.threadId];
    if (stream && streamEnded(stream.turnId, e)) {
      void qc.refetchQueries({ queryKey: ['messages', e.threadId] }).then(() => {
        ui().dropStream(e.threadId, stream.turnId);
      });
    } else if (e.state === 'idle') {
      void qc.refetchQueries({ queryKey: ['messages', e.threadId] });
    }
  });
  // A page inside the phone app leaves sounds and notifications to the phone.
  if (opts.notices !== false) s.on('notice', (e) => notice(qc, e));
  s.on('browser:state', (e) => useBrowsers.getState().setState(e));
  s.on('browser:frame', (e) => useBrowsers.getState().setFrame(e));
  s.on('computer:state', (e) => useComputers.getState().setState(e));
  s.on('connect_error', (err) => {
    // The refusal is worded in either language; both name the access key.
    if (/anahtar|access key/i.test(err.message)) ui().setAuthed(false);
  });
  return () => {
    stopWatching();
    outbox.stop();
    s.removeAllListeners();
    s.close();
    browserSocketClosed(s);
    computerSocketClosed(s);
  };
}

function refresh(qc: QueryClient, e: RefreshScope) {
  const inv = (...queryKey: unknown[]) => void qc.invalidateQueries({ queryKey });
  switch (e.scope) {
    case 'bots':
      inv('bots');
      inv('summaries');
      break;
    case 'groups':
      inv('groups');
      break;
    case 'rooms':
      inv('rooms');
      break;
    case 'threads':
      inv('threads', e.botId);
      inv('summaries');
      break;
    case 'thread':
      // A room's list entry shows its latest line and who speaks.
      inv('rooms');
      inv('meetings', e.threadId);
      inv('messages', e.threadId);
      inv('turn-changes', e.threadId);
      inv('thread', e.threadId);
      inv('threads', e.botId);
      inv('summaries');
      inv('job');
      break;
    case 'approvals':
      inv('approvals');
      inv('second-yes');
      inv('summaries');
      // An answered card counts toward ways to ask less.
      inv('suggestions');
      break;
    case 'memory':
      inv('memory');
      break;
    case 'routineMade': {
      // Set up while the person may be reading something else; the routine is a click away.
      const open = useUi.getState().routine;
      if (open?.routineId === e.routineId) break;
      toast.success(getT()('routines.made', { name: e.name }), {
        id: `routine-${e.routineId}`,
        action: {
          label: getT()('routines.madeOpen'),
          onClick: () => useUi.getState().openRoutine({ botId: e.botId, routineId: e.routineId }),
        },
      });
      break;
    }
    case 'routines':
      inv('routines');
      // A routine's instruction may have changed, by a bot or on another device.
      inv('routine-revisions');
      inv('routine-versions');
      inv('routine-rehearsals');
      inv('routine-replayable');
      // A run that ended, or a routine changed, changes how it stands.
      inv('routine-health');
      inv('summaries');
      // A run's line in a conversation shows how the run stands.
      inv('messages');
      break;
    case 'promises':
      inv('promises');
      break;
    case 'routineSuggestions':
      inv('routine-suggestions');
      break;
    case 'skillSuggestions':
      inv('skill-suggestions');
      break;
    case 'rules':
      inv('rules');
      inv('suggestions');
      break;
    case 'vault':
      inv('vault');
      break;
    case 'skills':
      inv('skills');
      break;
    case 'connections':
      inv('connections');
      break;
    case 'channels':
      inv('telegram');
      inv('whatsapp');
      inv('slack');
      inv('slack-link');
      inv('discord');
      inv('teams');
      inv('teams-link');
      break;
    case 'tickets':
      inv('tickets');
      break;
    case 'tables':
      inv('tables', e.botId);
      inv('table-rows');
      // A dashboard's table tiles are worked out from the rows as they are now.
      inv('dashboard');
      break;
    case 'dashboards':
      inv('dashboards');
      inv('dashboard');
      break;
    case 'actions':
      inv('actions', e.botId);
      break;
    case 'info':
      inv('info');
      inv('providers');
      // The model catalog came in: lists fill in with names and new models.
      inv('provider-models');
      break;
    case 'plan':
      inv('plan-usage');
      inv('usage');
      break;
    case 'people':
      inv('people');
      // A changed role changes what this device may do.
      inv('session');
      inv('bots');
      break;
  }
}
