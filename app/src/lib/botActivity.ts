import type { BotSummary, TurnState } from '@leafbot/shared';
import { activityOf, botState, type BotActivity } from './activity';
import { useBrowsers } from './browser';
import { useSummaries } from './queries';
import { useUi } from './store';

export { activityOf, botState, type ActivityInput, type BotActivity } from './activity';

/** The activity of a bot in one thread, from the live events; `fallback` is the state last fetched. */
export function useThreadActivity(
  botId: string,
  threadId: string | null | undefined,
  fallback: TurnState = 'idle',
  pendingApprovals = 0,
): BotActivity {
  const live = useUi((s) => (threadId ? s.states[threadId] : undefined));
  const streaming = useUi((s) => !!threadId && !!s.writing[threadId]);
  const browsing = useBrowsers((s) => s.states[botId]?.status === 'bot');
  return activityOf({ state: live ?? fallback, pendingApprovals, streaming, browsing });
}

/** The activity of a bot from its sidebar summary and the live events. */
export function useBotActivity(botId: string, summary?: BotSummary): BotActivity {
  const threadId = summary?.threadId;
  const live = useUi((s) => (threadId ? s.states[threadId] : undefined));
  const streaming = useUi((s) => !!threadId && !!s.writing[threadId]);
  const browsing = useBrowsers((s) => s.states[botId]?.status === 'bot');
  return activityOf({
    state: botState(live, summary?.state),
    pendingApprovals: summary?.pendingApprovals ?? 0,
    streaming,
    browsing,
  });
}

/** Same as useBotActivity, for places that have only the bot. */
export function useBotActivityById(botId: string): BotActivity {
  const { data } = useSummaries();
  return useBotActivity(
    botId,
    data?.find((s) => s.botId === botId),
  );
}
