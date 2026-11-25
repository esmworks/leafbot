import type { Bot } from '@leafbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Loading, Note } from '@/components/page';
import { locale, t } from '@/i18n';
import { formatters } from '@/lib/format';
import { nav } from '@/lib/nav';
import { useLibrary } from '@/lib/queries';
import { useApi } from '@/lib/server';
import { useColors } from '@/lib/theme';
import { fileSize, phonePreviewKind, shareFile } from './files';
import { Block } from './parts';

const fmt = formatters(locale, t);

/** The files in the bot's folders; one that can be shown opens in the preview, any can be shared. */
export function Library({ bot }: { bot: Bot }) {
  const c = useColors();
  const api = useApi();
  const { data: files = [], isLoading, isError } = useLibrary(bot.id);
  if (isLoading) return <Loading />;
  if (isError) return <Note tone="error">{t('panel.filesFailed')}</Note>;
  if (!files.length) {
    return (
      <Block>
        <Text style={[styles.empty, { color: c.mutedForeground }]}>{t('panel.noFiles')}</Text>
      </Block>
    );
  }
  const paths = files.filter((f) => phonePreviewKind(f.name) !== null).map((f) => f.path);
  return (
    <View style={styles.list}>
      {files.map((f) => {
        const info = (
          <>
            <View style={[styles.icon, { backgroundColor: c.muted }]}>
              <Feather name="file-text" size={20} color={c.foreground} />
            </View>
            <View style={styles.text}>
              <Text style={[styles.name, { color: c.foreground }]} numberOfLines={1}>
                {f.name}
              </Text>
              <Text style={[styles.meta, { color: c.mutedForeground }]}>
                {fileSize(f.size)} · {fmt.dayLabel(f.modifiedAt)}
              </Text>
            </View>
          </>
        );
        const share = () => void shareFile(api.fileUrl(bot.id, f.path), f.name);
        const canOpen = phonePreviewKind(f.name) !== null;
        return (
          <View key={f.path} style={styles.item}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t(canOpen ? 'preview.open' : 'message.download', { name: f.name })}
              onPress={canOpen ? () => nav.file(bot.id, f.path, paths) : share}
              style={({ pressed }) => [styles.main, pressed && { backgroundColor: c.accent }]}
            >
              {info}
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('message.download', { name: f.name })}
              hitSlop={4}
              onPress={share}
              style={styles.action}
            >
              <Feather name="download" size={22} color={c.mutedForeground} />
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 6 },
  empty: { fontSize: 16, lineHeight: 22 },
  item: { flexDirection: 'row', alignItems: 'center' },
  main: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 16,
  },
  icon: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1, minWidth: 0 },
  name: { fontSize: 17, fontWeight: '500' },
  meta: { fontSize: 13, marginTop: 1 },
  action: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
});
