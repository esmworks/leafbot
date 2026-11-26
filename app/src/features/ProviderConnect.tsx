import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Loader2,
  LogIn,
  Pencil,
  RefreshCw,
  Server,
  X,
} from 'lucide-react';
import type { ProviderInfo, ProviderSignIn } from '@leafbot/shared';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { splitPiModel } from '@/lib/new-bot';
import { useProviderModelInfo, useProviderModels, useProviders } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Chip } from './onboarding/Chip';

/** Offered first; every other provider the server knows is under "Other". */
export const POPULAR = ['openai', 'google', 'openrouter', 'deepseek', 'xai', 'mistral', 'groq'];
/**
 * Product names, not words to translate. A provider missing here shows its id, which is also
 * how regional plans (`minimax-cn`, `xiaomi-token-plan-sgp`) stay told apart.
 */
const NAMES: Record<string, string> = {
  openai: 'OpenAI',
  'github-copilot': 'GitHub Copilot',
  google: 'Google Gemini',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
  xai: 'xAI',
  mistral: 'Mistral',
  groq: 'Groq',
  anthropic: 'Anthropic',
  baseten: 'Baseten',
  cerebras: 'Cerebras',
  fireworks: 'Fireworks',
  huggingface: 'Hugging Face',
  'kimi-coding': 'Kimi Coding',
  meta: 'Meta',
  minimax: 'MiniMax',
  moonshotai: 'Moonshot AI',
  nvidia: 'NVIDIA',
  opencode: 'OpenCode',
  'opencode-go': 'OpenCode Go',
  together: 'Together AI',
  'vercel-ai-gateway': 'Vercel AI Gateway',
  xiaomi: 'Xiaomi',
  zai: 'Z.ai',
};
export const providerName = (id: string) => NAMES[id] ?? id;
const byName = (a: string, b: string) => providerName(a).localeCompare(providerName(b));
/** The chip that opens the form for the person's own endpoint; never a provider id. */
const CUSTOM = '+custom';
/**
 * Plans the person signs in to instead of pasting a key, first among the chips. The chip value is
 * not a provider id for ChatGPT, whose provider (OpenAI) also takes a key.
 */
export const PLANS = [
  { chip: '+chatgpt', provider: 'openai', name: 'ChatGPT' },
  { chip: '+copilot', provider: 'github-copilot', name: 'GitHub Copilot' },
] as const;
/**
 * How a usable provider is named in a list of connections: an endpoint by its own name, a provider
 * used only through a plan by the plan (ChatGPT), any other by the provider.
 */
export function connectionName(p: ProviderInfo): string {
  if (p.custom) return p.custom.name;
  const plan = PLANS.find((x) => x.provider === p.id);
  return plan && p.signIn?.signedIn && !p.hint ? plan.name : providerName(p.id);
}
/** Providers reached only by signing in to a plan: no key chip for them. */
export const PLAN_ONLY = new Set(['github-copilot']);
/** Ollama's address on the same computer; an address, not a word to translate. */
const EXAMPLE_URL = 'http://localhost:11434/v1';

/**
 * Saves an API key for a provider other than Claude, with the providers already usable above the
 * form. The server keeps the key; the app only ever sees its last characters.
 */
export function ProviderKeyForm() {
  const { isLoading } = useProviders();
  if (isLoading) return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  return (
    <div className="space-y-4">
      <ProviderRows />
      <AddProviderForm />
    </div>
  );
}

/**
 * The providers that can be used: those with a key, and the person's own endpoints. `plain`
 * leaves out the frame, for rows that sit in a settings card.
 */
