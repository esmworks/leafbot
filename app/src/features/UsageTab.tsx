import {
  planPace,
  planTone,
  ROUTINE_GATE_MODES,
  USAGE_RANGES,
  type Bot,
  type StorageReport,
  type UsageRange,
  type UsageReport,
} from '@leafbot/shared';
import { Download, Loader2, RotateCw } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BotAvatar } from '@/components/BotAvatar';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useT } from '@/i18n';
import { useFormat } from '@/lib/format';
import { PLAN_TONE_BAR, planLabel } from '@/lib/planUsage';
import { useBots, useSettings, useStorage, useUsage } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Chip } from './onboarding/Chip';
import { Card, Row, useSaveSettings } from './SettingsPage';
import { UnusedCard } from './UnusedCard';

/** What the bots cost over a period: a total, the cost per day and the cost per bot. */
export function UsageTab() {
  const t = useT();
  const { data: settings } = useSettings();
  const f = useFormat();
  const [days, setDays] = useState<UsageRange>(30);
  const [botId, setBotId] = useState<string | null>(null);
  const { data, isPending, isError } = useUsage(days, botId ?? undefined);
  const { data: bots } = useBots();

  return (
    <>
      <div className="mb-2 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-sm text-muted-foreground">{t('usage.total')}</div>
          <div className="text-3xl font-semibold tabular-nums">{data ? f.usd(data.total.costUsd) : '–'}</div>
          <div className="text-sm text-muted-foreground tabular-nums">
            {data ? t('usage.turnCount', { count: data.total.turns }) : ' '}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Select value={botId ?? ALL} onValueChange={(v) => setBotId(v === ALL ? null : v)}>
            <SelectTrigger className="w-44 rounded-full" aria-label={t('usage.botFilter')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('usage.allBots')}</SelectItem>
              {(bots ?? []).map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v) as UsageRange)}>
            <SelectTrigger className="w-44 rounded-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {USAGE_RANGES.map((d) => (
                <SelectItem key={d} value={String(d)}>
                  {t(`usage.range.${d}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {/* What the total is (an estimate on a subscription) belongs with the total, not after the
          lists below it. */}
      <div className="mb-8 space-y-1 text-xs leading-relaxed text-muted-foreground">
        {data && <p>{t('usage.estimate')}</p>}
        {data && data.total.unpriced > 0 && <p>{t('usage.unpriced', { count: data.total.unpriced })}</p>}
      </div>
      {isPending ? (
        <div className="flex justify-center py-16 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : isError || !data ? (
        <p className="py-16 text-center text-sm text-muted-foreground">{t('usage.failed')}</p>
      ) : (
        <Report data={data} filtered={botId !== null} onPickBot={setBotId} />
      )}
      <PlanUsage plan={data?.plan} />
      <Card title={t('usage.limits')}>
        <SpendLimit period="month" spend={data?.month} />
        {settings?.dailyLimitUsd !== undefined && <SpendLimit period="day" spend={data?.day} />}
      </Card>
      <RoutineGate gate={data?.gate} />
      <PromiseNet net={data?.promises} />
      <SuggestionNet net={data?.suggestions} />
      <OfferNet net={data?.offers} />
      <TidyNet net={data?.tidy} />
      <SkillNet net={data?.skillSuggestions} />
      <BackgroundNet calls={data?.background} />
      <Parallel parallel={data?.parallel} />
      <Steps />
      <Storage />
      <UnusedCard />
      <Button variant="secondary" size="sm" className="rounded-full" asChild>
        <a href={`/api/usage/turns.csv?days=${days}`} download>
          <Download /> {t('usage.downloadCsv')}
        </a>
      </Button>
    </>
  );
}

/** This month's or today's spending against its limit, and the limit itself (empty or 0 for none). */
function SpendLimit({ period, spend }: { period: 'month' | 'day'; spend?: UsageReport['month'] }) {
  const t = useT();
  const f = useFormat();
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  const [draft, setDraft] = useState<string | null>(null);
  const key = period === 'month' ? 'monthlyLimitUsd' : 'dailyLimitUsd';
  const limit = settings?.[key] ?? 0;
  const value = draft ?? (limit ? String(limit) : '');
  const commit = () => {
    if (draft === null) return;
    const n = Number(draft.replace(',', '.'));
    setDraft(null);
    if (!Number.isFinite(n) || n < 0 || n === limit) return;
    save.mutate({ [key]: Math.round(n * 100) / 100 });
  };
  const share = spend && spend.limitUsd > 0 ? Math.min(1, spend.costUsd / spend.limitUsd) : 0;
  return (
    // One block, so the card's divider runs between the periods, not between a row and its bar.
    <div>
      <Row
        label={`${t(period === 'month' ? 'usage.month' : 'usage.day')} · ${spend ? f.usd(spend.costUsd) : '–'}`}
        hint={
          spend && spend.limitUsd > 0
            ? t(period === 'month' ? 'usage.monthOf' : 'usage.dayOf', { limit: f.usd(spend.limitUsd) })
            : t(period === 'month' ? 'usage.noLimit' : 'usage.noDayLimit')
        }
      >
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          {t('usage.limit')}
          <Input
            inputMode="decimal"
            value={value}
            placeholder="0"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && commit()}
            className="h-8 w-24 rounded-full text-end tabular-nums"
            aria-label={t('usage.limit')}
          />
        </label>
      </Row>
      {spend && spend.limitUsd > 0 && (
        <div className="px-4 pb-4">
          <div className="h-2 overflow-hidden rounded-full bg-secondary">
            <div
              className={cn(
                'h-full rounded-full',
                share >= 1 ? 'bg-red-500' : share >= 0.8 ? 'bg-amber-500' : 'bg-emerald-500',
              )}
              style={{ width: `${share * 100}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The small-model check before routine runs that a watched page or a webhook started: off,
 * watching only, or on; and over the period, what it cost and what it would have saved.
 */
function RoutineGate({ gate }: { gate?: UsageReport['gate'] }) {
  const t = useT();
  const f = useFormat();
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  const mode = settings?.routineGate;
  // A server older than the check does not offer it.
  if (!mode) return null;
  return (
    <Card title={t('usage.gate')}>
      <Row label={t(`usage.gate.${mode}`)} hint={t(`usage.gate.${mode}Hint`)}>
        <div className="flex flex-wrap gap-2">
          {ROUTINE_GATE_MODES.map((m) => (
            <Chip key={m} on={mode === m} onClick={() => m !== mode && save.mutate({ routineGate: m })}>
              {t(`usage.gate.choice.${m}`)}
            </Chip>
          ))}
        </div>
      </Row>
      {gate && (
        <div className="space-y-1 px-4 pb-4 text-sm text-muted-foreground tabular-nums">
          <div>{t('usage.gate.checks', { count: gate.checks, cost: f.usd(gate.costUsd) })}</div>
          {gate.skippable > 0 && (
            <div>
              {t('usage.gate.skippable', { count: gate.skippable, cost: f.usd(gate.skippableCostUsd) })}
            </div>
          )}
          {gate.skipped > 0 && <div>{t('usage.gate.skipped', { count: gate.skipped })}</div>}
        </div>
      )}
    </Card>
  );
}

/** The promise safety net: on or off, and over the period what its looks at replies cost. */
function PromiseNet({ net }: { net?: UsageReport['promises'] }) {
  const t = useT();
  const f = useFormat();
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  const on = settings?.promiseKeeper;
  // A server older than the net does not offer it.
  if (on === undefined) return null;
  return (
    <Card title={t('usage.promises')}>
      <Row label={t('usage.promises.on')} hint={t('usage.promises.hint')}>
        <Switch
          checked={on}
          aria-label={t('usage.promises.on')}
          onCheckedChange={(v) => save.mutate({ promiseKeeper: v })}
        />
      </Row>
      {net && (
        <div className="px-4 pb-4 text-sm text-muted-foreground tabular-nums">
          {t('usage.promises.checks', { count: net.checks, cost: f.usd(net.costUsd), found: net.found })}
        </div>
      )}
    </Card>
  );
}

/** The calls the routine suggestions made to the small model over the period, and what they cost. */
function SuggestionNet({ net }: { net?: UsageReport['suggestions'] }) {
  const t = useT();
  const f = useFormat();
  if (!net) return null;
  return (
    <Card title={t('usage.suggestions')}>
      <div className="px-4 py-3 text-sm text-muted-foreground tabular-nums">
        {t('usage.suggestions.checks', { count: net.checks, cost: f.usd(net.costUsd), found: net.found })}
      </div>
    </Card>
  );
}

/** The looks the work offers took at conversations over the period, and what they cost. */
function OfferNet({ net }: { net?: UsageReport['offers'] }) {
  const t = useT();
  const f = useFormat();
  if (!net) return null;
  return (
    <Card title={t('usage.offers')}>
      <div className="px-4 py-3 text-sm text-muted-foreground tabular-nums">
        {t('usage.offers.checks', { count: net.checks, cost: f.usd(net.costUsd), found: net.found })}
      </div>
    </Card>
  );
}

/** The memory tidy-up's calls over the period: sets of notes and pages read, what they cost, notes changed. */
function TidyNet({ net }: { net?: UsageReport['tidy'] }) {
  const t = useT();
  const f = useFormat();
  if (!net) return null;
  return (
    <Card title={t('usage.tidy')}>
      <div className="px-4 py-3 text-sm text-muted-foreground tabular-nums">
        {t('usage.tidy.checks', {
          sets: net.sets,
          sources: net.sources,
          cost: f.usd(net.costUsd),
          changed: net.changed,
        })}
      </div>
    </Card>
  );
}

/** The calls the skill suggestions made to the small model over the period, and what they cost. */
function SkillNet({ net }: { net?: UsageReport['skillSuggestions'] }) {
  const t = useT();
  const f = useFormat();
  if (!net) return null;
  return (
    <Card title={t('usage.skillSuggestions')}>
      <div className="px-4 py-3 text-sm text-muted-foreground tabular-nums">
        {t('usage.skillSuggestions.checks', {
          count: net.checks,
          cost: f.usd(net.costUsd),
          found: net.found,
        })}
      </div>
    </Card>
  );
}

/** The other background calls over the period, one line per kind: how many, and what they cost. */
function BackgroundNet({ calls }: { calls?: UsageReport['background'] }) {
  const t = useT();
  const f = useFormat();
  if (!calls?.length) return null;
  return (
    <Card title={t('usage.background')}>
      {calls.map((c) => (
        <Row
          key={c.kind}
          label={t(`usage.background.${c.kind}`)}
          hint={t('usage.background.line', { count: c.calls, cost: f.usd(c.costUsd) })}
        />
      ))}
    </Card>
  );
}

/**
 * The Claude plan's usage windows, each a bar with a line where the window's time stands: a bar
 * past its line spends the plan faster than the window lasts.
 */
function PlanUsage({ plan }: { plan?: UsageReport['plan'] }) {
  const t = useT();
  const f = useFormat();
  // The time the page opened: the marks stay put while it is read.
  const [now] = useState(() => Date.now());
  if (!plan?.windows.length) return null;
  return (
    <Card title={t('usage.plan')}>
      <div className="space-y-4 px-4 py-4">
        {plan.windows.map((w) => {
          const pace = planPace(w, now);
          const used = w.used ?? 0;
          return (
            <div key={w.kind} className="space-y-1.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="font-medium">{planLabel(w, t)}</span>
                <span className="text-muted-foreground tabular-nums">
                  {w.used === null ? '–' : t('usage.plan.used', { percent: Math.round(used * 100) })}
                  {w.resetsAt && ` · ${t('usage.plan.resets', { time: f.dayLabel(w.resetsAt) })}`}
                </span>
              </div>
              <div className="relative h-2 rounded-full bg-secondary">
                <div
                  className={cn('h-full rounded-full', PLAN_TONE_BAR[planTone(w, now)])}
                  style={{ width: `${used * 100}%` }}
                />
                {pace !== null && (
                  <div
                    className="absolute -top-1 -bottom-1 w-0.5 rounded-full bg-foreground/60"
                    style={{ left: `calc(${pace * 100}% - 1px)` }}
                    aria-hidden
                  />
                )}
              </div>
            </div>
          );
        })}
        <p className="text-xs text-muted-foreground">{t('usage.plan.hint')}</p>
        <p className="text-xs text-muted-foreground">{t('usage.plan.seen', { time: f.dayLabel(plan.at) })}</p>
      </div>
    </Card>
  );
}

/** How many turns may run at once; 0 leaves it to the server. */
function Parallel({ parallel }: { parallel?: UsageReport['parallel'] }) {
  const t = useT();
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  // A server older than the setting does not offer it.
  if (!parallel || settings?.maxTurns === undefined) return null;
  const value = settings.maxTurns;
  return (
    <Card title={t('usage.parallel')}>
      <Row label={t('usage.parallel')} hint={t('usage.parallel.hint')}>
        <Select value={String(value)} onValueChange={(v) => save.mutate({ maxTurns: Number(v) })}>
          <SelectTrigger className="w-40 rounded-full" aria-label={t('usage.parallel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PARALLEL_CHOICES.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n === 0 ? t('usage.parallel.default', { count: parallel.serverDefault }) : String(n)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
    </Card>
  );
}

/** 0 is the server's own number. */
const PARALLEL_CHOICES = [0, 1, 2, 3, 4, 5, 6, 8, 10];

/** How many model calls one turn may make before it stops; 0 leaves it to the engine. */
function Steps() {
  const t = useT();
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  // A server older than the setting does not offer it.
  if (settings?.maxSteps === undefined) return null;
  return (
    <Card title={t('usage.steps')}>
      <Row label={t('usage.steps')} hint={t('usage.steps.hint')}>
        <Select value={String(settings.maxSteps)} onValueChange={(v) => save.mutate({ maxSteps: Number(v) })}>
          <SelectTrigger className="w-40 rounded-full" aria-label={t('usage.steps')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STEP_CHOICES.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n === 0 ? t('usage.parallel.default', { count: ENGINE_STEPS }) : String(n)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
    </Card>
  );
}

/** The engines' own number of steps per turn, which 0 leaves it to. */
const ENGINE_STEPS = 50;
/** 0 is the engines' own number; the server takes at most 500. */
const STEP_CHOICES = [0, 100, 200, 300, 500];

/** The bot filter's value for every bot; bot ids never take this form. */
const ALL = '*';

function Report({
  data,
  filtered,
  onPickBot,
}: {
  data: UsageReport;
  filtered: boolean;
  onPickBot: (botId: string) => void;
}) {
  const t = useT();
  const f = useFormat();
  const { data: bots } = useBots();
  const byId = new Map((bots ?? []).map((b) => [b.id, b]));
  return (
    <>
      <Card title={t('usage.daily')}>
        <div className="p-4">
          <DailyChart daily={data.daily} />
        </div>
      </Card>
      {!filtered && (
        <Card title={t('usage.bots')}>
          {data.bots.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">{t('usage.empty')}</p>
          ) : (
            data.bots.map((b) => {
              const bot = byId.get(b.botId);
              const share = data.total.costUsd > 0 ? b.costUsd / data.total.costUsd : 0;
              return (
                <button
                  type="button"
                  key={b.botId}
                  title={t('usage.showBot')}
                  className="flex w-full items-center gap-3 px-4 py-3 text-start hover:bg-accent/50"
                  onClick={() => onPickBot(b.botId)}
                >
                  {bot ? (
                    <BotAvatar
                      avatar={bot.avatar}
                      material={bot.material}
                      color={bot.color}
                      seed={bot.id}
                      size={28}
                    />
                  ) : (
                    <span className="size-7 shrink-0 rounded-full bg-secondary" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 text-sm">
                      <span className="truncate">{b.name || '–'}</span>
                      {b.archived && (
                        <span className="shrink-0 text-xs text-muted-foreground">{t('usage.archived')}</span>
                      )}
                    </div>
                    {/* Its part of the total, on one scale for every bot. */}
                    <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-secondary">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${share * 100}%` }} />
                    </div>
                  </div>
                  <div className="w-20 shrink-0 text-end text-xs text-muted-foreground tabular-nums">
                    {t('usage.turnCount', { count: b.turns })}
                  </div>
                  <div className="w-20 shrink-0 text-end text-sm font-medium tabular-nums">
                    {f.usd(b.costUsd)}
                  </div>
                </button>
              );
            })
          )}
        </Card>
      )}
      <Card title={t('usage.models')}>
        {data.models.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">{t('usage.empty')}</p>
        ) : (
          data.models.map((m) => {
            const share = data.total.costUsd > 0 ? m.costUsd / data.total.costUsd : 0;
            return (
              <div key={`${m.engine}:${m.model}`} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 text-sm">
                    <span className="truncate">
                      {m.model || (m.engine ? t('usage.defaultModel') : t('usage.unknownModel'))}
                    </span>
                    {m.engine && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {m.engine === 'acp'
                          ? t('bot.engine.acp', { name: m.model ?? '' })
                          : t(`bot.engine.${m.engine}`)}
                      </span>
                    )}
                  </div>
                  <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-secondary">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${share * 100}%` }} />
                  </div>
                </div>
                <div className="w-20 shrink-0 text-end text-xs text-muted-foreground tabular-nums">
                  {t('usage.turnCount', { count: m.turns })}
                </div>
                <div className="w-20 shrink-0 text-end text-sm font-medium tabular-nums">
                  {f.usd(m.costUsd)}
                </div>
              </div>
            );
          })
        )}
      </Card>
      {!!(data.routines?.length || data.rehearsals?.length) && (
        <Card title={t('usage.routines')}>
          {[
            ...(data.routines ?? []).map((r) => ({ ...r, key: r.routineId, label: r.name })),
            // A rehearsal's cost is real, and shown apart from the routine's own runs.
            ...(data.rehearsals ?? []).map((r) => ({
              ...r,
              key: `rehearsal-${r.routineId}`,
              label: t('usage.rehearsalOf', { name: r.name }),
            })),
          ].map((r) => {
            const share = data.total.costUsd > 0 ? r.costUsd / data.total.costUsd : 0;
            const bot = r.botId ? byId.get(r.botId) : undefined;
            return (
              <div key={r.key} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 text-sm">
                    <span className="truncate">{r.label}</span>
                    {bot && !filtered && (
                      <span className="shrink-0 text-xs text-muted-foreground">{bot.name}</span>
                    )}
                  </div>
                  <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-secondary">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${share * 100}%` }} />
                  </div>
                </div>
                <div className="w-20 shrink-0 text-end text-xs text-muted-foreground tabular-nums">
                  {t('usage.turnCount', { count: r.turns })}
                </div>
                <div className="w-20 shrink-0 text-end text-sm font-medium tabular-nums">
                  {f.usd(r.costUsd)}
                </div>
              </div>
            );
          })}
        </Card>
      )}
    </>
  );
}

/** One bar per day, the highest at the top of the plot; hovering a day shows its numbers. */
function DailyChart({ daily }: { daily: UsageReport['daily'] }) {
  const t = useT();
  const f = useFormat();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...daily.map((d) => d.costUsd));
  const first = daily[0]!;
  const last = daily.at(-1)!;
  const tip = hover === null ? null : daily[hover]!;
  return (
    <figure className="m-0">
      <div className="relative">
        <div className="mb-1 text-xs text-muted-foreground tabular-nums">
          {max > 0 ? f.usd(max) : f.usd(0)}
        </div>
        <div
          role="img"
          aria-label={t('usage.chart', { from: f.calendarDay(first.date), to: f.calendarDay(last.date) })}
          className="relative flex h-36 items-end gap-0.5 border-t border-b border-t-border/40 border-b-border"
          onMouseLeave={() => setHover(null)}
        >
          {daily.map((d, i) => (
            // The whole column is the hover target, not only the bar.
            <div
              key={d.date}
              className={cn(
                'flex h-full min-w-0 flex-1 items-end rounded-t-[4px]',
                hover === i && 'bg-accent',
              )}
              onMouseEnter={() => setHover(i)}
            >
              {d.costUsd > 0 && (
                <div
                  className="w-full rounded-t-[4px] bg-primary"
                  style={{ height: `max(2px, ${(d.costUsd / max) * 100}%)` }}
                />
              )}
            </div>
          ))}
        </div>
        {tip && (
          <div
            className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-lg border bg-popover px-2.5 py-1.5 text-xs whitespace-nowrap text-popover-foreground shadow-md"
            style={{ left: `clamp(70px, ${((hover! + 0.5) / daily.length) * 100}%, calc(100% - 70px))` }}
          >
            <div className="font-medium">{f.calendarDay(tip.date)}</div>
            <div className="text-muted-foreground tabular-nums">
              {f.usd(tip.costUsd)} · {t('usage.turnCount', { count: tip.turns })}
            </div>
          </div>
        )}
      </div>
      <div className="mt-1.5 flex justify-between text-xs text-muted-foreground">
        <span>{f.calendarDay(first.date, true)}</span>
        <span>{f.calendarDay(last.date, true)}</span>
      </div>
      {/* The same numbers for a screen reader. */}
      <table className="sr-only">
        <tbody>
          {daily.map((d) => (
            <tr key={d.date}>
              <td>{f.calendarDay(d.date)}</td>
              <td>{f.usd(d.costUsd)}</td>
              <td>{t('usage.turnCount', { count: d.turns })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/**
 * How much room the bots' folders take on the server, largest first, with each bot's largest
 * conversations. Read only: a conversation's folder holds the bot's work beside what was
 * attached, so room is freed by deleting the conversation, which a row opens.
 */
function Storage() {
  const t = useT();
  const { fileSize } = useFormat();
  const { data: bots } = useBots();
  const { data, isPending, isError, refetch, isFetching } = useStorage();
  const byId = new Map((bots ?? []).map((b) => [b.id, b]));
  const open = (botId: string, threadId: string) => {
    const ui = useUi.getState();
    ui.openSettings(null);
    ui.openChat(botId);
    ui.selectThread(threadId);
  };
  /** A size the walk did not finish counting is at least what it says. */
  const size = (bytes: number, partial = false) =>
    partial ? t('storage.atLeast', { size: fileSize(bytes) }) : fileSize(bytes);
  const largest = data ? Math.max(1, ...[...data.bots, ...data.groups, data.staged].map((r) => r.bytes)) : 1;
  const bar = (bytes: number) => (
    <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-secondary">
      <div className="h-full rounded-full bg-primary" style={{ width: `${(bytes / largest) * 100}%` }} />
    </div>
  );

  return (
    <Card title={t('storage.title')}>
      <div className="flex items-start gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium tabular-nums">{data ? size(data.total, data.capped) : '–'}</div>
          <div className="text-xs text-muted-foreground">
            {data?.capped ? t('storage.capped') : t('storage.hint')}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          onClick={() => void refetch()}
          disabled={isFetching}
          aria-label={t('storage.refresh')}
          title={t('storage.refresh')}
        >
          <RotateCw className={cn('size-4', isFetching && 'animate-spin')} />
        </Button>
      </div>
      {isPending ? (
        <div className="flex justify-center py-6 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : isError || !data ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">{t('storage.failed')}</p>
      ) : (
        <>
          {data.bots
            .filter((b) => b.bytes > 0 || b.partial)
            .map((b) => (
              <StorageBotRow
                key={b.botId}
                b={b}
                bot={byId.get(b.botId)}
                size={size}
                bar={bar}
                onOpen={open}
              />
            ))}
          {data.groups
            .filter((g) => g.bytes > 0 || g.partial)
            .map((g) => (
              <div key={g.groupId} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">
                    {t('storage.group', { name: g.name ?? t('storage.removedGroup') })}
                  </div>
                  {bar(g.bytes)}
                </div>
                <div className="w-24 shrink-0 text-end text-sm tabular-nums">{size(g.bytes, g.partial)}</div>
              </div>
            ))}
          {(data.staged.bytes > 0 || data.staged.partial) && (
            <div className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm">{t('storage.staged')}</div>
                <div className="text-xs text-muted-foreground">{t('storage.stagedHint')}</div>
                {bar(data.staged.bytes)}
              </div>
              <div className="w-24 shrink-0 text-end text-sm tabular-nums">
                {size(data.staged.bytes, data.staged.partial)}
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function StorageBotRow({
  b,
  bot,
  size,
  bar,
  onOpen,
}: {
  b: StorageReport['bots'][number];
  bot?: Bot;
  size(bytes: number, partial?: boolean): string;
  bar(bytes: number): React.ReactNode;
  onOpen(botId: string, threadId: string): void;
}) {
  const t = useT();
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        {bot ? (
          <BotAvatar avatar={bot.avatar} material={bot.material} color={bot.color} seed={bot.id} size={28} />
        ) : (
          <span className="size-7 shrink-0 rounded-full bg-secondary" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 text-sm">
            <span className="truncate">{b.name ?? t('storage.removedBot')}</span>
            {b.archived && (
              <span className="shrink-0 text-xs text-muted-foreground">{t('usage.archived')}</span>
            )}
          </div>
          {bar(b.bytes)}
        </div>
        <div className="w-24 shrink-0 text-end text-sm font-medium tabular-nums">
          {size(b.bytes, b.partial)}
        </div>
      </div>
      <div className="mt-2 space-y-0.5 ps-10">
        {b.own.bytes > 0 && (
          <div className="flex items-center gap-3 py-1 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">{t('storage.ownFolder')}</span>
            <span className="shrink-0 tabular-nums">{size(b.own.bytes, b.own.partial)}</span>
          </div>
        )}
        {b.threads.map((th) =>
          b.name && th.title !== null ? (
            <button
              type="button"
              key={th.threadId}
              onClick={() => onOpen(b.botId, th.threadId)}
              title={t('storage.openThread')}
              className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-1 text-start text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            >
              <span className="min-w-0 flex-1 truncate">{th.title || t('chat.newThread')}</span>
              <span className="shrink-0 tabular-nums">{size(th.bytes, th.partial)}</span>
            </button>
          ) : (
            <div key={th.threadId} className="flex items-center gap-3 py-1 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">{t('storage.removedThread')}</span>
              <span className="shrink-0 tabular-nums">{size(th.bytes, th.partial)}</span>
            </div>
          ),
        )}
        {b.threadCount > b.threads.length && b.threads.length > 0 && (
          <div className="py-1 text-xs text-muted-foreground">
            {t('storage.moreThreads', { count: b.threadCount - b.threads.length })}
          </div>
        )}
      </div>
    </div>
  );
}
