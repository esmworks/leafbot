import { leavesForEngine, newBotEngine } from '@leafbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { confirm, toast, toastError } from '@/components/overlay';
import { PillButton, Row, SwitchRow } from '@/components/page';
import { ChoiceRow, Hint, Pad, useSaveSettings } from '../common/controls';
import {
  connectionName,
  isPiModel,
  ModelSearch,
  PiModelPicker,
  splitPiModel,
  useHasProvider,
  useSavePiModel,
} from '../connect/ProviderConnect';
import { CLAUDE } from './data';
import { t } from '@/i18n';
import { useBots, useProviderModels, useProviders, useSettings } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

/** The save button that tries the model first, with what came of it. */
function TrySave({
  busy,
  disabled,
  inUse,
  inUseText,
  error,
  onPress,
}: {
  busy: boolean;
  disabled: boolean;
  inUse: boolean;
  inUseText: string;
  error: string | null;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <View style={styles.gap2}>
      <View style={styles.tryRow}>
        <PillButton
          variant="primary"
          label={busy ? t('claude.testing') : t('provider.tryAndSave')}
          onPress={onPress}
          busy={busy}
          disabled={disabled}
        />
        {inUse ? <Text style={[styles.small, { color: c.mutedForeground }]}>{inUseText}</Text> : null}
      </View>
      {error ? (
        <Text style={[styles.small, { color: c.destructive }]}>
          {t('provider.failed', { detail: error })}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * What new bots start with: Claude, or a model of a connected provider. Picking Claude saves at
 * once; a provider's model is tried with one short request before it is saved.
 */
export function NewBotsRow({ onOpenClaude }: { onOpenClaude: () => void }) {
  const { data: settings } = useSettings();
  const { data: providers = [] } = useProviders();
  const save = useSaveSettings();
  const connected = providers.filter((p) => p.configured);
  const stored = settings?.defaultEngine === 'pi' ? (settings.piModel ?? '') : '';
  const [ref, setRef] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const pi = useSavePiModel(() => {
    setRef(null);
    setPicked(null);
  });
  const engine = picked ?? (stored ? splitPiModel(stored).provider : CLAUDE);
  const value =
    ref ?? (engine !== CLAUDE && splitPiModel(stored).provider === engine ? stored : `${engine}/`);
  const { data: models = [] } = useProviderModels(engine === CLAUDE ? null : engine);
  const saved = engine !== CLAUDE && value === stored;
  return (
    <View>
      <ChoiceRow
        label={t('model.newBots')}
        detail={t('model.newBotsHint')}
        value={engine}
        options={[
          { value: CLAUDE, label: t('ai.claude') },
          ...connected.map((p) => ({ value: p.id, label: connectionName(p) })),
        ]}
        onChange={(v) => {
          setPicked(v);
          setRef(null);
          if (v === CLAUDE && settings?.defaultEngine !== 'claude') save.mutate({ defaultEngine: 'claude' });
        }}
      />
      {engine === CLAUDE ? (
        <>
          <Row label={t('providers.claudeModel')} onPress={onOpenClaude} />
          {!connected.length ? (
            <Pad>
              <Hint>{t('providers.addFirst')}</Hint>
            </Pad>
          ) : null}
        </>
      ) : (
        <Pad>
          <ModelSearch
            value={splitPiModel(value).model}
            models={models}
            onChange={(m) => setRef(`${engine}/${m}`)}
          />
          <TrySave
            busy={pi.save.isPending}
            disabled={!isPiModel(value) || saved}
            inUse={saved}
            inUseText={t('provider.inUse')}
            error={pi.error}
            onPress={() => pi.save.mutate(value)}
          />
        </Pad>
      )}
      {(engine === CLAUDE ? settings?.defaultEngine !== 'pi' : saved) ? <MoveExistingBots /> : null}
    </View>
  );
}

/**
 * Offers to move the bots that run on another AI to what new bots start with, since changing
 * that setting leaves every existing bot as it was.
 */
function MoveExistingBots() {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const { data: bots = [] } = useBots();
  const target = newBotEngine(settings);
  const count = bots.filter((b) => leavesForEngine(b, target)).length;
  const move = useMutation({
    mutationFn: api.moveBotsToNewEngine,
    onSuccess: ({ changed }) => {
      void qc.invalidateQueries({ queryKey: ['bots', origin] });
      void qc.invalidateQueries({ queryKey: ['routines', origin] });
      toast(t('model.moved', { count: changed }));
    },
    onError: toastError,
  });
  if (!count) return null;
  const ask = async () => {
    const pi = target.engine === 'pi';
    const yes = await confirm({
      title: pi
        ? t('model.moveConfirm.pi', { count, model: target.model })
        : t('model.moveConfirm.claude', { count }),
      message: [t('model.moveKeeps'), ...(pi ? [t('bot.engineHint.pi')] : [])].join('\n\n'),
      confirmLabel: t('model.moveButton'),
    });
    if (yes) move.mutate();
  };
  return (
    <Pad>
      <Hint>{t('model.moveExisting', { count })}</Hint>
      <View style={styles.start}>
        <PillButton label={t('model.moveButton')} onPress={() => void ask()} busy={move.isPending} />
      </View>
    </Pad>
  );
}

/** The model that carries the work once the usage limit is spent, instead of waiting for it. */
export function BackupModel() {
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  const [on, setOn] = useState<boolean | null>(null);
  const [ref, setRef] = useState<string | null>(null);
  const pi = useSavePiModel(() => setRef(null), true);
  const hasProvider = useHasProvider();
  const stored = settings?.backupModel ?? '';
  const open = on ?? !!stored;
  const value = ref ?? stored;
  return (
    <View>
      <SwitchRow
        label={t('model.backup')}
        detail={t('model.backupHint')}
        value={open}
        onChange={(v) => {
          setOn(v);
          if (!v && stored) save.mutate({ backupModel: '' });
        }}
      />
      {open ? (
        <Pad>
          <PiModelPicker value={value} onChange={setRef} empty={<Hint>{t('providers.addFirst')}</Hint>} />
          {hasProvider ? (
            <TrySave
              busy={pi.save.isPending}
              disabled={!isPiModel(value) || value === stored}
              inUse={!!stored && value === stored}
              inUseText={t('providers.backupInUse')}
              error={pi.error}
              onPress={() => pi.save.mutate(value)}
            />
          ) : null}
        </Pad>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  gap2: { gap: 2 },
  small: { fontSize: 15, lineHeight: 20 },
  tryRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  start: { alignItems: 'flex-start' },
});
