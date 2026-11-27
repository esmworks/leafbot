import {
  LOCALE_NAMES,
  LOCALES,
  PROFILE_FOCUS,
  PROFILE_HELP,
  type Locale,
  type ProfileFocus,
  type ProfileHelp,
} from '@leafbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, Loader2, Pencil } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { AppMascot, MASCOT_COLOR } from '@/components/AppMascot';
import { BotAvatar, ObjectArt } from '@/components/BotAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useLocale, useT } from '@/i18n';
import { api } from '@/lib/api';
import { desktop, useDesktopServer } from '@/lib/desktop';
import { newBotEngine } from '@/lib/new-bot';
import { useProviders, useSettings } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { cn } from '@/lib/utils';
import { ClaudeConnect, useClaudeState } from '../ClaudeConnect';
import { ModelDefaults, type ModelChoice } from '../ModelDefaults';
import { isPiModel, PiModelPicker, ProviderKeyForm, useSavePiModel } from '../ProviderConnect';
import { Chip } from './Chip';
import { ROLES, starterBot, suggestedStarters, type Role, type StarterId } from './profile';

type Question = 'name' | 'addressAs' | 'focus' | 'occupation' | 'helpWith' | 'about';
const QUESTIONS: Question[] = ['name', 'addressAs', 'focus', 'occupation', 'helpWith', 'about'];

interface Answers {
  name: string;
  addressAs: string;
  focus?: ProfileFocus;
  roles: Role[];
  roleText: string;
  helpWith: ProfileHelp[];
  about: string;
}

const EMPTY: Answers = { name: '', addressAs: '', roles: [], roleText: '', helpWith: [], about: '' };

type Step = 'language' | 'server' | 'ai' | 'model' | 'about' | 'bots';
type EngineKind = 'claude' | 'pi';

/**
 * First run on an empty server: a full-window page without the sidebar. It picks the language,
 * where the server runs (desktop app), how Claude signs in, the default model and effort, asks who
 * the person is, saves the answers to the profile and sets up starter bots from them.
 */
