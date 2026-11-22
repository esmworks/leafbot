import type { CanaryAlarm, RoutineSuggestion, SecondYes, SkillSuggestion } from '@leafbot/shared';
import { INTL_LOCALE } from '@leafbot/shared/i18n';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { ItemCard } from '@/components/dialogs/Item';
import { toast, toastError } from '@/components/overlay';
import { PillButton } from '@/components/page';
import { describeSchedule } from '@/components/panel/schedule';
import { Chip, ChipRow } from '@/components/settings/common/controls';
import { Field } from '@/components/ui';
import { locale, t } from '@/i18n';
import { formatters } from '@/lib/format';
import { nav } from '@/lib/nav';
import { useBots, usePeople, useRoutineSuggestions, useSecondYes, useSkillSuggestions } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { isClockTime, personNameOf, pickable, scheduleOf, type Rhythm } from '@/lib/today';
import { useColors } from '@/lib/theme';

const fmt = formatters(locale, t);
const weekday = new Intl.DateTimeFormat(INTL_LOCALE[locale], { weekday: 'short', timeZone: 'UTC' });
/** Weekday number n (0 is Sunday) named in the app's language; 2023-01-01 was a Sunday. */
const dayName = (n: number) => weekday.format(new Date(Date.UTC(2023, 0, 1 + n)));

/** A titled group of cards on the Today page, drawn in a warning colour when `tone` says so. */
function Group({
  title,
  tone = 'normal',
  children,
}: {
  title: string;
  tone?: 'normal' | 'alarm' | 'warn';
  children: ReactNode[];
}) {
  const c = useColors();
  const color = tone === 'alarm' ? c.destructive : tone === 'warn' ? c.amber : c.mutedForeground;
  return (
    <View style={styles.group}>
      <Text style={[styles.title, { color }]}>{title}</Text>
      <ItemCard>{children}</ItemCard>
    </View>
  );
}

/** Lists that change here are read again on every device through the live updates; this covers this one. */
function useRefresher(...keys: string[]) {
  const qc = useQueryClient();
  const { origin } = useServer();
  return () => {
    for (const k of keys) void qc.invalidateQueries({ queryKey: [k, origin] });
  };
}

/** A bot caught steered by text it read: stopped and moved to "Ask" until the person has seen it. */
export function CanarySection({ alarms }: { alarms: CanaryAlarm[] }) {
  const c = useColors();
  const api = useApi();
  const refresh = useRefresher('today');
  const seen = useMutation({
    mutationFn: (id: string) => api.canaryAlarmSeen(id),
    onSuccess: refresh,
    onError: toastError,
  });
  if (!alarms.length) return null;
  return (
    <Group title={t('today.canary')} tone="alarm">
      {alarms.map((a) => (
        <View key={a.id} style={styles.card}>
          <Text style={[styles.strong, { color: c.foreground }]}>
            {a.wire === 'key'
              ? t('today.canaryKey', { bot: a.botName, key: a.keyName ?? '' })
              : t('today.canaryPrompt', { bot: a.botName })}
          </Text>
          <Text style={[styles.small, { color: c.mutedForeground }]}>
            {fmt.shortTime(a.createdAt)}
            {a.movedFrom ? ` · ${t('today.canaryMoved')}` : ''}
          </Text>
          <Text style={[styles.small, { color: c.mutedForeground }]}>
            {a.sources.length
              ? t('today.canarySources', { sources: a.sources.join(', ') })
              : t('today.canaryNoSources')}
          </Text>
          <View style={styles.actions}>
            {a.threadId ? (
              <PillButton
                label={t('today.canaryOpen')}
                onPress={() => nav.chat(a.botId, { threadId: a.threadId! })}
              />
            ) : null}
            <PillButton
              label={t('today.canarySeen')}
              variant="destructive"
              busy={seen.isPending}
              onPress={() => seen.mutate(a.id)}
            />
          </View>
        </View>
      ))}
    </Group>
  );
}

