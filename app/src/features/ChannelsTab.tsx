import type {
  Bot,
  WhatsAppDoor,
  WhatsAppMode,
  WhatsAppReplyMode,
  WhatsAppRoute,
  WhatsAppStatus,
} from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useT, type MessageKey } from '@/i18n';
import { api } from '@/lib/api';
import { newBotEngine } from '@/lib/new-bot';
import { useBots, useSettings } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Card } from './SettingsPage';
import { EmailCard } from './EmailCard';
import { DiscordCard } from './DiscordCard';
import { SlackCard } from './SlackCards';
import { TeamsCard } from './TeamsCards';

const ERRORS: Record<string, MessageKey> = {
  expired: 'whatsapp.error.expired',
  ownNumber: 'whatsapp.error.ownNumber',
  loggedOut: 'whatsapp.error.loggedOut',
  forbidden: 'whatsapp.error.forbidden',
  mismatch: 'whatsapp.error.mismatch',
  replaced: 'whatsapp.error.replaced',
  unreachable: 'whatsapp.error.unreachable',
  failing: 'whatsapp.error.failing',
};

/**
 * Chat apps: WhatsApp for the chosen bot and the server's Slack app, Teams bot and Discord bot here; each bot's
 * Telegram is in that bot's settings.
 */
export function ChannelsTab() {
  const t = useT();
  return (
    <>
      <WhatsAppCard />
      <SlackCard />
      <TeamsCard />
      <DiscordCard />
      <Card title={t('channels.telegram')}>
        <p className="px-4 py-3 text-sm text-muted-foreground">{t('channels.telegramHint')}</p>
      </Card>
      <EmailCard />
    </>
  );
}

/** A value for "no bot" in a select, which cannot hold an empty one. */
const NONE = '-';

/**
 * Whether a bot is set up the way the front door should be: it reads only, has no internet,
 * memory or project folder. The door keeps its tools off by itself; what the bot's instructions
 * and memory hold, anyone who writes can ask about.
 */
const lockedDown = (b: Bot) => b.permissionMode === 'readonly' && !b.internet && !b.memory && !b.projectDir;