export function Onboarding({ onDone }: { onDone(): void }) {
  const t = useT();
  const [step, setStep] = useState<Step>('language');
  // The AI connected on the AI step; the model step asks for a model of that one.
  const [engine, setEngine] = useState<EngineKind>('claude');
  // The name the account gave, when the person signed in to it first, is not asked again.
  const known = useSettings().data?.userName?.trim() ?? '';
  const [answers, setAnswers] = useState<Answers>(() => ({ ...EMPTY, name: known }));
  // Set once the questions were answered, so coming back from the bots shows the whole talk.
  const [answered, setAnswered] = useState(false);
  // Bots already made by an attempt that failed half way, so a retry does not make them again.
  const [created] = useState(() => new Map<StarterId, string>());
  const skip = useMutation({
    mutationFn: () => api.updateSettings({ onboarded: true }),
    onSuccess: onDone,
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className="flex h-full flex-col bg-background">
      {/* Room for the window buttons, and a handle to move the window. */}
      <header className="window-drag flex h-12 shrink-0 items-center justify-end px-4">
        <Button
          variant="ghost"
          size="sm"
          className="rounded-full text-muted-foreground"
          onClick={() => skip.mutate()}
          disabled={skip.isPending}
        >
          {t('onboarding.skip')}
        </Button>
      </header>
      {step === 'language' && <LanguageStep onNext={() => setStep(desktop?.openConnect ? 'server' : 'ai')} />}
      {step === 'server' && <ServerStep onBack={() => setStep('language')} onNext={() => setStep('ai')} />}
      {step === 'ai' && (
        <AiStep
          onBack={() => setStep(desktop?.openConnect ? 'server' : 'language')}
          onNext={(connected) => {
            if (connected) setEngine(connected);
            setStep(connected ? 'model' : 'about');
          }}
        />
      )}
      {step === 'model' &&
        (engine === 'pi' ? (
          <PiModelStep onBack={() => setStep('ai')} onNext={() => setStep('about')} />
        ) : (
          <ModelStep onBack={() => setStep('ai')} onNext={() => setStep('about')} />
        ))}
      {step === 'about' && (
        <AboutStep
          answers={answers}
          resume={answered}
          onChange={setAnswers}
          onNext={() => {
            setAnswered(true);
            setStep('bots');
          }}
        />
      )}
      {step === 'bots' && (
        <BotsStep answers={answers} created={created} onBack={() => setStep('about')} onDone={onDone} />
      )}
    </div>
  );
}

/** A setup step: title and text, its content, and Back / Continue at the bottom. */
function StepPage({
  title,
  body,
  children,
  onBack,
  next,
}: {
  title: string;
  body: string;
  children: ReactNode;
  onBack(): void;
  next: ReactNode;
}) {
  const t = useT();
  return (
    <>
      <main className="scroll-thin flex-1 overflow-y-auto">
        <div className="mx-auto max-w-xl px-6 pt-6 pb-8">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{body}</p>
          <div className="mt-6">{children}</div>
        </div>
      </main>
      <footer className="border-t">
        <div className="mx-auto flex max-w-xl items-center gap-2 px-6 py-4">
          <Button variant="ghost" className="rounded-full" onClick={onBack}>
            {t('onboarding.back')}
          </Button>
          <div className="flex-1" />
          {next}
        </div>
      </footer>
    </>
  );
}

/** Desktop app only: keep the server on this computer, or switch this window to a remote one. */
function ServerStep({ onBack, onNext }: { onBack(): void; onNext(): void }) {
  const t = useT();
  const server = useDesktopServer();
  const remote = server?.mode === 'remote';
  const options = [
    {
      id: 'local',
      on: !remote,
      title: t('server.local'),
      hint: t('server.localHint'),
      pick: () => remote && void desktop?.useLocal(),
    },
    {
      id: 'remote',
      on: remote,
      title: t('server.remote'),
      hint:
        remote && server?.url
          ? t('server.connectedTo', { host: hostOf(server.url) })
          : t('server.remoteHint'),
      // The connect window asks for the address and key, then this window opens that server.
      pick: () => void desktop?.openConnect?.(),
    },
  ];
  return (
    <StepPage
      title={t('server.title')}
      body={t('server.body')}
      onBack={onBack}
      next={
        <Button className="rounded-full" onClick={onNext}>
          {t('onboarding.continue')} <ArrowRight className="rtl:-scale-x-100" />
        </Button>
      }
    >
      <div className="grid gap-2" role="radiogroup" aria-label={t('server.title')}>
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={o.on}
            onClick={o.pick}
            className={cn(
              'flex items-center gap-3 rounded-2xl border px-4 py-3.5 text-start transition-colors hover:bg-accent',
              o.on && 'border-[var(--brand)]/60 bg-[var(--brand)]/10 hover:bg-[var(--brand)]/15',
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{o.title}</span>
              <span className="block text-xs text-muted-foreground">{o.hint}</span>
            </span>
            {o.on && <Check className="size-4 shrink-0 text-[var(--brand)]" />}
          </button>
        ))}
      </div>
    </StepPage>
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Claude, or another provider's API key; either is enough for the bots to answer. */
function AiStep({ onBack, onNext }: { onBack(): void; onNext(connected: EngineKind | null): void }) {
  const t = useT();
  const qc = useQueryClient();
  const { connected: claudeOk } = useClaudeState();
  const { data: settings } = useSettings();
  const { data: providers = [] } = useProviders();
  const [picked, setPicked] = useState<EngineKind | null>(null);
  const kind = picked ?? (settings?.defaultEngine === 'pi' ? 'pi' : 'claude');
  const connected = kind === 'claude' ? claudeOk : providers.some((p) => p.configured);
  const options: { id: EngineKind; title: string; hint: string }[] = [
    { id: 'claude', title: t('ai.claude'), hint: t('ai.claudeHint') },
    { id: 'pi', title: t('ai.other'), hint: t('ai.otherHint') },
  ];
  // A fresh check on arrival: the status from boot may be old or never taken.
  const check = useMutation({
    mutationFn: api.checkClaude,
    onSettled: () => qc.invalidateQueries({ queryKey: ['info'] }),
  });
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    check.mutate();
  }, [check]);
  return (
    <StepPage
      title={t('claude.title')}
      body={t('claude.body')}
      onBack={onBack}
      next={
        <Button
          className="rounded-full"
          variant={connected ? 'default' : 'secondary'}
          disabled={kind === 'claude' && check.isPending}
          onClick={() => onNext(connected ? kind : null)}
        >
          {connected ? t('onboarding.continue') : t('onboarding.later')}
          {connected && <ArrowRight className="rtl:-scale-x-100" />}
        </Button>
      }
    >
      <div className="mb-6 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={t('claude.title')}>
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={kind === o.id}
            onClick={() => setPicked(o.id)}
            className={cn(
              'rounded-2xl border px-4 py-3.5 text-start transition-colors hover:bg-accent',
              kind === o.id && 'border-[var(--brand)]/60 bg-[var(--brand)]/10 hover:bg-[var(--brand)]/15',
            )}
          >
            <span className="block text-sm font-medium">{o.title}</span>
            <span className="block text-xs text-muted-foreground">{o.hint}</span>
          </button>
        ))}
      </div>
      {kind === 'claude' ? <ClaudeConnect checking={check.isPending} /> : <ProviderKeyForm />}
    </StepPage>
  );
}

