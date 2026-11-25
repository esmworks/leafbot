import { elevenLabs, googleSpeech, type AiEndpoint, type AiKind } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { TextBox } from '@/components/dialogs/common';
import { toast, toastError } from '@/components/overlay';
import { Loading, PillButton, Section } from '@/components/page';
import { Hint, Pad, Rows } from '@/components/settings/common/controls';
import { t, type MessageKey } from '@/i18n';
import { useApi, useServer } from '@/lib/server';

const KINDS: { kind: AiKind; title: MessageKey; hint: MessageKey; model: MessageKey; url: MessageKey }[] = [
  {
    kind: 'embeddings',
    title: 'ai.embeddings',
    hint: 'ai.embeddingsHint',
    model: 'ai.embeddingsModel',
    url: 'ai.embeddingsUrl',
  },
  { kind: 'stt', title: 'ai.stt', hint: 'ai.sttHint', model: 'ai.sttModel', url: 'ai.sttUrl' },
  { kind: 'tts', title: 'ai.tts', hint: 'ai.ttsHint', model: 'ai.ttsModel', url: 'ai.ttsUrl' },
];

/**
 * The model services the server calls besides the bots' own: memory search by meaning, speech to
 * text and text to speech. Each is an OpenAI-compatible address, or ElevenLabs' or Google's own API
 * for speech.
 */
export function ServicesSection() {
  const api = useApi();
  const { origin } = useServer();
  const { data } = useQuery({ queryKey: ['ai-endpoints', origin], queryFn: api.aiEndpoints });
  if (!data) return <Loading />;
  return (
    <>
      <Hint>{t('ai.intro')}</Hint>
      {KINDS.map((k) => (
        <ServiceForm
          key={`${k.kind}:${data[k.kind].source}:${data[k.kind].baseUrl}:${data[k.kind].model}`}
          meta={k}
          current={data[k.kind]}
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
  extra,
}: {
  meta: (typeof KINDS)[number];
  current: AiEndpoint;
  extra?: string;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const [baseUrl, setBaseUrl] = useState(current.baseUrl);
  const [model, setModel] = useState(current.model);
  const [voice, setVoice] = useState(current.voice);
  const [apiKey, setApiKey] = useState('');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['ai-endpoints', origin] });
    // Whether the chat box offers speech follows these.
    void qc.invalidateQueries({ queryKey: ['transcribe', origin] });
    void qc.invalidateQueries({ queryKey: ['speech', origin] });
  };
  const save = useMutation({
    mutationFn: () => api.setAiEndpoint(meta.kind, { baseUrl, model, voice, ...(apiKey ? { apiKey } : {}) }),
    onSuccess: () => {
      setApiKey('');
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
  const dirty = baseUrl !== current.baseUrl || model !== current.model || voice !== current.voice || !!apiKey;
  return (
    <Section title={t(meta.title)}>
      <Rows>
        <Pad>
          <Hint>{t(meta.hint)}</Hint>
          {meta.kind === 'stt' || meta.kind === 'tts' ? <Hint>{t(`ai.elevenLabs.${meta.kind}`)}</Hint> : null}
          {meta.kind === 'tts' ? <Hint>{t('ai.google.tts')}</Hint> : null}
          {current.source === 'env' && !dirty ? <Hint>{t('ai.fromEnv')}</Hint> : null}
          <TextBox
            value={baseUrl}
            onChangeText={setBaseUrl}
            placeholder={t(meta.url)}
            accessibilityLabel={t('ai.baseUrl')}
            keyboardType="url"
            autoCapitalize="none"
            autoCorrect={false}
          />
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
                elevenLabs(baseUrl)
                  ? t('ai.voiceId')
                  : googleSpeech(baseUrl)
                    ? t('ai.voiceName')
                    : t('ai.voice')
              }
              accessibilityLabel={t('ai.voice')}
              autoCapitalize="none"
              autoCorrect={false}
            />
          ) : null}
          <TextBox
            value={apiKey}
            onChangeText={setApiKey}
            secureTextEntry
            placeholder={current.hasKey && current.source === 'settings' ? t('ai.keyKept') : t('ai.key')}
            accessibilityLabel={t('ai.key')}
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="password"
          />
          {extra ? <Hint>{extra}</Hint> : null}
          <View style={styles.buttons}>
            {current.source === 'settings' ? (
              <PillButton label={t('ai.clear')} variant="ghost" onPress={() => clear.mutate()} />
            ) : null}
            {current.source !== 'none' && !dirty ? (
              <PillButton label={t('ai.test')} busy={test.isPending} onPress={() => test.mutate()} />
            ) : null}
            <PillButton
              label={t('common.save')}
              variant="primary"
              busy={save.isPending}
              disabled={!dirty || !baseUrl.trim() || !model.trim()}
              onPress={() => save.mutate()}
            />
          </View>
        </Pad>
      </Rows>
    </Section>
  );
}

const styles = StyleSheet.create({
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' },
});
