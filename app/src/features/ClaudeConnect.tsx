import type { ProviderSignIn, ServerInfo } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ExternalLink, Loader2, LogIn, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useClaudeAuth, useInfo, usePeople } from '@/lib/queries';
import { cn } from '@/lib/utils';

type Method = 'token' | 'apiKey';

/** Where Anthropic says which sign-ins products built on Claude Code may use. */
const TERMS_URL = 'https://code.claude.com/docs/en/legal-and-compliance';

/** The Claude status as one line: which sign-in the server uses and whether it works. */
export function useClaudeState() {
  const { data: info } = useInfo();
  const { data: auth, isLoading } = useClaudeAuth();
  const claude = info?.claude;
  return {
    loading: isLoading || !info,
    /** Null: a server older than the in-app sign-in. */
    auth,
    connected: claude?.status === 'ok',
    /** Not checked since the server started. */
    unknown: !claude || claude.status === 'unknown',
    claude,
  };
}

/**
 * Connects Claude: signing in with the person's Claude account first, and behind "other ways" a
 * subscription token from `claude setup-token` or an Anthropic API key. Saving a token or key tries
 * it with one real request, so "Connected" means Claude answered.
 */
export function ClaudeConnect({ checking = false }: { checking?: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const { loading, auth, connected, unknown, claude } = useClaudeState();
  const { data: people } = usePeople();
  const [open, setOpen] = useState(false);
  const [other, setOther] = useState(false);
  const [method, setMethod] = useState<Method>('token');
  const [value, setValue] = useState('');
  const [gateway, setGateway] = useState('');
  const [result, setResult] = useState<ServerInfo['claude'] | null>(null);
  const refresh = () =>
    Promise.all(['info', 'claude-auth', 'claude-models'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
  const save = useMutation({
    mutationFn: () =>
      api.setClaudeAuth({
        kind: method,
        value,
        ...(method === 'apiKey' && gateway.trim() ? { baseUrl: gateway.trim() } : {}),
      }),
    onSuccess: (r) => {
      setResult(r);
      if (r.status === 'ok') {
        setValue('');
        setOpen(false);
      }
      void refresh();
    },
    onError: (e) => setResult({ status: 'error', detail: (e as Error).message }),
  });
  const clear = useMutation({
    mutationFn: api.clearClaudeAuth,
    onSuccess: () => {
      setResult(null);
      void refresh();
    },
  });

  if (auth === null) return <p className="text-sm text-muted-foreground">{t('claude.oldServer')}</p>;
  if (loading) return <Loader2 className="size-4 animate-spin text-muted-foreground" />;

  const current =
    auth?.kind === 'token'
      ? t('claude.usingToken', { hint: auth.hint ?? '' })
      : auth?.kind === 'apiKey'
        ? auth.baseUrl
          ? t('claude.usingGateway', { hint: auth.hint ?? '', url: auth.baseUrl })
          : t('claude.usingApiKey', { hint: auth.hint ?? '' })
        : t('claude.usingLogin');
  const pending = checking || unknown;
  // Everyone's turns run on one subscription once others are on the server, which Anthropic's
  // terms do not allow; the owner is told so and decides, nothing is stopped.
  const sharedSubscription =
    connected && auth?.kind !== 'apiKey' && (people?.filter((p) => !p.disabled).length ?? 0) > 1;
  const showForm = open || (!connected && !pending);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) save.mutate();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3">
        <span
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-full',
            pending
              ? 'bg-secondary text-muted-foreground'
              : connected
                ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                : 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
          )}
        >
          {checking ? (
            <Loader2 className="size-4 animate-spin" />
          ) : unknown ? (
            <span className="size-2 rounded-full bg-current" />
          ) : connected ? (
            <Check className="size-4" />
          ) : (
            <X className="size-4" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">
            {checking ? t('claude.checking') : connected || unknown ? current : t('claude.notConnected')}
          </span>
          {!checking && (unknown || (connected && claude?.detail)) && (
            <span className="block text-xs text-muted-foreground">
              {unknown ? t('connection.status.unknown') : claude?.detail}
            </span>
          )}
        </span>
        {!checking && (connected || unknown) && !open && (
          <Button variant="ghost" size="sm" className="rounded-full" onClick={() => setOpen(true)}>
            {t('claude.useOther')}
          </Button>
        )}
        {auth && auth.kind !== 'login' && (
          <Button
            variant="ghost"
            size="sm"
            className="rounded-full text-muted-foreground"
            title={t('claude.removeHint')}
            onClick={() => clear.mutate()}
            disabled={clear.isPending}
          >
            {t('claude.remove')}
          </Button>
        )}
      </div>

      {sharedSubscription && !checking && (
        <div className="space-y-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
          <p>{t('claude.sharedSubscription')}</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <a
              href={TERMS_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              {t('claude.sharedTerms')} <ExternalLink className="size-3.5" />
            </a>
            {!open && (
              <button
                type="button"
                className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                onClick={() => {
                  setOpen(true);
                  setOther(true);
                  setMethod('apiKey');
                  setResult(null);
                }}
              >
                {t('claude.useApiKey')}
              </button>
            )}
          </div>
        </div>
      )}

      {showForm && (
        <ClaudeSignIn
          onDone={() => {
            setOpen(false);
            setOther(false);
            setResult(null);
            void refresh();
          }}
        />
      )}
      {showForm && !other && (
        <button
          type="button"
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          onClick={() => setOther(true)}
        >
          {t('claude.otherWays')}
        </button>
      )}
      {showForm && other && (
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
            {(['token', 'apiKey'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={method === m}
                onClick={() => {
                  setMethod(m);
                  setResult(null);
                }}
                className={cn(
                  'rounded-2xl border px-4 py-3 text-start transition-colors hover:bg-accent',
                  method === m && 'border-[var(--brand)]/60 bg-[var(--brand)]/10 hover:bg-[var(--brand)]/15',
                )}
              >
                <span className="block text-sm font-medium">{t(`claude.method.${m}`)}</span>
                <span className="block text-xs text-muted-foreground">{t(`claude.method.${m}Hint`)}</span>
              </button>
            ))}
          </div>
          {method === 'token' ? (
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>{t('claude.tokenStep1')}</p>
              <code className="block w-fit rounded-lg bg-secondary px-3 py-1.5 font-mono text-[13px] text-foreground select-all">
                claude setup-token
              </code>
              <p>{t('claude.tokenStep2')}</p>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">{t('claude.apiKeyBody')}</p>
              <Input
                type="url"
                spellCheck={false}
                value={gateway}
                onChange={(e) => {
                  setGateway(e.target.value);
                  setResult(null);
                }}
                aria-label={t('claude.gateway')}
                placeholder={t('claude.gatewayPlaceholder')}
                className="h-10 rounded-full px-4 text-sm"
              />
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setResult(null);
              }}
              aria-label={t(`claude.method.${method}`)}
              placeholder={t(method === 'token' ? 'claude.tokenPlaceholder' : 'claude.apiKeyPlaceholder')}
              className="h-10 min-w-56 flex-1 rounded-full px-4"
            />
            <Button type="submit" className="h-10 rounded-full" disabled={!value.trim() || save.isPending}>
              {save.isPending && <Loader2 className="animate-spin" />}
              {save.isPending ? t('claude.testing') : t('claude.saveAndTest')}
            </Button>
          </div>
          {result && result.status !== 'ok' && (
            <p className="text-sm text-destructive">
              {result.status === 'logged-out'
                ? t('claude.invalid')
                : t('claude.failed', { detail: result.detail ?? result.reason ?? '' })}
            </p>
          )}
        </form>
      )}
      {result?.status === 'ok' && !showForm && (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">{t('claude.connected')}</p>
      )}
    </div>
  );
}

/**
 * Signing in with the person's own Claude account, run on the server by the Claude Code it brings.
 * On the computer the server runs on the browser opens by itself and comes back; from elsewhere the
 * person opens the page here and pastes the code it shows after the sign-in.
 */
function ClaudeSignIn({ onDone }: { onDone(): void }) {
  const t = useT();
  const [session, setSession] = useState<ProviderSignIn | null>(null);
  const [pasted, setPasted] = useState('');
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  });
  const start = useMutation({ mutationFn: api.startClaudeSignIn, onSuccess: setSession });
  const live = session && (session.status === 'starting' || session.status === 'waiting');
  const { data: polled } = useQuery({
    queryKey: ['claude-sign-in', session?.id],
    queryFn: () => api.claudeSignIn(session!.id),
    enabled: !!live,
    refetchInterval: 1500,
  });
  const now = polled && polled.id === session?.id ? polled : session;
  const done = now?.status === 'done';
  useEffect(() => {
    if (!done) return;
    toast.success(t('claude.signInDone'));
    doneRef.current();
  }, [done, t]);
  // Ends a sign-in left half-way when the form closes.
  useEffect(() => {
    const id = session?.id;
    return () => {
      if (id) void api.cancelClaudeSignIn(id).catch(() => {});
    };
  }, [session?.id]);
  const paste = useMutation({
    mutationFn: () => api.pasteClaudeSignIn(now!.id, pasted.trim()),
    onSuccess: (s) => {
      setSession(s);
      setPasted('');
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (!now || now.status === 'cancelled' || now.status === 'error' || done) {
    const failed = now?.status === 'error' ? now.error : start.error ? (start.error as Error).message : null;
    return (
      <div className="space-y-2">
        <Button className="h-10 rounded-full" onClick={() => start.mutate()} disabled={start.isPending}>
          {start.isPending ? <Loader2 className="animate-spin" /> : <LogIn />}
          {t('claude.signIn')}
        </Button>
        <p className="text-xs text-muted-foreground">{t('claude.signInHint')}</p>
        {failed && <p className="text-sm text-destructive">{t('claude.signInFailed', { detail: failed })}</p>}
      </div>
    );
  }
  return (
    <div className="space-y-3 rounded-2xl border p-4">
      {now.status === 'starting' ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {t('claude.signInStarting')}
        </p>
      ) : (
        <p className="text-sm">{t('claude.signInOpened')}</p>
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
          <p className="text-xs text-muted-foreground">{t('claude.signInPasteHint')}</p>
          <div className="flex flex-wrap gap-2">
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder={t('claude.signInPastePlaceholder')}
              aria-label={t('claude.signInPastePlaceholder')}
              className="h-10 min-w-56 flex-1 rounded-full px-4"
            />
            <Button type="submit" className="h-10 rounded-full" disabled={!pasted.trim() || paste.isPending}>
              {t('common.save')}
            </Button>
          </div>
          {now.message && <p className="text-sm text-amber-600 dark:text-amber-400">{now.message}</p>}
        </form>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> {t('provider.signInWaiting')}
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="rounded-full"
          onClick={() => {
            void api.cancelClaudeSignIn(now.id).catch(() => {});
            setSession(null);
          }}
        >
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}