function ModelStep({ onBack, onNext }: { onBack(): void; onNext(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const [choice, setChoice] = useState<ModelChoice | null>(null);
  const value = choice ?? { model: settings?.defaultModel ?? '', effort: settings?.effort ?? '' };
  const save = useMutation({
    mutationFn: () =>
      api.updateSettings({ defaultModel: value.model, effort: value.effort, defaultEngine: 'claude' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] });
      onNext();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <StepPage
      title={t('model.title')}
      body={t('model.body')}
      onBack={onBack}
      next={
        <Button className="rounded-full" onClick={() => save.mutate()} disabled={save.isPending}>
          {t('onboarding.continue')} <ArrowRight className="rtl:-scale-x-100" />
        </Button>
      }
    >
      <ModelDefaults value={value} onChange={setChoice} />
    </StepPage>
  );
}

function PiModelStep({ onBack, onNext }: { onBack(): void; onNext(): void }) {
  const t = useT();
  const { data: settings } = useSettings();
  const [ref, setRef] = useState<string | null>(null);
  const value = ref ?? settings?.piModel ?? '';
  const { save, error } = useSavePiModel(onNext);
  return (
    <StepPage
      title={t('provider.modelTitle')}
      body={t('provider.modelBody')}
      onBack={onBack}
      next={
        <Button
          className="rounded-full"
          onClick={() => save.mutate(value)}
          disabled={!isPiModel(value) || save.isPending}
        >
          {save.isPending && <Loader2 className="animate-spin" />}
          {save.isPending ? t('claude.testing') : t('onboarding.continue')}
          {!save.isPending && <ArrowRight className="rtl:-scale-x-100" />}
        </Button>
      }
    >
      <PiModelPicker value={value} onChange={setRef} />
      {error && <p className="mt-3 text-sm text-destructive">{t('provider.failed', { detail: error })}</p>}
    </StepPage>
  );
}

function LanguageStep({ onNext }: { onNext(): void }) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const setLocale = useLocale((s) => s.setLocale);
  const pick = (language: Locale) => {
    setLocale(language, { unsaved: true });
    void api
      .updateSettings({ language })
      .then(() => useLocale.setState({ unsaved: false }))
      .catch(() => {});
  };
  return (
    // `my-auto` rather than `justify-center`: a centred column taller than the window would lose its
    // top past the scroll edge, while an auto margin centres it and still lets it scroll.
    <main className="flex flex-1 flex-col items-center overflow-y-auto px-6 pb-16">
      <div className="my-auto flex w-full max-w-xl flex-col items-center gap-8 text-center">
        <div className="flex max-w-sm flex-col items-center gap-3">
          <div className="size-16">
            <AppMascot />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('onboarding.languageTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('onboarding.languageBody')}</p>
        </div>
        {/* Fifteen languages one under another made a column taller than the window; in rows of
            three they fit on one screen with the button in view. */}
        <div
          className="grid w-full grid-cols-2 gap-2 sm:grid-cols-3"
          role="radiogroup"
          aria-label={t('common.language')}
        >
          {LOCALES.map((l) => (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={l === locale}
              lang={l}
              onClick={() => pick(l)}
              className={cn(
                'flex h-10 min-w-0 items-center justify-between gap-2 rounded-xl border px-3 text-start text-sm transition-colors hover:bg-accent',
                l === locale && 'border-[var(--brand)]/60 bg-[var(--brand)]/10 hover:bg-[var(--brand)]/15',
              )}
            >
              <span className="truncate">{LOCALE_NAMES[l]}</span>
              {l === locale && <Check className="size-4 shrink-0 text-[var(--brand)]" />}
            </button>
          ))}
        </div>
        <Button className="h-11 w-full max-w-sm rounded-full" onClick={onNext} autoFocus>
          {t('onboarding.continue')} <ArrowRight className="rtl:-scale-x-100" />
        </Button>
      </div>
    </main>
  );
}

function firstName(name: string) {
  return name.trim().split(/\s+/)[0] ?? '';
}

function AboutStep({
  answers,
  resume,
  onChange,
  onNext,
}: {
  answers: Answers;
  resume: boolean;
  onChange(a: Answers): void;
  onNext(): void;
}) {
  const t = useT();
  const reduced = useReducedMotion();
  // A name already known shows as answered, still open to change, and the talk starts after it.
  const [seen, setSeen] = useState<Question[]>(resume ? QUESTIONS : answers.name ? ['name'] : []);
  const [current, setCurrent] = useState<Question | 'done'>(
    resume ? 'done' : answers.name ? 'addressAs' : 'name',
  );
  const [typing, setTyping] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    end.current?.scrollIntoView({ block: 'end', behavior: reduced ? 'auto' : 'smooth' });
  }, [current, typing, reduced]);

  const answered = (q: Question, next: Answers) => {
    onChange(next);
    const nowSeen = seen.includes(q) ? seen : [...seen, q];
    setSeen(nowSeen);
    const upcoming = QUESTIONS.find((x) => !nowSeen.includes(x));
    if (!upcoming) {
      setCurrent('done');
      onNext();
      return;
    }
    setCurrent(upcoming);
    if (reduced) return;
    window.clearTimeout(timer.current);
    setTyping(true);
    timer.current = window.setTimeout(() => setTyping(false), 650);
  };

  const shown = (q: Question): string | null => {
    if (q === 'name') return answers.name || null;
    if (q === 'addressAs') return answers.addressAs || null;
    if (q === 'focus') return answers.focus ? t(`profile.focus.${answers.focus}`) : null;
    if (q === 'occupation') return occupationText(answers, t) || null;
    if (q === 'helpWith') return answers.helpWith.map((h) => t(`profile.help.${h}`)).join(', ') || null;
    return answers.about || null;
  };

  const turns: ReactNode[] = [];
  for (const [i, q] of QUESTIONS.entries()) {
    const live = q === current;
    if (!live && !seen.includes(q)) break;
    if (live && typing) break;
    turns.push(
      <BotSays key={`${q}-ask`}>
        {i === 0 && <p className="mb-1">{t('onboarding.intro')}</p>}
        <p className="font-medium">{t(`onboarding.q.${q}`)}</p>
        {(q === 'occupation' || q === 'helpWith') && live && (
          <p className="text-muted-foreground">{t('onboarding.pickMany')}</p>
        )}
      </BotSays>,
    );
    if (live) {
      turns.push(
        <Appear key={`${q}-input`}>
          <AnswerInput question={q} answers={answers} onAnswer={(next) => answered(q, next)} />
        </Appear>,
      );
      break;
    }
    turns.push(
      <PersonSays key={`${q}-answer`} onEdit={() => setCurrent(q)}>
        {shown(q) ?? <span className="text-muted-foreground">{t('onboarding.skipped')}</span>}
      </PersonSays>,
    );
  }
  if (typing) turns.push(<Typing key="typing" />);

  return (
    <main className="scroll-thin flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-4 px-6 pt-6 pb-24">
        <AnimatePresence initial={false}>{turns}</AnimatePresence>
        {current === 'done' && (
          <div className="flex justify-end">
            <Button className="rounded-full" onClick={onNext}>
              {t('onboarding.continue')} <ArrowRight className="rtl:-scale-x-100" />
            </Button>
          </div>
        )}
        <div ref={end} />
      </div>
    </main>
  );
}

