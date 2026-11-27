import type { Bot, EmailSettings } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { askText, confirm, toastError } from '@/components/overlay';
import { PillButton, Row, Section, SwitchRow } from '@/components/page';
import { Hint, Pad, Rows, SavedField, useSaveSettings } from '@/components/settings/common/controls';
import { t } from '@/i18n';
import { useBots, useInfo, useSettings } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { copy, PageHead, type Summary } from './common';

/**
 * Mail for the bots: the domain they receive at, the secret a mail relay sends with each message,
 * and each bot's address. The server runs no mail server; a relay posts each mail to it.
 */
export function EmailPage({ summary }: { summary?: Summary }) {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const { data: email } = useQuery({ queryKey: ['email', origin], queryFn: api.emailSettings });
  const { data: bots = [] } = useBots();
  const { data: info } = useInfo();
  const save = useSaveSettings();
  const put = (s: EmailSettings) => qc.setQueryData(['email', origin], s);
  const renew = useMutation({ mutationFn: api.renewEmailSecret, onSuccess: put, onError: toastError });
  if (!email || !settings) return <PageHead id="email" summary={summary} />;
  // Mail reaches the server from the internet, so only a public address can take it; the tunnel is the phone's own.
  const endpoint = info?.publicUrl ? `${info.publicUrl}/api/email/inbound?to=<address>` : null;
  return (
    <>
      <PageHead id="email" summary={summary} />
      <Section>
        <Rows>
          <Pad>
            <Hint>{t('email.hint')}</Hint>
            <SavedField
              label={t('email.domain')}
              hint={t('email.domainHint')}
              value={settings.emailDomain ?? ''}
              max={253}
              placeholder={t('email.domainPlaceholder')}
              onSave={(domain) =>
                save.mutate(
                  { emailDomain: domain },
                  { onSuccess: () => void qc.invalidateQueries({ queryKey: ['email', origin] }) },
                )
              }
            />
          </Pad>
        </Rows>
      </Section>
      {settings.emailDomain ? (
        <>
          <Section title={t('email.relay')}>
            <Rows>
              <Pad>
                <Hint>{t('email.relayHint')}</Hint>
              </Pad>
              {endpoint ? (
                <Row
                  icon="copy"
                  label={t('message.copy')}
                  detail={`POST ${endpoint}`}
                  detailLines={0}
                  onPress={() => void copy(endpoint, 'email.copied')}
                  chevron={false}
                />
              ) : null}
              {email.secret ? (
                <Row
                  icon="copy"
                  label={t('message.copy')}
                  detail={`Authorization: Bearer ${email.secret}`}
                  detailLines={0}
                  onPress={() => void copy(email.secret!, 'email.copied')}
                  chevron={false}
                />
              ) : null}
              <Pad>
                <PillButton
                  label={t(email.secret ? 'email.renew' : 'email.makeSecret')}
                  busy={renew.isPending}
                  onPress={() => {
                    if (!email.secret) return renew.mutate();
                    void confirm({ title: t('email.renewConfirm'), destructive: true }).then(
                      (ok) => ok && renew.mutate(),
                    );
                  }}
                />
              </Pad>
            </Rows>
          </Section>
          {bots
            .filter((b) => !b.archivedAt)
            .map((b) => (
              <BotAddress key={b.id} bot={b} email={email} onChange={put} />
            ))}
        </>
      ) : null}
    </>
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
  const api = useApi();
  const own = email.addresses.find((a) => a.botId === bot.id);
  const claim = useMutation({
    mutationFn: (name: string) => api.claimEmail(bot.id, name),
    onSuccess: onChange,
    onError: toastError,
  });
  const release = useMutation({
    mutationFn: () => api.releaseEmail(bot.id),
    onSuccess: onChange,
    onError: toastError,
  });
  const codes = useMutation({
    mutationFn: (on: boolean) => api.setEmailCodes(bot.id, on),
    onSuccess: onChange,
    onError: toastError,
  });
  return (
    <Section title={bot.name} footer={own ? undefined : `@${email.domain}`}>
      <Rows>
        {own ? <Row label={own.address ?? own.name} chevron={false} /> : null}
        {own ? (
          <SwitchRow
            label={t('email.codes', { bot: bot.name })}
            detail={t('email.codesHint')}
            value={own.codes}
            disabled={codes.isPending}
            onChange={(on) => codes.mutate(on)}
          />
        ) : null}
        {own ? (
          <Row
            label={t('email.release')}
            destructive
            chevron={false}
            busy={release.isPending}
            onPress={() =>
              void confirm({
                title: t('email.releaseConfirm', { address: own.address ?? own.name }),
                destructive: true,
                confirmLabel: t('email.release'),
              }).then((ok) => ok && release.mutate())
            }
          />
        ) : null}
        {!own ? (
          <Row
            label={t('email.noAddress')}
            value={t('email.claim')}
            busy={claim.isPending}
            onPress={() =>
              void askText({
                title: t('email.name', { bot: bot.name }),
                message: `@${email.domain}`,
                placeholder: t('email.namePlaceholder'),
                confirmLabel: t('email.claim'),
              }).then((name) => name?.trim() && claim.mutate(name.trim()))
            }
          />
        ) : null}
      </Rows>
    </Section>
  );
}
