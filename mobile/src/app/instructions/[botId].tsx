import { textDiff, type Bot } from '@leafbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { toastError } from '@/components/overlay';
import { back, Empty, Loading, Page, PillButton } from '@/components/page';
import { t } from '@/i18n';
import { useBots } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

/**
 * The instructions document's new text against the instructions the bot uses now. Nothing reaches
 * the bot until the person accepts; the text accepted is the one on the screen.
 */
export default function Screen() {
  const { botId } = useLocalSearchParams<{ botId: string }>();
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const { data: bots, isLoading } = useBots();
  const bot = bots?.find((b) => b.id === botId);
  const saved = (b: Bot) => {
    qc.setQueryData<Bot[]>(['bots', origin], (old = []) => old.map((x) => (x.id === b.id ? b : x)));
    void qc.invalidateQueries({ queryKey: ['bots', origin] });
    back();
  };
  const accept = useMutation({
    mutationFn: (expected: string) => api.acceptInstructionsDoc(botId, expected),
    onSuccess: saved,
    onError: toastError,
  });
  const decline = useMutation({
    mutationFn: () => api.declineInstructionsDoc(botId),
    onSuccess: saved,
    onError: toastError,
  });
  if (isLoading) {
    return (
      <Page title="">
        <Loading />
      </Page>
    );
  }
  const pending = bot?.instructionsPending;
  if (!bot || pending == null) {
    return (
      <Page title={bot?.name ?? ''}>
        <Empty icon="check" text={t('instructionsDoc.nothingWaits')} />
      </Page>
    );
  }
  const busy = accept.isPending || decline.isPending;
  return (
    <Page title={t('instructionsDoc.reviewTitle', { name: bot.name })}>
      <Text style={[styles.hint, { color: c.mutedForeground }]}>{t('instructionsDoc.reviewHint')}</Text>
      <View style={[styles.diff, { backgroundColor: c.muted }]}>
        <Text selectable style={[styles.text, { color: c.foreground }]}>
          {textDiff(bot.instructions, pending).map((p, i) =>
            p.type === 'same' ? (
              <Text key={i}>{p.text}</Text>
            ) : p.type === 'removed' ? (
              <Text
                key={i}
                style={{
                  color: c.destructive,
                  backgroundColor: `${c.destructive}22`,
                  textDecorationLine: 'line-through',
                }}
              >
                {p.text}
              </Text>
            ) : (
              <Text key={i} style={{ color: c.success, backgroundColor: `${c.success}22` }}>
                {p.text}
              </Text>
            ),
          )}
        </Text>
      </View>
      <View style={styles.buttons}>
        <PillButton
          label={t('instructionsDoc.decline')}
          variant="ghost"
          disabled={busy}
          busy={decline.isPending}
          onPress={() => decline.mutate()}
        />
        <PillButton
          label={t('instructionsDoc.accept')}
          variant="primary"
          disabled={busy}
          busy={accept.isPending}
          onPress={() => accept.mutate(pending)}
        />
      </View>
    </Page>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 15, lineHeight: 20 },
  diff: { borderRadius: 14, padding: 12 },
  text: { fontSize: 15, lineHeight: 21 },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8 },
});
