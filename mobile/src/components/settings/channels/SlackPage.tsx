import { slackManifest, type SlackStatus } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { FormField, TextBox } from '@/components/dialogs/common';
import { confirm, toast, toastError } from '@/components/overlay';
import { Note, PillButton, Row, Section } from '@/components/page';
import { Hint, Pad, Rows } from '@/components/settings/common/controls';
import { t } from '@/i18n';
import { useBots } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { BotChoice, copy, NONE, openUrl, PageHead, type Summary } from './common';

/** Slack's page for making an app from a manifest. */
const NEW_APP = 'https://api.slack.com/apps?new_app=1';

/** The server's Slack app: set up once by those who look after the server. */
export function SlackPage({ summary }: { summary?: Summary }) {
  const api = useApi();
  const { origin } = useServer();
  const { data: status } = useQuery({ queryKey: ['slack', origin], queryFn: api.slack });
  const { data: bots } = useBots();
  if (!status || !bots) return <PageHead id="slack" summary={summary} />;
  return (
    <>
      <PageHead id="slack" summary={summary} />
      <SlackForm key={`${status.connected}:${status.botId}`} status={status} />
    </>
  );
}

function SlackForm({ status }: { status: SlackStatus }) {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const live = (useBots().data ?? []).filter((b) => !b.archivedAt);
  const [appToken, setAppToken] = useState('');
  const [botToken, setBotToken] = useState('');
  const [botId, setBotId] = useState(
    status.botId ?? live.find((b) => b.isManager)?.id ?? live[0]?.id ?? NONE,
  );
  const chosen = botId === NONE ? null : botId;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['slack', origin] });
    void qc.invalidateQueries({ queryKey: ['slack-link', origin] });
  };
  const connect = useMutation({
    mutationFn: () => api.connectSlack({ appToken, botToken, botId: chosen }),
    onSuccess: (s) => {
      qc.setQueryData(['slack', origin], s);
      void qc.invalidateQueries({ queryKey: ['slack-link', origin] });
      toast(t('slack.connected'));
    },
    onError: toastError,
  });
  const update = useMutation({
    mutationFn: (id: string | null) => api.updateSlack({ botId: id }),
    onSuccess: (s) => qc.setQueryData(['slack', origin], s),
    onError: toastError,
  });
  const disconnect = useMutation({
    mutationFn: api.disconnectSlack,
    onSuccess: refresh,
    onError: toastError,
  });

  return (
    <>
      <Section>
        <Rows>
          <Pad>
            {status.error ? <Note tone="error">{t('slack.error', { error: status.error })}</Note> : null}
            {status.optionalMissing.length > 0 ? (
              <Note>{t('slack.optionalMissing', { scopes: status.optionalMissing.join(', ') })}</Note>
            ) : null}
            <Hint>{t('slack.about')}</Hint>
          </Pad>
          {status.botUser ? <Row label={`@${status.botUser}`} chevron={false} /> : null}
        </Rows>
      </Section>

      {!status.connected ? (
        <Section>
          <Rows>
            <Pad>
              <Hint>1. {t('slack.step1')}</Hint>
              <Hint>2. {t('slack.step2')}</Hint>
              <Hint>3. {t('slack.step3')}</Hint>
            </Pad>
            <Row icon="external-link" label={t('slack.step1Link')} onPress={() => openUrl(NEW_APP)} />
            <Row
              icon="copy"
              label={t('slack.copyManifest')}
              onPress={() => void copy(slackManifest(t('slack.appName')), 'slack.manifestCopied')}
            />
            <Pad>
              <FormField label={t('slack.appToken')}>
                <TextBox
                  value={appToken}
                  onChangeText={setAppToken}
                  placeholder={t('slack.appTokenPlaceholder')}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </FormField>
              <FormField label={t('slack.botToken')}>
                <TextBox
                  value={botToken}
                  onChangeText={setBotToken}
                  placeholder={t('slack.botTokenPlaceholder')}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </FormField>
            </Pad>
          </Rows>
        </Section>
      ) : null}

      <Section>
        <Rows>
          <BotChoice
            label={t('slack.defaultBot')}
            detail={t('slack.defaultBotHint')}
            value={botId}
            noneLabel={t('slack.noDefaultBot')}
            onChange={(v) => {
              setBotId(v);
              if (status.connected) update.mutate(v === NONE ? null : v);
            }}
          />
        </Rows>
      </Section>

      {status.connected ? (
        <Section title={t('slack.people')}>
          <Rows>
            {status.people.length ? (
              status.people.map((p) => (
                <Row key={p.userId} label={p.name} value={p.slackName} chevron={false} />
              ))
            ) : (
              <Pad>
                <Hint>{t('slack.nobodyLinked')}</Hint>
              </Pad>
            )}
          </Rows>
        </Section>
      ) : null}

      <Section>
        <Rows>
          {!status.connected ? (
            <Pad>
              <PillButton
                label={t('slack.connect')}
                variant="primary"
                onPress={() => connect.mutate()}
                busy={connect.isPending}
                disabled={!appToken.trim() || !botToken.trim()}
              />
            </Pad>
          ) : (
            <Row
              label={t('slack.disconnect')}
              destructive
              chevron={false}
              busy={disconnect.isPending}
              onPress={() =>
                void confirm({
                  title: t('slack.disconnectConfirm'),
                  destructive: true,
                  confirmLabel: t('slack.disconnect'),
                }).then((ok) => ok && disconnect.mutate())
              }
            />
          )}
        </Rows>
      </Section>
    </>
  );
}
