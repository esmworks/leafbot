import { LOCALE_NAMES, LOCALES } from '@leafbot/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, KeyRound, Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { AppMascot } from '@/components/AppMascot';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLocale, useT } from '@/i18n';
import { api, ApiError } from '@/lib/api';
import { desktop } from '@/lib/desktop';
import { useUi } from '@/lib/store';
import { cn } from '@/lib/utils';

/** Where people sign in with their Leaf Bot account and reach their servers. */
export const ACCOUNT_SERVERS_URL = 'https://www.leafbot.app/bots/';

/**
 * The sign-in page. People reach a server through their Leaf Bot account, on the website (or the
 * desktop and phone apps); the server itself signs no one in by name. On the computer the server
 * runs on, its owner may still use the access key, so the server stays theirs when the account
 * cannot be reached.
 */
export function Login() {
  const t = useT();
  const { data: session } = useQuery({ queryKey: ['session'], queryFn: api.session, retry: false });
  const local = !!session?.local;
  return (
    <div className="flex h-full flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="size-16">
            <AppMascot />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Leaf Bot</h1>
          <p className="text-sm text-muted-foreground">{t('login.accountOnly')}</p>
        </div>
        <Button asChild className="h-12 w-full rounded-full">
          <a href={ACCOUNT_SERVERS_URL} target="_blank" rel="noreferrer">
            <ExternalLink />
            {t('login.openAccount')}
          </a>
        </Button>
        {local && (
          <div className="space-y-3 border-t pt-6">
            <p className="text-center text-sm text-muted-foreground">{t('login.hint')}</p>
            <KeyForm />
          </div>
        )}
      </div>
      <DesktopServerChoice />
      <LanguageSwitch />
    </div>
  );
}

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

/** In the desktop app, on this computer's own server: signing in with the key the app keeps. */
function DesktopServerChoice() {
  const t = useT();
  const setAuthed = useUi((s) => s.setAuthed);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // Only this computer's own page gets the shell's bridge.
  if (!desktop) return null;
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
  return (
    <div className="mt-6 flex w-full max-w-sm flex-col items-center gap-1 text-center">
      <p className="text-sm text-muted-foreground">{t('login.serverHere')}</p>
      <Button variant="ghost" size="sm" onClick={() => void signIn()} disabled={busy}>
        {busy && <Loader2 className="animate-spin" />}
        {t('login.savedKey')}
      </Button>
      {failed && <p className="text-sm text-destructive">{t('login.unreachable')}</p>}
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
