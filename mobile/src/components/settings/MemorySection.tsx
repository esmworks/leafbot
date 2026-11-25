import {
  botNoteGroups,
  MEMORY_REVIEW_STEPS,
  STALE_MEMORY_DAYS,
  type BotNoteGroup,
  type Memory,
} from '@leafbot/shared';
import { changeHint, changeLabel } from '@leafbot/app/src/lib/memoryChange';
import {
  historyText,
  historyWho,
  noteExpired,
  noteMatches,
  pinnedFirst,
  placeLabel,
  placeNoteGroups,
  untilDay,
} from '@leafbot/app/src/lib/memoryNotes';
import Feather from '@expo/vector-icons/Feather';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { confirm, toast, toastError } from '@/components/overlay';
import { IconButton, PillButton, Row, Section, SwitchRow } from '@/components/page';
import { FormField } from '@/components/dialogs/common';
import { Field } from '@/components/ui';
import { ChoiceRow, Hint, Lead, Pad, Rows, useSaveSettings } from './common/controls';
import { locale, t } from '@/i18n';
import { formatters } from '@/lib/format';
import {
  useBots,
  useManagesServer,
  useMemory,
  useMemoryChanges,
  useRooms,
  useSession,
  useSettings,
  useStaleMemory,
} from '@/lib/queries';
import { ApiError } from '@/lib/api';
import { isDay, notePatch } from '@/lib/memoryEdit';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

const fmt = formatters(locale, t);

/** The interval a looking back starts with when the person turns it on. */
const REVIEW_DEFAULT = 20;

/**
 * One note: its words, a pin, an edit and a delete. Editing turns the line into a box; the save
 * carries the version the person began on, so a note changed meanwhile is not overwritten.
 */
function NoteLine({
  m,
  detail,
  onSave,
  onPin,
  onForget,
  onVerify,
}: {
  m: Memory;
  detail?: string;
  onSave: (m: Memory, patch: { content?: string; validUntil?: string | null }) => Promise<unknown>;
  onPin: (m: Memory) => void;
  onForget: (m: Memory) => void;
  /** The person says a note written from outside text is right. */
  onVerify: (m: Memory) => void;
}) {
  const c = useColors();
  const [draft, setDraft] = useState<string | null>(null);
  // The date field's own text: a day, or empty for no end.
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  if (draft !== null) {
    const dayBad = until !== '' && !isDay(until);
    const submit = () => {
      const content = draft.trim();
      if (!content || busy || dayBad) return;
      const patch = notePatch(m, content, until);
      if (!Object.keys(patch).length) return setDraft(null);
      setBusy(true);
      onSave(m, patch)
        .then(() => setDraft(null))
        // A note changed meanwhile: the list is already fetched again, so leave the stale draft.
        .catch((e) => e instanceof ApiError && e.status === 409 && setDraft(null))
        .finally(() => setBusy(false));
    };
    return (
      <Pad>
        <Field
          value={draft}
          onChangeText={setDraft}
          accessibilityLabel={t('memory.edit')}
          maxLength={2000}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={submit}
        />
        <FormField
          label={t('memory.validUntil')}
          hint={dayBad ? undefined : t('dialogs.dateHint')}
          error={dayBad ? 'dialogs.dateHint' : undefined}
        >
          <Field
            value={until}
            onChangeText={(x) => setUntil(x.trim())}
            accessibilityLabel={t('memory.validUntil')}
            maxLength={10}
            keyboardType="numbers-and-punctuation"
            returnKeyType="done"
            onSubmitEditing={submit}
          />
        </FormField>
        <View style={styles.pair}>
          {until ? (
            <PillButton variant="ghost" label={t('memory.validUntilClear')} onPress={() => setUntil('')} />
          ) : null}
          <PillButton
            variant="primary"
            label={t('common.save')}
            onPress={submit}
            busy={busy}
            disabled={!draft.trim() || dayBad}
          />
          <PillButton variant="ghost" label={t('common.cancel')} onPress={() => setDraft(null)} />
        </View>
      </Pad>
    );
  }
  const text = m.site ? `${m.site} · ${m.content}` : m.content;
  const ends = m.validUntil
    ? t(noteExpired(m) ? 'memory.expiredOn' : 'memory.validUntilOn', {
        date: fmt.calendarDay(untilDay(m.validUntil)),
      })
    : null;
  return (
    <Row
      label={text}
      detail={
        [
          m.pinned ? t('memory.pinned') : null,
          m.unverified ? t('memory.unverifiedShort') : null,
          detail,
          ends,
        ]
          .filter(Boolean)
          .join(' · ') || undefined
      }
      right={
        <View style={styles.pair}>
          {m.unverified ? (
            <IconButton
              icon="check-circle"
              size={18}
              label={t('memory.verify')}
              onPress={() => onVerify(m)}
            />
          ) : null}
          <IconButton
            icon="bookmark"
            size={18}
            color={m.pinned ? c.brand : undefined}
            label={m.pinned ? t('memory.unpin') : t('memory.pin')}
            onPress={() => onPin(m)}
          />
          <IconButton
            icon="edit-2"
            size={18}
            label={t('memory.edit')}
            onPress={() => {
              setDraft(m.content);
              setUntil(m.validUntil ? untilDay(m.validUntil) : '');
            }}
          />
          <IconButton icon="trash-2" size={18} label={t('common.delete')} onPress={() => onForget(m)} />
        </View>
      }
    />
  );
}

