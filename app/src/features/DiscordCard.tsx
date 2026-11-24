import type { Bot, DiscordServer, DiscordStatus } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useBots } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Card } from './SettingsPage';

/** Discord's page for making an application with a bot. */
const PORTAL = 'https://discord.com/developers/applications';
const NONE = '__none';

/** The server's Discord bot: set up once by those who look after the server. */
export function DiscordCard() {
  const { data: status } = useQuery({ queryKey: ['discord'], queryFn: api.discord });
  const { data: bots } = useBots();
  if (!status || !bots) return null;
  return <DiscordForm key={`${status.connected}:${status.botId}`} status={status} bots={bots} />;
}

function DiscordForm({ status, bots }: { status: DiscordStatus; bots: Bot[] }) {
  const t = useT();
  const qc = useQueryClient();
  const live = bots.filter((b) => !b.archivedAt);
  const [token, setToken] = useState('');
  const [botId, setBotId] = useState(status.botId ?? live[0]?.id ?? NONE);
  const chosen = botId === NONE ? null : botId;
  const fail = (e: Error) => toast.error(e.message);
  const put = (s: DiscordStatus) => qc.setQueryData(['discord'], s);
  const connect = useMutation({
    mutationFn: () => api.connectDiscord({ token, botId: chosen }),
    onSuccess: (s) => {
      put(s);
      toast.success(t('discord.connected'));
    },
    onError: fail,
  });
  const update = useMutation({ mutationFn: api.updateDiscord, onSuccess: put, onError: fail });
  const disconnect = useMutation({
    mutationFn: api.disconnectDiscord,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['discord'] }),
    onError: fail,
  });

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
          <span className="text-sm">{status.connected ? t('discord.on') : t('discord.off')}</span>
          {status.botUser && <span className="text-xs text-muted-foreground">@{status.botUser}</span>}
        </div>
        {status.error && (
          <p className="text-sm text-destructive">{t('discord.error', { error: status.error })}</p>
        )}
        {status.connected && !status.messageContent && (
          <p className="text-sm text-muted-foreground">{t('discord.noMessageContent')}</p>
        )}
        <p className="text-sm text-muted-foreground">{t('discord.about')}</p>
        <p className="text-sm text-muted-foreground">{t('discord.guests')}</p>

        {!status.connected && (
          <div className="space-y-4">
            <ol className="list-decimal space-y-2 ps-5 text-sm text-muted-foreground">
              <li>
                {t('discord.step1')}{' '}
                <a href={PORTAL} target="_blank" rel="noreferrer" className="text-primary underline">
                  {t('discord.step1Link')}
                </a>
              </li>
              <li>{t('discord.step2')}</li>
              <li>{t('discord.step3')}</li>
            </ol>
            <label className="block space-y-1">
              <span className="text-sm font-medium">{t('discord.token')}</span>
              <Input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                className="rounded-xl"
              />
            </label>
          </div>
        )}

        <label className="block space-y-1">
          <span className="text-sm font-medium">{t('discord.bot')}</span>
          <Select
            value={botId}
            onValueChange={(v) => {
              setBotId(v);
              if (status.connected) update.mutate({ botId: v === NONE ? null : v });
            }}
          >
            <SelectTrigger className="w-full rounded-xl">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t('discord.noBot')}</SelectItem>
              {live.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="block text-xs text-muted-foreground">{t('discord.botHint')}</span>
        </label>

        {status.connected && (
          <div className="space-y-3">
            <div className="space-y-1">
              <span className="text-sm font-medium">{t('discord.servers')}</span>
              {status.inviteUrl && (
                <p className="text-sm">
                  <a
                    href={status.inviteUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline"
                  >
                    {t('discord.invite')}
                  </a>
                </p>
              )}
              {!status.servers.length && (
                <p className="text-sm text-muted-foreground">{t('discord.noServers')}</p>
              )}
            </div>
            {status.servers.map((s) => (
              <ServerRoles
                key={s.id}
                server={s}
                busy={update.isPending}
                onChange={(roleIds) => update.mutate({ roles: { serverId: s.id, roleIds } })}
              />
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {!status.connected && (
            <Button
              type="button"
              className="rounded-full"
              disabled={!token.trim() || connect.isPending}
              onClick={() => connect.mutate()}
            >
              {t('discord.connect')}
            </Button>
          )}
          {status.connected && (
            <Button
              type="button"
              variant="ghost"
              className="rounded-full text-muted-foreground"
              disabled={disconnect.isPending}
              onClick={() => window.confirm(t('discord.disconnectConfirm')) && disconnect.mutate()}
            >
              {t('discord.disconnect')}
            </Button>
          )}
        </div>
      </div>
    </Card>
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
  const t = useT();
  const allowed = new Set(server.allowed);
  return (
    <div className="space-y-2 rounded-xl border px-3 py-3">
      <div className="text-sm font-medium">{server.name}</div>
      <p className="text-xs text-muted-foreground">
        {allowed.size ? t('discord.rolesOnly') : t('discord.everyone')}
      </p>
      {server.roles.map((r) => (
        <label key={r.id} className="flex items-center justify-between gap-4 text-sm">
          <span>{r.name}</span>
          <Switch
            checked={allowed.has(r.id)}
            disabled={busy}
            onCheckedChange={(on) =>
              onChange(on ? [...allowed, r.id] : [...allowed].filter((id) => id !== r.id))
            }
          />
        </label>
      ))}
    </div>
  );
}
