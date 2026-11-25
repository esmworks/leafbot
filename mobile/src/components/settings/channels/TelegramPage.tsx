import { useQueries } from '@tanstack/react-query';
import { Empty, Row, Section } from '@/components/page';
import { Lead, Rows } from '@/components/settings/common/controls';
import { TelegramSection } from '@/components/settings/TelegramSection';
import { t } from '@/i18n';
import { useApi, useServer } from '@/lib/server';
import { HealthStatus, PageHead, useLiveBots, type Summary } from './common';

/**
 * Telegram is set up bot by bot, each with a Telegram bot of its own; the bots are listed here and
 * each opens to its own Telegram settings, the same as in that bot's settings. `open` is the bot
 * whose settings are showing, held by the section so its Back arrow returns to this list.
 */
export function TelegramPage({
  summary,
  open,
  onOpen,
}: {
  summary?: Summary;
  open: string | null;
  onOpen: (botId: string) => void;
}) {
  const api = useApi();
  const { origin } = useServer();
  const live = useLiveBots();
  const states = useQueries({
    queries: live.map((b) => ({
      queryKey: ['telegram', origin, b.id],
      queryFn: () => api.telegram(b.id),
    })),
  });
  const opened = live.find((b) => b.id === open);
  if (opened) {
    return (
      <>
        <Lead>{opened.name}</Lead>
        <TelegramSection botId={opened.id} />
      </>
    );
  }
  return (
    <>
      <PageHead id="telegram" summary={summary} />
      {live.length ? (
        <Section>
          <Rows>
            {live.map((b, i) => {
              const st = states[i]?.data;
              const who = st?.bot ? `@${st.bot.username}${st.owner ? ` · ${st.owner.name}` : ''}` : null;
              return (
                <Row
                  key={b.id}
                  label={b.name}
                  detail={who}
                  right={
                    st ? <HealthStatus health={st.error ? 'error' : st.connected ? 'ok' : 'off'} /> : null
                  }
                  onPress={() => onOpen(b.id)}
                />
              );
            })}
          </Rows>
        </Section>
      ) : (
        <Empty text={t('channels.noBots')} />
      )}
    </>
  );
}
