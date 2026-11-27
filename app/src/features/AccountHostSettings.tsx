import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Unlink } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useSession } from '@/lib/queries';
import { useTransport } from '@/lib/transport';
import { Card, Row } from './SettingsPage';

/**
 * Linking this server to the owner's Leaf Bot account with an install code, so the people of that
 * account can open it from the web app without the server opening a port. For the owner, and only
 * on a page the server serves itself: the server refuses it through the account's own connection.
 */
export function AccountHostCard() {
  const t = useT();
  const qc = useQueryClient();
  const owner = useSession().data?.user?.role === 'owner';
  const tunnel = useTransport((s) => s.tunnel);
  const [code, setCode] = useState('');
  const { data: state } = useQuery({
    queryKey: ['account-host'],
    queryFn: api.accountHost,
    enabled: owner && !tunnel,
    staleTime: 30_000,
  });
  const link = useMutation({
    mutationFn: () => api.linkAccountHost(code.trim()),
    onSuccess: (s) => {
      qc.setQueryData(['account-host'], s);
      setCode('');
      toast.success(t('accountHost.linked'));
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const unlink = useMutation({
    mutationFn: api.unlinkAccountHost,
    onSuccess: (s) => qc.setQueryData(['account-host'], s),
    onError: (e) => toast.error((e as Error).message),
  });
  if (!owner || tunnel || !state) return null;
  if (state.linked) {
    const hint = state.noWebRtc
      ? t('accountHost.noWebRtc')
      : state.running
        ? t('accountHost.running')
        : t('accountHost.notRunning');
    return (
      <Card title={t('accountHost.title')}>
        <Row label={t('accountHost.linkedLabel')} hint={hint}>
          <Button
            variant="secondary"
            size="sm"
            className="rounded-full"
            disabled={unlink.isPending}
            onClick={() => {
              if (confirm(t('accountHost.unlinkConfirm'))) unlink.mutate();
            }}
          >
            <Unlink /> {t('accountHost.unlink')}
          </Button>
        </Row>
      </Card>
    );
  }
  return (
    <Card title={t('accountHost.title')}>
      <Row label={t('accountHost.linkLabel')} hint={t('accountHost.linkHint')} />
      <form
        className="flex gap-2 px-4 pb-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) link.mutate();
        }}
      >
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={t('accountHost.codePlaceholder')}
          aria-label={t('accountHost.codePlaceholder')}
          autoComplete="off"
          spellCheck={false}
        />
        <Button
          type="submit"
          size="sm"
          className="shrink-0 rounded-full"
          disabled={!code.trim() || link.isPending}
        >
          <Link2 /> {t('accountHost.link')}
        </Button>
      </form>
    </Card>
  );
}
