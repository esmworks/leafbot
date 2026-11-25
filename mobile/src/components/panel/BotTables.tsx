import type { Bot } from '@leafbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { StyleSheet, Text, View } from 'react-native';
import { t } from '@/i18n';
import { nav } from '@/lib/nav';
import { useBotTables } from '@/lib/queries';
import { useColors } from '@/lib/theme';
import { Block, SectionHead } from './parts';

/** The bot's tables in its panel; the section stays out of the way until the bot makes one. */
export function BotTables({ bot }: { bot: Bot }) {
  const c = useColors();
  const { data: tables = [] } = useBotTables(bot.id);
  if (!tables.length) return null;
  return (
    <View>
      <SectionHead title={t('tables.title')} />
      <View style={styles.list}>
        {tables.map((x) => (
          <Block key={x.id} style={styles.line} label={x.name} onPress={() => nav.table(bot.id, x.id)}>
            <Feather name="grid" size={20} color={c.mutedForeground} />
            <View style={styles.grow}>
              <Text style={[styles.name, { color: c.foreground }]} numberOfLines={1}>
                {x.name}
              </Text>
              <Text style={[styles.sub, { color: c.mutedForeground }]} numberOfLines={1}>
                {t('tables.rows', { count: x.rowCount })}
              </Text>
            </View>
            <Feather name="chevron-right" size={22} color={c.mutedForeground} />
          </Block>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 8 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  grow: { flex: 1, minWidth: 0 },
  name: { fontSize: 17, fontWeight: '500' },
  sub: { fontSize: 13, lineHeight: 18, marginTop: 1 },
});
