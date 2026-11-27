import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Link2, Printer } from 'lucide-react';
import { toast } from 'sonner';
import { LiveFrame } from '@/components/LiveFrame';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { useInfo } from '@/lib/queries';
import { publicOrigin, useTransport } from '@/lib/transport';
import { isLoopback } from './RoutinePage';

/**
 * A page a bot made (show_page), running in the conversation. It is read fresh from the bot's
 * folder, so the card shows the file as it is now. Its scripts run isolated: it may load the usual
 * libraries and show web images (map tiles), and fetch nothing.
 */
export function BotPage({
  botId,
  path,
  name,
  title,
  height,
}: {
  botId: string;
  path: string;
  name: string;
  title: string;
  /** The height the bot asked for, for a page laid out to the window (a map, a canvas). */
  height?: number;
}) {
  const t = useT();
  const url = api.fileUrl(botId, path);
  // On the web app the page's scripts would run in the website's origin, so it is not shown there.
  const tunnel = useTransport((s) => s.tunnel);
  const link = 'flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground';
  return (
    <div className="w-full max-w-(--bubble-width) space-y-2">
      <div className="flex items-center gap-3 px-1 text-sm">
        <span className="min-w-0 flex-1 truncate font-medium">{title || name}</span>
        <SharePage botId={botId} path={path} name={title || name} />
        {!tunnel && (
          <a
            href={api.pagePrintUrl(botId, path)}
            target="_blank"
            rel="noopener noreferrer"
            className={link}
            title={t('page.printHint')}
          >
            <Printer className="size-3.5" /> {t('page.pdf')}
          </a>
        )}
        <a href={url} target="_blank" rel="noopener noreferrer" className={link}>
          <Download className="size-3.5" /> {name}
        </a>
      </div>
      {tunnel ? (
        <p className="rounded-2xl border bg-card px-4 py-3 text-sm text-muted-foreground">
          {t('bots.pageElsewhere')}
        </p>
      ) : (
        <LiveFrame
          title={title || name}
          src={api.pageUrl(botId, path, height)}
          initialHeight={height ?? 360}
        />
      )}
    </div>
  );
}

/** Turns a link to the page on or off: anyone with it may open the page, without signing in. */
function SharePage({ botId, path, name }: { botId: string; path: string; name: string }) {
  const t = useT();
  const qc = useQueryClient();
  const key = ['page-share', botId, path];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.pageShare(botId, path) });
  const { data: info } = useInfo();
  const share = data?.share ?? null;
  const base = publicOrigin(info?.publicUrl);
  const url = share && base ? `${base}/p/${share.token}` : null;
  const set = useMutation({
    mutationFn: async (on: boolean) => {
      if (on) return { share: await api.sharePage(botId, path, name) };
      if (share) await api.unsharePage(share.token);
      return { share: null };
    },
    onSuccess: (next) => {
      qc.setQueryData(key, next);
      void qc.invalidateQueries({ queryKey: ['page-shares'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <Link2 className="size-3.5" /> {t(share ? 'page.shared' : 'page.share')}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3 text-sm">
        <label className="flex items-center justify-between gap-3">
          <span className="font-medium">{t('page.shareAnyone')}</span>
          <Switch checked={!!share} disabled={set.isPending} onCheckedChange={(on) => set.mutate(on)} />
        </label>
        <p className="text-xs text-muted-foreground">{t(share ? 'page.shareOnHint' : 'page.shareOffHint')}</p>
        {url && (
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-secondary px-2 py-1 font-mono text-[11px]">
              {url}
            </code>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="rounded-full"
              onClick={async () => {
                if (await copyText(url)) toast.success(t('page.linkCopied'));
                else toast.error(t('message.copyFailed'));
              }}
            >
              {t('message.copy')}
            </Button>
          </div>
        )}
        {url && base && isLoopback(new URL(base).hostname) && (
          <p className="text-xs text-muted-foreground">{t('page.shareLocalOnly')}</p>
        )}
      </PopoverContent>
    </Popover>
  );
}
