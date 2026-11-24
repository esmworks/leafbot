import type {
  Bot,
  WhatsAppDoor,
  WhatsAppMode,
  WhatsAppReplyMode,
  WhatsAppRoute,
  WhatsAppStatus,
} from '@leafbot/shared';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
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
import { BotAvatar } from '@/components/BotAvatar';
import { ListRow, Mark, PageHead, Status, type Health } from './SettingsList';
import { Card, Row } from './SettingsPage';
import { TelegramPanel } from './TelegramPanel';
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
  keysUnreadable: 'whatsapp.error.keysUnreadable',
};

/** The chat apps, in the order the list shows them. */
const CHANNELS = ['whatsapp', 'slack', 'teams', 'discord', 'telegram', 'email'] as const;
type Channel = (typeof CHANNELS)[number];
const isChannel = (id: string | null): id is Channel => CHANNELS.includes(id as Channel);

/** Opens one chat app's page, or the list with null. */
const show = (id: Channel | null) => useUi.setState({ settingsView: id });

/** The name each chat app goes by; product names from the catalog. */
const NAME_KEYS: Record<Channel, MessageKey> = {
  whatsapp: 'whatsapp.title',
  slack: 'slack.title',
  teams: 'teams.title',
  discord: 'discord.title',
  telegram: 'channels.telegram',
  email: 'email.title',
};

/** The name the settings title shows for the chat app page that is open. */
export function useChannelTitle(id: string | null): string | null {
  const t = useT();
  return isChannel(id) ? t(NAME_KEYS[id]) : null;
}

/**
 * Chat apps: one line each, with whether it works and which bot answers there, opening to its own
 * page. The server's WhatsApp, Slack, Teams, Discord and mail are set up there; each bot's
 * Telegram is listed bot by bot.
 */
export function ChannelsTab() {
  const view = useUi((s) => s.settingsView);
  if (isChannel(view)) return <ChannelPage id={view} />;
  return <ChannelList />;
}

/** What one chat app shows in the list and at the top of its page. */
interface Summary {
  health: Health;
  /** A few words: the account, who answers, how many are linked. */
  detail: (string | null | undefined | false)[];
}

/** Whether each chat app works and a few words about it, from what the server says of each. */
function useSummaries(): Partial<Record<Channel, Summary>> {
  const t = useT();
  const { data: bots = [] } = useBots();
  const live = bots.filter((b) => !b.archivedAt);
  const botName = (id: string | null | undefined) => bots.find((b) => b.id === id)?.name;
  const answers = (id: string | null | undefined) => {
    const name = botName(id);
    return name ? t('channels.answers', { bot: name }) : null;
  };
  const { data: wa } = useQuery({ queryKey: ['whatsapp'], queryFn: api.whatsapp });
  const { data: slack } = useQuery({ queryKey: ['slack'], queryFn: api.slack });
  const { data: teams } = useQuery({ queryKey: ['teams'], queryFn: api.teams });
  const { data: discord } = useQuery({ queryKey: ['discord'], queryFn: api.discord });
  const { data: email } = useQuery({ queryKey: ['email'], queryFn: api.emailSettings });
  const telegram = useQueries({
    queries: live.map((b) => ({ queryKey: ['telegram', b.id], queryFn: () => api.telegram(b.id) })),
  });
  const linked = (connected: boolean, error: string | null): Health =>
    error ? 'error' : connected ? 'ok' : 'off';
  const out: Partial<Record<Channel, Summary>> = {};
  if (wa)
    out.whatsapp = {
      health:
        wa.state === 'connected'
          ? 'ok'
          : wa.state === 'error'
            ? 'error'
            : wa.state === 'off'
              ? 'off'
              : 'pending',
      detail:
        wa.state === 'off' ? [t('channels.how.whatsapp')] : [wa.linked && `+${wa.linked}`, answers(wa.botId)],
    };
  if (slack)
    out.slack = {
      health: linked(slack.connected, slack.error),
      detail: slack.connected ? [slack.workspace?.name, answers(slack.botId)] : [t('channels.how.slack')],
    };
  if (teams)
    out.teams = {
      health: linked(teams.connected, teams.error),
      detail: teams.connected ? [answers(teams.botId)] : [t('channels.how.teams')],
    };
  if (discord)
    out.discord = {
      health: linked(discord.connected, discord.error),
      detail: discord.connected
        ? [
            discord.botUser && `@${discord.botUser}`,
            t('channels.servers', { count: discord.servers.length }),
            answers(discord.botId),
          ]
        : [t('channels.how.discord')],
    };
  const onTelegram = telegram.filter((q) => q.data?.connected).length;
  const telegramError = telegram.some((q) => q.data?.error);
  out.telegram = {
    health: telegramError ? 'error' : onTelegram ? 'ok' : 'off',
    detail: [onTelegram ? t('channels.telegramBots', { count: onTelegram }) : t('channels.how.telegram')],
  };
  if (email) {
    const addresses = email.addresses.filter((a) => a.address).length;
    out.email = {
      health: email.domain ? 'ok' : 'off',
      detail: email.domain
        ? [email.domain, t('channels.addresses', { count: addresses })]
        : [t('channels.how.email')],
    };
  }
  return out;
}

