import { describeSchedule, SHORT_DAY_NAMES, type RoutineSuggestion, type Schedule } from '@leafbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { BotAvatar } from '@/components/BotAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useLocale, useT } from '@/i18n';
import { api } from '@/lib/api';
import { useBots, useRoutineSuggestions } from '@/lib/queries';

type Kind = 'daily' | 'weekdays' | 'weekly';

/** The rhythm a person can pick for a suggestion that had none: every day, working days, or one weekday. */
function pickable(s: Schedule | null): { kind: Kind | ''; day: number; time: string } {
  if (s?.type === 'daily' || s?.type === 'weekdays') return { kind: s.type, day: 1, time: s.time };
  if (s?.type === 'weekly') return { kind: 'weekly', day: s.days[0] ?? 1, time: s.time };
  return { kind: '', day: 1, time: '09:00' };
}

/** One suggestion: what the person kept asking for, the instructions to edit, and the two answers. */
function SuggestionCard({ s }: { s: RoutineSuggestion }) {
  const t = useT();
  const locale = useLocale((x) => x.locale);
  const qc = useQueryClient();
  const { data: bots = [] } = useBots();
  const bot = bots.find((b) => b.id === s.botId);
  const [instructions, setInstructions] = useState(s.instructions);
  const [when, setWhen] = useState(() => pickable(s.schedule));
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['routine-suggestions'] });
    void qc.invalidateQueries({ queryKey: ['routines'] });
  };
  const fail = (e: unknown) => {
    toast.error((e as Error).message);
    refresh();
  };
  const schedule: Schedule | null =
    when.kind === 'weekly'
      ? { type: 'weekly', days: [when.day], time: when.time }
      : when.kind
        ? { type: when.kind, time: when.time }
        : null;
  const create = useMutation({
    mutationFn: () =>
      api.acceptRoutineSuggestion(s.id, {
        instructions: instructions.trim() || s.instructions,
        ...(schedule && { schedule }),
      }),
    onSuccess: () => {
      toast.success(t('routineSuggest.created', { name: s.name }));
      refresh();
    },
    onError: fail,
  });
  const dismiss = useMutation({
    mutationFn: () => api.dismissRoutineSuggestion(s.id),
    onSuccess: refresh,
    onError: fail,
  });
  const botName = bot?.name ?? t('common.bot');
  return (
    <div className="space-y-2 px-3 py-2.5">
      <div className="flex items-start gap-2">
        {bot && (
          <BotAvatar avatar={bot.avatar} material={bot.material} color={bot.color} seed={bot.id} size={24} />
        )}
        <div className="min-w-0 flex-1">
          <div className="font-medium">{s.name}</div>
          <div className="text-xs text-muted-foreground">
            {t('routineSuggest.line', { bot: botName, count: s.requests, days: s.days.length })}
            {s.schedule && ` ${t('routineSuggest.rhythm', { when: describeSchedule(s.schedule, locale) })}`}
          </div>
        </div>
      </div>
      {s.canCreate ? (
        <>
          <Textarea
            value={instructions}
            aria-label={t('routineSuggest.instructions')}
            onChange={(e) => setInstructions(e.target.value)}
            className="min-h-20 rounded-xl text-sm"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Select value={when.kind} onValueChange={(kind) => setWhen({ ...when, kind: kind as Kind })}>
              <SelectTrigger className="h-8 w-40 rounded-full" aria-label={t('routineSuggest.when')}>
                <SelectValue placeholder={t('routineSuggest.pick')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">{t('routineSuggest.daily')}</SelectItem>
                <SelectItem value="weekdays">{t('routineSuggest.weekdays')}</SelectItem>
                <SelectItem value="weekly">{t('routineSuggest.weekly')}</SelectItem>
              </SelectContent>
            </Select>
            {when.kind === 'weekly' && (
              <Select value={String(when.day)} onValueChange={(d) => setWhen({ ...when, day: Number(d) })}>
                <SelectTrigger className="h-8 w-24 rounded-full" aria-label={t('routineSuggest.day')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SHORT_DAY_NAMES[locale].map((name, i) => (
                    <SelectItem key={i} value={String(i)}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {when.kind && (
              <Input
                type="time"
                className="h-8 w-28 rounded-full"
                aria-label={t('routineSuggest.time')}
                value={when.time}
                onChange={(e) => e.target.value && setWhen({ ...when, time: e.target.value })}
              />
            )}
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{t('routineSuggest.askOwner', { bot: botName })}</p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="rounded-full"
          disabled={dismiss.isPending || create.isPending}
          onClick={() => dismiss.mutate()}
        >
          {t('routineSuggest.dismiss')}
        </Button>
        {s.canCreate && (
          <Button
            size="sm"
            className="rounded-full"
            disabled={!schedule || !instructions.trim() || create.isPending || dismiss.isPending}
            onClick={() => create.mutate()}
          >
            {t('routineSuggest.create')}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Things the person keeps asking a bot for by hand, offered as routines. The instructions can be
 * changed before the routine is made. Nothing is shown when there are none.
 */
export function RoutineSuggestionsSection({ enabled }: { enabled: boolean }) {
  const t = useT();
  const { data: suggestions = [] } = useRoutineSuggestions(enabled);
  if (!suggestions.length) return null;
  return (
    <section>
      <h3 className="mb-1.5 px-1 text-xs font-medium text-muted-foreground">{t('routineSuggest.title')}</h3>
      <div className="divide-y rounded-2xl border bg-card/50">
        {suggestions.map((s) => (
          <SuggestionCard key={s.id} s={s} />
        ))}
      </div>
    </section>
  );
}
