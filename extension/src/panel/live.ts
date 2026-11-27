import type {
  ClientToServerEvents,
  DeltaEvent,
  RefreshScope,
  ServerToClientEvents,
  TurnEvent,
} from '@leafbot/shared';
import { io, type Socket } from 'socket.io-client';
import { answerAsk, chromeBrowser, type Browser } from '../share';

export interface LiveHandlers {
  onConnected(connected: boolean): void;
  onDelta(e: DeltaEvent): void;
  onTurn(e: TurnEvent): void;
  onRefresh(e: RefreshScope): void;
}

/**
 * The panel's live connection to the server: the bot's reply as it is written, and the questions
 * the server puts to this Chrome. It offers Chrome only while sharing is on, and tells the server
 * again after every reconnect, since the server forgets a socket that went away.
 */
export class Live {
  private socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  private sharing: boolean;
  private browser: Browser;
  private origin: string;

  constructor(origin: string, sharing: boolean, askToRead: Browser['askToRead'], h: LiveHandlers) {
    this.sharing = sharing;
    this.origin = origin;
    this.browser = chromeBrowser(askToRead);
    this.socket = io(origin, { path: '/socket.io', withCredentials: true });
    this.socket.on('connect', () => {
      this.socket.emit('chrome:offer', this.sharing);
      h.onConnected(true);
    });
    this.socket.on('disconnect', () => h.onConnected(false));
    this.socket.on('delta', h.onDelta);
    this.socket.on('turn', h.onTurn);
    this.socket.on('refresh', h.onRefresh);
    // Answered with what sharing is at the moment of the question, not when the panel opened.
    this.socket.on('chrome:ask', (ask, ack) => {
      void answerAsk(ask, this.sharing, this.browser, this.origin).then(ack);
    });
  }

  /**
   * This panel's socket while it is connected and shares Chrome; a message sent with it lets its turn
   * read this Chrome, and no other the person has.
   */
  get panelId(): string | undefined {
    return this.sharing && this.socket.connected ? this.socket.id : undefined;
  }

  setSharing(sharing: boolean) {
    this.sharing = sharing;
    if (this.socket.connected) this.socket.emit('chrome:offer', sharing);
  }

  close() {
    this.socket.removeAllListeners();
    this.socket.disconnect();
  }
}
