import type { Bot, MemoryFlag } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useUi } from '@/lib/store';
import { Card } from './SettingsPage';

/**
 * What bots should have known during a task but could not find, or noticed was wrong, without
 * knowing the right answer. The person's answer becomes their own note (or the flagged note's new
 * words), so the gap is filled once instead of being met in every task.
 */
export function MemoryFlags({ bots }: { bots: readonly Pick<Bot, 'id' | 'name'>[] }) {
  const t = useT();
  const { data: flags = [] } = useQuery({ queryKey: ['memory', 'flags'], queryFn: api.memoryFlags });
  if (!flags.length) return null;
  return (
    <Card title={t('memory.flags')} hint={t('memory.flagsHint')}>
      {flags.map((f) => (
        <FlagRow key={f.id} f={f} bots={bots} />
      ))}
    </Card>
  );
}

function FlagRow({ f, bots }: { f: MemoryFlag; bots: readonly Pick<Bot, 'id' | 'name'>[] }) {
  const t = useT();
  const qc = useQueryClient();
  const [answering, setAnswering] = useState(false);
  const [text, setText] = useState('');
  const done = () => void qc.invalidateQueries({ queryKey: ['memory'] });
  const answer = useMutation({
    mutationFn: () => api.answerMemoryFlag(f.id, text.trim()),
    onSuccess: () => {
      toast.success(t('memory.flagAnswered'));
      setAnswering(false);
      setText('');
      done();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const dismiss = useMutation({
    mutationFn: () => api.dismissMemoryFlag(f.id),
    onSuccess: done,
    onError: (e) => toast.error((e as Error).message),
  });
  const bot = bots.find((b) => b.id === f.botId)?.name ?? t('common.bot');
  const hint = [
    f.kind === 'missing' ? t('memory.flagMissing') : t('memory.flagWrong'),
    bot,
    ...(f.count > 1 ? [t('memory.flagTimes', { count: f.count })] : []),
    ...(f.outside ? [t('memory.flagOutside')] : []),
  ].join(' · ');
  const busy = answer.isPending || dismiss.isPending;
  const open = () => {
    const ui = useUi.getState();
    ui.openChat(f.botId);
    if (f.threadId) ui.selectThread(f.threadId);
  };
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-40 flex-1">
          <div className="text-sm">{f.about}</div>
          <div className="text-xs text-muted-foreground">{hint}</div>
          {f.seen && (
            <div className="mt-1 text-xs text-muted-foreground">{t('memory.flagSeen', { text: f.seen })}</div>
          )}
          {f.note && (
            <div className="mt-1 text-xs text-muted-foreground">{t('memory.flagNote', { text: f.note })}</div>
          )}
          {f.skill && (
            <div className="mt-1 text-xs text-muted-foreground">
              {t('memory.flagSkill', { name: f.skill })}
            </div>
          )}
          {f.status === 'proposed' && (
            <div className="mt-1 text-xs text-amber-600 dark:text-amber-400">{t('memory.flagProposed')}</div>
          )}
        </div>
        <div className="flex items-center gap-1">
          {f.status === 'open' && !answering && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAnswering(true)}>
              {t('memory.flagAnswer')}
            </Button>
          )}
          {f.threadId && (
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={open}
              aria-label={t('memory.flagOpen')}
              title={t('memory.flagOpen')}
            >
              <MessageSquare className="size-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            disabled={busy}
            onClick={() => dismiss.mutate()}
            aria-label={t('memory.flagDismiss')}
            title={t('memory.flagDismiss')}
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>
      {answering && (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) answer.mutate();
          }}
        >
          <Input
            autoFocus
            value={text}
            maxLength={2000}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('memory.flagAnswerPlaceholder')}
            aria-label={t('memory.flagAnswer')}
          />
          <Button type="submit" size="sm" disabled={busy || !text.trim()}>
            {t('common.save')}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setAnswering(false)}>
            {t('common.cancel')}
          </Button>
        </form>
      )}
    </div>
  );
}
