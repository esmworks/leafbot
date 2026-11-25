import { useLocalSearchParams } from 'expo-router';
import { DashboardView } from '@/components/dialogs/DashboardsView';

export default function Screen() {
  const { dashboardId } = useLocalSearchParams<{ dashboardId: string }>();
  return <DashboardView id={dashboardId} />;
}
