import type {
  Bot,
  WhatsAppDoor,
  WhatsAppMode,
  WhatsAppReplyMode,
  WhatsAppRoute,
  WhatsAppStatus,
} from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { FormField, TextBox } from '@/components/dialogs/common';
import { newBotEngine } from '@/components/dialogs/model';
import { confirm, toast, toastError } from '@/components/overlay';
import { Note, PillButton, Row, Section, Segments, Sheet, SwitchRow } from '@/components/page';
import { ChoiceRow, Hint, Pad, Rows } from '@/components/settings/common/controls';
import { t, type MessageKey } from '@/i18n';
import { nav } from '@/lib/nav';
import { useBots, useSettings } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';
import { BotChoice, NONE, PageHead, type Summary } from './common';

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

/**
 * Whether a bot is set up the way the front door should be: it reads only, has no internet,
 * memory or project folder. The door keeps its tools off by itself; what the bot's instructions
 * and memory hold, anyone who writes can ask about.
 */
const lockedDown = (b: Bot) => b.permissionMode === 'readonly' && !b.internet && !b.memory && !b.projectDir;

type Route = WhatsAppRoute & { name: string };

/** WhatsApp, in the parts the web shows: the connection, which bot answers, what the bots may do. */
export function WhatsAppPage({ summary }: { summary?: Summary }) {
  const api = useApi();
  const { origin } = useServer();
  const { data: status } = useQuery({ queryKey: ['whatsapp', origin], queryFn: api.whatsapp });
  const { data: bots } = useBots();
  return (
    <>
      <PageHead id="whatsapp" summary={summary} />
      {status && bots ? (
        // The form starts again from what is saved whenever that changes (saved, or disconnected).
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
      ) : null}
    </>
  );
}

/** How a bot answers a chat: not at all, on a card, or at once. */
function ReplyChoice({
  value,
  onChange,
  cardsOnly = false,
}: {
  value: WhatsAppReplyMode;
  onChange: (m: WhatsAppReplyMode) => void;
  /** Answers always wait on a card: no automatic sending to offer. */
  cardsOnly?: boolean;
}) {
  const modes = cardsOnly ? (['off', 'draft'] as const) : (['off', 'draft', 'auto'] as const);
  return (
    <ChoiceRow
      label={t('whatsapp.reply')}
      value={cardsOnly && value === 'auto' ? 'draft' : value}
      options={modes.map((m) => ({ value: m, label: t(`whatsapp.reply.${m}`) }))}
      onChange={onChange}
    />
  );
}

