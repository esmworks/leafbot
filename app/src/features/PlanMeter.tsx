import {
  currentPlanWindows,
  planHeadline,
  planUsedPercent,
  planTone,
  type PlanWindow,
} from '@leafbot/shared';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useT } from '@/i18n';
import { useFormat } from '@/lib/format';
import { PLAN_TONE_BAR, PLAN_TONE_TEXT, planLabel } from '@/lib/planUsage';
import { usePlanUsage } from '@/lib/queries';
import { useMinuteClock } from '@/lib/snooze';
import { cn } from '@/lib/utils';

/**
 * The share used as an arc on a faint track, starting at twelve o'clock, filling up as the plan is
 * used, as Claude's own apps draw it. The arc is measured in hundredths of the circle, so the
 * percentage is its length as it is.
 */
function UsedRing({ used }: { used: number }) {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className="size-[18px] shrink-0 -rotate-90">
      <circle
        cx="10"
        cy="10"
        r="8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeOpacity="0.25"
      />
      {used > 0 && (
        <circle
          cx="10"
          cy="10"
          r="8"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${used} 100`}
        />
      )}
    </svg>
  );
}

/**
 * How much of the Claude plan is used, beside a Claude bot's chat: a ring and the share used of
 * the fuller of the five-hour and weekly windows, and every window with its reset on a click.
 * Nothing shows until a Claude turn has heard the plan's usage (an API key never does).
 */
export function PlanMeter() {
  const t = useT();
  const f = useFormat();
  const now = useMinuteClock();
  const { data: plan } = usePlanUsage();
  if (!plan) return null;
  const head = planHeadline(plan.windows, now);
  if (!head) return null;
  const used = planUsedPercent(head);
  const tone = planTone(head, now);
  const label = t('planMeter.label', { percent: used, window: planLabel(head, t) });
  const windows = currentPlanWindows(plan.windows, now).filter((w) => w.used !== null);
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              className={cn(
                'wallpaper-chip h-9 gap-1.5 rounded-full px-2 tabular-nums',
                PLAN_TONE_TEXT[tone],
              )}
              aria-label={label}
              data-plan-meter={tone}
            >
              <UsedRing used={used} />
              <span className="text-sm font-medium @max-2xl/chathead:hidden">
                {t('planMeter.used', { percent: used })}
              </span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] rounded-2xl">
        <div className="space-y-3">
          <div className="text-sm font-semibold">{t('usage.plan')}</div>
          {windows.map((w) => (
            <PlanRow key={w.kind} w={w} now={now} />
          ))}
          <p className="text-xs text-muted-foreground">
            {t('usage.plan.seen', { time: f.dayLabel(plan.at) })}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function PlanRow({ w, now }: { w: PlanWindow; now: number }) {
  const t = useT();
  const f = useFormat();
  const used = planUsedPercent(w);
  const tone = planTone(w, now);
  return (
    <div className="space-y-1.5" data-plan-row={w.kind}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
        <span className="text-muted-foreground">{planLabel(w, t)}</span>
        <span className="tabular-nums">
          <span className={cn('font-medium', tone !== 'fine' && PLAN_TONE_TEXT[tone])}>
            {used === 100 ? t('planMeter.none') : t('planMeter.used', { percent: used })}
          </span>
          {w.resetsAt && (
            <span className="text-muted-foreground">
              {' '}
              · {t('usage.plan.resets', { time: f.dayLabel(w.resetsAt) })}
            </span>
          )}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-secondary" aria-hidden>
        <div
          className={cn('h-full rounded-full', PLAN_TONE_BAR[tone])}
          style={{ width: `${used}%` }}
          data-plan-bar
        />
      </div>
    </div>
  );
}
