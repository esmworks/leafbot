import { slackManifest, type Bot, type SlackStatus } from '@leafbot/shared';
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

/** Slack's page for making an app from a manifest. */
const NEW_APP = 'https://api.slack.com/apps?new_app=1';
const NONE = '__none';

/** The server's Slack app: set up once by those who look after the server. */
export function SlackCard() {
  const { data: status } = useQuery({ queryKey: ['slack'], queryFn: api.slack });
  const { data: bots } = useBots();
  if (!status || !bots) return null;
  return <SlackForm key={`${status.connected}:${status.botId}`} status={status} bots={bots} />;
}

function SlackForm({ status, bots }: { status: SlackStatus; bots: Bot[] }) {
  const t = useT();
  const qc = useQueryClient();
  const live = bots.filter((b) => !b.archivedAt);
  const [appToken, setAppToken] = useState('');
  const [botToken, setBotToken] = useState('');
  const [botId, setBotId] = useState(
    status.botId ?? live.find((b) => b.isManager)?.id ?? live[0]?.id ?? NONE,
  );
  const chosen = botId === NONE ? null : botId;
  const fail = (e: Error) => toast.error(e.message);
  const connect = useMutation({
    mutationFn: () => api.connectSlack({ appToken, botToken, botId: chosen }),
    onSuccess: (s) => {
      qc.setQueryData(['slack'], s);
      void qc.invalidateQueries({ queryKey: ['slack-link'] });
      toast.success(t('slack.connected'));
    },
    onError: fail,
  });
  const update = useMutation({
    mutationFn: (id: string | null) => api.updateSlack({ botId: id }),
    onSuccess: (s) => qc.setQueryData(['slack'], s),
    onError: fail,
  });
  const disconnect = useMutation({
    mutationFn: api.disconnectSlack,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['slack'] });
      void qc.invalidateQueries({ queryKey: ['slack-link'] });
    },
    onError: fail,
  });
  const copyManifest = async () => {
    if (await copyText(slackManifest(t('slack.appName')))) toast.success(t('slack.manifestCopied'));
    else toast.error(t('message.copyFailed'));
  };

  const botPicker = (value: string, onChange: (v: string) => void) => (
    <Select value={value} onValueChange={onChange}>
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
  );

  return (
    <Card title={t('slack.title')}>
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
          <span className="text-sm">
            {status.connected
              ? t('slack.connectedTo', { workspace: status.workspace?.name ?? '' })
              : t('slack.off')}
          </span>
          {status.botUser && <span className="text-xs text-muted-foreground">@{status.botUser}</span>}
        </div>
        {status.error && (
          <p className="text-sm text-destructive">{t('slack.error', { error: status.error })}</p>
        )}
        {status.optionalMissing.length > 0 && (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            {t('slack.optionalMissing', { scopes: status.optionalMissing.join(', ') })}
          </p>
        )}
        <p className="text-sm text-muted-foreground">{t('slack.about')}</p>

        {!status.connected && (
          <div className="space-y-4">
            <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
              <li>
                {t('slack.step1')}{' '}
                <a href={NEW_APP} target="_blank" rel="noreferrer" className="text-primary underline">
                  {t('slack.step1Link')}
                </a>
              </li>
              <li>{t('slack.step2')}</li>
              <li>{t('slack.step3')}</li>
            </ol>
            <Button
              type="button"
              variant="secondary"
              className="rounded-full"
              onClick={() => void copyManifest()}
            >
              {t('slack.copyManifest')}
            </Button>
            <label className="block space-y-1">
              <span className="text-sm font-medium">{t('slack.appToken')}</span>
              <Input
                value={appToken}
                onChange={(e) => setAppToken(e.target.value)}
                placeholder={t('slack.appTokenPlaceholder')}
                autoComplete="off"
                className="rounded-xl"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium">{t('slack.botToken')}</span>
              <Input
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder={t('slack.botTokenPlaceholder')}
                autoComplete="off"
                className="rounded-xl"
              />
            </label>
          </div>
        )}

        <label className="block space-y-1">
          <span className="text-sm font-medium">{t('slack.defaultBot')}</span>
          {botPicker(botId, (v) => {
            setBotId(v);
            if (status.connected) update.mutate(v === NONE ? null : v);
          })}
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
                    <span className="text-muted-foreground">{p.slackName}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{t('slack.nobodyLinked')}</p>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {!status.connected && (
            <Button
              type="button"
              className="rounded-full"
              disabled={!appToken.trim() || !botToken.trim() || connect.isPending}
              onClick={() => connect.mutate()}
            >
              {t('slack.connect')}
            </Button>
          )}
          {status.connected && (
            <Button
              type="button"
              variant="ghost"
              className="rounded-full text-muted-foreground"
              disabled={disconnect.isPending}
              onClick={() => window.confirm(t('slack.disconnectConfirm')) && disconnect.mutate()}
            >
              {t('slack.disconnect')}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

/** One person's Slack account: linked with a code they send the server's Slack app. */
export function SlackLinkCard() {
  const t = useT();
  const qc = useQueryClient();
  const { data: link } = useQuery({ queryKey: ['slack-link'], queryFn: api.slackLink });
  const put = (l: Awaited<ReturnType<typeof api.slackLink>>) => qc.setQueryData(['slack-link'], l);
  const code = useMutation({
    mutationFn: api.slackCode,
    onSuccess: put,
    onError: (e) => toast.error(e.message),
  });
  const unlink = useMutation({
    mutationFn: api.slackUnlink,
    onSuccess: put,
    onError: (e) => toast.error(e.message),
  });
  if (!link?.available) return null;
  const command = link.code ? `link ${link.code}` : '';
  return (
    <Card title={t('slack.mine')}>
      <div className="space-y-3 px-4 py-4">
        {link.linked ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm">{t('slack.linkedAs', { name: link.linked.name })}</span>
            <Button
              type="button"
              variant="ghost"
              className="rounded-full text-muted-foreground"
              disabled={unlink.isPending}
              onClick={() => unlink.mutate()}
            >
              {t('slack.unlink')}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('slack.notLinked', { workspace: link.workspace ?? '' })}
          </p>
        )}
        <p className="text-xs text-muted-foreground">{t('slack.howItWorks')}</p>
        {command && (
          <div className="space-y-1 rounded-2xl bg-secondary/60 p-4">
            <p className="text-sm">{t('slack.sendCode')}</p>
            <button
              type="button"
              className="font-mono text-lg"
              onClick={() =>
                void copyText(command).then((ok) =>
                  ok ? toast.success(t('slack.codeCopied')) : toast.error(t('message.copyFailed')),
                )
              }
            >
              {command}
            </button>
          </div>
        )}
        {!link.linked && (
          <Button
            type="button"
            variant="secondary"
            className="rounded-full"
            disabled={code.isPending}
            onClick={() => code.mutate()}
          >
            {t(command ? 'slack.newCode' : 'slack.getCode')}
          </Button>
        )}
      </div>
    </Card>
  );
}