function WhatsAppForm({ status, bots }: { status: WhatsAppStatus; bots: Bot[] }) {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const c = useColors();
  const live = bots.filter((b) => !b.archivedAt);
  const [mode, setMode] = useState<WhatsAppMode>(status.mode ?? 'separate');
  const [phone, setPhone] = useState(status.phone ?? '');
  const [botId, setBotId] = useState(status.botId ?? live.find((b) => b.isManager)?.id ?? live[0]?.id ?? '');
  const [notices, setNotices] = useState(status.notices);
  const [chats, setChats] = useState(status.chats);
  const [autoSend, setAutoSend] = useState(status.autoSend);
  const [door, setDoor] = useState<WhatsAppDoor | null>(status.door);
  const [routes, setRoutes] = useState<Route[]>(status.routes);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const state = status.state;
  const connected = state === 'connected';
  const { data: groups } = useQuery({
    queryKey: ['whatsapp-groups', origin],
    queryFn: api.whatsappGroups,
    enabled: connected,
  });
  const { data: settings } = useSettings();
  const put = (s: WhatsAppStatus) => qc.setQueryData(['whatsapp', origin], s);
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
        ...newBotEngine(settings),
      });
      const made = { botId: bot.id, mode: 'draft' as const };
      setDoor(made);
      return { bot, status: await api.setWhatsapp({ ...form(), door: made }) };
    },
    onSuccess: ({ bot, status: s }) => {
      void qc.invalidateQueries({ queryKey: ['bots', origin] });
      put(s);
      toast(t('whatsapp.doorBot.created'));
      nav.botEdit(bot.id);
    },
    onError: toastError,
  });
  const save = useMutation({
    mutationFn: () => api.setWhatsapp(form()),
    onSuccess: (s) => {
      put(s);
      toast(t('whatsapp.saved'));
    },
    onError: toastError,
  });
  const link = useMutation({
    mutationFn: async () => {
      // What is in the form is what the new link is for.
      await api.setWhatsapp(form());
      return api.linkWhatsapp();
    },
    onSuccess: put,
    onError: toastError,
  });
  const disconnect = useMutation({ mutationFn: api.disconnectWhatsapp, onSuccess: put, onError: toastError });
  const error = status.error ? (ERRORS[status.error] ? t(ERRORS[status.error]!) : status.error) : null;
  const addable = (groups ?? []).filter((g) => !routes.some((r) => r.chat === g.id));

  return (
    <>
      <Section title={t('whatsapp.section.connection')}>
        <Rows>
          <Row
            label={t(`whatsapp.state.${state}`)}
            value={status.linked ? `+${status.linked}` : null}
            chevron={false}
          />
          {state === 'linking' ? (
            <Pad>
              {status.qr ? (
                <Image
                  source={{ uri: status.qr }}
                  style={styles.qr}
                  accessibilityLabel={t('whatsapp.qrAlt')}
                />
              ) : (
                <Hint>{t('whatsapp.qrWaiting')}</Hint>
              )}
              <Hint>{t('whatsapp.scan')}</Hint>
            </Pad>
          ) : null}
          {connected ? (
            <Pad>
              <Hint>{t(`whatsapp.howTo.${status.mode ?? mode}`, { number: status.linked ?? '' })}</Hint>
            </Pad>
          ) : null}
          <Pad>
            <Segments
              options={(['separate', 'own'] as const).map((m) => ({
                value: m,
                label: t(`whatsapp.mode.${m}`),
              }))}
              value={mode}
              onChange={setMode}
            />
            <Hint>{t(`whatsapp.modeHint.${mode}`)}</Hint>
            <FormField label={t(`whatsapp.phone.${mode}`)} hint={t(`whatsapp.phoneHint.${mode}`)}>
              <TextBox
                value={phone}
                onChangeText={setPhone}
                keyboardType="phone-pad"
                placeholder="905321234567"
              />
            </FormField>
            {state === 'off' || state === 'error' ? (
              <PillButton
                label={t(state === 'error' ? 'whatsapp.relink' : 'whatsapp.link')}
                variant="primary"
                onPress={() => link.mutate()}
                busy={link.isPending}
                disabled={!phone.trim()}
              />
            ) : null}
          </Pad>
          {state !== 'off' ? (
            <Row
              label={t('whatsapp.disconnect')}
              destructive
              chevron={false}
              busy={disconnect.isPending}
              onPress={() =>
                void confirm({
                  title: t('whatsapp.disconnectConfirm'),
                  destructive: true,
                  confirmLabel: t('whatsapp.disconnect'),
                }).then((ok) => ok && disconnect.mutate())
              }
            />
          ) : null}
        </Rows>
        {error ? <Note tone="error">{error}</Note> : null}
      </Section>

      <Section title={t('whatsapp.section.bots')}>
        <Rows>
          <BotChoice
            label={t('whatsapp.bot')}
            detail={t('whatsapp.botHint')}
            value={botId}
            placeholder={t('whatsapp.botPick')}
            onChange={setBotId}
          />
          <ChoiceRow
            label={t('whatsapp.door')}
            detail={t('whatsapp.doorHint')}
            value={door?.botId ?? NONE}
            options={[
              { value: NONE, label: t('whatsapp.doorNone') },
              ...live.map((b) => ({ value: b.id, label: b.name })),
            ]}
            onChange={(v) => setDoor(v === NONE ? null : { botId: v, mode: door?.mode ?? 'draft' })}
          />
          {door ? (
            <ReplyChoice
              value={door.mode}
              onChange={(m) => setDoor({ ...door, mode: m })}
              cardsOnly={mode === 'own'}
            />
          ) : null}
          <Pad>
            {mode === 'own' ? <Hint>{t('whatsapp.doorOwn')}</Hint> : null}
            {doorBot && !lockedDown(doorBot) ? <Note tone="error">{t('whatsapp.doorBot.loose')}</Note> : null}
            <Hint>{t('whatsapp.doorRisk')}</Hint>
            {!doorBot ? (
              <PillButton
                label={t('whatsapp.doorBot.create')}
                onPress={() => makeDoor.mutate()}
                busy={makeDoor.isPending}
              />
            ) : null}
          </Pad>
        </Rows>
      </Section>

      <Section title={t('whatsapp.routes')} footer={t('whatsapp.routesHint')}>
        <Rows>
          {routes.map((r, i) => (
            <Rows key={i}>
              <Pad gap={8}>
                {r.chat.includes('@') ? (
                  <Text style={[styles.group, { color: c.foreground }]} numberOfLines={2}>
                    {groupName(r.chat) || r.name || t('whatsapp.routeGroup')}
                  </Text>
                ) : (
                  <TextBox
                    value={r.chat}
                    onChangeText={(v) => setRoute(i, { chat: v })}
                    keyboardType="phone-pad"
                    placeholder="905321234567"
                    accessibilityLabel={t('whatsapp.routeNumber')}
                  />
                )}
              </Pad>
              <BotChoice
                label={t('whatsapp.bot')}
                value={r.botId}
                placeholder={t('whatsapp.botPick')}
                onChange={(v) => setRoute(i, { botId: v })}
              />
              <ReplyChoice value={r.mode} onChange={(m) => setRoute(i, { mode: m })} />
              <Row
                label={t('whatsapp.routeRemove')}
                destructive
                chevron={false}
                onPress={() => setRoutes((all) => all.filter((_, j) => j !== i))}
              />
            </Rows>
          ))}
          <Row
            icon="plus"
            label={t('whatsapp.routeAdd')}
            chevron={false}
            onPress={() => setRoutes((all) => [...all, { chat: '', botId: '', mode: 'draft', name: '' }])}
          />
          {connected && addable.length ? (
            <Row icon="users" label={t('whatsapp.routeGroupAdd')} onPress={() => setGroupsOpen(true)} />
          ) : null}
        </Rows>
      </Section>
      <Sheet
        open={groupsOpen}
        onClose={() => setGroupsOpen(false)}
        title={t('whatsapp.routeGroupAdd')}
        items={addable.map((g) => ({
          label: g.name,
          onPress: () => setRoutes((all) => [...all, { chat: g.id, botId: '', mode: 'draft', name: g.name }]),
        }))}
      />

      <Section title={t('whatsapp.section.allow')} footer={t('whatsapp.risk')}>
        <Rows>
          <SwitchRow
            label={t('whatsapp.notices')}
            detail={t('whatsapp.noticesHint')}
            value={notices}
            onChange={setNotices}
          />
          <SwitchRow
            label={t('whatsapp.chats')}
            detail={t('whatsapp.chatsHint')}
            value={chats}
            onChange={setChats}
          />
          <SwitchRow
            label={t('whatsapp.autoSend')}
            detail={t('whatsapp.autoSendHint')}
            value={autoSend}
            onChange={setAutoSend}
          />
        </Rows>
      </Section>
      {state !== 'off' ? (
        <Pad>
          <PillButton
            label={t('common.save')}
            variant="primary"
            onPress={() => save.mutate()}
            busy={save.isPending}
          />
        </Pad>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  qr: { width: 240, height: 240, alignSelf: 'center', borderRadius: 12, backgroundColor: '#fff' },
  group: { fontSize: 17 },
});
