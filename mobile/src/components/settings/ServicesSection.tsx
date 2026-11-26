import {
  AI_DEFAULT_MODELS,
  AI_PROVIDER_URLS,
  elevenLabs,
  googleSpeech,
  servesAi,
  type AiEndpoint,
  type AiKind,
} from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { TextBox } from '@/components/dialogs/common';
import { toast, toastError } from '@/components/overlay';
import { Loading, PillButton, Section } from '@/components/page';
import { ChoiceRow, Hint, Pad, Rows } from '@/components/settings/common/controls';
import { providerName } from '@/components/settings/connect/ProviderConnect';
import { t, type MessageKey } from '@/i18n';
import { useProviders } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';

const KINDS: { kind: AiKind; title: MessageKey; hint: MessageKey; model: MessageKey }[] = [
  { kind: 'embeddings', title: 'ai.embeddings', hint: 'ai.embeddingsHint', model: 'ai.embeddingsModel' },
  { kind: 'stt', title: 'ai.stt', hint: 'ai.sttHint', model: 'ai.sttModel' },
  { kind: 'tts', title: 'ai.tts', hint: 'ai.ttsHint', model: 'ai.ttsModel' },
];

interface Option {
  value: string;
  label: string;
  baseUrl: string;
}

/**
 * The model services the server calls besides the bots' own: memory search by meaning, speech to
 * text and text to speech. Each goes through a provider connected under Providers, so a key is
 * saved once and serves the bots and these services alike.
 */
export function ServicesSection() {
  const api = useApi();
  const { origin } = useServer();
  const { data } = useQuery({ queryKey: ['ai-endpoints', origin], queryFn: api.aiEndpoints });
  const { data: providers } = useProviders();
  if (!data || !providers) return <Loading />;
  return (
    <>
      <Hint>{t('ai.intro')}</Hint>
      {KINDS.map((k) => (
        <ServiceForm
          key={`${k.kind}:${data[k.kind].source}:${data[k.kind].provider}:${data[k.kind].model}:${data[k.kind].voice}`}
          meta={k}
          current={data[k.kind]}
          options={providers
            .filter((p) => servesAi(k.kind, p))
            .map((p) => ({
              value: p.id,
              label: p.custom?.name ?? providerName(p.id),
              baseUrl: p.custom?.baseUrl ?? AI_PROVIDER_URLS[k.kind][p.id]!,
            }))}
          extra={
            k.kind === 'embeddings' && data[k.kind].source !== 'none'
              ? t('ai.indexed', { indexed: data.memoryIndex.indexed, total: data.memoryIndex.total })
              : undefined
          }
        />
      ))}
    </>
  );
}

function ServiceForm({
  meta,
  current,
  options,
  extra,
}: {
  meta: (typeof KINDS)[number];
  current: AiEndpoint;
  options: Option[];
  extra?: string;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const [provider, setProvider] = useState(current.provider);
  const [model, setModel] = useState(current.model);
  const [voice, setVoice] = useState(current.voice);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['ai-endpoints', origin] });
    // Whether the chat box offers speech follows these.
    void qc.invalidateQueries({ queryKey: ['transcribe', origin] });
    void qc.invalidateQueries({ queryKey: ['speech', origin] });
  };
  const save = useMutation({
    mutationFn: () => api.setAiEndpoint(meta.kind, { provider, model, voice }),
    onSuccess: () => {
      refresh();
      toast(t('ai.saved'));
    },
    onError: toastError,
  });
  const clear = useMutation({
    mutationFn: () => api.clearAiEndpoint(meta.kind),
    onSuccess: refresh,
    onError: toastError,
  });
  const test = useMutation({
    mutationFn: () => api.testAiEndpoint(meta.kind),
    onSuccess: (r) =>
      r.ok
        ? toast(t(`ai.testOk.${meta.kind}`, { detail: r.detail }))
        : toast(t('ai.testFailed', { detail: r.detail }), { tone: 'error' }),
    onError: toastError,
  });
  /** A newly picked provider starts with its usual model and voice, when it has them. */
  const pick = (id: string) => {
    setProvider(id);
    const usual = AI_DEFAULT_MODELS[meta.kind][id];
    if (usual) {
      setModel(usual.model);
      setVoice(usual.voice ?? '');
    }
  };
  // A provider saved earlier that lost its key stays listed, so the choice never shows empty.
  const all =
    current.gone && current.provider && !options.some((o) => o.value === current.provider)
      ? [{ value: current.provider, label: current.provider, baseUrl: '' }, ...options]
      : options;
  const at = all.find((o) => o.value === provider)?.baseUrl ?? '';
  const dirty = provider !== current.provider || model !== current.model || voice !== current.voice;
  return (
    <Section title={t(meta.title)}>
      <Rows>
        <Pad>
          <Hint>{t(meta.hint)}</Hint>
          {meta.kind === 'stt' || meta.kind === 'tts' ? <Hint>{t(`ai.elevenLabs.${meta.kind}`)}</Hint> : null}
          {meta.kind === 'tts' ? <Hint>{t('ai.google.tts')}</Hint> : null}
          {current.source === 'env' && !dirty ? <Hint>{t('ai.fromEnv')}</Hint> : null}
          {current.gone && !dirty ? <Hint>{t('ai.gone')}</Hint> : null}
          {all.length === 0 ? <Hint>{t('ai.noProvider')}</Hint> : null}
        </Pad>
        {all.length > 0 ? (
          <ChoiceRow
            label={t('ai.provider')}
            value={provider}
            options={all}
            onChange={pick}
            placeholder={t('ai.pickProvider')}
          />
        ) : null}
        {all.length > 0 ? (
          <Pad>
            <TextBox
              value={model}
              onChangeText={setModel}
              placeholder={t(meta.model)}
              accessibilityLabel={t('ai.model')}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {meta.kind === 'tts' ? (
              <TextBox
                value={voice}
                onChangeText={setVoice}
                placeholder={
                  elevenLabs(at) ? t('ai.voiceId') : googleSpeech(at) ? t('ai.voiceName') : t('ai.voice')
                }
                accessibilityLabel={t('ai.voice')}
                autoCapitalize="none"
                autoCorrect={false}
              />
            ) : null}
            {extra ? <Hint>{extra}</Hint> : null}
            <View style={styles.buttons}>
              {current.source === 'settings' ? (
                <PillButton label={t('ai.clear')} variant="ghost" onPress={() => clear.mutate()} />
              ) : null}
              {current.source !== 'none' && !current.gone && !dirty ? (
                <PillButton label={t('ai.test')} busy={test.isPending} onPress={() => test.mutate()} />
              ) : null}
              <PillButton
                label={t('common.save')}
                variant="primary"
                busy={save.isPending}
                disabled={!dirty || !provider || !model.trim()}
                onPress={() => save.mutate()}
              />
            </View>
          </Pad>
        ) : null}
      </Rows>
    </Section>
  );
}

const styles = StyleSheet.create({
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' },
});
