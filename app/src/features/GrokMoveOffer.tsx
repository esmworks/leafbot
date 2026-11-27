import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useSession, useSettings } from '@/lib/queries';
import { useUi } from '@/lib/store';

/**
 * Once per person, after the first-run questions: the way to bring their bots over from Grok Bot.
 * Only those who may import see it. On the owner's own computer it waits for the Grok Bot app to
 * be there, so someone who never used it is not asked. Any answer closes it for good; the steps
 * stay under Settings → Import.
 */
export function GrokMoveOffer() {
  const t = useT();
  const qc = useQueryClient();
  const settings = useSettings();
  const role = useSession().data?.user?.role;
  const openSettings = useUi((s) => s.openSettings);
  const [closed, setClosed] = useState(false);
  // An older server sends no flag; the offer is then never shown.
  const due = settings.data?.grokMoveOffered === false && (role === 'owner' || role === 'admin');
  const look = useQuery({
    queryKey: ['grok-look'],
    queryFn: api.grokLook,
    enabled: due && role === 'owner',
    retry: false,
    staleTime: 60_000,
  });
  const fits =
    role === 'admin' ||
    look.isError ||
    (!!look.data && (!look.data.onComputer || look.data.appBots !== null));
  const seen = useMutation({
    mutationFn: () => api.updateSettings({ grokMoveOffered: true }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });
  const done = (start: boolean) => {
    setClosed(true);
    seen.mutate();
    if (start) openSettings('import');
  };
  return (
    <Dialog open={due && fits && !closed} onOpenChange={(open) => !open && done(false)}>
      <DialogContent className="rounded-2xl sm:max-w-sm">
        <DialogHeader className="items-center text-center sm:text-center">
          <ArrowRightLeft className="mb-2 size-8 text-muted-foreground" aria-hidden />
          <DialogTitle>{t('grokMove.offer.title')}</DialogTitle>
          <DialogDescription>{t('grokMove.offer.body')}</DialogDescription>
        </DialogHeader>
        <div className="mt-2 flex flex-col gap-2">
          <Button className="rounded-xl" autoFocus onClick={() => done(true)}>
            {t('grokMove.offer.start')}
          </Button>
          <Button variant="ghost" className="rounded-xl" onClick={() => done(false)}>
            {t('grokMove.offer.notNow')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
