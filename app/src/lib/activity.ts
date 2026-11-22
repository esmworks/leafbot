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

/** How much a state says about a bot at work; the stronger of two wins. */
const WEIGHT: Record<TurnState, number> = { idle: 0, queued: 1, running: 2, waiting: 3 };

/**
 * A bot's state for its avatar and its dot: the stronger of the live state of the conversation it
 * opens to and what was last fetched for all its conversations. A bot at work on a ticket or on
 * another bot's request is busy though the conversation it opens to is idle or only has a message
 * queued.
 */
export function botState(live: TurnState | undefined, fetched: TurnState | undefined): TurnState {
  const a = live ?? 'idle';
  const b = fetched ?? 'idle';
  return WEIGHT[b] > WEIGHT[a] ? b : a;
}
