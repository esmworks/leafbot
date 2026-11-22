import type { AiEndpoint, AiKind } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT, type MessageKey } from '@/i18n';
import { api } from '@/lib/api';
import { Card } from './SettingsPage';

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
 * text and text to speech. Each is an OpenAI-compatible address, such as a server of the person's
 * own (Ollama, a Whisper or Kokoro server) or a provider's API.
 */
export function AiServicesTab() {
  const t = useT();
  const { data } = useQuery({ queryKey: ['ai-endpoints'], queryFn: api.aiEndpoints });
  if (!data) return null;
  return (
    <>
      <p className="mb-4 px-1 text-sm text-muted-foreground">{t('ai.intro')}</p>
      {KINDS.map((k) => (
        <Card key={k.kind} title={t(k.title)}>
          <ServiceForm
            key={`${data[k.kind].source}:${data[k.kind].baseUrl}:${data[k.kind].model}`}
            meta={k}
            current={data[k.kind]}
            extra={
              k.kind === 'embeddings' && data[k.kind].source !== 'none'
                ? t('ai.indexed', { indexed: data.memoryIndex.indexed, total: data.memoryIndex.total })
                : undefined
            }
          />
        </Card>
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
  const t = useT();
  const qc = useQueryClient();
  const [baseUrl, setBaseUrl] = useState(current.baseUrl);
  const [model, setModel] = useState(current.model);
  const [voice, setVoice] = useState(current.voice);
  const [apiKey, setApiKey] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['ai-endpoints'] });
  const save = useMutation({
    mutationFn: () => api.setAiEndpoint(meta.kind, { baseUrl, model, voice, ...(apiKey ? { apiKey } : {}) }),
    onSuccess: () => {
      setApiKey('');
      void refresh();
      void qc.invalidateQueries({ queryKey: ['transcribe'] });
      void qc.invalidateQueries({ queryKey: ['speech'] });
      toast.success(t('ai.saved'));
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const clear = useMutation({
    mutationFn: () => api.clearAiEndpoint(meta.kind),
    onSuccess: () => {
      void refresh();
      void qc.invalidateQueries({ queryKey: ['transcribe'] });
      void qc.invalidateQueries({ queryKey: ['speech'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const test = useMutation({
    mutationFn: () => api.testAiEndpoint(meta.kind),
    onSuccess: (r) =>
      r.ok
        ? toast.success(t(`ai.testOk.${meta.kind}`, { detail: r.detail }))
        : toast.error(t('ai.testFailed', { detail: r.detail })),
    onError: (e) => toast.error((e as Error).message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const dirty = baseUrl !== current.baseUrl || model !== current.model || voice !== current.voice || !!apiKey;
  return (
    <form onSubmit={submit} className="space-y-2 px-4 py-3">
      <p className="text-xs text-muted-foreground">{t(meta.hint)}</p>
      {current.source === 'env' && !dirty && (
        <p className="text-xs text-muted-foreground">{t('ai.fromEnv')}</p>
      )}
      <Input
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        placeholder={t(meta.url)}
        aria-label={t('ai.baseUrl')}
        inputMode="url"
        required
      />
      <div className="flex gap-2">
        <Input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={t(meta.model)}
          aria-label={t('ai.model')}
          required
        />
        {meta.kind === 'tts' && (
          <Input
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
            placeholder={t('ai.voice')}
            aria-label={t('ai.voice')}
            className="w-40"
          />
        )}
      </div>
      <Input
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder={current.hasKey && current.source === 'settings' ? t('ai.keyKept') : t('ai.key')}
        aria-label={t('ai.key')}
        autoComplete="new-password"
      />
      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        {extra && <span className="mr-auto text-xs text-muted-foreground">{extra}</span>}
        {current.source === 'settings' && (
          <Button type="button" variant="ghost" className="rounded-full" onClick={() => clear.mutate()}>
            {t('ai.clear')}
          </Button>
        )}
        {current.source !== 'none' && !dirty && (
          <Button
            type="button"
            variant="secondary"
            className="rounded-full"
            disabled={test.isPending}
            onClick={() => test.mutate()}
          >
            {t('ai.test')}
          </Button>
        )}
        <Button type="submit" className="rounded-full" disabled={save.isPending || !dirty}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}