function occupationText(a: Answers, t: ReturnType<typeof useT>) {
  return [...a.roles.map((r) => t(`onboarding.role.${r}`)), a.roleText.trim()].filter(Boolean).join(', ');
}

function AnswerInput({
  question,
  answers,
  onAnswer,
}: {
  question: Question;
  answers: Answers;
  onAnswer(next: Answers): void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(() =>
    question === 'name'
      ? answers.name
      : question === 'addressAs'
        ? answers.addressAs || firstName(answers.name)
        : question === 'about'
          ? answers.about
          : '',
  );
  const [roles, setRoles] = useState<Role[]>(answers.roles);
  const [roleText, setRoleText] = useState(answers.roleText);
  const [other, setOther] = useState(!!answers.roleText);
  const [help, setHelp] = useState<ProfileHelp[]>(answers.helpWith);
  const skipButton = (patch: Partial<Answers>) => (
    <Button
      type="button"
      variant="ghost"
      className="rounded-full text-muted-foreground"
      onClick={() => onAnswer({ ...answers, ...patch })}
    >
      {t('onboarding.skipQuestion')}
    </Button>
  );

  if (question === 'name' || question === 'addressAs' || question === 'about') {
    const submit = (e: FormEvent) => {
      e.preventDefault();
      const value = draft.trim();
      if (!value) return;
      onAnswer({ ...answers, [question]: value });
    };
    const empty =
      question === 'name' ? { name: '' } : question === 'addressAs' ? { addressAs: '' } : { about: '' };
    return (
      <form onSubmit={submit} className="flex flex-col items-end gap-2 ps-11">
        {question === 'about' ? (
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && (e.metaKey || e.ctrlKey)) submit(e);
            }}
            maxLength={2000}
            rows={3}
            autoFocus
            aria-label={t('onboarding.q.about')}
            placeholder={t('profile.aboutPlaceholder')}
            className="rounded-2xl"
          />
        ) : (
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={question === 'name' ? 80 : 60}
            autoFocus
            autoComplete={question === 'name' ? 'name' : 'off'}
            aria-label={t(`onboarding.q.${question}`)}
            placeholder={t('onboarding.typeHere')}
            className="h-11 rounded-full px-4"
          />
        )}
        <div className="flex gap-2">
          {skipButton(empty)}
          <Button type="submit" className="rounded-full" disabled={!draft.trim()}>
            {t('onboarding.continue')}
          </Button>
        </div>
      </form>
    );
  }

  if (question === 'focus') {
    return (
      <div className="flex flex-col items-end gap-3 ps-11">
        <div className="flex flex-wrap justify-end gap-2">
          {PROFILE_FOCUS.map((f) => (
            <Chip key={f} on={answers.focus === f} onClick={() => onAnswer({ ...answers, focus: f })}>
              {t(`profile.focus.${f}`)}
            </Chip>
          ))}
        </div>
        {skipButton({ focus: undefined })}
      </div>
    );
  }

  if (question === 'occupation') {
    const toggle = (r: Role) => setRoles((rs) => (rs.includes(r) ? rs.filter((x) => x !== r) : [...rs, r]));
    const ready = roles.length > 0 || !!roleText.trim();
    const done = () => onAnswer({ ...answers, roles, roleText: roleText.trim() });
    return (
      <div className="flex flex-col items-end gap-3 ps-11">
        <div className="flex flex-wrap justify-end gap-2">
          {ROLES.map((r) => (
            <Chip key={r} check on={roles.includes(r)} onClick={() => toggle(r)}>
              {t(`onboarding.role.${r}`)}
            </Chip>
          ))}
          {other ? (
            <Input
              value={roleText}
              onChange={(e) => setRoleText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && ready) done();
              }}
              maxLength={120}
              autoFocus
              aria-label={t('onboarding.other')}
              placeholder={t('profile.occupationPlaceholder')}
              className="h-9 w-72 rounded-full"
            />
          ) : (
            <Chip on={false} onClick={() => setOther(true)}>
              <Pencil className="size-3.5" /> {t('onboarding.other')}
            </Chip>
          )}
        </div>
        <div className="flex gap-2">
          {skipButton({ roles: [], roleText: '' })}
          <Button className="rounded-full" disabled={!ready} onClick={done}>
            {t('onboarding.continue')}
          </Button>
        </div>
      </div>
    );
  }

  // helpWith
  const toggle = (h: ProfileHelp) =>
    setHelp((hs) =>
      hs.includes(h) ? hs.filter((x) => x !== h) : PROFILE_HELP.filter((x) => x === h || hs.includes(x)),
    );
  return (
    <div className="flex flex-col items-end gap-3 ps-11">
      <div className="flex flex-wrap justify-end gap-2">
        {PROFILE_HELP.map((h) => (
          <Chip key={h} check on={help.includes(h)} onClick={() => toggle(h)}>
            {t(`profile.help.${h}`)}
          </Chip>
        ))}
      </div>
      <div className="flex gap-2">
        {skipButton({ helpWith: [] })}
        <Button
          className="rounded-full"
          disabled={!help.length}
          onClick={() => onAnswer({ ...answers, helpWith: help })}
        >
          {t('onboarding.continue')}
        </Button>
      </div>
    </div>
  );
}