/** The "memory" settings section's content, under the section's own title bar. */
export function MemorySection() {
  const manages = useManagesServer();
  const api = useApi();
  const { origin } = useServer();
  const { data: memory = [] } = useMemory();
  const { data: bots = [] } = useBots();
  // Notes of an archived bot stay until deleted; its name tells them apart.
  const { data: archived = [] } = useQuery({
    queryKey: ['bots', origin, 'archived'],
    queryFn: api.archivedBots,
  });
  const qc = useQueryClient();
  const c = useColors();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const { data: rooms = [] } = useRooms();
  const { data: settings } = useSettings();
  const saveSettings = useSaveSettings();
  const session = useSession().data?.user;
  const me = session?.id;
  const managesServer = session?.role === 'owner' || session?.role === 'admin';
  // Each bot's notes stay folded until opened, so a long list reads as one line per bot.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const refresh = () => qc.invalidateQueries({ queryKey: ['memory', origin] });
  // The server refuses a save over a note that changed meanwhile; the list is fetched again then.
  const save = useMutation({
    mutationFn: ({ m, patch }: { m: Memory; patch: { content?: string; validUntil?: string | null } }) =>
      api.updateMemory(m.id, { ...patch, ...(patch.content !== undefined && { updatedAt: m.updatedAt }) }),
    onSuccess: refresh,
    onError: (e) => {
      toastError(e);
      void refresh();
    },
  });
  const pin = useMutation({
    mutationFn: (m: Memory) => api.updateMemory(m.id, { pinned: !m.pinned }),
    onSuccess: refresh,
    onError: toastError,
  });
  const verify = useMutation({
    mutationFn: (m: Memory) => api.updateMemory(m.id, { verified: true }),
    onSuccess: refresh,
    onError: toastError,
  });
  const { data: history = [], isPending: historyPending } = useQuery({
    queryKey: ['memory', origin, 'history'],
    queryFn: api.memoryHistory,
    enabled: historyOpen,
  });
  const add = useMutation({
    mutationFn: () => api.addMemory({ scope: 'user', content: text }),
    onSuccess: () => {
      setText('');
      void refresh();
    },
    onError: toastError,
  });
  const clearBot = useMutation({
    mutationFn: api.removeBotMemory,
    onSuccess: refresh,
    onError: toastError,
  });
  // A deleted memory can be brought back for a moment, in case the wrong one went.
  const forget = useMutation({
    mutationFn: async (m: Memory) => {
      await api.removeMemory(m.id);
      return m;
    },
    onSuccess: (m) => {
      void refresh();
      // A place's note is written by the bots there, so it cannot be put back from here.
      const { scope } = m;
      if (scope === 'room') return;
      toast(t('memory.deleted'), {
        action: {
          label: t('memory.undo'),
          onPress: () =>
            void api
              .addMemory({
                scope,
                botId: m.botId,
                content: m.content,
                site: m.site,
                validUntil: m.validUntil,
              })
              // A pinned note comes back pinned, as it was.
              .then((back) => (m.pinned ? api.updateMemory(back.id, { pinned: true }) : back))
              .then(refresh)
              .catch(toastError),
        },
      });
    },
    onError: toastError,
  });
  const { data: stale = [] } = useStaleMemory();
  const clearStale = useMutation({
    mutationFn: () => api.removeStaleMemory(stale.map((m) => m.id)),
    onSuccess: refresh,
    onError: toastError,
  });
  const { data: changes = [] } = useMemoryChanges();
  // A change waits until the person says yes or no; either way it leaves the list.
  const decide = useMutation({
    mutationFn: async ({ ids, yes }: { ids: string[]; yes: boolean }) => {
      for (const id of ids) await (yes ? api.acceptMemoryChange(id) : api.rejectMemoryChange(id));
    },
    onSuccess: refresh,
    onError: toastError,
  });
  const searching = query.trim() !== '';
  const hit = (m: Memory) => noteMatches(m, query);
  // A note past its "true until" date waits in its own list, not among the notes bots read.
  const now = new Date();
  const current = memory.filter((m) => !noteExpired(m, now));
  const expiredHits = memory.filter((m) => noteExpired(m, now) && hit(m));
  const user = pinnedFirst(current.filter((m) => m.scope === 'user' && hit(m)));
  const common = pinnedFirst(current.filter((m) => m.scope === 'common' && hit(m)));
  const groups = botNoteGroups(current.filter(hit), bots, archived).map((g) => ({
    ...g,
    notes: pinnedFirst(g.notes),
  }));
  const roomGroups = placeNoteGroups(current.filter(hit), t, rooms);
  const staleHits = stale.filter(hit);
  const noteProps = {
    onSave: (m: Memory, patch: { content?: string; validUntil?: string | null }) =>
      save.mutateAsync({ m, patch }),
    onPin: (m: Memory) => pin.mutate(m),
    onForget: (m: Memory) => forget.mutate(m),
    onVerify: (m: Memory) => verify.mutate(m),
  };
  const reviewEvery = settings?.memoryReviewEvery;
  const botName = (id: string | null) =>
    [...bots, ...archived].find((b) => b.id === id)?.name ?? t('common.bot');
  // Whose note it is: the person's own, a place's, or one bot's.
  const whose = (m: Memory) =>
    m.scope === 'user'
      ? t('memory.staleShared')
      : m.scope === 'room'
        ? placeLabel(m.place, t, rooms)
        : m.scope === 'common'
          ? t('memory.scopeCommon')
          : botName(m.botId);
  const staleDetail = (m: Memory) =>
    `${whose(m)} · ${
      m.lastUsedAt
        ? t('memory.lastUsed', { when: fmt.dayLabel(m.lastUsedAt) })
        : t('memory.neverUsed', { when: fmt.dayLabel(m.updatedAt) })
    }`;
  const clearAllStale = async () => {
    const ok = await confirm({
      title: t('memory.staleDeleteAllConfirm', { count: stale.length }),
      destructive: true,
      confirmLabel: t('common.delete'),
    });
    if (ok) clearStale.mutate();
  };
  const name = (g: BotNoteGroup) => g.name ?? t('common.bot');
  const clear = async (g: BotNoteGroup) => {
    const ok = await confirm({
      title: t('memory.deleteAllConfirm', { name: name(g), count: g.notes.length }),
      destructive: true,
      confirmLabel: t('common.delete'),
    });
    if (ok) clearBot.mutate(g.botId);
  };
  const label = (m: Memory) => (m.site ? `${m.site} · ${m.content}` : m.content);
  const trash = (m: Memory) => (
    <IconButton icon="trash-2" size={18} label={t('common.delete')} onPress={() => forget.mutate(m)} />
  );
  return (
    <>
      <View style={styles.form}>
        <Field
          value={text}
          onChangeText={setText}
          placeholder={t('memory.placeholder')}
          accessibilityLabel={t('memory.placeholder')}
          style={styles.grow}
          maxLength={2000}
          returnKeyType="done"
          onSubmitEditing={() => text.trim() && add.mutate()}
        />
        <PillButton
          variant="primary"
          size="large"
          label={t('common.add')}
          onPress={() => add.mutate()}
          busy={add.isPending}
          disabled={!text.trim()}
        />
      </View>
      <View style={styles.search}>
        <Field
          value={query}
          onChangeText={setQuery}
          placeholder={t('memory.search')}
          accessibilityLabel={t('memory.search')}
          returnKeyType="search"
          autoCorrect={false}
        />
      </View>
      <Lead>{t('memory.pinHint')}</Lead>
      {changes.length > 0 ? (
        <Section title={t('memory.pending')}>
          <Rows>
            <Pad>
              <Hint>{t('memory.pendingHint')}</Hint>
            </Pad>
            {changes.map((ch) => (
              <Row
                key={ch.id}
                label={changeLabel(ch)}
                detail={changeHint(ch, [...bots, ...archived], t)}
                detailLines={3}
                right={
                  <View style={styles.pair}>
                    <IconButton
                      icon="check"
                      size={18}
                      label={t('memory.accept')}
                      onPress={() => decide.mutate({ ids: [ch.id], yes: true })}
                    />
                    <IconButton
                      icon="x"
                      size={18}
                      label={t('memory.reject')}
                      onPress={() => decide.mutate({ ids: [ch.id], yes: false })}
                    />
                  </View>
                }
              />
            ))}
            {changes.length > 1 ? (
              <>
                <Row
                  label={t('memory.acceptAll')}
                  onPress={() => decide.mutate({ ids: changes.map((x) => x.id), yes: true })}
                />
                <Row
                  label={t('memory.rejectAll')}
                  destructive
                  onPress={() => decide.mutate({ ids: changes.map((x) => x.id), yes: false })}
                />
              </>
            ) : null}
          </Rows>
        </Section>
      ) : null}
      {expiredHits.length > 0 ? (
        <Section title={t('memory.expired')}>
          <Rows>
            <Pad>
              <Hint>{t('memory.expiredHint')}</Hint>
            </Pad>
            {expiredHits.map((m) => (
              <NoteLine key={m.id} m={m} detail={whose(m)} {...noteProps} />
            ))}
          </Rows>
        </Section>
      ) : null}
      {staleHits.length > 0 ? (
        <Section title={t('memory.stale')}>
          <Rows>
            <Pad>
              <Hint>{t('memory.staleHint', { days: STALE_MEMORY_DAYS })}</Hint>
            </Pad>
            {staleHits.map((m) => (
              <Row key={m.id} label={label(m)} detail={staleDetail(m)} right={trash(m)} />
            ))}
            {stale.length > 1 ? (
              <Row label={t('memory.deleteAll')} destructive onPress={() => void clearAllStale()} />
            ) : null}
          </Rows>
        </Section>
      ) : null}
      {common.length > 0 ? (
        <Section title={t('memory.common')}>
          <Rows>
            <Pad>
              <Hint>{t(manages ? 'memory.commonHint' : 'memory.commonHintMember')}</Hint>
            </Pad>
            {common.map((m) =>
              manages ? <NoteLine key={m.id} m={m} {...noteProps} /> : <Row key={m.id} label={m.content} />,
            )}
          </Rows>
        </Section>
      ) : null}
      <Section title={t('memory.user')}>
        <Rows>
          {user.length === 0 ? (
            <Pad>
              <Hint>{t(searching ? 'memory.searchEmpty' : 'memory.empty')}</Hint>
            </Pad>
          ) : null}
          {user.map((m) => (
            <NoteLine key={m.id} m={m} {...noteProps} />
          ))}
        </Rows>
      </Section>
      <Section title={t('memory.bots')}>
        <Rows>
          {groups.length === 0 ? (
            <Pad>
              <Hint>{t(searching ? 'memory.searchEmpty' : 'memory.empty')}</Hint>
            </Pad>
          ) : null}
          {groups.map((g) => {
            // A search opens the bots with hits, so the notes found are in sight.
            const isOpen = searching || open.has(g.botId);
            return (
              // The bot's line and its open notes share the card's dividers.
              <Rows key={g.botId}>
                <Row
                  label={g.archived ? t('memory.archivedBot', { name: name(g) }) : name(g)}
                  detail={t('memory.noteCount', { count: g.notes.length })}
                  onPress={() => toggle(g.botId)}
                  chevron={false}
                  right={
                    <Feather
                      name={isOpen ? 'chevron-up' : 'chevron-down'}
                      size={22}
                      color={c.mutedForeground}
                    />
                  }
                />
                {isOpen ? g.notes.map((m) => <NoteLine key={m.id} m={m} {...noteProps} />) : null}
                {isOpen && !searching && g.notes.length > 1 ? (
                  <Row label={t('memory.deleteAll')} destructive onPress={() => void clear(g)} />
                ) : null}
              </Rows>
            );
          })}
        </Rows>
      </Section>
      {roomGroups.length > 0 ? (
        <Section title={t('memory.rooms')}>
          <Rows>
            {searching ? null : (
              <Pad>
                <Hint>{t('memory.roomsHint')}</Hint>
              </Pad>
            )}
            {roomGroups.map((g) => {
              const isOpen = searching || open.has(g.place);
              return (
                <Rows key={g.place}>
                  <Row
                    label={g.label}
                    detail={t('memory.noteCount', { count: g.notes.length })}
                    onPress={() => toggle(g.place)}
                    chevron={false}
                    right={
                      <Feather
                        name={isOpen ? 'chevron-up' : 'chevron-down'}
                        size={22}
                        color={c.mutedForeground}
                      />
                    }
                  />
                  {isOpen ? g.notes.map((m) => <NoteLine key={m.id} m={m} {...noteProps} />) : null}
                </Rows>
              );
            })}
          </Rows>
        </Section>
      ) : null}
      {/* The server's setting: only those who look after the server may change it. */}
      {reviewEvery !== undefined && managesServer ? (
        <Section>
          <SwitchRow
            label={t('memory.learn')}
            detail={t('memory.learnHint')}
            value={reviewEvery > 0}
            onChange={(on) => saveSettings.mutate({ memoryReviewEvery: on ? REVIEW_DEFAULT : 0 })}
          />
          {reviewEvery > 0 ? (
            <ChoiceRow
              label={t('memory.learnEvery')}
              value={String(reviewEvery)}
              options={MEMORY_REVIEW_STEPS.filter((n) => n > 0).map((n) => ({
                value: String(n),
                label: t('memory.learnEveryChoice', { count: n }),
              }))}
              onChange={(v) => saveSettings.mutate({ memoryReviewEvery: Number(v) })}
            />
          ) : null}
        </Section>
      ) : null}
      <Section title={t('memory.history')}>
        <Rows>
          <Row
            label={t('memory.history')}
            onPress={() => setHistoryOpen(!historyOpen)}
            chevron={false}
            right={
              <Feather
                name={historyOpen ? 'chevron-up' : 'chevron-down'}
                size={22}
                color={c.mutedForeground}
              />
            }
          />
          {historyOpen && !historyPending && history.length === 0 ? (
            <Pad>
              <Hint>{t('memory.historyEmpty')}</Hint>
            </Pad>
          ) : null}
          {historyOpen
            ? [...history]
                .reverse()
                .map((l) => (
                  <Row
                    key={l.id}
                    label={historyText(l, t)}
                    detail={`${historyWho(l, me, bots, t)} · ${fmt.dayLabel(l.createdAt)}`}
                  />
                ))
            : null}
        </Rows>
      </Section>
    </>
  );
}

const styles = StyleSheet.create({
  pair: { flexDirection: 'row', gap: 4 },
  // The box and its button share a row, as on the web.
  form: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  grow: { flex: 1 },
  search: { marginTop: 8 },
});
