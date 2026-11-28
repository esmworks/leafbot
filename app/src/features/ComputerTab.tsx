import type { ComputerPermission } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Monitor, MousePointer2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { desktop } from '@/lib/desktop';
import { useServerHost } from '@/lib/serverSwitch';
import { usePersonComputer } from './PersonComputer';
import { Card, Row } from './SettingsPage';

const PERMISSIONS: { id: ComputerPermission; icon: React.ReactNode }[] = [
  { id: 'screen', icon: <Monitor /> },
  { id: 'accessibility', icon: <MousePointer2 /> },
];

/**
 * The computer the bots may use, in one place: which of macOS's two permissions it has, and a way
 * to each in System Settings. macOS asks its own question only once, so after a no these buttons
 * are the way left; the same buttons manage a permission already given.
 */
export function ComputerTab() {
  const t = useT();
  const qc = useQueryClient();
  const { data, isFetching, refetch } = usePersonComputer();
  const ask = useMutation({
    mutationFn: (pane: ComputerPermission) => api.requestPersonComputer(pane),
    onSuccess: (state) => qc.setQueryData(['person-computer'], state),
    onError: (e) => toast.error((e as Error).message),
  });
  if (!data) return null;

  const again = (
    <Button
      size="sm"
      variant="secondary"
      className="rounded-full"
      disabled={isFetching}
      onClick={() => void refetch()}
    >
      <RefreshCw className={isFetching ? 'animate-spin' : undefined} />
      {t('computerUse.checkAgain')}
    </Button>
  );

  if (!data.available) {
    if (data.remote && desktop?.computer) return <OfferThisComputer again={again} />;
    return (
      <Card>
        <Row
          label={t('computerUse.notConnected')}
          hint={data.remote ? t('bot.personComputerRemote') : t('computerUse.unavailable')}
        >
          {again}
        </Row>
      </Card>
    );
  }

  return (
    <>
      {data.device && (
        <Card>
          <Row label={t('computerUse.device', { device: data.device })} hint={t('computerUse.deviceHint')} />
        </Card>
      )}
      {data.os === 'windows' ? (
        <Card>
          <Row label={t('computerUse.windows')} hint={t('computerUse.windowsHint')} />
        </Card>
      ) : (
        <Card title={t('computerUse.permissions')}>
          {PERMISSIONS.map(({ id, icon }) => {
            const granted = data[id];
            return (
              <div key={id} className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-secondary text-muted-foreground [&_svg]:size-4">
                  {icon}
                </span>
                <div className="min-w-40 flex-1">
                  <div className="text-sm">{t(`computerUse.${id}`)}</div>
                  <div className="text-xs text-muted-foreground">{t(`computerUse.${id}Hint`)}</div>
                </div>
                {/* The state and its button stay together, at the end of the line when they wrap. */}
                <div className="ms-auto flex items-center gap-2">
                  {granted && (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
                      {t('computerUse.granted')}
                    </span>
                  )}
                  <Button
                    size="sm"
                    variant={granted ? 'ghost' : 'default'}
                    className="rounded-full"
                    disabled={ask.isPending}
                    onClick={() => ask.mutate(id)}
                  >
                    {t(granted ? 'computerUse.manage' : 'computerUse.grant')}
                  </Button>
                </div>
              </div>
            );
          })}
        </Card>
      )}
      {data.os !== 'windows' && (
        <div className="flex flex-wrap items-start justify-between gap-3 px-1">
          <p className="min-w-60 flex-1 text-xs text-muted-foreground">{t('computerUse.macosHint')}</p>
          {again}
        </div>
      )}
      <p className="mt-6 px-1 text-xs text-muted-foreground">{t('computerUse.botsHint')}</p>
    </>
  );
}

/** How long the page waits for the server to see a computer the person just turned on. */
const OFFER_WAIT_MS = 15_000;
const OFFER_POLL_MS = 1_500;

/**
 * The desktop app's window showing an account server that sees no computer of the person's: the
 * way to offer this one from here, rather than from a menu item that shows only once a server was
 * chosen in the menu bar. The app asks on this computer before it turns the offer on.
 */
function OfferThisComputer({ again }: { again: React.ReactNode }) {
  const t = useT();
  const bridge = desktop?.computer;
  const current = useServerHost((s) => s.host?.servers.find((x) => x.current)?.id ?? null);
  const { data: here, refetch: refetchHere } = useQuery({
    queryKey: ['desktop-computer'],
    queryFn: () => bridge?.state() ?? Promise.resolve(null),
    refetchOnWindowFocus: true,
  });
  const qc = useQueryClient();
  const offer = useMutation({
    mutationFn: async (serverId: string) => {
      const after = await bridge?.offer(serverId);
      await refetchHere();
      if (!after?.on || after.server !== serverId) return;
      // The offer reaches the server through the tunnel a moment later.
      for (let waited = 0; waited < OFFER_WAIT_MS; waited += OFFER_POLL_MS) {
        await new Promise((r) => setTimeout(r, OFFER_POLL_MS));
        const st = await api.personComputer().catch(() => null);
        if (st?.available) {
          qc.setQueryData(['person-computer'], st);
          return;
        }
      }
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (!here || !current) {
    return (
      <Card>
        <Row label={t('computerUse.notConnected')} hint={t('bot.personComputerRemote')}>
          {again}
        </Row>
      </Card>
    );
  }
  if (!here.helper) {
    return (
      <Card>
        <Row label={t('computerUse.notConnected')} hint={t('computerUse.noHelper')} />
      </Card>
    );
  }
  if (here.on && here.server === current) {
    return (
      <Card>
        <Row label={t('computerUse.connecting')} hint={t('computerUse.connectingHint')}>
          {again}
        </Row>
      </Card>
    );
  }
  const hint =
    here.server && here.server !== current ? t('computerUse.offerMove') : t('computerUse.offerHint');
  return (
    <Card>
      <Row label={t('computerUse.notConnected')} hint={hint}>
        <Button
          size="sm"
          className="rounded-full"
          disabled={offer.isPending}
          onClick={() => offer.mutate(current)}
        >
          {offer.isPending && <RefreshCw className="animate-spin" />}
          {t('computerUse.offer')}
        </Button>
      </Row>
    </Card>
  );
}
