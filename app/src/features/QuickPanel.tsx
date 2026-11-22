import { describeAction, questionItems, type Approval, type Bot } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, KeyRound, ShieldAlert, MessageCircleQuestion } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { BotAvatar } from '@/components/BotAvatar';
import { useLocale, useT } from '@/i18n';
import { api } from '@/lib/api';
import { desktop } from '@/lib/desktop';
import { useFormat } from '@/lib/format';
import { useBots } from '@/lib/queries';
import { quickAction, shortcutLabel, type QuickAction, type QuickCard } from '@/lib/quick';
import { cn } from '@/lib/utils';

const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);

/** How a card can be answered in place; cards that need more (sign-ins, several questions) open the chat. */
function cardOf(a: Approval): QuickCard {
  if (a.kind === 'tool') return { kind: 'tool' };
  if (a.kind === 'question') {
    const { items } = questionItems(a);
    const only = items.length === 1 ? items[0]! : null;
    if (only && !only.secret) return { kind: 'question', options: Math.min(only.options.length, 9) };
  }
  return { kind: 'open' };
}

/**
 * The desktop app's quick window: every card the bots wait on, oldest first, answered from the
 * keyboard. Opened with a global shortcut over any app, it closes itself once put away.
 */
export function QuickPanel() {
  const t = useT();
  const qc = useQueryClient();
  const { data: bots = [] } = useBots();
  const byId = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots]);
  // Asked for often: this window has no live connection, and it is only open for moments.
  const { data: approvals, refetch } = useQuery({
    queryKey: ['approvals'],
    queryFn: api.approvals,
    refetchInterval: 4000,
  });
  const pending = useMemo(
    () =>
      (approvals ?? [])
        // A step that has its first yes waits for a second person, not for this card's buttons.
        .filter((a) => a.status === 'pending' && !(a.needsSecond && a.firstAt))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [approvals],
  );
  const [selected, setSelected] = useState(0);
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState('');
  const [shortcut, setShortcut] = useState<string | null>(null);
  const current = pending[Math.min(selected, pending.length - 1)] ?? null;

  useEffect(() => {
    void desktop
      ?.quickKey?.()
      .then(setShortcut)
      .catch(() => {});
    // Each time the window comes back it starts over from the oldest card, with fresh cards.
    return desktop?.onQuickShown?.(() => {
      setSelected(0);
      setWriting(false);
      setDraft('');
      void refetch();
    });
  }, [refetch]);

  const answer = useMutation({
    mutationFn: (d: { id: string; decision: 'allow' | 'deny'; answer?: string }) =>
      api.answer(d.id, { decision: d.decision, ...(d.answer !== undefined && { answer: d.answer }) }),
    onSuccess: () => {
      setWriting(false);
      setDraft('');
      return qc.invalidateQueries({ queryKey: ['approvals'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const close = () => void desktop?.quickHide?.();
  const open = (a: Approval) => void desktop?.openThread?.(a.threadId);

  const run = (action: QuickAction, a: Approval | null) => {
    if (action.type === 'close') return close();
    if (action.type === 'move') {
      setWriting(false);
      setSelected((i) => Math.max(0, Math.min(pending.length - 1, i + action.by)));
      return;
    }
    if (!a || answer.isPending) return;
    if (action.type === 'open') return open(a);
    if (action.type === 'allow') return answer.mutate({ id: a.id, decision: 'allow' });
    if (action.type === 'deny') return answer.mutate({ id: a.id, decision: 'deny' });
    if (action.type === 'write') return setWriting(true);
    const option = questionItems(a).items[0]?.options[action.index];
    if (option !== undefined) answer.mutate({ id: a.id, decision: 'allow', answer: option });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // While an answer is typed, the keys are its letters; Esc only stops writing.
      if (writing) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setWriting(false);
        }
        return;
      }
      const action = quickAction(e, current ? cardOf(current) : null);
      if (!action) return;
      e.preventDefault();
      run(action, current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="flex h-full flex-col bg-background text-sm">
      <header className="flex items-center gap-2 border-b px-4 py-3 [-webkit-app-region:drag]">
        <span className="font-medium">{t('quick.title')}</span>
        {pending.length > 0 && <span className="text-muted-foreground tabular-nums">{pending.length}</span>}
        {shortcut && (
          <span className="ms-auto flex gap-1 text-xs text-muted-foreground">
            {shortcutLabel(shortcut, mac).map((k) => (
              <Key key={k}>{k}</Key>
            ))}
          </span>
        )}
      </header>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {approvals === undefined ? null : pending.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <CircleCheck className="size-6 text-emerald-500" />
            {t('quick.empty')}
          </div>
        ) : (
          pending.map((a, i) => (
            <Card
              key={a.id}
              a={a}
              bot={byId.get(a.botId)}
              selected={a.id === current?.id}
              onSelect={() => setSelected(i)}
              onAction={(action) => {
                setSelected(i);
                run(action, a);
              }}
              writing={writing && a.id === current?.id}
              draft={draft}
              setDraft={setDraft}
              busy={answer.isPending}
              onSend={() => {
                if (draft.trim()) answer.mutate({ id: a.id, decision: 'allow', answer: draft.trim() });
              }}
            />
          ))
        )}
      </div>
      <footer className="flex flex-wrap gap-x-3 gap-y-1 border-t px-4 py-2 text-xs text-muted-foreground">
        <Hint keys={['↑', '↓']} label={t('quick.hintMove')} />
        <Hint keys={['1–9']} label={t('quick.hintAnswer')} />
        <Hint keys={['R']} label={t('quick.hintWrite')} />
        <Hint keys={['O']} label={t('quick.hintOpen')} />
        <Hint keys={['Esc']} label={t('quick.hintClose')} />
      </footer>
    </div>
  );
}

function Card({
  a,
  bot,
  selected,
  onSelect,
  onAction,
  writing,
  draft,
  setDraft,
  busy,
  onSend,
}: {
  a: Approval;
  bot: Bot | undefined;
  selected: boolean;
  onSelect(): void;
  onAction(action: QuickAction): void;
  writing: boolean;
  draft: string;
  setDraft(v: string): void;
  busy: boolean;
  onSend(): void;
}) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale((s) => s.locale);
  const ref = useRef<HTMLDivElement>(null);
  const botName = bot?.name ?? t('common.bot');
  const card = cardOf(a);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  const question = a.kind === 'question' ? questionItems(a).items[0] : undefined;
  const text =
    a.kind === 'tool'
      ? describeAction(a.toolName, a.input, { bot: botName, locale }).want
      : a.kind === 'login'
        ? t('quick.login', { summary: a.summary })
        : (question?.question ?? a.summary);
  const Icon = a.kind === 'tool' ? ShieldAlert : a.kind === 'login' ? KeyRound : MessageCircleQuestion;

  return (
    <div
      ref={ref}
      onClick={onSelect}
      className={cn(
        'space-y-2 rounded-2xl border px-3 py-2.5',
        selected ? 'border-amber-500/60 bg-amber-500/5' : 'bg-card/50',
      )}
    >
      <div className="flex items-center gap-2">
        {bot && <BotAvatar avatar={bot.avatar} color={bot.color} seed={bot.id} size={22} />}
        <span className="min-w-0 flex-1 truncate font-medium">{botName}</span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {f.shortTime(a.createdAt)}
        </span>
      </div>
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1 break-words">{text}</div>
      </div>
      {card.kind === 'tool' && (
        <div className="flex flex-wrap gap-1.5 ps-6">
          <Choice
            n="1"
            label={t('approval.allowOnce')}
            disabled={busy}
            onClick={() => onAction({ type: 'allow' })}
          />
          <Choice
            n="2"
            label={t('approval.deny')}
            disabled={busy}
            onClick={() => onAction({ type: 'deny' })}
          />
        </div>
      )}
      {card.kind === 'question' && question && (
        <div className="space-y-1 ps-6">
          {question.options.slice(0, 9).map((o, i) => (
            <Choice
              key={o}
              n={String(i + 1)}
              label={o}
              disabled={busy}
              onClick={() => onAction({ type: 'choose', index: i })}
            />
          ))}
          {writing ? (
            <textarea
              autoFocus
              rows={2}
              value={draft}
              disabled={busy}
              placeholder={t('quick.writePlaceholder')}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  onSend();
                }
              }}
              className="w-full resize-none rounded-xl border bg-background px-2.5 py-1.5 outline-none focus:ring-2 focus:ring-ring"
            />
          ) : (
            <Choice
              n="R"
              label={t('quick.write')}
              disabled={busy}
              onClick={() => onAction({ type: 'write' })}
            />
          )}
        </div>
      )}
      {card.kind === 'open' && (
        <div className="ps-6">
          <Choice
            n="O"
            label={t('quick.openChat')}
            disabled={busy}
            onClick={() => onAction({ type: 'open' })}
          />
        </div>
      )}
    </div>
  );
}

function Choice({
  n,
  label,
  disabled,
  onClick,
}: {
  n: string;
  label: string;
  disabled: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-start hover:bg-accent disabled:opacity-50"
    >
      <Key>{n}</Key>
      <span className="min-w-0 break-words">{label}</span>
    </button>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded border bg-muted px-1 font-sans text-[11px] text-muted-foreground">
      {children}
    </kbd>
  );
}

function Hint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((k) => (
        <Key key={k}>{k}</Key>
      ))}
      {label}
    </span>
  );
}