function ChannelList() {
  const t = useT();
  const summaries = useSummaries();
  return (
    <div className="mb-6 divide-y rounded-2xl border bg-card/50">
      {CHANNELS.map((id) => {
        const s = summaries[id];
        const name = t(NAME_KEYS[id]);
        return (
          <ListRow
            key={id}
            name={name}
            mark={<Mark name={name} />}
            status={s && <Status health={s.health} />}
            detail={s?.detail ?? []}
            onOpen={() => show(id)}
          />
        );
      })}
    </div>
  );
}

function ChannelPage({ id }: { id: Channel }) {
  const t = useT();
  const s = useSummaries()[id];
  const name = t(NAME_KEYS[id]);
  return (
    <>
      <PageHead
        name={name}
        mark={<Mark name={name} large />}
        status={s && <Status health={s.health} />}
        line={s?.detail.filter(Boolean).join(' · ')}
      />
      {id === 'whatsapp' && <WhatsAppCard />}
      {id === 'slack' && <SlackCard />}
      {id === 'teams' && <TeamsCard />}
      {id === 'discord' && <DiscordCard />}
      {id === 'telegram' && <TelegramBots />}
      {id === 'email' && <EmailCard />}
    </>
  );
}

/**
 * Telegram is set up bot by bot, each with a Telegram bot of its own; the bots are listed here and
 * each opens to its own Telegram settings, the same as in that bot's settings.
 */
