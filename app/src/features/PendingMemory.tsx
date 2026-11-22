import type { Bot } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { changeHint, changeLabel } from '@/lib/memoryChange';
import { Card, Row } from './SettingsPage';

/**
 * Memory changes bots asked for while nobody watched (a routine, another bot's request). They
 * change nothing until accepted here, so what a webhook call or a page said cannot slip into
 * memory unseen.
 */
export function PendingMemory({ bots }: { bots: readonly Pick<Bot, 'id' | 'name'>[] }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: changes = [] } = useQuery({ queryKey: ['memory', 'changes'], queryFn: api.memoryChanges });
  const done = () => void qc.invalidateQueries({ queryKey: ['memory'] });
  const accept = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await api.acceptMemoryChange(id);
    },
    onSuccess: done,
    onError: (e) => toast.error((e as Error).message),
  });
  const reject = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await api.rejectMemoryChange(id);
    },
    onSuccess: done,
    onError: (e) => toast.error((e as Error).message),
  });
  if (!changes.length) return null;
  const all = changes.map((c) => c.id);
  const busy = accept.isPending || reject.isPending;
  return (
    <Card title={t('memory.pending')}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <p className="min-w-40 flex-1 text-xs text-muted-foreground">{t('memory.pendingHint')}</p>
        {changes.length > 1 && (
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full"
              disabled={busy}
              onClick={() => accept.mutate(all)}
            >
              {t('memory.acceptAll')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full"
              disabled={busy}
              onClick={() => reject.mutate(all)}
            >
              {t('memory.rejectAll')}
            </Button>
          </div>
        )}
      </div>
      {changes.map((c) => (
        <Row key={c.id} label={changeLabel(c)} hint={changeHint(c, bots, t)}>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 rounded-full"
            disabled={busy}
            onClick={() => accept.mutate([c.id])}
            aria-label={t('memory.accept')}
          >
            <Check className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 rounded-full"
            disabled={busy}
            onClick={() => reject.mutate([c.id])}
            aria-label={t('memory.reject')}
          >
            <X className="size-4" />
          </Button>
        </Row>
      ))}
    </Card>
  );
}
