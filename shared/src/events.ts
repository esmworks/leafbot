import type { ComputerAck, ComputerState } from './computer.js';
import type { PhoneAnswer, PhoneAsk, PhoneKind } from './phone.js';
import type { BrowserInput, TurnState } from './schemas.js';

/** Scope of a `refresh` push: the client refetches only that slice over HTTP. */
export type RefreshScope =
  | { scope: 'bots' }
  | { scope: 'groups' }
  | { scope: 'threads'; botId: string }
  | { scope: 'thread'; threadId: string; botId: string }
  | { scope: 'approvals' }
  | { scope: 'memory' }
  | { scope: 'routines' }
  | { scope: 'promises' }
  | { scope: 'routineSuggestions' }
  | { scope: 'skillSuggestions' }
  | { scope: 'rules' }
  | { scope: 'vault' }
  | { scope: 'connections' }
  | { scope: 'skills' }
  | { scope: 'rooms' }
  | { scope: 'channels' }
  | { scope: 'tickets' }
  | { scope: 'tables'; botId: string }
  | { scope: 'actions'; botId: string }
  | { scope: 'info' }
  | { scope: 'people' }
  /** The Claude plan's usage windows changed, as a turn heard them. */
  | { scope: 'plan' };

export interface HelloEvent {
  bootId: string;
  /** Changes when a new version is deployed, not on a plain restart; null in development. */
  buildId?: string | null;
}

export interface DeltaEvent {
  threadId: string;
  turnId: string;
  /** Appended text for the in-progress assistant message. */
  text: string;
}

/**
 * Something the person may want to hear of while looking elsewhere: a bot's reply, a card that
 * waits for them, or a failed turn. The app decides whether to show it as a notification.
 */
export interface NoticeEvent {
  kind: 'reply' | 'needsYou' | 'error';
  /** For `needsYou`: what kind of card waits, so each can sound different. Missing from older servers. */
  need?: 'tool' | 'question' | 'login';
  botId: string;
  threadId: string;
  text: string;
  /**
   * Only these people are told, instead of those who see the conversation: a step waits for their
   * second yes and they do not see the conversation, so `threadId` is empty.
   */
  to?: string[];
}

export interface TurnEvent {
  threadId: string;
  botId: string;
  state: TurnState;
}

/**
 * The tool a running turn is using now, as the engine reports it (`Bash`, `mcp__notion__search`);
 * null once no tool runs. Live only, never stored: the "Working" line names it.
 */
export interface ToolEvent {
  threadId: string;
  tool: string | null;
}

/**
 * A bot's browser: `off` (not running), `idle`, `bot` (the bot is using it), `user` (a person took
 * control; the bot waits) or `window` (open as an ordinary window on the server's computer for a
 * person to use directly; the bot waits until it closes).
 */
export type BrowserStatus = 'off' | 'idle' | 'bot' | 'user' | 'window';

export interface BrowserState {
  botId: string;
  status: BrowserStatus;
  url: string | null;
  title: string | null;
  tabs: number;
}

/** One picture of the browser's screen, as JPEG bytes. Sent only to people watching that bot. */
export interface BrowserFrame {
  botId: string;
  data: ArrayBuffer | Uint8Array;
  width: number;
  height: number;
}

export type BrowserAck = { ok: true } | { ok: false; error: string };

export interface ServerToClientEvents {
  hello: (e: HelloEvent) => void;
  refresh: (e: RefreshScope) => void;
  delta: (e: DeltaEvent) => void;
  turn: (e: TurnEvent) => void;
  tool: (e: ToolEvent) => void;
  notice: (e: NoticeEvent) => void;
  'browser:state': (e: BrowserState) => void;
  'browser:frame': (e: BrowserFrame) => void;
  'computer:state': (e: ComputerState) => void;
  /** Screen bytes (RFB) for the one socket that opened the view. */
  'vnc:data': (e: { botId: string; data: ArrayBuffer | Uint8Array }) => void;
  'vnc:closed': (e: { botId: string }) => void;
  /** A bot reads from the person's phone; only the phone app, which offered that kind, answers. */
  'phone:ask': (e: PhoneAsk, ack: (a: PhoneAnswer) => void) => void;
}

export interface ClientToServerEvents {
  /** Start receiving a bot's screen; the answer is its current state. */
  'browser:watch': (botId: string, ack: (s: BrowserState | null) => void) => void;
  'browser:unwatch': (botId: string) => void;
  /** Take control (the browser starts if it is off) or give it back to the bot. */
  'browser:control': (e: { botId: string; on: boolean }, ack: (r: BrowserAck) => void) => void;
  'browser:input': (e: { botId: string; input: BrowserInput }) => void;
  /** Follow a bot's computer state; the answer is its current state (null: no computer). */
  'computer:watch': (botId: string, ack: (s: ComputerState | null) => void) => void;
  'computer:unwatch': (botId: string) => void;
  /** Start (wake) the desktop. */
  'computer:wake': (botId: string, ack: (r: ComputerAck) => void) => void;
  /** Take the mouse and keyboard, or give them back to the bot. */
  'computer:control': (e: { botId: string; on: boolean }, ack: (r: ComputerAck) => void) => void;
  /** Open a live screen stream (RFB) to the desktop; it must be running. */
  'vnc:open': (botId: string, ack: (r: ComputerAck) => void) => void;
  /** Bytes from the viewer. Input is dropped unless this socket's person has control. */
  'vnc:data': (e: { botId: string; data: ArrayBuffer | Uint8Array }) => void;
  'vnc:close': (botId: string) => void;
  /** The phone app says what its person lets bots read from it now; an empty list takes it back. */
  'phone:offer': (kinds: PhoneKind[]) => void;
}
