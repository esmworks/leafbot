import type { BotImportPlan } from '@leafbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { toast, toastError } from '@/components/overlay';
import { PillButton, Row, Section } from '@/components/page';
import { shareFile } from '@/components/panel/files';
import { Lead, Rows } from './common/controls';
import { Backup } from './more/Backup';
import { ExportBots } from './more/ExportBots';
import { PlanBots } from './more/PlanBots';
import { t, type MessageKey } from '@/i18n';
import type { PickedFile } from '@/lib/api';
import { serverFetch } from '@/lib/connection';
import { useApi, useServer } from '@/lib/server';

/** The steps the person runs in the other app to write the file this section reads. */
const INSTRUCTIONS = '/import/grok-bot-export.md';

/**
 * Bots from another app: the person runs the export instructions there, then picks the file it
 * writes. Everything in it is shown before anything is saved.
 */
export function ImportSection() {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const [file, setFile] = useState<PickedFile | null>(null);
  const [plan, setPlan] = useState<BotImportPlan | null>(null);
  const reset = () => {
    setFile(null);
    setPlan(null);
  };
  const preview = useMutation({
    mutationFn: api.previewBotImport,
    onSuccess: setPlan,
    onError: (e) => {
      reset();
      toastError(e);
    },
  });
  const commit = useMutation({
    mutationFn: api.importBots,
    onSuccess: (result) => {
      toast(t('import.done', { count: result.botIds.length }));
      reset();
      for (const key of ['bots', 'groups', 'memory', 'routines', 'skills'])
        void qc.invalidateQueries({ queryKey: [key, origin] });
    },
    onError: toastError,
  });
  const copyInstructions = async () => {
    try {
      const res = await serverFetch(INSTRUCTIONS);
      if (!res.ok) {
        res.cancel();
        throw new Error(String(res.status));
      }
      await Clipboard.setStringAsync(await res.text());
      toast(t('import.copied'));
    } catch {
      toast(t('import.copyFailed'), { tone: 'error' });
    }
  };
  const pick = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ['application/json', 'text/plain', '*/*'],
        copyToCacheDirectory: true,
      });
      const a = res.assets?.[0];
      if (res.canceled || !a) return;
      const picked = { uri: a.uri, name: a.name };
      setFile(picked);
      setPlan(null);
      preview.mutate(picked);
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <>
      <Lead>{t('import.hint')}</Lead>
      <Section title={t('import.step1')} footer={t('import.instructionsHint')}>
        <Rows>
          <Row
            icon="copy"
            label={t('import.instructions')}
            value={t('import.copy')}
            chevron={false}
            onPress={() => void copyInstructions()}
          />
          <Row
            icon="download"
            label={t('import.download')}
            chevron={false}
            onPress={() => void shareFile(INSTRUCTIONS, 'leafbot-export.md')}
          />
        </Rows>
      </Section>
      <Section title={t('import.step2')} footer={t('import.fileHint')}>
        <Row
          icon="file"
          label={file?.name ?? t('import.file')}
          value={t('import.choose')}
          chevron={false}
          busy={preview.isPending}
          disabled={commit.isPending}
          onPress={() => void pick()}
        />
      </Section>
      {plan && file ? (
        <>
          <Lead>{t('import.safety')}</Lead>
          <PlanBots plan={plan} />
          {plan.groups.length > 0 ? (
            <Section title={t('import.groups')}>
              <Rows>
                {plan.groups.map((g) => (
                  <Row
                    key={g.name}
                    label={g.name}
                    detail={g.members
                      .map((ref) => plan.bots.find((b) => b.ref === ref)?.name ?? ref)
                      .join(', ')}
                  />
                ))}
              </Rows>
            </Section>
          ) : null}
          {plan.warnings.length > 0 || plan.notImported.length > 0 ? (
            <Section title={t('import.leftOut')}>
              <Rows>
                {plan.warnings.map((w, i) => (
                  <Row key={`w${i}`} label={t(w.key as MessageKey, w.params)} />
                ))}
                {plan.notImported.map((n, i) => (
                  <Row
                    key={`n${i}`}
                    label={n.what}
                    detail={[n.bot && (plan.bots.find((b) => b.ref === n.bot)?.name ?? n.bot), n.reason]
                      .filter(Boolean)
                      .join(' · ')}
                  />
                ))}
              </Rows>
            </Section>
          ) : null}
          <View style={styles.buttons}>
            <PillButton
              variant="ghost"
              label={t('common.cancel')}
              onPress={reset}
              disabled={commit.isPending}
            />
            <PillButton
              variant="primary"
              label={t('import.confirm', { count: plan.bots.length })}
              onPress={() => commit.mutate(file)}
              busy={commit.isPending}
            />
          </View>
        </>
      ) : null}
      <ExportBots />
      <Backup />
    </>
  );
}

const styles = StyleSheet.create({
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
});
