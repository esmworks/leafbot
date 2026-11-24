import type { Bot, TeamsLink, TeamsStatus } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { useBots } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Card } from './SettingsPage';

/** Azure's page for registering a new bot. */
const NEW_BOT = 'https://portal.azure.com/#create/Microsoft.AzureBot';
const NONE = '__none';

/** The server's Teams bot: set up once by those who look after the server. */
export function TeamsCard() {
  const { data: status } = useQuery({ queryKey: ['teams'], queryFn: api.teams });
  const { data: bots } = useBots();
  if (!status || !bots) return null;
  return <TeamsForm key={`${status.connected}:${status.botId}`} status={status} bots={bots} />;
}

function TeamsForm({ status, bots }: { status: TeamsStatus; bots: Bot[] }) {
  const t = useT();
  const qc = useQueryClient();
  const live = bots.filter((b) => !b.archivedAt);
  const [appId, setAppId] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [secret, setSecret] = useState('');
  const [botId, setBotId] = useState(
    status.botId ?? live.find((b) => b.isManager)?.id ?? live[0]?.id ?? NONE,
  );
  const chosen = botId === NONE ? null : botId;
  const fail = (e: Error) => toast.error(e.message);
  const connect = useMutation({
    mutationFn: () =>
      api.connectTeams({ appId: appId.trim(), tenantId: tenantId.trim(), secret, botId: chosen }),
    onSuccess: (s) => {
      qc.setQueryData(['teams'], s);
      void qc.invalidateQueries({ queryKey: ['teams-link'] });
      toast.success(t('teams.connected'));
    },
    onError: fail,
  });
  const update = useMutation({
    mutationFn: (id: string | null) => api.updateTeams({ botId: id }),
    onSuccess: (s) => qc.setQueryData(['teams'], s),
    onError: fail,
  });
  const disconnect = useMutation({
    mutationFn: api.disconnectTeams,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['teams'] });
      void qc.invalidateQueries({ queryKey: ['teams-link'] });
    },
    onError: fail,
  });
  const copy = async (text: string) => {
    if (await copyText(text)) toast.success(t('teams.copied'));
    else toast.error(t('message.copyFailed'));
  };
  const field = (label: string, value: string, set: (v: string) => void, placeholder: string) => (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      <Input
        value={value}
        onChange={(e) => set(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        className="rounded-xl"
      />
    </label>
  );

  return (
    <Card>
      <div className="space-y-4 px-4 py-4">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'size-2 rounded-full',
              status.connected && !status.error
                ? 'bg-emerald-500'
                : status.error
                  ? 'bg-destructive'
                  : 'bg-muted-foreground/40',
            )}
          />
          <span className="text-sm">{t(status.connected ? 'teams.on' : 'teams.off')}</span>
        </div>
        {status.error && <p className="text-sm text-destructive">{status.error}</p>}
        <p className="text-sm text-muted-foreground">{t('teams.about')}</p>

        <div className="space-y-1">
          <span className="text-sm font-medium">{t('teams.endpoint')}</span>
          {status.endpoint ? (
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg bg-secondary/60 px-2 py-1 text-xs">
                {status.endpoint}
              </code>
              <Button type="button" variant="secondary" size="sm" onClick={() => void copy(status.endpoint!)}>
                {t('teams.copy')}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-amber-600 dark:text-amber-400">{t('teams.noEndpoint')}</p>
          )}
        </div>

        {!status.connected && (
          <div className="space-y-4">
            <ol className="list-decimal space-y-2 ps-5 text-sm text-muted-foreground">
              <li>
                {t('teams.step1')}{' '}
                <a href={NEW_BOT} target="_blank" rel="noreferrer" className="text-primary underline">
                  {t('teams.step1Link')}
                </a>
              </li>
              <li>{t('teams.step2')}</li>
              <li>{t('teams.step3')}</li>
            </ol>
            {field(t('teams.appId'), appId, setAppId, '00000000-0000-0000-0000-000000000000')}
            {field(t('teams.tenantId'), tenantId, setTenantId, '00000000-0000-0000-0000-000000000000')}
            <label className="block space-y-1">
              <span className="text-sm font-medium">{t('teams.secret')}</span>
              <Input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                autoComplete="off"
                className="rounded-xl"
              />
            </label>
          </div>
        )}
        {status.connected && status.appId && (
          <p className="text-xs text-muted-foreground">
            {t('teams.registered', { appId: status.appId, tenantId: status.tenantId ?? '' })}
          </p>
        )}

        <label className="block space-y-1">
          <span className="text-sm font-medium">{t('slack.defaultBot')}</span>
          <Select
            value={botId}
            onValueChange={(v) => {
              setBotId(v);
              if (status.connected) update.mutate(v === NONE ? null : v);
            }}
          >
            <SelectTrigger className="w-full rounded-xl">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t('slack.noDefaultBot')}</SelectItem>
              {live.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="block text-xs text-muted-foreground">{t('slack.defaultBotHint')}</span>
        </label>

        {status.connected && (
          <div className="space-y-1">
            <span className="text-sm font-medium">{t('slack.people')}</span>
            {status.people.length ? (
              <ul className="space-y-1 text-sm">
                {status.people.map((p) => (
                  <li key={p.userId} className="flex justify-between gap-4">
                    <span>{p.name}</span>
                    <span className="text-muted-foreground">{p.teamsName}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{t('teams.nobodyLinked')}</p>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {!status.connected && (
            <Button
              type="button"
              disabled={!appId.trim() || !tenantId.trim() || !secret.trim() || connect.isPending}
              onClick={() => connect.mutate()}
            >
              {t('slack.connect')}
            </Button>
          )}
          {status.connected && (
            <Button
              type="button"
              variant="ghost"
              className="text-muted-foreground"
              disabled={disconnect.isPending}
              onClick={() => window.confirm(t('teams.disconnectConfirm')) && disconnect.mutate()}
            >
              {t('slack.disconnect')}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

/** One person's Teams account: linked with a code they send the server's Teams bot. */
export function TeamsLinkCard() {
  const t = useT();
  const qc = useQueryClient();
  const { data: link } = useQuery({ queryKey: ['teams-link'], queryFn: api.teamsLink });
  const put = (l: TeamsLink) => qc.setQueryData(['teams-link'], l);
  const code = useMutation({
    mutationFn: api.teamsCode,
    onSuccess: put,
    onError: (e) => toast.error(e.message),
  });
  const unlink = useMutation({
    mutationFn: api.teamsUnlink,
    onSuccess: put,
    onError: (e) => toast.error(e.message),
  });
  if (!link?.available) return null;
  const command = link.code ? `link ${link.code}` : '';
  return (
    <Card title={t('teams.mine')}>
      <div className="space-y-3 px-4 py-4">
        {link.linked ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm">{t('teams.linkedAs', { name: link.linked.name })}</span>
            <Button
              type="button"
              variant="ghost"
              className="text-muted-foreground"
              disabled={unlink.isPending}
              onClick={() => unlink.mutate()}
            >
              {t('slack.unlink')}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('teams.notLinked')}</p>
        )}
        {command && (
          <div className="space-y-1 rounded-2xl bg-secondary/60 p-4">
            <p className="text-sm">{t('teams.sendCode')}</p>
            <button
              type="button"
              className="text-lg font-medium"
              onClick={() =>
                void copyText(command).then((ok) =>
                  ok ? toast.success(t('teams.copied')) : toast.error(t('message.copyFailed')),
                )
              }
            >
              {command}
            </button>
          </div>
        )}
        {!link.linked && (
          <Button type="button" variant="secondary" disabled={code.isPending} onClick={() => code.mutate()}>
            {t(command ? 'slack.newCode' : 'slack.getCode')}
          </Button>
        )}
      </div>
    </Card>
  );
}
