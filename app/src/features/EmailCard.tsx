import type { Bot, EmailSettings } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { useBots, useInfo, useSettings } from '@/lib/queries';
import { Card, Row, useSaveSettings } from './SettingsPage';

/**
 * Mail for the bots: the domain they receive at, the secret a mail relay sends with each message,
 * and each bot's address. The server runs no mail server; a relay posts each mail to it.
 */
export function EmailCard() {
  const t = useT();
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const { data: email } = useQuery({ queryKey: ['email'], queryFn: api.emailSettings });
  const { data: bots = [] } = useBots();
  const { data: info } = useInfo();
  const save = useSaveSettings();
  const [domain, setDomain] = useState<string | null>(null);
  const shownDomain = domain ?? settings?.emailDomain ?? '';
  const put = (s: EmailSettings) => qc.setQueryData(['email'], s);
  const renew = useMutation({
    mutationFn: api.renewEmailSecret,
    onSuccess: put,
    onError: (e) => toast.error((e as Error).message),
  });
  if (!email || !settings) return null;
  const base = info?.publicUrl ?? window.location.origin;
  const endpoint = `${base}/api/email/inbound?to=<address>`;
  const copy = async (text: string) => {
    if (await copyText(text)) toast.success(t('email.copied'));
    else toast.error(t('message.copyFailed'));
  };
  return (
    <Card>
      <p className="px-4 py-3 text-sm text-muted-foreground">{t('email.hint')}</p>
      <Row label={t('email.domain')} hint={t('email.domainHint')}>
        <Input
          value={shownDomain}
          onChange={(e) => setDomain(e.target.value)}
          onBlur={() => {
            if (domain === null || domain.trim() === (settings.emailDomain ?? '')) return;
            save.mutate(
              { emailDomain: domain.trim() },
              {
                onSuccess: () => {
                  setDomain(null);
                  void qc.invalidateQueries({ queryKey: ['email'] });
                },
              },
            );
          }}
          placeholder={t('email.domainPlaceholder')}
          aria-label={t('email.domain')}
          className="w-56 rounded-full"
        />
      </Row>
      {settings.emailDomain && (
        <>
          <div className="space-y-2 px-4 py-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="flex-1">{t('email.relay')}</span>
              <Button
                size="sm"
                variant="secondary"
                className="rounded-full"
                disabled={renew.isPending}
                onClick={() => {
                  if (!email.secret || confirm(t('email.renewConfirm'))) renew.mutate();
                }}
              >
                {t(email.secret ? 'email.renew' : 'email.makeSecret')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('email.relayHint')}</p>
            <code className="block truncate rounded-lg bg-secondary px-2 py-1 font-mono text-[11px]">
              POST {endpoint}
            </code>
            {email.secret && (
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg bg-secondary px-2 py-1 font-mono text-[11px]">
                  Authorization: Bearer {email.secret}
                </code>
                <Button
                  size="sm"
                  variant="secondary"
                  className="rounded-full"
                  onClick={() => void copy(email.secret!)}
                >
                  {t('message.copy')}
                </Button>
              </div>
            )}
          </div>
          {bots
            .filter((b) => !b.archivedAt)
            .map((b) => (
              <BotAddress key={b.id} bot={b} email={email} onChange={put} />
            ))}
        </>
      )}
    </Card>
  );
}

function BotAddress({
  bot,
  email,
  onChange,
}: {
  bot: Bot;
  email: EmailSettings;
  onChange(s: EmailSettings): void;
}) {
  const t = useT();
  const own = email.addresses.find((a) => a.botId === bot.id);
  const [name, setName] = useState('');
  const claim = useMutation({
    mutationFn: () => api.claimEmail(bot.id, name),
    onSuccess: (s) => {
      onChange(s);
      setName('');
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const release = useMutation({
    mutationFn: () => api.releaseEmail(bot.id),
    onSuccess: onChange,
    onError: (e) => toast.error((e as Error).message),
  });
  const codes = useMutation({
    mutationFn: (on: boolean) => api.setEmailCodes(bot.id, on),
    onSuccess: onChange,
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <>
      <Row label={bot.name} hint={own?.address ?? t('email.noAddress')}>
        {own ? (
          <Button
            size="sm"
            variant="ghost"
            className="rounded-full"
            disabled={release.isPending}
            onClick={() => {
              if (confirm(t('email.releaseConfirm', { address: own.address ?? own.name }))) release.mutate();
            }}
          >
            {t('email.release')}
          </Button>
        ) : (
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) claim.mutate();
            }}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('email.namePlaceholder')}
              aria-label={t('email.name', { bot: bot.name })}
              className="h-8 w-36 rounded-full text-sm"
            />
            <span className="text-xs text-muted-foreground">@{email.domain}</span>
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              className="rounded-full"
              disabled={claim.isPending}
            >
              {t('email.claim')}
            </Button>
          </form>
        )}
      </Row>
      {own && (
        <Row label={t('email.codes', { bot: bot.name })} hint={t('email.codesHint')}>
          <Switch
            checked={own.codes}
            disabled={codes.isPending}
            onCheckedChange={(on) => codes.mutate(on)}
            aria-label={t('email.codes', { bot: bot.name })}
          />
        </Row>
      )}
    </>
  );
}
