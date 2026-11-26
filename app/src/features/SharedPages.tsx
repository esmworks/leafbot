import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useBots, useInfo } from '@/lib/queries';
import { publicOrigin } from '@/lib/transport';

/** Every page shared by link, so a link sent long ago can be found and turned off. */
export function SharedPages() {
  const t = useT();
  const qc = useQueryClient();
  const { dayLabel } = useFormat();
  const { data: shares = [] } = useQuery({ queryKey: ['page-shares'], queryFn: api.pageShares });
  const { data: bots = [] } = useBots();
  const { data: info } = useInfo();
  const base = publicOrigin(info?.publicUrl);
  const off = useMutation({
    mutationFn: (token: string) => api.unsharePage(token),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['page-shares'] });
      void qc.invalidateQueries({ queryKey: ['page-share'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (!shares.length) return null;
  return (
    <section className="space-y-2">
      <h3 className="px-1 text-sm font-medium">{t('page.sharedPages')}</h3>
      <div className="divide-y rounded-2xl border bg-card/50">
        {shares.map((s) => (
          <div key={s.token} className="flex items-center gap-3 px-4 py-3 text-sm">
            <Link2 className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <a
                href={base ? `${base}/p/${s.token}` : undefined}
                target="_blank"
                rel="noopener noreferrer"
                className="block truncate font-medium hover:underline"
              >
                {s.name}
              </a>
              <div className="truncate text-xs text-muted-foreground">
                {bots.find((b) => b.id === s.botId)?.name ?? ''} · {dayLabel(s.createdAt)}
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('page.shareTurnOff')}
              title={t('page.shareTurnOff')}
              onClick={() => off.mutate(s.token)}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>
      <p className="px-1 text-xs text-muted-foreground">{t('page.sharedPagesHint')}</p>
    </section>
  );
}