/** Steps that wait for this person's second yes; the conversation they come from is not theirs to read. */
export function SecondYesSection() {
  const c = useColors();
  const api = useApi();
  const { data: items = [] } = useSecondYes();
  const { data: bots = [] } = useBots();
  const { data: people = [] } = usePeople();
  const refresh = useRefresher('second-yes');
  const answer = useMutation({
    mutationFn: (d: { id: string; decision: 'allow' | 'deny' }) => api.answerSecond(d.id, d.decision),
    onSuccess: refresh,
    onError: (e) => {
      toastError(e);
      refresh();
    },
  });
  if (!items.length) return null;
  const name = (id: string | null) => personNameOf(people, id, t('people.owner'), t('common.someone'));
  return (
    <Group title={t('second.title')} tone="warn">
      {items.map((s: SecondYes) => {
        const bot = bots.find((b) => b.id === s.botId);
        return (
          <View key={s.id} style={styles.card}>
            <View style={styles.head}>
              {bot ? <Avatar name={bot.name} color={bot.color} avatar={bot.avatar} size={24} /> : null}
              <Text style={[styles.grow, styles.strong, { color: c.foreground }]} numberOfLines={1}>
                {bot?.name ?? t('common.bot')}
              </Text>
            </View>
            <Text style={[styles.body, { color: c.foreground }]}>{s.summary}</Text>
            {s.detail ? (
              <Text style={[styles.small, { color: c.mutedForeground }]} numberOfLines={8}>
                {s.detail}
              </Text>
            ) : null}
            <Text style={[styles.small, { color: c.mutedForeground }]}>
              {[
                s.askedBy ? t('second.askedBy', { name: name(s.askedBy) }) : '',
                t('second.firstYes', { name: name(s.firstApprover), when: fmt.dayLabel(s.firstAt) }),
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
            <View style={styles.actions}>
              <PillButton
                label={t('second.allow')}
                variant="primary"
                disabled={answer.isPending}
                onPress={() => answer.mutate({ id: s.id, decision: 'allow' })}
              />
              <PillButton
                label={t('approval.deny')}
                variant="ghost"
                disabled={answer.isPending}
                onPress={() => answer.mutate({ id: s.id, decision: 'deny' })}
              />
            </View>
          </View>
        );
      })}
    </Group>
  );
}

/** One suggestion: what the person kept asking for, the instructions to edit, and the two answers. */
function SuggestionCard({ s }: { s: RoutineSuggestion }) {
  const c = useColors();
  const api = useApi();
  const { data: bots = [] } = useBots();
  const bot = bots.find((b) => b.id === s.botId);
  const [instructions, setInstructions] = useState(s.instructions);
  const [when, setWhen] = useState(() => pickable(s.schedule));
  const refresh = useRefresher('routine-suggestions', 'routines');
  const fail = (e: unknown) => {
    toastError(e);
    refresh();
  };
  const schedule = scheduleOf(when);
  const create = useMutation({
    mutationFn: () =>
      api.acceptRoutineSuggestion(s.id, {
        instructions: instructions.trim() || s.instructions,
        ...(schedule && { schedule }),
      }),
    onSuccess: () => {
      toast(t('routineSuggest.created', { name: s.name }));
      refresh();
    },
    onError: fail,
  });
  const dismiss = useMutation({
    mutationFn: () => api.dismissRoutineSuggestion(s.id),
    onSuccess: refresh,
    onError: fail,
  });
  const botName = bot?.name ?? t('common.bot');
  const busy = create.isPending || dismiss.isPending;
  const rhythms: Rhythm[] = ['daily', 'weekdays', 'weekly'];
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        {bot ? <Avatar name={bot.name} color={bot.color} avatar={bot.avatar} size={24} /> : null}
        <View style={styles.grow}>
          <Text style={[styles.strong, { color: c.foreground }]}>{s.name}</Text>
          <Text style={[styles.small, { color: c.mutedForeground }]}>
            {t('routineSuggest.line', { bot: botName, count: s.requests, days: s.days.length })}
            {s.schedule ? ` ${t('routineSuggest.rhythm', { when: describeSchedule(s.schedule) })}` : ''}
          </Text>
        </View>
      </View>
      {s.canCreate ? (
        <>
          <Field
            value={instructions}
            onChangeText={setInstructions}
            multiline
            accessibilityLabel={t('routineSuggest.instructions')}
            style={styles.area}
          />
          <ChipRow>
            {rhythms.map((k) => (
              <Chip
                key={k}
                on={when.kind === k}
                label={t(`routineSuggest.${k}`)}
                onPress={() => setWhen({ ...when, kind: k })}
              />
            ))}
          </ChipRow>
          {when.kind === 'weekly' ? (
            <ChipRow>
              {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                <Chip
                  key={d}
                  on={when.day === d}
                  label={dayName(d)}
                  onPress={() => setWhen({ ...when, day: d })}
                />
              ))}
            </ChipRow>
          ) : null}
          {when.kind ? (
            <Field
              value={when.time}
              onChangeText={(time) => setWhen({ ...when, time })}
              maxLength={5}
              keyboardType="numbers-and-punctuation"
              accessibilityLabel={t('routineSuggest.time')}
              invalid={!isClockTime(when.time)}
            />
          ) : (
            <Text style={[styles.small, { color: c.mutedForeground }]}>{t('routineSuggest.pick')}</Text>
          )}
        </>
      ) : (
        <Text style={[styles.small, { color: c.mutedForeground }]}>
          {t('routineSuggest.askOwner', { bot: botName })}
        </Text>
      )}
      <View style={styles.actions}>
        <PillButton
          label={t('routineSuggest.dismiss')}
          variant="ghost"
          disabled={busy}
          onPress={() => dismiss.mutate()}
        />
        {s.canCreate ? (
          <PillButton
            label={t('routineSuggest.create')}
            variant="primary"
            disabled={!schedule || !instructions.trim() || busy}
            busy={create.isPending}
            onPress={() => create.mutate()}
          />
        ) : null}
      </View>
    </View>
  );
}