/** How a bot answers a chat: not at all, on a card, or at once. */
function ReplyModeSelect({
  value,
  onChange,
  cardsOnly = false,
}: {
  value: WhatsAppReplyMode;
  onChange: (m: WhatsAppReplyMode) => void;
  /** Answers always wait on a card: no automatic sending to offer. */
  cardsOnly?: boolean;
}) {
  const t = useT();
  const modes = cardsOnly ? (['off', 'draft'] as const) : (['off', 'draft', 'auto'] as const);
  return (
    <Select
      value={cardsOnly && value === 'auto' ? 'draft' : value}
      onValueChange={(v) => onChange(v as WhatsAppReplyMode)}
    >
      <SelectTrigger className="w-36 rounded-xl" aria-label={t('whatsapp.reply')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {modes.map((m) => (
          <SelectItem key={m} value={m}>
            {t(`whatsapp.reply.${m}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function WhatsAppCard() {
  const { data: status } = useQuery({ queryKey: ['whatsapp'], queryFn: api.whatsapp });
  const { data: bots } = useBots();
  if (!status || !bots) return null;
  // The form starts again from what is saved whenever that changes (saved, or disconnected).
  return (
    <WhatsAppForm
      key={JSON.stringify([
        status.mode,
        status.phone,
        status.botId,
        status.chats,
        status.autoSend,
        status.door,
        status.routes,
      ])}
      status={status}
      bots={bots}
    />
  );
}

function WhatsAppForm({ status, bots }: { status: WhatsAppStatus; bots: Bot[] }) {
  const t = useT();
  const qc = useQueryClient();
  const live = bots.filter((b) => !b.archivedAt);
  const [mode, setMode] = useState<WhatsAppMode>(status.mode ?? 'separate');
  const [phone, setPhone] = useState(status.phone ?? '');
  const [botId, setBotId] = useState(status.botId ?? live.find((b) => b.isManager)?.id ?? live[0]?.id ?? '');
  const [notices, setNotices] = useState(status.notices);
  const [chats, setChats] = useState(status.chats);
  const [autoSend, setAutoSend] = useState(status.autoSend);
  const [door, setDoor] = useState<WhatsAppDoor | null>(status.door);
  const [routes, setRoutes] = useState<(WhatsAppRoute & { name: string })[]>(status.routes);
  const connected = status.state === 'connected';
  const { data: groups } = useQuery({
    queryKey: ['whatsapp-groups'],
    queryFn: api.whatsappGroups,
    enabled: connected,
  });
  const form = () => {
    // A number as it is typed, with spaces or a plus, is kept as its digits.
    const given = routes.map(({ name: _name, ...r }) => ({
      ...r,
      chat: r.chat.includes('@') ? r.chat : r.chat.replace(/\D/g, ''),
    }));
    // A row left empty is dropped; one half filled stops the save, not to be lost unseen.
    if (given.some((r) => !r.chat !== !r.botId)) throw new Error(t('whatsapp.routeNoBot'));
    return {
      mode,
      phone,
      botId: botId || null,
      notices,
      chats,
      autoSend,
      door,
      routes: given.filter((r) => r.chat && r.botId),
    };
  };
  const setRoute = (i: number, change: Partial<WhatsAppRoute>) =>
    setRoutes((all) => all.map((r, j) => (j === i ? { ...r, ...change } : r)));
  const groupName = (chat: string) => groups?.find((g) => g.id === chat)?.name;
  const { data: settings } = useSettings();
  const openSettings = useUi((s) => s.openSettings);
  const openBotDialog = useUi((s) => s.openBotDialog);
  const doorBot = door ? live.find((b) => b.id === door.botId) : undefined;
  // A bot made for the front door alone, locked down; the door is saved with it, and its
  // instructions open next, to be filled with what anyone may know.
  const makeDoor = useMutation({
    mutationFn: async () => {
      // The form is saved first, so a number it cannot take stops here and leaves no bot behind
      // that no door points to.
      await api.setWhatsapp(form());
      const bot = await api.createBot({
        name: t('whatsapp.doorBot.name'),
        description: t('whatsapp.doorBot.description'),
        instructions: t('whatsapp.doorBot.instructions'),
        permissionMode: 'readonly',
        internet: false,
        memory: false,
        projectDir: null,
        ...(settings ? newBotEngine(settings) : {}),
      });
      const made = { botId: bot.id, mode: 'draft' as const };
      setDoor(made);
      return { bot, status: await api.setWhatsapp({ ...form(), door: made }) };
    },
    onSuccess: ({ bot, status: s }) => {
      void qc.invalidateQueries({ queryKey: ['bots'] });
      put(s);
      toast.success(t('whatsapp.doorBot.created'));
      openSettings(null);
      openBotDialog({ mode: 'edit', botId: bot.id });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const put = (s: WhatsAppStatus) => qc.setQueryData(['whatsapp'], s);
  const save = useMutation({
    mutationFn: () => api.setWhatsapp(form()),
    onSuccess: (s) => {
      put(s);
      toast.success(t('whatsapp.saved'));
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const link = useMutation({
    mutationFn: async () => {
      // What is in the form is what the new link is for.
      await api.setWhatsapp(form());
      return api.linkWhatsapp();
    },
    onSuccess: put,
    onError: (e) => toast.error((e as Error).message),
  });
  const disconnect = useMutation({
    mutationFn: api.disconnectWhatsapp,
    onSuccess: put,
    onError: (e) => toast.error((e as Error).message),
  });
  const state = status.state;
  const error = status.error ? (ERRORS[status.error] ? t(ERRORS[status.error]!) : status.error) : null;

  return (
    <Card title={t('whatsapp.title')}>
      <div className="space-y-4 px-4 py-4">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'size-2 rounded-full',
              state === 'connected'
                ? 'bg-emerald-500'
                : state === 'error'
                  ? 'bg-destructive'
                  : 'bg-muted-foreground/40',
            )}
          />
          <span className="text-sm">{t(`whatsapp.state.${state}`)}</span>
          {status.linked && <span className="text-xs text-muted-foreground">+{status.linked}</span>}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="grid gap-2 sm:grid-cols-2">
          {(['separate', 'own'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                'rounded-2xl border px-4 py-3 text-left',
                mode === m ? 'border-primary bg-primary/5' : 'bg-card/50',
              )}
            >
              <span className="block text-sm font-medium">{t(`whatsapp.mode.${m}`)}</span>
              <span className="block text-xs text-muted-foreground">{t(`whatsapp.modeHint.${m}`)}</span>
            </button>
          ))}
        </div>
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t(`whatsapp.phone.${mode}`)}</span>
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            inputMode="tel"
            placeholder="905321234567"
            className="rounded-xl"
          />
          <span className="block text-xs text-muted-foreground">{t(`whatsapp.phoneHint.${mode}`)}</span>
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t('whatsapp.bot')}</span>
          <Select value={botId} onValueChange={setBotId}>
            <SelectTrigger className="w-full rounded-xl">
              <SelectValue placeholder={t('whatsapp.botPick')} />
            </SelectTrigger>
            <SelectContent>
              {live.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="block text-xs text-muted-foreground">{t('whatsapp.botHint')}</span>
        </label>
        <label className="flex items-center justify-between gap-4">
          <span>
            <span className="block text-sm">{t('whatsapp.notices')}</span>
            <span className="block text-xs text-muted-foreground">{t('whatsapp.noticesHint')}</span>
          </span>
          <Switch checked={notices} onCheckedChange={setNotices} />
        </label>
        <label className="flex items-center justify-between gap-4">
          <span>
            <span className="block text-sm">{t('whatsapp.chats')}</span>
            <span className="block text-xs text-muted-foreground">{t('whatsapp.chatsHint')}</span>
          </span>
          <Switch checked={chats} onCheckedChange={setChats} />
        </label>
        <label className="flex items-center justify-between gap-4">
          <span>
            <span className="block text-sm">{t('whatsapp.autoSend')}</span>
            <span className="block text-xs text-muted-foreground">{t('whatsapp.autoSendHint')}</span>
          </span>
          <Switch checked={autoSend} onCheckedChange={setAutoSend} />
        </label>

        <div className="space-y-2">
          <span className="block text-sm font-medium">{t('whatsapp.door')}</span>
          <div className="flex flex-wrap gap-2">
            <Select
              value={door?.botId ?? NONE}
              onValueChange={(v) => setDoor(v === NONE ? null : { botId: v, mode: door?.mode ?? 'draft' })}
            >
              <SelectTrigger className="min-w-0 flex-1 rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t('whatsapp.doorNone')}</SelectItem>
                {live.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {door && (
              <ReplyModeSelect
                value={door.mode}
                onChange={(m) => setDoor({ ...door, mode: m })}
                cardsOnly={mode === 'own'}
              />
            )}
          </div>
          {mode === 'own' && (
            <span className="block text-xs text-muted-foreground">{t('whatsapp.doorOwn')}</span>
          )}
          {!doorBot && (
            <Button
              type="button"
              variant="secondary"
              className="rounded-xl"
              disabled={makeDoor.isPending}
              onClick={() => makeDoor.mutate()}
            >
              {t('whatsapp.doorBot.create')}
            </Button>
          )}
          {doorBot && !lockedDown(doorBot) && (
            <p className="text-xs text-destructive">{t('whatsapp.doorBot.loose')}</p>
          )}
          <span className="block text-xs text-muted-foreground">{t('whatsapp.doorHint')}</span>
          <span className="block text-xs text-muted-foreground">{t('whatsapp.doorRisk')}</span>
        </div>

        <div className="space-y-2">
          <span className="block text-sm font-medium">{t('whatsapp.routes')}</span>
          <span className="block text-xs text-muted-foreground">{t('whatsapp.routesHint')}</span>
          {routes.map((r, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              {r.chat.includes('@') ? (
                <span className="min-w-0 flex-1 truncate text-sm">
                  {groupName(r.chat) || r.name || t('whatsapp.routeGroup')}
                </span>
              ) : (
                <Input
                  value={r.chat}
                  onChange={(e) => setRoute(i, { chat: e.target.value })}
                  inputMode="tel"
                  placeholder="905321234567"
                  aria-label={t('whatsapp.routeNumber')}
                  className="min-w-0 flex-1 rounded-xl"
                />
              )}
              <Select value={r.botId} onValueChange={(v) => setRoute(i, { botId: v })}>
                <SelectTrigger className="w-40 rounded-xl">
                  <SelectValue placeholder={t('whatsapp.botPick')} />
                </SelectTrigger>
                <SelectContent>
                  {live.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <ReplyModeSelect value={r.mode} onChange={(m) => setRoute(i, { mode: m })} />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('whatsapp.routeRemove')}
                onClick={() => setRoutes((all) => all.filter((_, j) => j !== i))}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              className="rounded-xl"
              onClick={() => setRoutes((all) => [...all, { chat: '', botId: '', mode: 'draft', name: '' }])}
            >
              {t('whatsapp.routeAdd')}
            </Button>
            {connected && !!groups?.length && (
              <Select
                value=""
                onValueChange={(id) =>
                  setRoutes((all) =>
                    all.some((r) => r.chat === id)
                      ? all
                      : [...all, { chat: id, botId: '', mode: 'draft', name: groupName(id) ?? '' }],
                  )
                }
              >
                <SelectTrigger className="w-48 rounded-xl">
                  <SelectValue placeholder={t('whatsapp.routeGroupAdd')} />
                </SelectTrigger>
                <SelectContent>
                  {groups.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </div>

        {state === 'linking' && (
          <div className="flex flex-wrap items-center gap-4 rounded-2xl bg-secondary/60 p-4">
            {status.qr ? (
              <img src={status.qr} alt={t('whatsapp.qrAlt')} className="size-48 rounded-xl bg-white p-1" />
            ) : (
              <div className="grid size-48 place-items-center rounded-xl bg-card text-xs text-muted-foreground">
                {t('whatsapp.qrWaiting')}
              </div>
            )}
            <p className="min-w-0 flex-1 text-sm text-muted-foreground">{t('whatsapp.scan')}</p>
          </div>
        )}
        {state === 'connected' && (
          <p className="rounded-2xl bg-secondary/60 p-4 text-sm text-muted-foreground">
            {t(`whatsapp.howTo.${status.mode ?? mode}`, { number: status.linked ?? '' })}
          </p>
        )}
        <p className="text-xs text-muted-foreground">{t('whatsapp.risk')}</p>

        <div className="flex flex-wrap gap-2">
          {(state === 'off' || state === 'error') && (
            <Button
              type="button"
              className="rounded-full"
              disabled={!phone.trim() || link.isPending}
              onClick={() => link.mutate()}
            >
              {t(state === 'error' ? 'whatsapp.relink' : 'whatsapp.link')}
            </Button>
          )}
          {state !== 'off' && (
            <Button type="button" variant="secondary" className="rounded-full" onClick={() => save.mutate()}>
              {t('common.save')}
            </Button>
          )}
          {state !== 'off' && (
            <Button
              type="button"
              variant="ghost"
              className="rounded-full text-muted-foreground"
              disabled={disconnect.isPending}
              onClick={() => window.confirm(t('whatsapp.disconnectConfirm')) && disconnect.mutate()}
            >
              {t('whatsapp.disconnect')}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
