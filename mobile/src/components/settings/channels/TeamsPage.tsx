import type { TeamsStatus } from '@leafbot/shared';
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

/** Azure's page for registering a new bot. */
const NEW_BOT = 'https://portal.azure.com/#create/Microsoft.AzureBot';

/** The server's Teams bot: set up once by those who look after the server. */
export function TeamsPage({ summary }: { summary?: Summary }) {
  const api = useApi();
  const { origin } = useServer();
  const { data: status } = useQuery({ queryKey: ['teams', origin], queryFn: api.teams });
  const { data: bots } = useBots();
  return (
    <>
      <PageHead id="teams" summary={summary} />
      {status && bots ? <TeamsForm key={`${status.connected}:${status.botId}`} status={status} /> : null}
    </>
  );
}

function TeamsForm({ status }: { status: TeamsStatus }) {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const live = (useBots().data ?? []).filter((b) => !b.archivedAt);
  const [appId, setAppId] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [secret, setSecret] = useState('');
  const [botId, setBotId] = useState(
    status.botId ?? live.find((b) => b.isManager)?.id ?? live[0]?.id ?? NONE,
  );
  const chosen = botId === NONE ? null : botId;
  const connect = useMutation({
    mutationFn: () =>
      api.connectTeams({ appId: appId.trim(), tenantId: tenantId.trim(), secret, botId: chosen }),
    onSuccess: (s) => {
      qc.setQueryData(['teams', origin], s);
      void qc.invalidateQueries({ queryKey: ['teams-link', origin] });
      toast(t('teams.connected'));
    },
    onError: toastError,
  });
  const update = useMutation({
    mutationFn: (id: string | null) => api.updateTeams({ botId: id }),
    onSuccess: (s) => qc.setQueryData(['teams', origin], s),
    onError: toastError,
  });
  const disconnect = useMutation({
    mutationFn: api.disconnectTeams,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['teams', origin] });
      void qc.invalidateQueries({ queryKey: ['teams-link', origin] });
    },
    onError: toastError,
  });

  return (
    <>
      <Section>
        <Rows>
          <Pad>
            {status.error ? <Note tone="error">{status.error}</Note> : null}
            <Hint>{t('teams.about')}</Hint>
          </Pad>
          {status.endpoint ? (
            <Row
              icon="copy"
              label={t('teams.endpoint')}
              detail={status.endpoint}
              onPress={() => void copy(status.endpoint!, 'teams.copied')}
              chevron={false}
            />
          ) : (
            <Pad>
              <Hint>{t('teams.noEndpoint')}</Hint>
            </Pad>
          )}
          {status.connected && status.appId ? (
            <Pad>
              <Hint>{t('teams.registered', { appId: status.appId, tenantId: status.tenantId ?? '' })}</Hint>
            </Pad>
          ) : null}
        </Rows>
      </Section>

      {!status.connected ? (
        <Section>
          <Rows>
            <Pad>
              <Hint>1. {t('teams.step1')}</Hint>
              <Hint>2. {t('teams.step2')}</Hint>
              <Hint>3. {t('teams.step3')}</Hint>
            </Pad>
            <Row icon="external-link" label={t('teams.step1Link')} onPress={() => openUrl(NEW_BOT)} />
            <Pad>
              <FormField label={t('teams.appId')}>
                <TextBox
                  value={appId}
                  onChangeText={setAppId}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </FormField>
              <FormField label={t('teams.tenantId')}>
                <TextBox
                  value={tenantId}
                  onChangeText={setTenantId}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </FormField>
              <FormField label={t('teams.secret')}>
                <TextBox
                  value={secret}
                  onChangeText={setSecret}
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
                <Row key={p.userId} label={p.name} value={p.teamsName} chevron={false} />
              ))
            ) : (
              <Pad>
                <Hint>{t('teams.nobodyLinked')}</Hint>
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
                disabled={!appId.trim() || !tenantId.trim() || !secret.trim()}
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
                  title: t('teams.disconnectConfirm'),
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
