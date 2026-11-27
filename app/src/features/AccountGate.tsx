import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { AppMascot } from '@/components/AppMascot';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { api, ApiError } from '@/lib/api';
import { LanguageSwitch } from './Login';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME = 80;

type Step = { at: 'email' } | { at: 'code'; email: string } | { at: 'name' };

/**
 * The owner's sign-in to their Leaf Bot account, before anything else on a server not linked to
 * one: an emailed code, then the name when the account has none. The server links itself to the
 * account on the way, so the owner reaches it from their phone and the web from then on. Once
 * linked it is never asked again, so the app keeps working without the account service.
 */
export function AccountGate({ onDone }: { onDone(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>({ at: 'email' });
  const finish = () => {
    void Promise.all([
      qc.invalidateQueries({ queryKey: ['account-host'] }),
      qc.invalidateQueries({ queryKey: ['settings'] }),
    ]).then(onDone);
  };
  return (
    <div className="flex h-full flex-col bg-background">
      {/* Room for the window buttons, and a handle to move the window. */}
      <header className="window-drag h-12 shrink-0" />
      <div className="flex flex-1 flex-col items-center justify-center p-6">
        <div className="w-full max-w-sm space-y-6">
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="size-16">
              <AppMascot />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {step.at === 'name' ? t('accountGate.nameTitle') : t('accountGate.title')}
            </h1>
            <p className="text-sm text-muted-foreground">
              {step.at === 'email'
                ? t('accountGate.hint')
                : step.at === 'code'
                  ? t('accountGate.codeHint', { email: step.email })
                  : t('accountGate.nameHint')}
            </p>
          </div>
          {step.at === 'email' && <EmailForm onSent={(email) => setStep({ at: 'code', email })} />}
          {step.at === 'code' && (
            <CodeForm
              email={step.email}
              onBack={() => setStep({ at: 'email' })}
              onSignedIn={(needsName) => (needsName ? setStep({ at: 'name' }) : finish())}
            />
          )}
          {step.at === 'name' && <NameForm onSaved={finish} />}
        </div>
        {step.at === 'email' && <LanguageSwitch />}
      </div>
    </div>
  );
}

const message = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

function Field({ error, children }: { error: string | null; children: ReactNode }) {
  return (
    <div className="space-y-2">
      {children}
      {error && (
        <p className="px-4 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function EmailForm({ onSent }: { onSent(email: string): void }) {
  const t = useT();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: (address: string) => api.accountSignInStart(address),
    onSuccess: (_, address) => onSent(address),
    onError: (e) => setError(message(e, t('login.unreachable'))),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const address = email.trim();
    if (!EMAIL.test(address)) return setError(t('accountGate.enterEmail'));
    setError(null);
    send.mutate(address);
  };
  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <Field error={error}>
        <Input
          autoFocus
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={t('accountGate.email')}
          aria-label={t('accountGate.email')}
          aria-invalid={!!error}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setError(null);
          }}
          className="h-12 rounded-full px-5"
        />
      </Field>
      <Button type="submit" className="h-12 w-full rounded-full" disabled={send.isPending}>
        {send.isPending && <Loader2 className="animate-spin" />}
        {t('accountGate.send')}
      </Button>
    </form>
  );
}

function CodeForm({
  email,
  onBack,
  onSignedIn,
}: {
  email: string;
  onBack(): void;
  onSignedIn(needsName: boolean): void;
}) {
  const t = useT();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const verify = useMutation({
    mutationFn: (c: string) => api.accountSignInVerify(email, c),
    onSuccess: (r) => onSignedIn(r.needsName),
    onError: (e) => setError(message(e, t('login.unreachable'))),
  });
  const resend = useMutation({
    mutationFn: () => api.accountSignInStart(email),
    onSuccess: () => {
      setCode('');
      setResent(true);
    },
    onError: (e) => setError(message(e, t('login.unreachable'))),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) return setError(t('accountGate.enterCode'));
    setError(null);
    verify.mutate(code);
  };
  const busy = verify.isPending || resend.isPending;
  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <Field error={error}>
        <Input
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="000000"
          aria-label={t('accountGate.code')}
          aria-invalid={!!error}
          value={code}
          onChange={(e) => {
            setCode(e.target.value.replace(/\D/g, '').slice(0, 6));
            setError(null);
            setResent(false);
          }}
          className="h-12 rounded-full px-5 text-center text-lg tracking-widest"
        />
      </Field>
      {resent && <p className="px-4 text-sm text-muted-foreground">{t('accountGate.resent')}</p>}
      <Button type="submit" className="h-12 w-full rounded-full" disabled={busy}>
        {verify.isPending && <Loader2 className="animate-spin" />}
        {t('accountGate.verify')}
      </Button>
      <div className="flex justify-between gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack} disabled={busy}>
          <ArrowLeft />
          {t('accountGate.otherEmail')}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => resend.mutate()} disabled={busy}>
          {t('accountGate.resend')}
        </Button>
      </div>
    </form>
  );
}

function NameForm({ onSaved }: { onSaved(): void }) {
  const t = useT();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (n: string) => api.accountSetName(n),
    onSuccess: onSaved,
    onError: (e) => setError(message(e, t('login.unreachable'))),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const clean = name.replace(/\s+/g, ' ').trim();
    if (!clean || clean.length > MAX_NAME) return setError(t('accountGate.enterName'));
    setError(null);
    save.mutate(clean);
  };
  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <Field error={error}>
        <Input
          autoFocus
          autoComplete="name"
          placeholder={t('accountGate.name')}
          aria-label={t('accountGate.name')}
          aria-invalid={!!error}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          className="h-12 rounded-full px-5"
        />
      </Field>
      <Button type="submit" className="h-12 w-full rounded-full" disabled={save.isPending}>
        {save.isPending && <Loader2 className="animate-spin" />}
        {t('accountGate.continue')}
      </Button>
    </form>
  );
}
