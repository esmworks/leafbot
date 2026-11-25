import type { Bot } from '@leafbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { StyleSheet, Text, View } from 'react-native';
import { PillButton } from '@/components/page';
import { t } from '@/i18n';
import { nav } from '@/lib/nav';
import { useColors } from '@/lib/theme';
import { Block } from './parts';

/** In the bot's panel, only while its instructions document has a change that waits, or could not be read. */
export function InstructionsDocNotice({ bot }: { bot: Bot }) {
  const c = useColors();
  if (!bot.instructionsUrl || (bot.instructionsPending == null && !bot.instructionsError)) return null;
  const pending = bot.instructionsPending != null;
  return (
    <Block style={styles.block}>
      <View style={styles.line}>
        <Feather
          name={pending ? 'file-text' : 'alert-circle'}
          size={18}
          color={pending ? c.mutedForeground : c.destructive}
        />
        <Text style={[styles.text, { color: c.foreground }]}>
          {pending
            ? t('instructionsDoc.changed')
            : t('instructionsDoc.unreadable', { why: bot.instructionsError ?? '' })}
        </Text>
      </View>
      {pending ? (
        <View style={styles.buttons}>
          <PillButton
            label={t('instructionsDoc.review')}
            variant="primary"
            onPress={() => nav.instructions(bot.id)}
          />
        </View>
      ) : null}
    </Block>
  );
}

const styles = StyleSheet.create({
  block: { gap: 10 },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  text: { flex: 1, fontSize: 16, lineHeight: 22 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