/** Things the person keeps asking a bot for by hand, offered as routines. */
export function RoutineSuggestionsSection() {
  const { data: suggestions = [] } = useRoutineSuggestions();
  if (!suggestions.length) return null;
  return (
    <Group title={t('routineSuggest.title')}>
      {suggestions.map((s) => (
        <SuggestionCard key={s.id} s={s} />
      ))}
    </Group>
  );
}

/** One skill suggestion: the kind of task, the skill to read and edit, and the two answers. */
function SkillCard({ s }: { s: SkillSuggestion }) {
  const c = useColors();
  const api = useApi();
  const { data: bots = [] } = useBots();
  const bot = bots.find((b) => b.id === s.botId);
  const [name, setName] = useState(s.name);
  const [description, setDescription] = useState(s.description);
  const [body, setBody] = useState(s.body);
  const refresh = useRefresher('skill-suggestions', 'skills');
  const fail = (e: unknown) => {
    toastError(e);
    refresh();
  };
  const botName = bot?.name ?? t('common.bot');
  const create = useMutation({
    mutationFn: () =>
      api.acceptSkillSuggestion(s.id, {
        name: name.trim() || s.name,
        description: description.trim() || s.description,
        body: body.trim() || s.body,
      }),
    onSuccess: (skill) => {
      toast(t('skillSuggest.created', { name: skill.name, bot: botName }));
      refresh();
    },
    onError: fail,
  });
  const dismiss = useMutation({
    mutationFn: () => api.dismissSkillSuggestion(s.id),
    onSuccess: refresh,
    onError: fail,
  });
  const busy = create.isPending || dismiss.isPending;
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        {bot ? <Avatar name={bot.name} color={bot.color} avatar={bot.avatar} size={24} /> : null}
        <View style={styles.grow}>
          <Text style={[styles.strong, { color: c.foreground }]}>{s.description}</Text>
          <Text style={[styles.small, { color: c.mutedForeground }]}>
            {t('skillSuggest.line', { bot: botName, count: s.requests, days: s.days.length })}
          </Text>
        </View>
      </View>
      {s.canCreate ? (
        <>
          <Field
            value={name}
            onChangeText={setName}
            autoCapitalize="none"
            accessibilityLabel={t('skillSuggest.name')}
          />
          <Field
            value={description}
            onChangeText={setDescription}
            accessibilityLabel={t('skillSuggest.description')}
          />
          <Field
            value={body}
            onChangeText={setBody}
            multiline
            accessibilityLabel={t('skillSuggest.body')}
            style={styles.area}
          />
        </>
      ) : (
        <Text style={[styles.small, { color: c.mutedForeground }]}>
          {t('skillSuggest.askOwner', { bot: botName })}
        </Text>
      )}
      <View style={styles.actions}>
        <PillButton
          label={t('skillSuggest.dismiss')}
          variant="ghost"
          disabled={busy}
          onPress={() => dismiss.mutate()}
        />
        {s.canCreate ? (
          <PillButton
            label={t('skillSuggest.create')}
            variant="primary"
            disabled={!body.trim() || busy}
            busy={create.isPending}
            onPress={() => create.mutate()}
          />
        ) : null}
      </View>
    </View>
  );
}

/** Many-step tasks the person keeps asking a bot for, offered as skills. */
export function SkillSuggestionsSection() {
  const { data: suggestions = [] } = useSkillSuggestions();
  if (!suggestions.length) return null;
  return (
    <Group title={t('skillSuggest.title')}>
      {suggestions.map((s) => (
        <SkillCard key={s.id} s={s} />
      ))}
    </Group>
  );
}

const styles = StyleSheet.create({
  group: { gap: 6 },
  title: { fontSize: 15, fontWeight: '500', paddingHorizontal: 4 },
  card: { padding: 16, gap: 8 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  grow: { flex: 1 },
  strong: { fontSize: 16, fontWeight: '500' },
  body: { fontSize: 16 },
  small: { fontSize: 14, lineHeight: 19 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, paddingTop: 4 },
  area: { height: undefined, minHeight: 90, textAlignVertical: 'top', paddingTop: 10 },
});
