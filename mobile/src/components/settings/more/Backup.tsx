import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { TextBox } from '@/components/dialogs/common';
import { toastError } from '@/components/overlay';
import { PillButton, Section } from '@/components/page';
import { shareFile } from '@/components/panel/files';
import { Hint, Pad, Rows } from '../common/controls';
import { t } from '@/i18n';
import { useApi } from '@/lib/server';

/** The smallest backup password the server takes. */
const MIN_PASSWORD = 12;

/**
 * Everything on the server in one file sealed with a password, handed to the phone's share sheet
 * to keep it somewhere. Restoring one is done in the web or desktop app.
 */
export function Backup() {
  const api = useApi();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const { id } = await api.createBackup(password);
      const day = new Date().toISOString().slice(0, 10);
      await shareFile(`/api/backup/${id}`, `leafbot-backup-${day}.ybk`);
      setPassword('');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t('backup.title')} footer={t('backup.phoneRestore')}>
      <Rows>
        <Pad>
          <Hint>{t('backup.hint')}</Hint>
          <TextBox
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t('backup.passwordPlaceholder', { count: MIN_PASSWORD })}
            accessibilityLabel={t('backup.password')}
          />
        </Pad>
        <View style={styles.button}>
          <PillButton
            variant="primary"
            icon="download"
            label={t('backup.download')}
            onPress={() => void save()}
            busy={busy}
            disabled={password.length < MIN_PASSWORD}
          />
        </View>
      </Rows>
    </Section>
  );
}

const styles = StyleSheet.create({
  button: { alignItems: 'flex-end', padding: 12 },
});