function TelegramBots() {
  const t = useT();
  const { data: bots = [] } = useBots();
  const live = bots.filter((b) => !b.archivedAt);
  const [open, setOpen] = useState<string | null>(null);
  const states = useQueries({
    queries: live.map((b) => ({ queryKey: ['telegram', b.id], queryFn: () => api.telegram(b.id) })),
  });
  return (
    <>
      {!live.length && <p className="px-1 text-sm text-muted-foreground">{t('channels.noBots')}</p>}
      <div className={cn('mb-6 divide-y rounded-2xl border bg-card/50', !live.length && 'hidden')}>
        {live.map((b, i) => {
          const st = states[i]?.data;
          return (
            <div key={b.id} className="first:rounded-t-2xl last:rounded-b-2xl">
              <div className="flex items-center gap-3 px-4 py-3">
                <BotAvatar avatar={b.avatar} material={b.material} color={b.color} seed={b.id} size={36} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-sm font-medium">{b.name}</span>
                    {st && <Status health={st.error ? 'error' : st.connected ? 'ok' : 'off'} />}
                  </span>
                  {st?.bot && (
                    <span className="block truncate text-xs text-muted-foreground">
                      @{st.bot.username}
                      {st.owner ? ` · ${st.owner.name}` : ''}
                    </span>
                  )}
                </span>
                <Button
                  size="sm"
                  variant={open === b.id ? 'ghost' : 'secondary'}
                  className="rounded-full"
                  onClick={() => setOpen(open === b.id ? null : b.id)}
                >
                  {open === b.id
                    ? t('common.close')
                    : st?.connected
                      ? t('channels.manage')
                      : t('channels.connect')}
                </Button>
              </div>
              {open === b.id && (
                <div className="px-4 pb-4">
                  <TelegramPanel botId={b.id} />
                </div>
              )}
            </div>
          );
        })}
      </div>
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
  const openBotPage = useUi((s) => s.openBotPage);
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
      openBotPage({ mode: 'edit', botId: bot.id });
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

  const botSelect = (value: string, onChange: (v: string) => void, className: string, label: string) => (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={className} aria-label={label}>
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
  );

  return (
    <>
      <Card title={t('whatsapp.section.connection')}>
        <div className="space-y-4 px-4 py-4">
          {error && <p className="text-sm text-destructive">{error}</p>}
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
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
            {(['separate', 'own'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => setMode(m)}
                className={cn(
                  'rounded-2xl border px-4 py-3 text-start transition-colors hover:bg-accent',
                  mode === m && 'border-[var(--brand)]/60 bg-[var(--brand)]/10 hover:bg-[var(--brand)]/15',
                )}
              >
                <span className="block text-sm font-medium">{t(`whatsapp.mode.${m}`)}</span>
                <span className="block text-xs text-muted-foreground">{t(`whatsapp.modeHint.${m}`)}</span>
              </button>
            ))}
          </div>
          <label className="block space-y-1">
            <span className="text-sm">{t(`whatsapp.phone.${mode}`)}</span>
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              inputMode="tel"
              placeholder="905321234567"
              className="rounded-full"
            />
            <span className="block text-xs text-muted-foreground">{t(`whatsapp.phoneHint.${mode}`)}</span>
          </label>
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

      <Card title={t('whatsapp.section.bots')}>
        <Row label={t('whatsapp.bot')} hint={t('whatsapp.botHint')}>
          {botSelect(botId, setBotId, 'w-56 rounded-full', t('whatsapp.bot'))}
        </Row>
        <div className="space-y-2 px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="min-w-40 flex-1">
              <div className="text-sm">{t('whatsapp.door')}</div>
              <div className="text-xs text-muted-foreground">{t('whatsapp.doorHint')}</div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Select
                value={door?.botId ?? NONE}
                onValueChange={(v) => setDoor(v === NONE ? null : { botId: v, mode: door?.mode ?? 'draft' })}
              >
                <SelectTrigger className="w-56 rounded-full" aria-label={t('whatsapp.door')}>
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
          </div>
          {mode === 'own' && <p className="text-xs text-muted-foreground">{t('whatsapp.doorOwn')}</p>}
          {doorBot && !lockedDown(doorBot) && (
            <p className="text-xs text-destructive">{t('whatsapp.doorBot.loose')}</p>
          )}
          <p className="text-xs text-muted-foreground">{t('whatsapp.doorRisk')}</p>
          {!doorBot && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="rounded-full"
              disabled={makeDoor.isPending}
              onClick={() => makeDoor.mutate()}
            >
              {t('whatsapp.doorBot.create')}
            </Button>
          )}
        </div>
        <div className="space-y-2 px-4 py-3">
          <div className="text-sm">{t('whatsapp.routes')}</div>
          <div className="text-xs text-muted-foreground">{t('whatsapp.routesHint')}</div>
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
                  className="min-w-0 flex-1 rounded-full"
                />
              )}
              {botSelect(r.botId, (v) => setRoute(i, { botId: v }), 'w-40 rounded-full', t('whatsapp.bot'))}
              <ReplyModeSelect value={r.mode} onChange={(m) => setRoute(i, { mode: m })} />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="rounded-full text-muted-foreground"
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
              size="sm"
              className="rounded-full"
              onClick={() => setRoutes((all) => [...all, { chat: '', botId: '', mode: 'draft', name: '' }])}
            >
              <Plus /> {t('whatsapp.routeAdd')}
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
                <SelectTrigger className="h-8 w-48 rounded-full">
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
      </Card>

      <Card title={t('whatsapp.section.allow')}>
        <Row label={t('whatsapp.notices')} hint={t('whatsapp.noticesHint')}>
          <Switch checked={notices} onCheckedChange={setNotices} aria-label={t('whatsapp.notices')} />
        </Row>
        <Row label={t('whatsapp.chats')} hint={t('whatsapp.chatsHint')}>
          <Switch checked={chats} onCheckedChange={setChats} aria-label={t('whatsapp.chats')} />
        </Row>
        <Row label={t('whatsapp.autoSend')} hint={t('whatsapp.autoSendHint')}>
          <Switch checked={autoSend} onCheckedChange={setAutoSend} aria-label={t('whatsapp.autoSend')} />
        </Row>
      </Card>

      <p className="mb-4 px-1 text-xs text-muted-foreground">{t('whatsapp.risk')}</p>
      {state !== 'off' && (
        <Button
          type="button"
          className="rounded-full"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          {t('common.save')}
        </Button>
      )}
    </>
  );
}