function Appear({ children }: { children: ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
      {children}
    </motion.div>
  );
}

function BotSays({ children }: { children: ReactNode }) {
  return (
    <Appear>
      <div className="flex items-end gap-3">
        <div className="size-8 shrink-0">
          <ObjectArt id="circle" color={MASCOT_COLOR} seed="leafbot" />
        </div>
        <div className="max-w-[85%] rounded-2xl rounded-es-md bg-secondary px-4 py-2.5 text-[15px] leading-relaxed">
          {children}
        </div>
      </div>
    </Appear>
  );
}

function PersonSays({ children, onEdit }: { children: ReactNode; onEdit(): void }) {
  const t = useT();
  return (
    <Appear>
      <div className="group flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onEdit}
          aria-label={t('onboarding.editAnswer')}
          title={t('onboarding.editAnswer')}
          className="rounded-full p-2 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent focus-visible:opacity-100"
        >
          <Pencil className="size-3.5" />
        </button>
        <div className="max-w-[80%] rounded-2xl rounded-ee-md bg-[var(--brand)]/12 px-4 py-2.5 text-[15px] leading-relaxed">
          {children}
        </div>
      </div>
    </Appear>
  );
}

function Typing() {
  return (
    <Appear>
      <div className="flex items-end gap-3">
        <div className="size-8 shrink-0">
          <ObjectArt id="circle" color={MASCOT_COLOR} activity="thinking" motion="always" seed="leafbot" />
        </div>
        <div className="flex gap-1 rounded-2xl rounded-es-md bg-secondary px-4 py-3.5" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60"
              style={{ animationDelay: `${i * 120}ms` }}
            />
          ))}
        </div>
      </div>
    </Appear>
  );
}

