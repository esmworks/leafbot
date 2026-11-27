import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ShieldAlert, X } from 'lucide-react';
import type { SecondYes } from '@leafbot/shared';
import { toast } from 'sonner';
import { BotAvatar } from '@/components/BotAvatar';
import { ActionCard, ActionCardDetail, ActionCardMeta } from '@/components/ui/action-card';
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
  const items = useSecondYes(enabled);
  const { data: bots = [] } = useBots();
  const answer = useAnswerSecond();
  const said = useSaid();
  if (!items.length) return null;
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
              <div className="text-xs text-muted-foreground">{said(s)}</div>
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

/**
 * The steps waiting for this person's second yes. The cards at the bottom right ask for them all
 * the time; an older server without the list asks nothing.
 */
export function useSecondYes(enabled = true) {
  return (
    useQuery({
      queryKey: ['second-yes'],
      queryFn: api.secondYes,
      enabled,
      refetchOnMount: 'always',
      retry: false,
    }).data ?? []
  );
}

function useAnswerSecond() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (d: { id: string; decision: 'allow' | 'deny' }) => api.answerSecond(d.id, d.decision),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['second-yes'] }),
    onError: (e) => {
      toast.error((e as Error).message);
      void qc.invalidateQueries({ queryKey: ['second-yes'] });
    },
  });
}

/** Whose request it is and who said yes first, on one line. */
function useSaid() {
  const t = useT();
  const f = useFormat();
  const { data: people = [] } = usePeople();
  const name = (id: string | null) => personNameOf(people, id, t('people.owner'), t('common.someone'));
  return (s: SecondYes) =>
    [
      s.askedBy ? t('second.askedBy', { name: name(s.askedBy) }) : '',
      t('second.firstYes', { name: name(s.firstApprover), when: f.dayLabel(s.firstAt) }),
    ]
      .filter(Boolean)
      .join(' · ');
}

/** A step waiting for this person's second yes, as a card at the bottom right of the app. */
export function SecondYesCard({ item, onClose }: { item: SecondYes; onClose: () => void }) {
  const t = useT();
  const { data: bots = [] } = useBots();
  const answer = useAnswerSecond();
  const said = useSaid();
  const bot = bots.find((b) => b.id === item.botId);
  const title = t('second.cardTitle', { bot: bot?.name ?? t('common.bot') });
  return (
    <ActionCard
      role="dialog"
      aria-label={title}
      className="pointer-events-auto"
      title={
        <span className="flex min-w-0 items-start gap-2">
          {bot && (
            <BotAvatar
              avatar={bot.avatar}
              material={bot.material}
              color={bot.color}
              seed={bot.id}
              size={20}
            />
          )}
          <span className="min-w-0">{title}</span>
        </span>
      }
      description={item.summary}
      closeLabel={t('actionCard.close')}
      onClose={onClose}
      actionLabel={t('second.allow')}
      onAction={() => answer.mutate({ id: item.id, decision: 'allow' })}
      secondaryLabel={t('approval.deny')}
      onSecondary={() => answer.mutate({ id: item.id, decision: 'deny' })}
      busy={answer.isPending}
    >
      <ActionCardMeta>{said(item)}</ActionCardMeta>
      {item.detail && (
        <ActionCardDetail text={item.detail} showLabel={t('approval.show')} hideLabel={t('approval.hide')} />
      )}
    </ActionCard>
  );
}
