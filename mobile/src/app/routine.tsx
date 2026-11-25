import { useLocalSearchParams } from 'expo-router';
import { RoutineEditor } from '@/components/dialogs/RoutineForm';

/** Create a routine (for `botId`, or a bot picked on the page) or edit `routineId`. */
export default function Screen() {
  const { botId, routineId, showRuns } = useLocalSearchParams<{
    botId?: string;
    routineId?: string;
    showRuns?: string;
  }>();
  return (
    <RoutineEditor
      botId={botId || undefined}
      routineId={routineId || undefined}
      showRuns={showRuns === '1'}
    />
  );
}
