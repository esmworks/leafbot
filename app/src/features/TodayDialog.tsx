import type { CanaryAlarm, TodayReport } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Brain,
  CircleAlert,
  CircleCheck,
  Clock,
  Loader2,
  ShieldAlert,
  Sparkles,
  UserPlus,
} from 'lucide-react';
import { useClosedCards } from '@/features/ActionCards';
import { useNewcomers } from '@/features/Newcomers';
import { useSpaceRequestTitle, useSpaceRequests } from '@/features/SpaceRequests';
import { personName } from '@/features/PeopleTab';
import { BotAvatar } from '@/components/BotAvatar';
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useBots, useRoutineHealth, useSummaries } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { RoutineSuggestionsSection } from './RoutineSuggestions';
import { SkillSuggestionsSection } from './SkillSuggestions';
import { SecondYesSection } from './SecondYes';
import { cn } from '@/lib/utils';

/**
 * Today at a glance: what waits for the person, what each bot did and what the routines ran,
 * each a click away from its conversation.
 */
export function TodayDialog() {
  const t = useT();
  const f = useFormat();
  const open = useUi((s) => s.todayOpen);
  const setOpen = useUi((s) => s.setTodayOpen);
  const { data } = useQuery({
    queryKey: ['today'],
    queryFn: api.today,
    enabled: open,
    refetchOnMount: 'always',
  });
  const qc = useQueryClient();
  // An alarm stays on this page until the person says they saw it.
  const seen = useMutation({
    mutationFn: (id: string) => api.canaryAlarmSeen(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['today'] }),
  });
  const { data: summaries = [] } = useSummaries();
  const { data: bots = [] } = useBots();
  const newcomers = useNewcomers();
  const spaceRequests = useSpaceRequests();
  const requestTitle = useSpaceRequestTitle();
  const reopen = useClosedCards((c) => c.reopen);
  /** Brings a card back over the app, even one closed on this device, and steps aside for it. */
  const back = (id: string) => {
    reopen(id);
    setOpen(false);
  };
  const byId = new Map(bots.map((b) => [b.id, b]));
  const waiting = summaries.filter((s) => s.waiting);
  const { data: health = [] } = useRoutineHealth(open);
  // Only what is wrong: something to gain, or a routine not used, waits for Settings → Routines.
  const attention = health.filter((h) => h.status === 'problem').length;
  const go = (botId: string, threadId?: string | null) => {
    const ui = useUi.getState();
    ui.openChat(botId);
    if (threadId) ui.selectThread(threadId);
    setOpen(false);
  };
  const avatar = (botId: string) => {
    const b = byId.get(botId);
    return b ? (
      <BotAvatar avatar={b.avatar} material={b.material} color={b.color} seed={b.id} size={28} />
    ) : null;
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="flex max-h-[85vh] flex-col overflow-hidden rounded-3xl sm:max-w-lg"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>{t('today.title')}</DialogTitle>
        </DialogHeader>
        {!data ? (
          <div className="flex justify-center py-10 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <DialogBody className="space-y-5 text-sm">
            <p className="text-muted-foreground">
              {t('today.summary', {
                turns: data.bots.reduce((n, b) => n + b.turns, 0),
                runs: data.runs.length,
                cost: f.usd(data.costUsd),
              })}
            </p>
            {/* A bot caught steered by text it read: stopped and moved to "Ask" until the person has seen it. */}
            {data.canaryAlarms?.length ? (
              <section>
                <h3 className="mb-1.5 flex items-center gap-1.5 px-1 text-xs font-medium text-destructive">
                  <ShieldAlert className="size-3.5" />
                  {t('today.canary')}
                </h3>
                <div className="divide-y rounded-2xl border border-destructive/40 bg-destructive/5">
                  {data.canaryAlarms.map((a) => (
                    <CanaryItem
                      key={a.id}
                      alarm={a}
                      onOpen={() => go(a.botId, a.threadId)}
                      onSeen={() => seen.mutate(a.id)}
                      busy={seen.isPending}
                    />
                  ))}
                </div>
              </section>
            ) : null}
            {/* Steps that need this person's second yes; they do not see the conversation. */}
            <SecondYesSection enabled={open} />
            {/* What the person keeps asking a bot for by hand, offered as a routine. */}
            <RoutineSuggestionsSection enabled={open} />
            {/* A many-step task the person keeps asking a bot for, offered as a skill. */}
            <SkillSuggestionsSection enabled={open} />
            <Section
              title={t('today.waiting')}
              empty={t('today.waitingNone')}
              items={waiting}
              extra={
                <>
                  {/* Someone new waits for their team spaces; their card is at the bottom right. */}
                  {newcomers.map((p) => (
                    <Item key={p.id} onClick={() => back(p.id)}>
                      <UserPlus className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        {t('newcomer.joined', { name: personName(p, t('people.owner')) })}
                      </span>
                      <span className="shrink-0 text-xs font-medium text-amber-600 dark:text-amber-400">
                        {t('newcomer.chooseShort')}
                      </span>
                    </Item>
                  ))}
                  {/* Someone asks to join a closed space; their card is at the bottom right too. */}
                  {spaceRequests.map((r) => (
                    <Item key={r.id} onClick={() => back(r.id)}>
                      <UserPlus className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{requestTitle(r)}</span>
                      <span className="shrink-0 text-xs font-medium text-amber-600 dark:text-amber-400">
                        {t('spaceRequest.short')}
                      </span>
                    </Item>
                  ))}
                  {/* Memory changes asked for while nobody watched wait for the person's yes. */}
                  {data.pendingMemory ? (
                    <Item
                      onClick={() => {
                        useUi.getState().openSettings('memory');
                        setOpen(false);
                      }}
                    >
                      <Brain className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        {t('today.pendingMemory', { count: data.pendingMemory })}
                      </span>
                      <span className="shrink-0 text-xs font-medium text-amber-600 dark:text-amber-400">
                        {t('today.pendingMemoryReview')}
                      </span>
                    </Item>
                  ) : null}
                  {/* Gaps bots found in what they know wait for the person's answer. */}
                  {data.openFlags ? (
                    <Item
                      onClick={() => {
                        useUi.getState().openSettings('memory');
                        setOpen(false);
                      }}
                    >
                      <Brain className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        {t('today.openFlags', { count: data.openFlags })}
                      </span>
                      <span className="shrink-0 text-xs font-medium text-amber-600 dark:text-amber-400">
                        {t('memory.flagAnswer')}
                      </span>
                    </Item>
                  ) : null}
                  {/* Routines whose runs point to something wrong, worth changing, or not used. */}
                  {attention ? (
                    <Item
                      onClick={() => {
                        useUi.getState().openSettings('routines');
                        setOpen(false);
                      }}
                    >
                      <Clock className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        {t('today.routineHealth', { count: attention })}
                      </span>
                      <span className="shrink-0 text-xs font-medium text-amber-600 dark:text-amber-400">
                        {t('today.routineHealthOpen')}
                      </span>
                    </Item>
                  ) : null}
                  {/* Better ways bots found for the person's skills wait for the person to read them. */}
                  {data.pendingSkills ? (
                    <Item
                      onClick={() => {
                        useUi.getState().openSettings('skills');
                        setOpen(false);
                      }}
                    >
                      <Sparkles className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        {t('today.pendingSkills', { count: data.pendingSkills })}
                      </span>
                      <span className="shrink-0 text-xs font-medium text-amber-600 dark:text-amber-400">
                        {t('today.pendingMemoryReview')}
                      </span>
                    </Item>
                  ) : null}
                  {/* Notes past their "true until" date wait in the memory screen too. */}
                  {data.expiredMemory ? (
                    <Item
                      onClick={() => {
                        useUi.getState().openSettings('memory');
                        setOpen(false);
                      }}
                    >
                      <Brain className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        {t('today.expiredMemory', { count: data.expiredMemory })}
                      </span>
                      <span className="shrink-0 text-xs font-medium text-amber-600 dark:text-amber-400">
                        {t('today.staleMemoryReview')}
                      </span>
                    </Item>
                  ) : null}
                  {/* Notes no bot uses wait for the person to keep or delete them in the memory screen. */}
                  {data.staleMemory ? (
                    <Item
                      onClick={() => {
                        useUi.getState().openSettings('memory');
                        setOpen(false);
                      }}
                    >
                      <Brain className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        {t('today.staleMemory', { count: data.staleMemory })}
                      </span>
                      <span className="shrink-0 text-xs font-medium text-amber-600 dark:text-amber-400">
                        {t('today.staleMemoryReview')}
                      </span>
                    </Item>
                  ) : null}
                </>
              }
            >
              {(s) => (
                <Item key={s.botId} onClick={() => go(s.botId, s.waiting!.threadId)}>
                  {avatar(s.botId)}
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{byId.get(s.botId)?.name}</span>{' '}
                    <span className="text-muted-foreground">{s.waiting!.summary}</span>
                  </span>
                  <span className="shrink-0 text-xs font-medium text-amber-600 dark:text-amber-400">
                    {t(`sidebar.waitingFor.${s.waiting!.kind}`)}
                  </span>
                </Item>
              )}
            </Section>
            <Section title={t('today.bots')} empty={t('today.botsNone')} items={data.bots}>
              {(b: TodayReport['bots'][number]) => (
                <Item key={b.botId} onClick={() => go(b.botId)}>
                  {avatar(b.botId)}
                  <span className="min-w-0 flex-1 truncate font-medium">{b.name}</span>
                  {b.failed > 0 && (
                    <span className="shrink-0 text-xs text-destructive">
                      {t('today.failed', { count: b.failed })}
                    </span>
                  )}
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {t('usage.turnCount', { count: b.turns })}
                  </span>
                </Item>
              )}
            </Section>
            <Section title={t('today.runs')} empty={t('today.runsNone')} items={data.runs}>
              {(r: TodayReport['runs'][number]) => (
                <Item key={`${r.routineId}:${r.startedAt}`} onClick={() => go(r.botId, r.threadId)}>
                  <RunIcon status={r.status} />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{r.name}</span>{' '}
                    <span className="text-muted-foreground">{byId.get(r.botId)?.name}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {f.shortTime(r.startedAt)}
                  </span>
                </Item>
              )}
            </Section>
          </DialogBody>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Section<T>({
  title,
  empty,
  items,
  extra,
  children,
}: {
  title: string;
  empty: string;
  items: T[];
  /** A line after the items, not one of them. */
  extra?: React.ReactNode;
  children: (item: T) => React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-1.5 px-1 text-xs font-medium text-muted-foreground">{title}</h3>
      {items.length || extra ? (
        <div className="divide-y rounded-2xl border bg-card/50">
          {items.map(children)}
          {extra}
        </div>
      ) : (
        <p className="px-1 text-muted-foreground">{empty}</p>
      )}
    </section>
  );
}

function Item({ onClick, children }: { onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-3 py-2 text-start first:rounded-t-2xl last:rounded-b-2xl hover:bg-accent/50"
    >
      {children}
    </button>
  );
}

function RunIcon({ status }: { status: TodayReport['runs'][number]['status'] }) {
  const cls = 'size-4 shrink-0';
  if (status === 'done') return <CircleCheck className={cn(cls, 'text-emerald-500')} />;
  if (status === 'error') return <CircleAlert className={cn(cls, 'text-destructive')} />;
  return <Clock className={cn(cls, 'text-muted-foreground')} />;
}

/** One alarm: what tripped, what the bot had read, and that it now asks first. */
function CanaryItem({
  alarm: a,
  onOpen,
  onSeen,
  busy,
}: {
  alarm: CanaryAlarm;
  onOpen(): void;
  onSeen(): void;
  busy: boolean;
}) {
  const t = useT();
  const f = useFormat();
  return (
    <div className="space-y-1 px-3 py-2">
      <div className="font-medium">
        {a.wire === 'key'
          ? t('today.canaryKey', { bot: a.botName, key: a.keyName ?? '' })
          : t('today.canaryPrompt', { bot: a.botName })}
      </div>
      <div className="text-xs text-muted-foreground">
        {f.shortTime(a.createdAt)}
        {a.movedFrom ? ` · ${t('today.canaryMoved')}` : ''}
      </div>
      <div className="text-xs text-muted-foreground">
        {a.sources.length
          ? t('today.canarySources', { sources: a.sources.join(', ') })
          : t('today.canaryNoSources')}
      </div>
      <div className="flex justify-end gap-2 pt-1">
        {a.threadId && (
          <button type="button" onClick={onOpen} className="text-xs font-medium hover:underline">
            {t('today.canaryOpen')}
          </button>
        )}
        <button
          type="button"
          onClick={onSeen}
          disabled={busy}
          className="text-xs font-medium text-destructive hover:underline"
        >
          {t('today.canarySeen')}
        </button>
      </div>
    </div>
  );
}
