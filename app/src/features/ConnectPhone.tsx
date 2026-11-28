import { useMutation, useQuery } from '@tanstack/react-query';
import { Loader2, Smartphone } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { account } from '@/bots/account';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { viaTunnel } from '@/lib/transport';
import { Card, Row } from './SettingsPage';

type Code = { code: string; expiresAt: number; url: string; image: string };

/**
 * Signs a phone in to the person's Leaf Bot account: a one-time code shown as a QR code, which the
 * phone app scans (or the code typed there). It works once, for two minutes. Through the account,
 * the account makes it for whoever is signed in; on the server's own address, the server makes it
 * for its owner, as only they reach that page without the account.
 */
export function ConnectPhone({ owner }: { owner: boolean }) {
  const t = useT();
  const tunnel = viaTunnel();
  const [made, setMade] = useState<Code | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const make = useMutation({
    mutationFn: async () => {
      const c = tunnel ? await account.connectCode() : await api.phoneCode();
      const image = await QRCode.toDataURL(c.url, { margin: 1, width: 240, errorCorrectionLevel: 'M' });
      return { ...c, image };
    },
    onSuccess: (c) => {
      setMade(c);
      setNow(Date.now());
    },
    onError: (e) => toast.error(e instanceof Error && e.message ? e.message : t('phone.failed')),
  });
  // On the server's own page the code comes from the account the server is linked to, so until it
  // is linked (the card below does that) there is none to make.
  const { data: host } = useQuery({
    queryKey: ['account-host'],
    queryFn: api.accountHost,
    enabled: owner && !tunnel,
    staleTime: 30_000,
  });
  const left = made ? Math.max(0, Math.round((made.expiresAt - now) / 1000)) : 0;
  useEffect(() => {
    if (!made || left <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(timer);
  }, [made, left]);
  if (!tunnel && (!owner || !host?.linked)) return null;
  return (
    <Card title={t('phone.title')}>
      <Row label={t('phone.label')} hint={t('phone.signInHint')}>
        <Button
          variant="secondary"
          size="sm"
          className="rounded-full"
          onClick={() => make.mutate()}
          disabled={make.isPending}
        >
          {make.isPending ? <Loader2 className="animate-spin" /> : <Smartphone />}
          {made && left > 0 ? t('phone.again') : t('phone.make')}
        </Button>
      </Row>
      {made && left > 0 && (
        <div className="flex flex-wrap items-center gap-4 px-4 pb-4">
          <img src={made.image} alt={t('phone.qrAlt')} className="size-40 rounded-xl bg-white p-2" />
          <div className="space-y-1">
            <p className="text-sm">{t('phone.orType')}</p>
            <span className="block text-xl font-semibold tracking-widest">{made.code}</span>
            <p className="text-xs text-muted-foreground">
              {t('phone.left', {
                minutes: String(Math.floor(left / 60)),
                seconds: String(left % 60).padStart(2, '0'),
              })}
            </p>
          </div>
        </div>
      )}
    </Card>
  );
}
