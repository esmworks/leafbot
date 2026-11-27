import type { ApiSource } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileJson, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { BotAccess } from './VaultTab';

const NO_KEY = '__none__';

/**
 * OpenAPI documents whose operations bots may call. Each goes to the API's own address with one
 * of the saved API keys, added by the server; a bot lists the operations and calls one by its id.
 */
export function ApiSources() {
  const t = useT();
  const qc = useQueryClient();
  const { data: sources = [] } = useQuery({ queryKey: ['api-sources'], queryFn: api.apiSources });
  const [adding, setAdding] = useState(false);
  const refresh = useMutation({
    mutationFn: (id: string) => api.refreshApiSource(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-sources'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.removeApiSource(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-sources'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <section className="space-y-2">
      <div className="flex items-start gap-2 px-1">
        <div className="flex-1 space-y-1">
          <h3 className="text-sm font-medium">{t('apiSources.title')}</h3>
          <p className="text-xs leading-relaxed text-muted-foreground">{t('apiSources.note')}</p>
        </div>
        <Button size="sm" variant="secondary" className="rounded-full" onClick={() => setAdding(true)}>
          <Plus /> {t('common.add')}
        </Button>
      </div>
      {adding && <SourceForm onDone={() => setAdding(false)} />}
      {sources.length > 0 && (
        <div className="divide-y rounded-2xl border bg-card/50">
          {sources.map((s: ApiSource) => (
            <div key={s.id} className="flex items-center gap-3 px-4 py-3">
              <FileJson className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {s.name}
                  {s.title && <span className="font-normal text-muted-foreground"> · {s.title}</span>}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {t('apiSources.summary', { count: s.operations, url: s.baseUrl })}
                  {s.credential ? ` · 🔑 ${s.credential}` : ''}
                  {s.botIds ? ` · ${t('vault.someBots', { count: s.botIds.length })}` : ''}
                </div>
              </div>
              {s.specUrl && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="rounded-full"
                  disabled={refresh.isPending}
                  onClick={() => refresh.mutate(s.id)}
                  aria-label={t('apiSources.refresh')}
                  title={t('apiSources.refresh')}
                >
                  <RefreshCw />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="rounded-full"
                onClick={() => {
                  if (confirm(t('apiSources.confirmDelete', { name: s.name }))) remove.mutate(s.id);
                }}
                aria-label={t('common.delete')}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SourceForm({ onDone }: { onDone(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: keys = [] } = useQuery({ queryKey: ['api-keys'], queryFn: api.apiKeys });
  const [name, setName] = useState('');
  const [specUrl, setSpecUrl] = useState('');
  const [spec, setSpec] = useState('');
  const [pasting, setPasting] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [credential, setCredential] = useState(NO_KEY);
  const [botIds, setBotIds] = useState<string[] | null>(null);
  const save = useMutation({
    mutationFn: () =>
      api.addApiSource({
        name,
        ...(pasting ? { spec } : { specUrl }),
        ...(baseUrl.trim() && { baseUrl: baseUrl.trim() }),
        credential: credential === NO_KEY ? null : credential,
        botIds,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['api-sources'] });
      onDone();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-2 rounded-2xl border bg-background p-3">
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('apiSources.name')}
        aria-label={t('apiSources.name')}
        required
      />
      {pasting ? (
        <Textarea
          value={spec}
          onChange={(e) => setSpec(e.target.value)}
          placeholder={t('apiSources.paste')}
          rows={5}
          className="font-mono text-xs"
          required
        />
      ) : (
        <Input
          value={specUrl}
          onChange={(e) => setSpecUrl(e.target.value)}
          placeholder={t('apiSources.specUrl')}
          aria-label={t('apiSources.specUrl')}
          inputMode="url"
          required
        />
      )}
      <button
        type="button"
        className="px-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
        onClick={() => setPasting((v) => !v)}
      >
        {t(pasting ? 'apiSources.useUrl' : 'apiSources.usePaste')}
      </button>
      <Input
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        placeholder={t('apiSources.baseUrl')}
        aria-label={t('apiSources.baseUrl')}
        inputMode="url"
      />
      <Select value={credential} onValueChange={setCredential}>
        <SelectTrigger aria-label={t('apiSources.key')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_KEY}>{t('apiSources.noKey')}</SelectItem>
          {keys.map((k) => (
            <SelectItem key={k.id} value={k.name}>
              🔑 {k.name} · {k.origin}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <BotAccess botIds={botIds} onChange={setBotIds} />
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" className="rounded-full" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" className="rounded-full" disabled={save.isPending}>
          {t('common.add')}
        </Button>
      </div>
    </form>
  );
}
