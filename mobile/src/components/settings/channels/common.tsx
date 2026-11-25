import type { Bot } from '@leafbot/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { Linking } from 'react-native';
import { toast, toastError } from '@/components/overlay';
import { Row, Section, type IconName } from '@/components/page';
import { ChoiceRow, Rows, Status } from '@/components/settings/common/controls';
import { t, type MessageKey } from '@/i18n';
import { useBots } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';

/** The chat apps, in the order the list shows them. */
export const CHANNELS = ['whatsapp', 'slack', 'teams', 'discord', 'telegram', 'email'] as const;
export type Channel = (typeof CHANNELS)[number];

/** The name each chat app goes by; product names from the catalog. */
export const NAME_KEYS: Record<Channel, MessageKey> = {
  whatsapp: 'whatsapp.title',
  slack: 'slack.title',
  teams: 'teams.title',
  discord: 'discord.title',
  telegram: 'channels.telegram',
  email: 'email.title',
};

export const ICONS: Record<Channel, IconName> = {
  whatsapp: 'message-circle',
  slack: 'hash',
  teams: 'users',
  discord: 'message-square',
  telegram: 'send',
  email: 'mail',
};

/** `off`: not set up. `pending`: on its way, such as a link waiting for its code to be scanned. */
export type Health = 'ok' | 'unknown' | 'off' | 'pending' | 'error';

/** What one chat app shows in the list and at the top of its page. */
export interface Summary {
  health: Health;
  /** A few words: the account, who answers, how many are linked. */
  detail: (string | null | undefined | false)[];
}

export const healthLabel = (health: Health) => t(`settings.status.${health}`);

/** Whether a chat app works, as a mark and a word. */
export function HealthStatus({ health }: { health: Health }) {
  return (
    <Status
      state={health === 'ok' ? 'ok' : health === 'error' ? 'problem' : 'unknown'}
      label={healthLabel(health)}
    />
  );
}

/** The bots that are not archived. */
export function useLiveBots(): Bot[] {
  const { data: bots = [] } = useBots();
  return bots.filter((b) => !b.archivedAt);
}

/** Whether each chat app works and a few words about it, from what the server says of each. */
export function useSummaries(): Partial<Record<Channel, Summary>> {
  const api = useApi();
  const { origin } = useServer();
  const { data: bots = [] } = useBots();
  const live = bots.filter((b) => !b.archivedAt);
  const answers = (id: string | null | undefined) => {
    const name = bots.find((b) => b.id === id)?.name;
    return name ? t('channels.answers', { bot: name }) : null;
  };
  const { data: wa } = useQuery({ queryKey: ['whatsapp', origin], queryFn: api.whatsapp });
  const { data: slack } = useQuery({ queryKey: ['slack', origin], queryFn: api.slack });
  const { data: teams } = useQuery({ queryKey: ['teams', origin], queryFn: api.teams });
  const { data: discord } = useQuery({ queryKey: ['discord', origin], queryFn: api.discord });
  const { data: email } = useQuery({ queryKey: ['email', origin], queryFn: api.emailSettings });
  const telegram = useQueries({
    queries: live.map((b) => ({
      queryKey: ['telegram', origin, b.id],
      queryFn: () => api.telegram(b.id),
    })),
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

/** The top of a chat app's page: its name over whether it works and a few words about it. */
export function PageHead({ id, summary }: { id: Channel; summary?: Summary }) {
  return (
    <Section title={t(NAME_KEYS[id])}>
      <Rows>
        <Row
          icon={ICONS[id]}
          label={summary ? healthLabel(summary.health) : t(NAME_KEYS[id])}
          detail={summary?.detail.filter(Boolean).join(' · ') || null}
          chevron={false}
        />
      </Rows>
    </Section>
  );
}

/** A value for "no bot" in a choice, which cannot hold an empty one. */
export const NONE = '__none';

/** Which bot answers: one of the live bots, or none when `noneLabel` is given. */
export function BotChoice({
  label,
  detail,
  value,
  onChange,
  noneLabel,
  placeholder,
}: {
  label: string;
  detail?: string | null;
  value: string;
  onChange: (id: string) => void;
  noneLabel?: string;
  placeholder?: string;
}) {
  const live = useLiveBots();
  const options = live.map((b) => ({ value: b.id, label: b.name }));
  return (
    <ChoiceRow
      label={label}
      detail={detail}
      value={value}
      placeholder={placeholder}
      options={noneLabel ? [{ value: NONE, label: noneLabel }, ...options] : options}
      onChange={onChange}
    />
  );
}

/** Puts text on the clipboard and says so. */
export async function copy(text: string, done: MessageKey) {
  try {
    await Clipboard.setStringAsync(text);
    toast(t(done));
  } catch {
    toast(t('message.copyFailed'), { tone: 'error' });
  }
}

/** Opens a web address in the phone's browser. */
export function openUrl(url: string) {
  void Linking.openURL(url).catch(toastError);
}
