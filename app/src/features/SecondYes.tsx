import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ShieldAlert, X } from 'lucide-react';
import { toast } from 'sonner';
import { BotAvatar } from '@/components/BotAvatar';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useBots, usePeople } from '@/lib/queries';
import { Detail } from './MessageItem';
import { personNameOf } from './PeopleTab';

/**
 * Steps that wait for this person's second yes: what the step is, whose request it is and who
 * said yes first, and nothing of the conversation it comes from, which is not theirs to read.
 * Nothing is shown when no step waits.
 */
export function SecondYesSection({ enabled = true }: { enabled?: boolean }) {
  const t = useT();
  const f = useFormat();
  const qc = useQueryClient();
  const { data: items = [] } = useQuery({
    queryKey: ['second-yes'],
    queryFn: api.secondYes,
    enabled,
    refetchOnMount: 'always',
  });
  const { data: bots = [] } = useBots();
  const { data: people = [] } = usePeople();
  const answer = useMutation({
    mutationFn: (d: { id: string; decision: 'allow' | 'deny' }) => api.answerSecond(d.id, d.decision),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['second-yes'] }),
    onError: (e) => {
      toast.error((e as Error).message);
      void qc.invalidateQueries({ queryKey: ['second-yes'] });
    },
  });
  if (!items.length) return null;
  const name = (id: string | null) => personNameOf(people, id, t('people.owner'), t('common.someone'));
  return (
    <section>
      <h3 className="mb-1.5 flex items-center gap-1.5 px-1 text-xs font-medium text-amber-600 dark:text-amber-400">
        <ShieldAlert className="size-3.5" />
        {t('second.title')}
      </h3>
      <div className="divide-y rounded-2xl border border-amber-500/40 bg-amber-500/5">
        {items.map((s) => {
          const bot = bots.find((b) => b.id === s.botId);
          return (
            <div key={s.id} className="space-y-1.5 px-3 py-2.5">
              <div className="flex items-center gap-2">
                {bot && (
                  <BotAvatar
                    avatar={bot.avatar}
                    material={bot.material}
                    color={bot.color}
                    seed={bot.id}
                    size={24}
                  />
                )}
                <span className="min-w-0 flex-1 truncate font-medium">{bot?.name ?? t('common.bot')}</span>
              </div>
              <div>{s.summary}</div>
              {s.detail && <Detail text={s.detail} />}
              <div className="text-xs text-muted-foreground">
                {[
                  s.askedBy ? t('second.askedBy', { name: name(s.askedBy) }) : '',
                  t('second.firstYes', { name: name(s.firstApprover), when: f.dayLabel(s.firstAt) }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
              <div className="flex gap-2 pt-0.5">
                <Button
                  size="sm"
                  className="rounded-full"
                  disabled={answer.isPending}
                  onClick={() => answer.mutate({ id: s.id, decision: 'allow' })}
                >
                  <Check /> {t('second.allow')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="rounded-full"
                  disabled={answer.isPending}
                  onClick={() => answer.mutate({ id: s.id, decision: 'deny' })}
                >
                  <X /> {t('approval.deny')}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
