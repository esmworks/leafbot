import {
  AI_DEFAULT_MODELS,
  AI_PROVIDER_URLS,
  elevenLabs,
  googleSpeech,
  servesAi,
  type AiEndpoint,
  type AiKind,
  type ProviderInfo,
} from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useT, type MessageKey } from '@/i18n';
import { api } from '@/lib/api';
import { useProviders } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { providerName } from './ProviderConnect';
import { Card, Row } from './SettingsPage';

const KINDS: { kind: AiKind; title: MessageKey; hint: MessageKey; model: MessageKey }[] = [
  { kind: 'embeddings', title: 'ai.embeddings', hint: 'ai.embeddingsHint', model: 'ai.embeddingsModel' },
  { kind: 'stt', title: 'ai.stt', hint: 'ai.sttHint', model: 'ai.sttModel' },
  { kind: 'tts', title: 'ai.tts', hint: 'ai.ttsHint', model: 'ai.ttsModel' },
];

interface AiOption {
  id: string;
  name: string;
  baseUrl: string;
}

/**
 * The providers that can serve a kind: a built-in one whose API does it and that has a saved key,
 * and every endpoint of the person's own, under the name they gave it.
 */
export function aiOptions(kind: AiKind, providers: ProviderInfo[]): AiOption[] {
  return providers
    .filter((p) => servesAi(kind, p))
    .map((p) => ({
      id: p.id,
      name: p.custom?.name ?? providerName(p.id),
      baseUrl: p.custom?.baseUrl ?? AI_PROVIDER_URLS[kind][p.id]!,
    }));
}

/**
 * The model services the server calls besides the bots' own: memory search by meaning, speech to
 * text and text to speech. Each goes through a provider connected under Providers, so a key is
 * saved once and serves the bots and these services alike.
 */
export function AiServicesTab() {
  const t = useT();
  const { data } = useQuery({ queryKey: ['ai-endpoints'], queryFn: api.aiEndpoints });
  const { data: providers } = useProviders();
  if (!data || !providers) return null;
  return (
    <>
      <p className="mb-8 text-sm leading-relaxed text-muted-foreground">{t('ai.intro')}</p>
      {KINDS.map((k) => (
        <Card key={k.kind} title={t(k.title)} hint={t(k.hint)}>
          <ServiceForm
            key={`${data[k.kind].source}:${data[k.kind].provider}:${data[k.kind].model}:${data[k.kind].voice}`}
            meta={k}
            current={data[k.kind]}
            options={aiOptions(k.kind, providers)}
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
  options,
  extra,
}: {
  meta: (typeof KINDS)[number];
  current: AiEndpoint;
  options: AiOption[];
  extra?: string;
}) {
  const t = useT();
  const qc = useQueryClient();
  const openSettings = useUi((s) => s.openSettings);
  const [provider, setProvider] = useState(current.provider);
  const [model, setModel] = useState(current.model);
  const [voice, setVoice] = useState(current.voice);
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['ai-endpoints'] });
    void qc.invalidateQueries({ queryKey: ['transcribe'] });
    void qc.invalidateQueries({ queryKey: ['speech'] });
  };
  const save = useMutation({
    mutationFn: () => api.setAiEndpoint(meta.kind, { provider, model, voice }),
    onSuccess: () => {
      done();
      toast.success(t('ai.saved'));
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const clear = useMutation({
    mutationFn: () => api.clearAiEndpoint(meta.kind),
    onSuccess: done,
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
  /** A newly picked provider starts with its usual model and voice, when it has them. */
  const pick = (id: string) => {
    setProvider(id);
    const usual = AI_DEFAULT_MODELS[meta.kind][id];
    if (usual) {
      setModel(usual.model);
      setVoice(usual.voice ?? '');
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const at = options.find((o) => o.id === provider)?.baseUrl ?? '';
  const dirty = provider !== current.provider || model !== current.model || voice !== current.voice;
  // A provider saved earlier that lost its key stays listed, so the box never shows empty.
  const listed = current.gone && current.provider && !options.some((o) => o.id === current.provider);
  const notes: MessageKey[] =
    meta.kind === 'stt'
      ? ['ai.elevenLabs.stt']
      : meta.kind === 'tts'
        ? ['ai.elevenLabs.tts', 'ai.google.tts']
        : [];
  const none = options.length === 0 && !listed;
  // A state worth saying (from the environment, provider gone) leads; the fields follow as labelled
  // rows, and the notes for one provider or another wait folded until someone sets that one up.
  return (
    <form onSubmit={submit} className="divide-y">
      {current.source === 'env' && !dirty && (
        <p className="px-4 py-3 text-xs text-muted-foreground">{t('ai.fromEnv')}</p>
      )}
      {current.gone && !dirty && <p className="px-4 py-3 text-xs text-destructive">{t('ai.gone')}</p>}
      {none ? (
        <Row label={t('ai.noProvider')}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-full"
            onClick={() => openSettings('providers')}
          >
            {t('ai.manageProviders')}
          </Button>
        </Row>
      ) : (
        <>
          <Row label={t('ai.provider')}>
            <Select value={provider || undefined} onValueChange={pick}>
              <SelectTrigger className="w-56 rounded-full" aria-label={t('ai.provider')}>
                <SelectValue placeholder={t('ai.pickProvider')} />
              </SelectTrigger>
              <SelectContent>
                {listed && <SelectItem value={current.provider}>{current.provider}</SelectItem>}
                {options.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <Row label={t('ai.model')}>
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={t(meta.model)}
              aria-label={t('ai.model')}
              className="w-56 rounded-full"
              required
            />
          </Row>
          {meta.kind === 'tts' && (
            <Row label={t('ai.voice')}>
              <Input
                value={voice}
                onChange={(e) => setVoice(e.target.value)}
                placeholder={
                  elevenLabs(at) ? t('ai.voiceId') : googleSpeech(at) ? t('ai.voiceName') : t('ai.voice')
                }
                aria-label={t('ai.voice')}
                className="w-56 rounded-full"
              />
            </Row>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-3">
            {extra && <span className="me-auto text-xs text-muted-foreground">{extra}</span>}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="rounded-full"
              onClick={() => openSettings('providers')}
            >
              {t('ai.manageProviders')}
            </Button>
            {current.source === 'settings' && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="rounded-full"
                onClick={() => clear.mutate()}
              >
                {t('ai.clear')}
              </Button>
            )}
            {current.source !== 'none' && !current.gone && !dirty && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="rounded-full"
                disabled={test.isPending}
                onClick={() => test.mutate()}
              >
                {t('ai.test')}
              </Button>
            )}
            <Button
              type="submit"
              size="sm"
              className="rounded-full"
              disabled={save.isPending || !dirty || !provider || !model.trim()}
            >
              {t('common.save')}
            </Button>
          </div>
        </>
      )}
      {notes.length > 0 && (
        <details className="group px-4 py-3">
          <summary className="cursor-pointer text-xs text-muted-foreground transition-colors select-none hover:text-foreground">
            {t('ai.setupNotes')}
          </summary>
          <div className="mt-2 space-y-2 text-xs leading-relaxed text-muted-foreground">
            {notes.map((n) => (
              <p key={n}>{t(n)}</p>
            ))}
          </div>
        </details>
      )}
    </form>
  );
}
