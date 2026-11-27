import type { GrokMoveLink } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Link2, Loader2, PackageOpen, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { useFormat } from '@/lib/format';
import { Card, Row } from './SettingsPage';

const KEY = ['grok-link'];

/**
 * Grok Bot sending bots straight here: the person pastes a one-hour link into Grok Bot as a custom
 * connector and asks a bot there to move. What arrives waits here, in the server's memory, until
 * the person reads it into the import below; nothing is saved before they confirm there. Hidden
 * where the person may not open a link; where none can be made, says what it needs.
 */
export function GrokConnectCard({
  disabled,
  hosted,
  onArrived,
}: {
  disabled: boolean;
  /** The server is not on the person's computer, so only a public address can make the link. */
  hosted: boolean;
  /**
   * The arrived documents as one text, to preview as a pasted reply would be, and the last one's
   * number, to tell the server once they are imported.
   */
  onArrived: (text: string, upTo: number) => void;
}) {
  const t = useT();
  const fmt = useFormat();
  const qc = useQueryClient();
  const state = useQuery({
    queryKey: KEY,
    queryFn: () => api.grokLink(),
    retry: false,
    // While a link is open, what arrives shows within a few seconds.
    refetchInterval: (q) => (q.state.data?.url ? 3000 : false),
  });
  const set = (next: GrokMoveLink) => qc.setQueryData(KEY, next);
  const open = useMutation({
    mutationFn: api.openGrokLink,
    onSuccess: set,
    onError: (e) => toast.error((e as Error).message),
  });
  const end = useMutation({ mutationFn: api.endGrokLink, onSuccess: set });
  // Only read here; the import tells the server once the bots are in, so a preview left
  // unconfirmed is offered again.
  const take = useMutation({
    mutationFn: api.grokLinkTexts,
    onSuccess: ({ text }, upTo) => text && onArrived(text, upTo),
    onError: (e) => toast.error((e as Error).message),
  });
  const link = state.data;
  if (!link) return null;
  const fresh = link.arrived;
  const copy = async (text: string) => {
    if (await copyText(text)) toast.success(t('grokMove.copied'));
    else toast.error(t('grokMove.copyFailed'));
  };

  return (
    <Card title={t('grokMove.connect.title')}>
      <p className="px-4 pt-3 text-xs text-muted-foreground">{t('grokMove.connect.hint')}</p>
      {!link.available ? (
        <Row
          label={t('grokMove.connect.unavailable')}
          hint={t(hosted ? 'grokMove.connect.unavailableHostedHint' : 'grokMove.connect.unavailableHint')}
        />
      ) : !link.url ? (
        <Row
          label={t(link.stopped ? 'grokMove.connect.stopped' : 'grokMove.connect.start')}
          hint={t('grokMove.connect.private')}
        >
          <Button
            variant="outline"
            size="sm"
            className="rounded-full"
            disabled={open.isPending}
            onClick={() => open.mutate()}
          >
            {open.isPending ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />}
            {t('grokMove.connect.get')}
          </Button>
        </Row>
      ) : (
        <>
          <div className="space-y-2 px-4 py-3">
            <div className="text-sm">{t('grokMove.connect.linkLabel')}</div>
            <div className="flex gap-2">
              <Input
                readOnly
                value={link.url}
                aria-label={t('grokMove.connect.linkLabel')}
                className="min-w-0 flex-1 rounded-xl font-mono text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                variant="outline"
                size="sm"
                className="rounded-full"
                onClick={() => void copy(link.url!)}
              >
                <Copy className="size-4" />
                {t('grokMove.connect.copy')}
              </Button>
            </div>
            <div className="text-xs text-muted-foreground">
              {t('grokMove.connect.until', { time: fmt.clock(link.expiresAt!) })}
            </div>
          </div>
          <Row label={t('grokMove.connect.where')} hint={t('grokMove.connect.whereHint')} />
          <Row label={t('grokMove.connect.ask')} hint={t('grokMove.connect.askMessage')}>
            <Button
              variant="outline"
              size="sm"
              className="rounded-full"
              onClick={() => void copy(t('grokMove.connect.askMessage'))}
            >
              <Copy className="size-4" />
              {t('grokMove.connect.copy')}
            </Button>
          </Row>
          {fresh.length > 0 ? (
            <Row label={t('grokMove.connect.arrived', { names: fresh.flatMap((a) => a.names).join(', ') })}>
              <Button
                size="sm"
                className="rounded-full"
                disabled={disabled || take.isPending}
                onClick={() => take.mutate(fresh.at(-1)!.seq)}
              >
                {take.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <PackageOpen className="size-4" />
                )}
                {t('grokMove.connect.use')}
              </Button>
            </Row>
          ) : (
            <Row label={t('grokMove.connect.waiting')}>
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </Row>
          )}
          <Row label={t('grokMove.connect.endHint')}>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-full"
              disabled={end.isPending}
              onClick={() => end.mutate()}
            >
              <Unlink className="size-4" />
              {t('grokMove.connect.end')}
            </Button>
          </Row>
        </>
      )}
    </Card>
  );
}
