import type { TurnState } from '@leafbot/shared';

// Kept apart from the hooks that read it from the stores, so the phone app can use it too.

/** What a bot is doing right now, as its avatar shows it. */
export type BotActivity = 'idle' | 'queued' | 'thinking' | 'writing' | 'browsing' | 'waiting';

export interface ActivityInput {
  state: TurnState;
  pendingApprovals: number;
  /** Text of the current answer is arriving right now (not paused for a tool). */
  streaming: boolean;
  /** The bot is driving its browser. */
  browsing: boolean;
}

/** Waiting on a person wins over everything; then whatever the running turn is busy with. */
export function activityOf({ state, pendingApprovals, streaming, browsing }: ActivityInput): BotActivity {
  if (pendingApprovals > 0 || state === 'waiting') return 'waiting';
  if (state === 'queued') return 'queued';
  if (state !== 'running') return 'idle';
  if (browsing) return 'browsing';
  return streaming ? 'writing' : 'thinking';
}

/**
 * A bot's state for its avatar: the live state of the conversation it opens to, or, while that one
 * is idle, what was last fetched for all its conversations. A bot at work on a ticket or on another
 * bot's request is busy though the conversation it opens to has just gone idle.
 */
export function botState(live: TurnState | undefined, fetched: TurnState | undefined): TurnState {
  return live && live !== 'idle' ? live : (fetched ?? live ?? 'idle');
}