function BotsStep({
  answers,
  created,
  onBack,
  onDone,
}: {
  answers: Answers;
  created: Map<StarterId, string>;
  onBack(): void;
  onDone(): void;
}) {
  const t = useT();
  const selectBot = useUi((s) => s.selectBot);
  const { data: settings } = useSettings();
  const { connected: claudeOk } = useClaudeState();
  const engine = newBotEngine(settings);
  const ready = engine.engine === 'pi' || claudeOk;
  const offered = suggestedStarters(answers.helpWith);
  const [chosen, setChosen] = useState<StarterId[]>(offered);
  const finish = useMutation({
    mutationFn: async () => {
      await api.updateSettings({
        userName: answers.name,
        addressAs: answers.addressAs,
        occupation: occupationText(answers, t),
        ...(answers.focus ? { focus: answers.focus } : {}),
        helpWith: answers.helpWith,
        aboutMe: answers.about,
      });
      for (const id of offered) {
        if (!chosen.includes(id) || created.has(id)) continue;
        created.set(id, (await api.createBot({ ...starterBot(id, t), ...engine })).id);
      }
      await api.updateSettings({ onboarded: true });
      return offered.map((id) => created.get(id)).find(Boolean) ?? null;
    },
    onSuccess: (first) => {
      if (first) selectBot(first);
      onDone();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const toggle = (id: StarterId) =>
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

  return (
    <>
      <main className="scroll-thin flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-6 pt-6 pb-8">
          <h1 className="text-2xl font-semibold tracking-tight">{t('onboarding.botsTitle')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('onboarding.botsBody')}</p>
          {!ready && (
            <p className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
              {t('onboarding.noAi')}
            </p>
          )}
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {offered.map((id) => {
              const bot = starterBot(id, t);
              const on = chosen.includes(id);
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(id)}
                  className={cn(
                    'flex items-start gap-3 rounded-2xl border p-4 text-start transition-colors hover:bg-accent',
                    on && 'border-[var(--brand)]/60 bg-[var(--brand)]/5',
                  )}
                >
                  <BotAvatar avatar={bot.avatar} color={bot.color} seed={id} size={44} />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{bot.name}</span>
                    <span className="block text-sm text-muted-foreground">{bot.description}</span>
                  </span>
                  <span
                    aria-hidden
                    className={cn(
                      'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border',
                      on && 'border-[var(--brand)] bg-[var(--brand)] text-white',
                    )}
                  >
                    {on && <Check className="size-3.5" strokeWidth={3} />}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </main>
      <footer className="border-t">
        <div className="mx-auto flex max-w-2xl items-center gap-2 px-6 py-4">
          <Button variant="ghost" className="rounded-full" onClick={onBack} disabled={finish.isPending}>
            {t('onboarding.back')}
          </Button>
          <div className="flex-1" />
          <Button className="rounded-full" onClick={() => finish.mutate()} disabled={finish.isPending}>
            {finish.isPending && <Loader2 className="animate-spin" />}
            {finish.isPending
              ? t('onboarding.creating')
              : chosen.length
                ? t('onboarding.create')
                : t('onboarding.startEmpty')}
          </Button>
        </div>
      </footer>
    </>
  );
}
