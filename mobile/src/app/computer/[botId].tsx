import { useLocalSearchParams } from 'expo-router';
import type { ReactNode } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { back, Empty, IconButton, Loading, Page } from '@/components/page';
import { BrowserView, DesktopView } from '@/components/panel/ComputerView';
import { t } from '@/i18n';
import { useTurnable } from '@/lib/orientation';
import { useBots, useInfo } from '@/lib/queries';
import { useColors } from '@/lib/theme';

/** The bot's browser, or its computer when the server gives bots one, as the web app's phone view. */
export default function ComputerScreen() {
  useTurnable();
  const { botId } = useLocalSearchParams<{ botId: string }>();
  const bots = useBots();
  const info = useInfo();
  const { width, height } = useWindowDimensions();
  const wide = width > height;
  const bot = bots.data?.find((b) => b.id === botId);
  if (!bot || !info.data) {
    return (
      <Page title="" scroll={false}>
        {bots.isLoading || info.isLoading ? (
          <Loading />
        ) : (
          <Empty icon="alert-circle" text={t('panel.loadFailed')} />
        )}
      </Page>
    );
  }
  const desktop = info.data.computer.status === 'ok';
  if (!desktop && info.data.browser.status !== 'ok') {
    return (
      <Page title={t('computer.browserTitleOf', { name: bot.name })} scroll={false}>
        <Empty icon="monitor" text={t('computer.unavailable')} />
      </Page>
    );
  }
  const view = desktop ? <DesktopView bot={bot} /> : <BrowserView bot={bot} wide={wide} />;
  if (wide) return <Sideways>{view}</Sideways>;
  return (
    <Page
      title={t(desktop ? 'computer.titleOf' : 'computer.browserTitleOf', { name: bot.name })}
      scroll={false}
    >
      {view}
    </Page>
  );
}

/** Turned sideways the screen gets the whole height: no title bar, the back button at the side. */
function Sideways({ children }: { children: ReactNode }) {
  const c = useColors();
  return (
    <SafeAreaView style={[styles.row, { backgroundColor: c.background }]} edges={['left', 'right', 'bottom']}>
      <View style={styles.side}>
        <IconButton icon="chevron-left" size={24} label={t('chat.back')} onPress={back} />
      </View>
      <View style={styles.fill}>{children}</View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: 'row' },
  side: { paddingTop: 8, paddingHorizontal: 2 },
  fill: { flex: 1 },
});
