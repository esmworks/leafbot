import { LOCALE_NAMES, LOCALES } from '@leafbot/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { KeyRound, Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { AppMascot } from '@/components/AppMascot';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLocale, useT } from '@/i18n';
import { api, ApiError } from '@/lib/api';
import { desktop, useDesktopServer } from '@/lib/desktop';
import { useUi } from '@/lib/store';
import { cn } from '@/lib/utils';

/**
 * The sign-in page: username and password once the account exists, the access key before that
 * (and whenever the password is forgotten). Older servers without accounts get the key alone.
 */
export function Login() {
  const t = useT();
  const { data: session } = useQuery({ queryKey: ['session'], queryFn: api.session, retry: false });
  const [useKey, setUseKey] = useState(false);
  const [useCode, setUseCode] = useState(false);
  const hasAccount = !!session?.account;
  return (
    <div className="flex h-full flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="size-16">
            <AppMascot />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Leaf Bot</h1>
          <p className="text-sm text-muted-foreground">
            {useCode ? t('login.codeHint') : hasAccount && !useKey ? t('login.accountHint') : t('login.hint')}
          </p>
        </div>
        {useCode ? <CodeForm /> : hasAccount && !useKey ? <PasswordForm /> : <KeyForm />}
        {hasAccount && !useCode && (
          <Button variant="ghost" size="sm" className="w-full" onClick={() => setUseKey((v) => !v)}>
            {useKey ? t('login.usePassword') : t('login.useKey')}
          </Button>
        )}
        <Button variant="ghost" size="sm" className="w-full" onClick={() => setUseCode((v) => !v)}>
          {useCode ? t('login.back') : t('login.useCode')}
        </Button>
      </div>
      <DesktopServerChoice />
      <LanguageSwitch />
    </div>
  );
}

