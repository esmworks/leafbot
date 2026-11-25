import type { Bot } from '@leafbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { PillButton } from '@/components/page';
import { toastError } from '@/components/overlay';
import { t } from '@/i18n';
import { usePermissionSuggestions } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';
import { Block } from './parts';

/**
 * Ways to ask less, read from the person's own answers on this bot's cards: a step they always
 * allowed can become an "always allow" rule, and a bot whose cards they nearly always allowed can
 * go ahead by itself. Each is one tap, or turned down for good.
 */
export function BotSuggestions({ bot }: { bot: Bot }) {
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const { data } = usePermissionSuggestions(bot.id);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['suggestions', origin, bot.id] });
  const allow = useMutation({
    mutationFn: (pattern: string) => api.addRule({ list: 'allow', pattern, botId: bot.id }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rules', origin] });
      refresh();
    },
    onError: toastError,
  });
  const full = useMutation({
    mutationFn: () => api.updateBot(bot.id, { permissionMode: 'auto' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bots', origin] });
      refresh();
    },
    onError: toastError,
  });
  const dismiss = useMutation({
    mutationFn: (key: string) => api.dismissSuggestion(bot.id, key),
    onSuccess: refresh,
    onError: toastError,
  });
  const busy = allow.isPending || full.isPending || dismiss.isPending;
  // An older server has no suggestions to give.
  if (!data || (!data.rules.length && !data.mode)) return null;
  const row = (key: string, text: string, action: ReactNode, why?: string) => (
    <Block key={key} style={styles.item}>
      <Text style={[styles.text, { color: c.foreground }]}>{text}</Text>
      {why ? <Text style={[styles.why, { color: c.mutedForeground }]}>{why}</Text> : null}
      <View style={styles.buttons}>
        {action}
        <PillButton
          label={t('suggest.notNow')}
          variant="ghost"
          disabled={busy}
          onPress={() => dismiss.mutate(key)}
        />
      </View>
    </Block>
  );
  return (
    <View>
      <View style={styles.head}>
        <Feather name="zap" size={16} color={c.mutedForeground} />
        <Text style={[styles.title, { color: c.foreground }]} accessibilityRole="header">
          {t('suggest.title')}
        </Text>
      </View>
      <View style={styles.list}>
        {data.mode
          ? row(
              'mode',
              t('suggest.full', { allowed: data.mode.allowed, total: data.mode.allowed + data.mode.denied }),
              <PillButton
                label={t('suggest.fullOn')}
                variant="primary"
                disabled={busy}
                onPress={() => full.mutate()}
              />,
            )
          : null}
        {data.rules.map((r) =>
          row(
            r.pattern,
            // A rule narrower than the tool (one command, one folder, one site) says how far it goes.
            r.pattern.includes('(') ? `${r.summary} · ${r.pattern}` : r.summary,
            <PillButton
              label={t('suggest.allow')}
              variant="primary"
              disabled={busy}
              onPress={() => allow.mutate(r.pattern)}
            />,
            t('suggest.rule', { count: r.allowed }),
          ),
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  title: { fontSize: 17, fontWeight: '600' },
  list: { gap: 8 },
  item: { gap: 8 },
  text: { fontSize: 16, lineHeight: 22 },
  why: { fontSize: 13, lineHeight: 18 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