export function ProviderRows({ plain = false }: { plain?: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: providers = [] } = useProviders();
  const remove = useMutation({
    mutationFn: api.removeProviderKey,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['providers'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  const signOut = useMutation({
    mutationFn: api.signOut,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['providers'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  const planRow = (p: ProviderInfo) => (
    <div
      key={`${p.id}-plan`}
      className={cn('flex items-center gap-3 px-4 py-3', !plain && 'rounded-2xl border')}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
        <Check className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {PLANS.find((x) => x.provider === p.id)?.name ?? providerName(p.id)}
        </span>
        <span className="block truncate text-xs text-muted-foreground">{t('provider.signedIn')}</span>
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="rounded-full text-muted-foreground"
        onClick={() => signOut.mutate(p.id)}
        disabled={signOut.isPending}
      >
        <X /> {t('provider.signOut')}
      </Button>
    </div>
  );
  const keyRow = (p: ProviderInfo) => (
    <div key={p.id} className={cn('flex items-center gap-3 px-4 py-3', !plain && 'rounded-2xl border')}>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
        <Check className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{providerName(p.id)}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {t('provider.keySaved', { hint: p.hint ?? '' })}
        </span>
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="rounded-full text-muted-foreground"
        onClick={() => remove.mutate(p.id)}
        disabled={remove.isPending}
      >
        <X /> {t('common.remove')}
      </Button>
    </div>
  );
  // A provider can have both: a saved key and a sign-in with the person's plan.
  return providers
    .filter((p) => p.configured)
    .flatMap((p) => [
      ...(p.signIn?.signedIn ? [planRow(p)] : []),
      ...(p.custom ? [<EndpointRow key={p.id} provider={p} plain={plain} />] : p.hint ? [keyRow(p)] : []),
    ]);
}

/**
 * Picks a provider and takes its key, or adds the person's own endpoint. `onAdded` runs once a
 * key or an endpoint is saved.
 */
export function AddProviderForm({ onAdded }: { onAdded?: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: providers = [] } = useProviders();
  const [provider, setProvider] = useState('');
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.setProviderKey(current, key.trim()),
    onSuccess: () => {
      setKey('');
      setError(null);
      void qc.invalidateQueries({ queryKey: ['providers'] });
      onAdded?.();
    },
    onError: (e) => setError((e as Error).message),
  });
  const ids = providers.filter((p) => !p.custom && !PLAN_ONLY.has(p.id)).map((p) => p.id);
  const plans = PLANS.filter((x) => providers.some((p) => p.id === x.provider && p.signIn));
  const popular = POPULAR.filter((id) => ids.includes(id));
  const others = ids.filter((id) => !popular.includes(id)).sort(byName);
  const current = provider || popular[0] || ids[0] || '';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (key.trim()) save.mutate();
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="text-sm font-medium">{t('provider.pick')}</div>
      <div className="flex flex-wrap items-center gap-2">
        {plans.map((x) => (
          <Chip
            key={x.chip}
            on={current === x.chip}
            onClick={() => {
              setProvider(x.chip);
              setError(null);
            }}
          >
            <LogIn className="size-3.5" /> {x.name}
          </Chip>
        ))}
        {popular.map((id) => (
          <Chip
            key={id}
            on={current === id}
            onClick={() => {
              setProvider(id);
              setError(null);
            }}
          >
            {providerName(id)}
          </Chip>
        ))}
        {others.length > 0 && (
          <Select
            value={others.includes(current) ? current : ''}
            onValueChange={(id) => {
              setProvider(id);
              setError(null);
            }}
          >
            <SelectTrigger
              className={cn(
                'h-9 w-auto min-w-28 rounded-full',
                others.includes(current) && 'border-[var(--brand)]/60 bg-[var(--brand)]/10',
              )}
              aria-label={t('provider.other')}
            >
              <SelectValue placeholder={t('provider.other')} />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {others.map((id) => (
                <SelectItem key={id} value={id}>
                  {providerName(id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Chip
          on={current === CUSTOM}
          onClick={() => {
            setProvider(CUSTOM);
            setError(null);
          }}
        >
          <Server className="size-3.5" /> {t('provider.custom')}
        </Chip>
      </div>
      {current === CUSTOM ? (
        <EndpointForm onAdded={onAdded} />
      ) : PLANS.some((x) => x.chip === current) ? (
        <PlanSignIn key={current} plan={PLANS.find((x) => x.chip === current)!} onDone={onAdded} />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setError(null);
            }}
            aria-label={t('provider.keyFor', { provider: providerName(current) })}
            placeholder={t('provider.keyFor', { provider: providerName(current) })}
            className="h-10 min-w-56 flex-1 rounded-full px-4 font-mono"
          />
          <Button type="submit" className="h-10 rounded-full" disabled={!key.trim() || save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />}
            {t('common.save')}
          </Button>
        </div>
      )}
      {error && current !== CUSTOM && !current.startsWith('+') && (
        <p className="text-sm text-destructive">{error}</p>
      )}
    </form>
  );
}

/**
 * Signing in with the person's own plan. The server runs the sign-in; this shows what the person
 * does in their browser: open a page and type a code (Copilot), or sign in on a page that comes
 * back by itself on this computer, or whose final address is pasted here from elsewhere (ChatGPT).
 */
export function PlanSignIn({ plan, onDone }: { plan: (typeof PLANS)[number]; onDone?: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [session, setSession] = useState<ProviderSignIn | null>(null);
  const [enterprise, setEnterprise] = useState('');
  const [pasted, setPasted] = useState('');
  const copilot = plan.provider === 'github-copilot';
  const start = useMutation({
    mutationFn: () => api.startSignIn(plan.provider, copilot ? enterprise.trim() : undefined),
    onSuccess: setSession,
    onError: (e) => toast.error((e as Error).message),
  });
  const live = session && (session.status === 'starting' || session.status === 'waiting');
  const { data: polled } = useQuery({
    queryKey: ['sign-in', session?.id],
    queryFn: () => api.signIn(session!.id),
    enabled: !!live,
    refetchInterval: 1500,
  });
  const now = polled && polled.id === session?.id ? polled : session;
  useEffect(() => {
    if (now?.status !== 'done') return;
    toast.success(t('provider.signInDone', { provider: plan.name }));
    void qc.invalidateQueries({ queryKey: ['providers'] });
    onDone?.();
  }, [now?.status, plan.name, qc, t, onDone]);
  // Ends a sign-in left half-way when the form closes or another provider is picked.
  useEffect(() => {
    const id = session?.id;
    return () => {
      if (id) void api.cancelSignIn(id).catch(() => {});
    };
  }, [session?.id]);
  const paste = useMutation({
    mutationFn: () => api.pasteSignIn(now!.id, pasted.trim()),
    onSuccess: (s) => {
      setSession(s);
      setPasted('');
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (!now || now.status === 'cancelled' || now.status === 'error' || now.status === 'done') {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {t(copilot ? 'provider.copilotHint' : 'provider.chatgptHint')}
        </p>
        {copilot && (
          <Input
            value={enterprise}
            onChange={(e) => setEnterprise(e.target.value)}
            placeholder={t('provider.enterprise')}
            aria-label={t('provider.enterprise')}
            className="h-10 rounded-full px-4"
          />
        )}
        {now?.status === 'error' && <p className="text-sm text-destructive">{now.error}</p>}
        <Button className="h-10 rounded-full" onClick={() => start.mutate()} disabled={start.isPending}>
          {start.isPending ? <Loader2 className="animate-spin" /> : <LogIn />}
          {t('provider.signInWith', { provider: plan.name })}
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-3 rounded-2xl border p-4">
      {now.status === 'starting' && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      {now.userCode && (
        <div className="space-y-2">
          <p className="text-sm">{t('provider.deviceCode')}</p>
          <div className="flex items-center gap-2">
            <code className="rounded-xl bg-secondary px-3 py-1.5 font-mono text-lg tracking-widest">
              {now.userCode}
            </code>
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full"
              aria-label={t('message.copy')}
              onClick={() => void copyText(now.userCode!)}
            >
              <Copy />
            </Button>
          </div>
        </div>
      )}
      {now.url && (
        <Button asChild variant="outline" className="rounded-full">
          <a href={now.url} target="_blank" rel="noopener noreferrer">
            <ExternalLink /> {t('provider.openSignIn')}
          </a>
        </Button>
      )}
      {now.needsPaste && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (pasted.trim()) paste.mutate();
          }}
        >
          <p className="text-xs text-muted-foreground">{t('provider.pasteHint')}</p>
          <div className="flex flex-wrap gap-2">
            <Input
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder={t('provider.pastePlaceholder')}
              aria-label={t('provider.pastePlaceholder')}
              className="h-10 min-w-56 flex-1 rounded-full px-4 font-mono"
            />
            <Button type="submit" className="h-10 rounded-full" disabled={!pasted.trim() || paste.isPending}>
              {t('common.save')}
            </Button>
          </div>
        </form>
      )}
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" /> {t('provider.signInWaiting')}
      </p>
    </div>
  );
}

/** One of the person's own endpoints: its name, where it is, and its model list on request. */
export function EndpointRow({ provider: p, plain = false }: { provider: ProviderInfo; plain?: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const refresh = useMutation({
    mutationFn: () => api.refreshEndpoint(p.id),
    onSuccess: (models) => {
      qc.setQueryData(['provider-models', p.id], models);
      toast.success(t('provider.customRefreshed', { count: models.length }));
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: () => api.removeEndpoint(p.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['providers'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  const [editing, setEditing] = useState(false);
  if (editing)
    return (
      <div className={cn(plain && 'px-2 py-2')}>
        <EndpointEdit provider={p} onDone={() => setEditing(false)} />
      </div>
    );
  return (
    <div className={cn('flex items-center gap-3 px-4 py-3', !plain && 'rounded-2xl border')}>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
        <Server className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{p.custom!.name}</span>
        <span className="block truncate font-mono text-xs text-muted-foreground">
          {p.custom!.baseUrl}
          {p.hint ? ` · ${p.hint}` : ''}
        </span>
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="rounded-full text-muted-foreground"
        aria-label={t('provider.customEdit')}
        title={t('provider.customEdit')}
        onClick={() => setEditing(true)}
      >
        <Pencil />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="rounded-full text-muted-foreground"
        aria-label={t('provider.customRefresh')}
        title={t('provider.customRefresh')}
        onClick={() => refresh.mutate()}
        disabled={refresh.isPending}
      >
        <RefreshCw className={cn(refresh.isPending && 'animate-spin')} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="rounded-full text-muted-foreground"
        onClick={() => remove.mutate()}
        disabled={remove.isPending}
      >
        <X /> {t('common.remove')}
      </Button>
    </div>
  );
}

/** Model names typed into one field, split at commas and spaces. */
const modelList = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((m) => m.trim())
    .filter(Boolean);

/**
 * Changes a saved endpoint's name, address, key or models; an empty key field keeps the saved
 * key. The models start as the saved list, so one the server leaves out can be added by hand.
 */
export function EndpointEdit({ provider: p, onDone }: { provider: ProviderInfo; onDone(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState(p.custom!.name);
  const [baseUrl, setBaseUrl] = useState(p.custom!.baseUrl);
  const [key, setKey] = useState('');
  const { data: saved = [] } = useProviderModels(p.id);
  // Null until edited: the saved list may still be loading, and an untouched list is not sent.
  const [models, setModels] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      api.updateEndpoint(p.id, {
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        key: key.trim(),
        ...(models !== null ? { models: modelList(models) } : {}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['providers'] });
      void qc.invalidateQueries({ queryKey: ['provider-models', p.id] });
      onDone();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <form
      className="space-y-2 rounded-2xl border px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() && baseUrl.trim()) save.mutate();
      }}
    >
      <div className="flex flex-wrap gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label={t('provider.customName')}
          className="h-10 w-40 rounded-full px-4"
        />
        <Input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          aria-label={t('provider.customUrl')}
          spellCheck={false}
          className="h-10 min-w-56 flex-1 rounded-full px-4 font-mono"
        />
      </div>
      <Input
        value={models ?? saved.join(', ')}
        onChange={(e) => setModels(e.target.value)}
        aria-label={t('provider.customModelsEdit')}
        placeholder={t('provider.customModelsEdit')}
        title={t('provider.customModelsEdit')}
        spellCheck={false}
        className="h-10 rounded-full px-4 font-mono"
      />
      <div className="flex flex-wrap gap-2">
        <Input
          type="password"
          autoComplete="off"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          aria-label={t('provider.customKey')}
          placeholder={p.hint ? t('provider.customKeyKeep', { hint: p.hint }) : t('provider.customKey')}
          className="h-10 min-w-40 flex-1 rounded-full px-4 font-mono"
        />
        <Button type="button" variant="ghost" className="h-10 rounded-full" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button
          type="submit"
          className="h-10 rounded-full"
          disabled={save.isPending || !name.trim() || !baseUrl.trim()}
        >
          {save.isPending && <Loader2 className="animate-spin" />}
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}

/**
 * Adds an OpenAI-compatible endpoint, such as Ollama or LM Studio on this network, or a hosted
 * service. The server asks it for its models; the key is optional and stays on the server.
 */
export function EndpointForm({
  onAdded,
  hideFound = false,
}: {
  onAdded?: () => void;
  /** Leaves out the servers found on the server's computer, for a page that lists them itself. */
  hideFound?: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [key, setKey] = useState('');
  const [models, setModels] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () =>
      api.addEndpoint({
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        ...(key.trim() ? { key: key.trim() } : {}),
        ...(models.trim() ? { models: modelList(models) } : {}),
      }),
    onSuccess: () => {
      setName('');
      setBaseUrl('');
      setKey('');
      setModels('');
      setError(null);
      void qc.invalidateQueries({ queryKey: ['providers'] });
      onAdded?.();
    },
    onError: (e) => setError((e as Error).message),
  });
  const ready = !!name.trim() && !!baseUrl.trim() && !add.isPending;
  // Model servers already running on the server's computer, offered with one click.
  const { data: found = [] } = useQuery({
    queryKey: ['endpoint-discovery'],
    queryFn: api.discoverEndpoints,
    staleTime: 60_000,
  });
  const addFound = useMutation({
    mutationFn: (f: { name: string; baseUrl: string }) =>
      api.addEndpoint({ name: f.name, baseUrl: f.baseUrl }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['providers'] });
      void qc.invalidateQueries({ queryKey: ['endpoint-discovery'] });
      onAdded?.();
    },
    onError: (e) => setError((e as Error).message),
  });
  return (
    <div className="space-y-2">
      {!hideFound && found.length > 0 && (
        <div className="space-y-1.5 rounded-2xl border border-dashed p-3">
          <div className="text-xs font-medium text-muted-foreground">{t('provider.found')}</div>
          {found.map((f) => (
            <div key={f.baseUrl} className="flex items-center gap-3">
              <Server className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm">
                {f.name}{' '}
                <span className="text-xs text-muted-foreground">
                  {t('provider.foundModels', { count: f.models.length })}
                </span>
              </span>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="rounded-full"
                disabled={addFound.isPending}
                onClick={() => addFound.mutate(f)}
              >
                {t('common.add')}
              </Button>
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t('provider.customHint')}</p>
      <div className="flex flex-wrap gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label={t('provider.customName')}
          placeholder={t('provider.customName')}
          className="h-10 w-40 rounded-full px-4"
        />
        <Input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          aria-label={t('provider.customUrl')}
          placeholder={EXAMPLE_URL}
          spellCheck={false}
          className="h-10 min-w-56 flex-1 rounded-full px-4 font-mono"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          aria-label={t('provider.customKey')}
          placeholder={t('provider.customKey')}
          className="h-10 min-w-40 flex-1 rounded-full px-4 font-mono"
        />
        <Input
          value={models}
          onChange={(e) => setModels(e.target.value)}
          aria-label={t('provider.customModels')}
          placeholder={t('provider.customModels')}
          spellCheck={false}
          className="h-10 min-w-40 flex-1 rounded-full px-4 font-mono"
        />
        <Button
          type="button"
          className="h-10 rounded-full"
          disabled={!ready}
          onClick={() => {
            setError(null);
            add.mutate();
          }}
        >
          {add.isPending && <Loader2 className="animate-spin" />}
          {t('common.add')}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

/** True once a provider can be used: it has a key, or it is the person's own endpoint. */
export function useHasProvider() {
  const { data: providers = [] } = useProviders();
  return providers.some((p) => p.configured);
}

/**
 * Picks one model of a provider that has a key, as `provider/model`. Lists can be long, so the
 * model is typed with suggestions instead of picked from cards. With no provider yet it asks for
 * one right here, so the way on is not somewhere else on the page.
 */
export function PiModelPicker({
  value,
  onChange,
  empty,
}: {
  value: string;
  onChange(v: string): void;
  /** Shown while no provider can be used; the key form when left out. */
  empty?: ReactNode;
}) {
  const t = useT();
  const { data: providers = [] } = useProviders();
  const configured = providers.filter((p) => p.configured).map((p) => p.id);
  const parts = splitPiModel(value);
  const provider = configured.includes(parts.provider) ? parts.provider : (configured[0] ?? '');
  const model = provider === parts.provider ? parts.model : '';
  const { data: models = [] } = useProviderModelInfo(provider || null);
  if (!configured.length) return <>{empty ?? <ProviderKeyForm />}</>;
  return (
    <div className="flex flex-wrap gap-2">
      <Select value={provider} onValueChange={(p) => onChange(`${p}/`)}>
        <SelectTrigger className="h-10 w-44 rounded-full" aria-label={t('provider.provider')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {configured.map((id) => (
            <SelectItem key={id} value={id}>
              {providers.find((p) => p.id === id)?.custom?.name ?? providerName(id)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <ModelSearch
        value={model}
        models={models.map((m) => ({ value: m.id, name: m.name }))}
        onChange={(m) => onChange(`${provider}/${m}`)}
      />
    </div>
  );
}

/** A model the picker offers: the id that is saved, and a readable name when there is one. */
export interface ModelOption {
  value: string;
  name?: string;
}

/**
 * A model name field with the provider's models below it, narrowed to those whose id or name holds
 * what is typed. A name off the list stays allowed: the provider may serve models its list leaves
 * out. The list opens under the field and scrolls on its own, so a long one stays inside the window.
 */
export function ModelSearch({
  value,
  models,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  models: ModelOption[];
  onChange(model: string): void;
  placeholder?: string;
  /** For the field, e.g. to match the other fields of a form. */
  className?: string;
}) {
  const t = useT();
  const listId = useId();
  const [open, setOpen] = useState(false);
  // What was typed since the field took focus; until then every model is shown.
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const q = query.toLowerCase();
  const shown = q
    ? models.filter((m) => m.value.toLowerCase().includes(q) || m.name?.toLowerCase().includes(q))
    : models;
  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);
  const pick = (m: string) => {
    onChange(m);
    setQuery('');
    setOpen(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return setOpen(true);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (shown.length ? (i + step + shown.length) % shown.length : 0));
    } else if (e.key === 'Enter' && open && shown[active]) {
      e.preventDefault();
      pick(shown[active].value);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };
  return (
    <div className="relative min-w-56 flex-1">
      <Input
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        value={value}
        onFocus={(e) => {
          // Selected, so typing searches afresh instead of adding to the saved name. Deferred:
          // the click that focused the field would place the cursor and undo the selection.
          const field = e.currentTarget;
          setTimeout(() => field.select());
          setQuery('');
          setActive(
            Math.max(
              0,
              models.findIndex((m) => m.value === value),
            ),
          );
          setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen(true)}
        onChange={(e) => {
          const typed = e.target.value.trim();
          onChange(typed);
          setQuery(typed);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        aria-label={t('provider.model')}
        placeholder={placeholder ?? models[0]?.value ?? t('provider.model')}
        spellCheck={false}
        autoComplete="off"
        className={cn('h-10 rounded-full px-4 pe-9 font-mono', className)}
      />
      <ChevronDown className="pointer-events-none absolute top-1/2 end-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
      {open && (shown.length > 0 || q) && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-lg">
          {shown.length > 0 ? (
            <ul ref={list} id={listId} role="listbox" className="max-h-64 overflow-y-auto p-1">
              {shown.map((m, i) => (
                <li
                  key={m.value}
                  role="option"
                  aria-selected={m.value === value}
                  // Keeps the focus in the field, so the list does not close before the pick.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(m.value);
                  }}
                  onMouseMove={() => setActive(i)}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded-xl px-3 py-1.5 text-sm',
                    i === active && 'bg-accent text-accent-foreground',
                  )}
                >
                  {m.name && m.name !== m.value ? (
                    <span className="flex min-w-0 flex-1 items-baseline gap-2">
                      <span className="truncate">{m.name}</span>
                      <span className="truncate font-mono text-xs text-muted-foreground">{m.value}</span>
                    </span>
                  ) : (
                    <span className="min-w-0 flex-1 truncate font-mono">{m.value}</span>
                  )}
                  {m.value === value && <Check className="size-4 shrink-0 text-muted-foreground" />}
                </li>
              ))}
            </ul>
          ) : (
            <p id={listId} className="px-4 py-2.5 text-xs text-muted-foreground">
              {t('provider.modelUnlisted')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Tries the model with one short request, then makes it what new bots start with. */
/** Tries a `provider/model` and stores it for new bots, or as the backup model with `backup`. */
/** The settings a tried model can be saved to besides the start of new bots. */
export type PiModelField = 'backupModel' | 'piAdvisorModel';

export function useSavePiModel(onSaved?: () => void, field?: PiModelField) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async (ref: string) => {
      const { provider, model } = splitPiModel(ref);
      const r = await api.testProviderModel(provider, model);
      if (!r.ok) throw new Error(r.detail);
      await api.updateSettings(field ? { [field]: ref } : { defaultEngine: 'pi', piModel: ref });
    },
    onMutate: () => setError(null),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] });
      onSaved?.();
    },
    onError: (e) => setError((e as Error).message),
  });
  return { save, error };
}

/** True when `provider/model` names both parts. */
export function isPiModel(ref: string) {
  const { provider, model } = splitPiModel(ref);
  return !!provider && !!model;
}
