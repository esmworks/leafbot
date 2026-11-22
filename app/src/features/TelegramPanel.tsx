import type { TelegramStatus } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Send } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/i18n';
import { api } from '@/lib/api';

/**
 * A bot's own Telegram bot: the token from BotFather, then a pairing link the person opens on the
 * phone; after that, only that Telegram account can talk to the bot.
 */
export function TelegramPanel({ botId }: { botId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: status } = useQuery({ queryKey: ['telegram', botId], queryFn: () => api.telegram(botId) });
  const [token, setToken] = useState('');
  const put = (s: TelegramStatus) => qc.setQueryData(['telegram', botId], s);
  const connect = useMutation({
    mutationFn: () => api.connectTelegram(botId, token),
    onSuccess: (s) => {
      put(s);
      setToken('');
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const pair = useMutation({
    mutationFn: () => api.pairTelegram(botId),
    onSuccess: put,
    onError: (e) => toast.error((e as Error).message),
  });
  const notices = useMutation({
    mutationFn: (on: boolean) => api.updateTelegram(botId, { notices: on }),
    onSuccess: put,
    onError: (e) => toast.error((e as Error).message),
  });
  const disconnect = useMutation({
    mutationFn: () => api.disconnectTelegram(botId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['telegram', botId] }),
    onError: (e) => toast.error((e as Error).message),
  });
  if (!status) return null;
  const chat = status.bot ? `https://t.me/${status.bot.username}` : null;

  return (
    <div className="space-y-3 rounded-2xl bg-secondary/60 px-4 py-3">
      <div className="flex items-center gap-2">
        <Send className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">{t('telegram.title')}</span>
        <span className="ms-auto text-xs text-muted-foreground">
          {status.owner ? t('telegram.paired') : status.connected ? t('telegram.waiting') : t('telegram.off')}
        </span>
      </div>
      {status.error && (
        <p className="text-xs text-destructive">{t('telegram.error', { error: status.error })}</p>
      )}

      {!status.connected && (
        <div className="space-y-2">
          <ol className="list-decimal space-y-1 ps-5 text-xs text-muted-foreground">
            <li>
              {t('telegram.step1')}{' '}
              <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="underline">
                {t('telegram.botFather')}
              </a>
            </li>
            <li>{t('telegram.step2')}</li>
          </ol>
          <div className="flex gap-2">
            <Input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t('telegram.tokenPlaceholder')}
              className="rounded-xl"
            />
            <Button
              type="button"
              className="rounded-full"
              disabled={!token.trim() || connect.isPending}
              onClick={() => connect.mutate()}
            >
              {t('telegram.connect')}
            </Button>
          </div>
        </div>
      )}

      {status.connected && status.bot && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {status.owner
              ? t('telegram.pairedWith', { bot: status.bot.username, name: status.owner.name })
              : t('telegram.connected', { bot: status.bot.username })}
          </p>
          {status.pairLink && (
            <div className="flex flex-wrap items-center gap-4">
              {status.pairQr && (
                <img
                  src={status.pairQr}
                  alt={t('telegram.qrAlt')}
                  className="size-36 rounded-xl bg-white p-1"
                />
              )}
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-xs text-muted-foreground">{t('telegram.pairHint')}</p>
                <Button asChild type="button" variant="secondary" className="rounded-full">
                  <a href={status.pairLink} target="_blank" rel="noreferrer">
                    <ExternalLink /> {t('telegram.openToPair')}
                  </a>
                </Button>
              </div>
            </div>
          )}
          {!status.pairLink && !status.owner && (
            <Button type="button" variant="secondary" className="rounded-full" onClick={() => pair.mutate()}>
              {t('telegram.newLink')}
            </Button>
          )}
          {status.owner && (
            <label className="flex items-center justify-between gap-4">
              <span>
                <span className="block text-sm">{t('telegram.notices')}</span>
                <span className="block text-xs text-muted-foreground">{t('telegram.noticesHint')}</span>
              </span>
              <Switch checked={status.notices} onCheckedChange={(on) => notices.mutate(on)} />
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            {status.owner && chat && (
              <Button asChild type="button" variant="secondary" className="rounded-full">
                <a href={chat} target="_blank" rel="noreferrer">
                  <ExternalLink /> {t('telegram.openChat')}
                </a>
              </Button>
            )}
            {status.owner && !status.pairLink && (
              <Button type="button" variant="ghost" className="rounded-full" onClick={() => pair.mutate()}>
                {t('telegram.otherAccount')}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              className="rounded-full text-muted-foreground"
              disabled={disconnect.isPending}
              onClick={() => window.confirm(t('telegram.disconnectConfirm')) && disconnect.mutate()}
            >
              {t('telegram.disconnect')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
