import type { DiscordServer, DiscordStatus } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { FormField, TextBox } from '@/components/dialogs/common';
import { confirm, toast, toastError } from '@/components/overlay';
import { Note, PillButton, Row, Section, SwitchRow } from '@/components/page';
import { Hint, Pad, Rows } from '@/components/settings/common/controls';
import { t } from '@/i18n';
import { useBots } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { BotChoice, NONE, openUrl, PageHead, type Summary } from './common';

/** Discord's page for making an application with a bot. */
const PORTAL = 'https://discord.com/developers/applications';

/** The server's Discord bot: set up once by those who look after the server. */
export function DiscordPage({ summary }: { summary?: Summary }) {
  const api = useApi();
  const { origin } = useServer();
  const { data: status } = useQuery({ queryKey: ['discord', origin], queryFn: api.discord });
  const { data: bots } = useBots();
  return (
    <>
      <PageHead id="discord" summary={summary} />
      {status && bots ? <DiscordForm key={`${status.connected}:${status.botId}`} status={status} /> : null}
    </>
  );
}

function DiscordForm({ status }: { status: DiscordStatus }) {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const live = (useBots().data ?? []).filter((b) => !b.archivedAt);
  const [token, setToken] = useState('');
  const [botId, setBotId] = useState(status.botId ?? live[0]?.id ?? NONE);
  const chosen = botId === NONE ? null : botId;
  const put = (s: DiscordStatus) => qc.setQueryData(['discord', origin], s);
  const connect = useMutation({
    mutationFn: () => api.connectDiscord({ token, botId: chosen }),
    onSuccess: (s) => {
      put(s);
      toast(t('discord.connected'));
    },
    onError: toastError,
  });
  const update = useMutation({ mutationFn: api.updateDiscord, onSuccess: put, onError: toastError });
  const disconnect = useMutation({
    mutationFn: api.disconnectDiscord,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['discord', origin] }),
    onError: toastError,
  });

  return (
    <>
      <Section>
        <Rows>
          <Pad>
            {status.error ? <Note tone="error">{t('discord.error', { error: status.error })}</Note> : null}
            {status.connected && !status.messageContent ? <Hint>{t('discord.noMessageContent')}</Hint> : null}
            <Hint>{t('discord.about')}</Hint>
            <Hint>{t('discord.guests')}</Hint>
          </Pad>
          {status.botUser ? <Row label={`@${status.botUser}`} chevron={false} /> : null}
        </Rows>
      </Section>

      {!status.connected ? (
        <Section>
          <Rows>
            <Pad>
              <Hint>1. {t('discord.step1')}</Hint>
              <Hint>2. {t('discord.step2')}</Hint>
              <Hint>3. {t('discord.step3')}</Hint>
            </Pad>
            <Row icon="external-link" label={t('discord.step1Link')} onPress={() => openUrl(PORTAL)} />
            <Pad>
              <FormField label={t('discord.token')}>
                <TextBox
                  value={token}
                  onChangeText={setToken}
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
            label={t('discord.bot')}
            detail={t('discord.botHint')}
            value={botId}
            noneLabel={t('discord.noBot')}
            onChange={(v) => {
              setBotId(v);
              if (status.connected) update.mutate({ botId: v === NONE ? null : v });
            }}
          />
        </Rows>
      </Section>

      {status.connected ? (
        <Section title={t('discord.servers')}>
          <Rows>
            {status.inviteUrl ? (
              <Row
                icon="external-link"
                label={t('discord.invite')}
                onPress={() => openUrl(status.inviteUrl!)}
              />
            ) : null}
            {!status.servers.length ? (
              <Pad>
                <Hint>{t('discord.noServers')}</Hint>
              </Pad>
            ) : null}
          </Rows>
        </Section>
      ) : null}
      {status.connected
        ? status.servers.map((s) => (
            <ServerRoles
              key={s.id}
              server={s}
              busy={update.isPending}
              onChange={(roleIds) => update.mutate({ roles: { serverId: s.id, roleIds } })}
            />
          ))
        : null}

      <Section>
        <Rows>
          {!status.connected ? (
            <Pad>
              <PillButton
                label={t('discord.connect')}
                variant="primary"
                onPress={() => connect.mutate()}
                busy={connect.isPending}
                disabled={!token.trim()}
              />
            </Pad>
          ) : (
            <Row
              label={t('discord.disconnect')}
              destructive
              chevron={false}
              busy={disconnect.isPending}
              onPress={() =>
                void confirm({
                  title: t('discord.disconnectConfirm'),
                  destructive: true,
                  confirmLabel: t('discord.disconnect'),
                }).then((ok) => ok && disconnect.mutate())
              }
            />
          )}
        </Rows>
      </Section>
    </>
  );
}

/** Who in one Discord server may use the bot: everyone, or the members of the roles turned on. */
function ServerRoles({
  server,
  busy,
  onChange,
}: {
  server: DiscordServer;
  busy: boolean;
  onChange: (roleIds: string[]) => void;
}) {
  const allowed = new Set(server.allowed);
  return (
    <Section title={server.name} footer={allowed.size ? t('discord.rolesOnly') : t('discord.everyone')}>
      <Rows>
        {server.roles.map((r) => (
          <SwitchRow
            key={r.id}
            label={r.name}
            value={allowed.has(r.id)}
            disabled={busy}
            onChange={(on) => onChange(on ? [...allowed, r.id] : [...allowed].filter((id) => id !== r.id))}
          />
        ))}
      </Rows>
    </Section>
  );
}