function PasswordForm() {
  const t = useT();
  const setAuthed = useUi((s) => s.setAuthed);
  const Form = useMemo(
    () =>
      z.object({
        username: z.string().trim().min(1, t('login.enterUsername')),
        password: z.string().min(1, t('login.enterPassword')),
      }),
    [t],
  );
  const form = useForm<z.infer<typeof Form>>({
    resolver: zodResolver(Form),
    defaultValues: { username: '', password: '' },
  });
  const submit = form.handleSubmit(async ({ username, password }) => {
    try {
      await api.login(username, password);
      setAuthed(true);
    } catch (e) {
      form.setError('password', { message: e instanceof ApiError ? e.message : t('login.unreachable') });
    }
  });
  const errors = form.formState.errors;
  const error = errors.username?.message ?? errors.password?.message;
  return (
    <form onSubmit={submit} className="space-y-3">
      <Input
        {...form.register('username')}
        autoFocus
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        placeholder={t('login.username')}
        aria-label={t('login.username')}
        aria-invalid={!!errors.username}
        className="h-12 rounded-full px-5"
      />
      <Input
        {...form.register('password')}
        type="password"
        autoComplete="current-password"
        placeholder={t('login.password')}
        aria-label={t('login.password')}
        aria-invalid={!!errors.password}
        className="h-12 rounded-full px-5"
      />
      {error && <p className="px-4 text-sm text-destructive">{error}</p>}
      <Button type="submit" className="h-12 w-full rounded-full" disabled={form.formState.isSubmitting}>
        {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
        {t('login.submit')}
      </Button>
    </form>
  );
}

/** A one-time code from a device already signed in (Settings → Connection). */
function CodeForm() {
  const t = useT();
  const setAuthed = useUi((s) => s.setAuthed);
  const Form = useMemo(() => z.object({ code: z.string().trim().min(1, t('login.enterCode')) }), [t]);
  const form = useForm<z.infer<typeof Form>>({ resolver: zodResolver(Form), defaultValues: { code: '' } });
  const submit = form.handleSubmit(async ({ code }) => {
    try {
      await api.pair(code);
      setAuthed(true);
    } catch (e) {
      form.setError('code', { message: e instanceof ApiError ? e.message : t('login.unreachable') });
    }
  });
  const error = form.formState.errors.code?.message;
  return (
    <form onSubmit={submit} className="space-y-6">
      <div className="space-y-2">
        <Input
          {...form.register('code')}
          autoFocus
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder={CODE_EXAMPLE}
          aria-label={t('login.code')}
          aria-invalid={!!error}
          className="h-12 rounded-full px-5 text-center font-mono text-lg tracking-widest"
        />
        {error && <p className="px-4 text-sm text-destructive">{error}</p>}
      </div>
      <Button type="submit" className="h-12 w-full rounded-full" disabled={form.formState.isSubmitting}>
        {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
        {t('login.submit')}
      </Button>
    </form>
  );
}

/** The shape of a pairing code; an example, the same in every language. */
const CODE_EXAMPLE = 'ABCD-2345';

function KeyForm() {
  const t = useT();
  const setAuthed = useUi((s) => s.setAuthed);
  const Form = useMemo(() => z.object({ key: z.string().trim().min(1, t('login.enterKey')) }), [t]);
  const form = useForm<z.infer<typeof Form>>({ resolver: zodResolver(Form), defaultValues: { key: '' } });
  const submit = form.handleSubmit(async ({ key }) => {
    try {
      await api.access(key);
      setAuthed(true);
    } catch (e) {
      form.setError('key', { message: e instanceof ApiError ? e.message : t('login.unreachable') });
    }
  });
  const error = form.formState.errors.key?.message;
  return (
    <form onSubmit={submit} className="space-y-6">
      <div className="space-y-2">
        <div className="relative">
          <KeyRound className="absolute top-1/2 start-4 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            {...form.register('key')}
            type="password"
            autoFocus
            autoComplete="current-password"
            placeholder={t('login.placeholder')}
            aria-invalid={!!error}
            className="h-12 rounded-full ps-11"
          />
        </div>
        {error && <p className="px-4 text-sm text-destructive">{error}</p>}
      </div>
      <Button type="submit" className="h-12 w-full rounded-full" disabled={form.formState.isSubmitting}>
        {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
        {t('login.submit')}
      </Button>
    </form>
  );
}

/**
 * In the desktop app: which server this window shows, signing in with the key the app keeps,
 * and switching to another server (or back to the one on this computer).
 */
function DesktopServerChoice() {
  const t = useT();
  const server = useDesktopServer();
  const setAuthed = useUi((s) => s.setAuthed);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!desktop || !server) return null;
  const signIn = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const key = await desktop!.accessKey();
      if (!key) throw new Error('no key');
      await api.access(key);
      setAuthed(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const host = server.url ? new URL(server.url).host : '';
  return (
    <div className="mt-6 flex w-full max-w-sm flex-col items-center gap-1 text-center">
      <p className="text-sm text-muted-foreground">
        {server.mode === 'local' ? t('login.serverHere') : t('login.serverRemote', { host })}
      </p>
      <Button variant="ghost" size="sm" onClick={() => void signIn()} disabled={busy}>
        {busy && <Loader2 className="animate-spin" />}
        {t('login.savedKey')}
      </Button>
      {failed && <p className="text-sm text-destructive">{t('login.unreachable')}</p>}
      <div className="flex flex-wrap justify-center gap-1">
        <Button variant="ghost" size="sm" onClick={() => void desktop!.openConnect?.()}>
          {t('login.otherServer')}
        </Button>
        {server.mode === 'remote' && (
          <Button variant="ghost" size="sm" onClick={() => void desktop!.useLocal()}>
            {t('login.useLocal')}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Before signing in the settings screen is out of reach, so the language is picked here. */
export function LanguageSwitch() {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const setLocale = useLocale((s) => s.setLocale);
  return (
    <div
      role="group"
      aria-label={t('common.language')}
      className="mt-8 flex flex-wrap justify-center gap-1 text-sm"
    >
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-pressed={l === locale}
          onClick={() => setLocale(l, { unsaved: true })}
          className={cn(
            'rounded-full px-3 py-1 text-muted-foreground transition-colors hover:text-foreground',
            l === locale && 'bg-secondary text-foreground',
          )}
        >
          {LOCALE_NAMES[l]}
        </button>
      ))}
    </div>
  );
}
