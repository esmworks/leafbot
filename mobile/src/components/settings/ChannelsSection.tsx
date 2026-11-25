import { useState } from 'react';
import { Row, Section } from '@/components/page';
import { Rows } from '@/components/settings/common/controls';
import { useSectionBack } from '@/components/settings/common/sectionBack';
import { DiscordPage } from '@/components/settings/channels/DiscordPage';
import { EmailPage } from '@/components/settings/channels/EmailPage';
import { SlackPage } from '@/components/settings/channels/SlackPage';
import { TeamsPage } from '@/components/settings/channels/TeamsPage';
import { TelegramPage } from '@/components/settings/channels/TelegramPage';
import { WhatsAppPage } from '@/components/settings/channels/WhatsAppPage';
import {
  CHANNELS,
  HealthStatus,
  ICONS,
  NAME_KEYS,
  useSummaries,
  type Channel,
} from '@/components/settings/channels/common';
import { t } from '@/i18n';

/** The chat app whose page is open, and for Telegram the bot whose settings are open in it. */
interface View {
  id: Channel;
  telegramBot: string | null;
}

/**
 * The "chat apps" settings section: each chat app on one line with whether it works and which bot
 * answers there, opening to its own page. The title bar's Back closes a page, or a bot's Telegram
 * settings, before it leaves the section.
 */
export function ChannelsSection() {
  const [view, setView] = useState<View | null>(null);
  const summaries = useSummaries();
  useSectionBack(!!view, () => setView((v) => (v?.telegramBot ? { ...v, telegramBot: null } : null)));

  if (view) {
    const summary = summaries[view.id];
    return (
      <>
        {view.id === 'whatsapp' && <WhatsAppPage summary={summary} />}
        {view.id === 'slack' && <SlackPage summary={summary} />}
        {view.id === 'teams' && <TeamsPage summary={summary} />}
        {view.id === 'discord' && <DiscordPage summary={summary} />}
        {view.id === 'telegram' && (
          <TelegramPage
            summary={summary}
            open={view.telegramBot}
            onOpen={(botId) => setView({ id: 'telegram', telegramBot: botId })}
          />
        )}
        {view.id === 'email' && <EmailPage summary={summary} />}
      </>
    );
  }
  return (
    <Section>
      <Rows>
        {CHANNELS.map((id) => {
          const s = summaries[id];
          return (
            <Row
              key={id}
              icon={ICONS[id]}
              label={t(NAME_KEYS[id])}
              detail={s?.detail.filter(Boolean).join(' · ') || null}
              detailLines={2}
              right={s ? <HealthStatus health={s.health} /> : null}
              onPress={() => setView({ id, telegramBot: null })}
            />
          );
        })}
      </Rows>
    </Section>
  );
}
