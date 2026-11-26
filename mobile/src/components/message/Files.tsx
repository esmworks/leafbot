import type { MessageFile } from '@leafbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { t } from '@/i18n';
import { nav } from '@/lib/nav';
import { useApi } from '@/lib/server';
import { useColors } from '@/lib/theme';
import { fileSize, isImage } from './util';

/**
 * The files of a message: pictures drawn in place, other files as chips. A tap opens the file
 * screen, stepping through the message's other saved files. A message still being sent has no saved
 * path yet, so its files are shown without opening.
 */
export function MessageFiles({
  files,
  botId,
  align = 'end',
}: {
  files: MessageFile[];
  botId?: string;
  /** The person's files sit on the right, a bot's on the left. */
  align?: 'start' | 'end';
}) {
  const api = useApi();
  const c = useColors();
  const saved = botId ? files.filter((f) => f.path).map((f) => f.path) : [];
  return (
    <View style={[styles.wrap, { justifyContent: align === 'end' ? 'flex-end' : 'flex-start' }]}>
      {files.map((f) => {
        const open = botId && f.path ? () => nav.file(botId, f.path, saved) : undefined;
        const label = t('preview.open', { name: f.name });
        if (botId && f.path && isImage(f.name)) {
          return (
            <Pressable key={f.path} accessibilityRole="imagebutton" accessibilityLabel={label} onPress={open}>
              <Image
                source={{ uri: api.fileUrl(botId, f.path, { inline: true, thumb: true }) }}
                accessibilityLabel={f.name}
                contentFit="cover"
                style={[styles.image, { borderColor: c.border }]}
              />
            </Pressable>
          );
        }
        return (
          <Pressable
            key={f.path || f.name}
            accessibilityRole="button"
            accessibilityLabel={label}
            disabled={!open}
            onPress={open}
            style={({ pressed }) => [
              styles.chip,
              { borderColor: c.border, backgroundColor: pressed ? c.accent : c.card },
            ]}
          >
            <View style={[styles.icon, { backgroundColor: c.muted }]}>
              <Feather name="file-text" size={20} color={c.foreground} />
            </View>
            <View style={styles.chipText}>
              <Text style={[styles.name, { color: c.foreground }]} numberOfLines={1}>
                {f.name}
              </Text>
              <Text style={[styles.size, { color: c.mutedForeground }]}>{fileSize(f.size)}</Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, maxWidth: '92%' },
  image: { width: 220, height: 180, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    maxWidth: 256,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  icon: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  chipText: { flexShrink: 1 },
  name: { fontSize: 16, fontWeight: '500' },
  size: { fontSize: 13 },
});
