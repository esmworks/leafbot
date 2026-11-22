import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { useSession } from '@/lib/queries';
import { Card, Row } from './SettingsPage';

/**
 * Reaching this server from the person's other devices over their Tailscale network: it gets an
 * https address only those devices reach, and signing in is still needed there. For the owner,
 * since it changes how the server's computer is reached.
 */
export function TailscaleCard() {
  const t = useT();
  const qc = useQueryClient();
  const owner = useSession().data?.user?.role === 'owner';
  const { data: ts } = useQuery({
    queryKey: ['tailscale'],
    queryFn: api.tailscale,
    enabled: owner,
    staleTime: 30_000,
  });
  const share = useMutation({
    mutationFn: api.setTailscale,
    onSuccess: (state) => qc.setQueryData(['tailscale'], state),
    onError: (e) => toast.error((e as Error).message),
  });
  if (!owner || !ts) return null;
  return (
    <Card title={t('tailscale.title')}>
      {!ts.installed ? (
        <Row label={t('tailscale.share')} hint={t('tailscale.missing')} />
      ) : !ts.running ? (
        <Row label={t('tailscale.share')} hint={t('tailscale.stopped')} />
      ) : (
        <Row label={t('tailscale.share')} hint={t('tailscale.hint', { name: ts.name ?? '' })}>
          <Switch
            checked={ts.sharing}
            disabled={share.isPending}
            onCheckedChange={(on) => share.mutate(on)}
            aria-label={t('tailscale.share')}
          />
        </Row>
      )}
      {ts.url && (
        <Row label={t('tailscale.address')} hint={ts.url}>
          <Button
            variant="secondary"
            size="sm"
            className="rounded-full"
            onClick={() => void copyText(ts.url!).then(() => toast.success(t('tailscale.copied')))}
          >
            <Copy /> {t('tailscale.copy')}
          </Button>
        </Row>
      )}
    </Card>
  );
}
