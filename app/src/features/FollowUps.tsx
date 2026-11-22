import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { BotAvatar } from '@/components/BotAvatar';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useBots, useFollowUps } from '@/lib/queries';

/** How many follow-ups show before the rest are folded away. */
const SHOWN = 5;

/**
 * What the bots keep track of for the person, soonest first: their own reminders, not routines.
 * A person's promise shows with the promises, so only the rest are listed here. Each can be
 * removed; nothing needs an answer. Nothing is shown when there are none.
 */
export function FollowUpsSection({ enabled }: { enabled: boolean }) {
  const t = useT();
  const f = useFormat();
  const qc = useQueryClient();
  const { data = [] } = useFollowUps(enabled);
  const { data: bots = [] } = useBots();
  const [all, setAll] = useState(false);
  const drop = useMutation({
    mutationFn: api.dropFollowUp,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['follow-ups'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  const list = data.filter((x) => x.kind !== 'promise');
  if (!list.length) return null;
  const shown = all ? list : list.slice(0, SHOWN);
  return (
    <section>
      <h3 className="mb-1.5 px-1 text-xs font-medium text-muted-foreground">{t('followUp.title')}</h3>
      <div className="divide-y rounded-2xl border bg-card/50">
        {shown.map((x) => {
          const bot = bots.find((b) => b.id === x.botId);
          return (
            <div key={x.id} className="flex items-start gap-2 px-3 py-2.5">
              {bot && <BotAvatar avatar={bot.avatar} color={bot.color} seed={bot.id} size={24} />}
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="text-sm">{x.text}</div>
                <div className="text-xs text-muted-foreground">
                  {t('followUp.when', { bot: bot?.name ?? t('common.bot'), when: f.dayLabel(x.dueAt) })}
                  {x.eventAt && ` · ${t('followUp.event', { when: f.dayLabel(x.eventAt) })}`}
                  {x.context && ` · ${x.context}`}
                </div>
              </div>
              <button
                type="button"
                disabled={drop.isPending}
                onClick={() => drop.mutate(x.id)}
                aria-label={t('followUp.drop')}
                title={t('followUp.drop')}
                className="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
        {list.length > SHOWN && (
          <button
            type="button"
            onClick={() => setAll(!all)}
            className="w-full px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:underline"
          >
            {all ? t('followUp.fewer') : t('followUp.all', { count: list.length })}
          </button>
        )}
      </div>
    </section>
  );
}
