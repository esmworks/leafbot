import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { PillButton, Section, SwitchRow } from '@/components/page';
import { shareFile } from '@/components/panel/files';
import { Hint, Pad, Rows } from '../common/controls';
import { t } from '@/i18n';
import { useBots } from '@/lib/queries';

/** Bots written to an import file, to move them to another LeafBot or keep a copy. */
export function ExportBots() {
  const { data: bots = [] } = useBots();
  const [off, setOff] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const picked = bots.filter((b) => !off.has(b.id));
  if (!bots.length) return null;
  const share = async () => {
    setBusy(true);
    await shareFile(`/api/export/bots?ids=${picked.map((b) => b.id).join(',')}`, 'leafbot-bots.json');
    setBusy(false);
  };
  return (
    <Section title={t('export.title')}>
      <Rows>
        <Pad>
          <Hint>{t('export.hint')}</Hint>
        </Pad>
        {bots.map((b) => (
          <SwitchRow
            key={b.id}
            label={b.name}
            value={!off.has(b.id)}
            onChange={(on) =>
              setOff((prev) => {
                const next = new Set(prev);
                if (on) next.delete(b.id);
                else next.add(b.id);
                return next;
              })
            }
          />
        ))}
        <View style={styles.button}>
          <PillButton
            variant="primary"
            icon="download"
            label={t('export.download', { count: picked.length })}
            onPress={() => void share()}
            busy={busy}
            disabled={!picked.length}
          />
        </View>
      </Rows>
    </Section>
  );
}

const styles = StyleSheet.create({
  button: { alignItems: 'flex-end', padding: 12 },
});
