import { useEffect } from 'react';
import { useRoutines } from '@/lib/queries';
import { useUi } from '@/lib/store';
import type { Routine } from '@leafbot/shared';

/**
 * The routine the store has open, in place of its bot's chat: a saved one while it still exists,
 * or a new one. A routine deleted meanwhile closes.
 */
export function useOpenedRoutine(): { botId: string; routine?: Routine; showRuns: boolean } | null {
  const opened = useUi((s) => s.routine);
  const { data: routines, isFetching } = useRoutines();
  const routine = opened?.routineId ? routines?.find((r) => r.id === opened.routineId) : undefined;
  const gone = !!opened?.routineId && !!routines && !isFetching && !routine;
  useEffect(() => {
    if (gone) useUi.getState().closePage();
  }, [gone]);
  if (!opened || (opened.routineId && !routine)) return null;
  return { botId: opened.botId, routine, showRuns: !!opened.showRuns };
}
