import {
  PERMISSION_MODES,
  shownMode,
  type Bot,
  type BotUpdate,
  type Routine,
  type ShownMode,
} from '@leafbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { Sheet, type IconName, type SheetItem } from '@/components/page';
import { toast, toastError } from '@/components/overlay';
import { locale, t, type MessageKey } from '@/i18n';
import { formatters } from '@/lib/format';
import { nav } from '@/lib/nav';
import { useConnections, useGroups, useRoutines, useSkills, useSummaries } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';
import { AppLogo } from './AppLogo';
import { BotSuggestions } from './BotSuggestions';
import { BotTables } from './BotTables';
import { ComputerCard } from './ComputerCard';
import { InstructionsDocNotice } from './InstructionsDocNotice';
import { Block, SectionHead, useBrowserAvailable } from './parts';
import { describeSchedule } from './schedule';

const fmt = formatters(locale, t);

const MODE_LABEL: Record<ShownMode, MessageKey> = {
  readonly: 'mode.readonly',
  ask: 'mode.ask',
  auto: 'mode.auto',
};

/** The panel's first tab: the bot's computer, routines, apps, skills and settings. */
export function Activity({ bot }: { bot: Bot }) {
  const browser = useBrowserAvailable();
  return (
    <View style={styles.stack}>
      {/* A bot with the internet off gets no browser. */}
      {browser && bot.internet !== false ? <ComputerCard bot={bot} /> : null}
      <InstructionsDocNotice bot={bot} />
      <BotSuggestions bot={bot} />
      <Upcoming bot={bot} />
      <BotApps bot={bot} />
      <BotSkills bot={bot} />
      <BotTables bot={bot} />
      <BotFacts bot={bot} />
    </View>
  );
}

function Upcoming({ bot }: { bot: Bot }) {
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const { data: routines = [] } = useRoutines();
  const mine = routines.filter((r) => r.botId === bot.id);
  const { data: summaries = [] } = useSummaries();
  // Servers older than the field send no ids.
  const failed = new Set(summaries.find((s) => s.botId === bot.id)?.failedRoutines ?? []);
  const toggle = useMutation({
    mutationFn: (r: Routine) => api.updateRoutine(r.id, { enabled: !r.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['routines', origin] }),
    onError: toastError,
  });
  const run = useMutation({
    mutationFn: (r: Routine) => api.runRoutine(r.id),
    onSuccess: (done) =>
      done?.status === 'skipped'
        ? toast(done.reason ?? t('panel.skipped'))
        : toast(t('panel.routineStarted')),
    onError: toastError,
  });
  return (
    <View>
      <SectionHead
        title={t('panel.upcoming')}
        action={t('panel.addRoutine')}
        plus
        onAction={() => nav.routine({ botId: bot.id })}
      />
      {mine.length === 0 ? (
        <Block>
          <Text style={[styles.muted, { color: c.mutedForeground }]}>{t('panel.noRoutines')}</Text>
        </Block>
      ) : null}
      <View style={styles.list}>
        {mine.map((r) => (
          <Block key={r.id} style={styles.line}>
            {failed.has(r.id) ? (
              <Feather name="alert-circle" size={20} color={c.destructive} />
            ) : (
              <Feather name="clock" size={20} color={c.mutedForeground} />
            )}
            <Pressable
              accessibilityRole="button"
              style={styles.grow}
              onPress={() =>
                nav.routine({ botId: bot.id, routineId: r.id, showRuns: failed.has(r.id) ? '1' : undefined })
              }
            >
              <Text style={[styles.name, { color: c.foreground }]} numberOfLines={1}>
                {r.name}
              </Text>
              <Text style={[styles.sub, { color: c.mutedForeground }]} numberOfLines={2}>
                {r.pausedReason === 'failures' && !r.enabled ? (
                  <Text style={{ color: c.destructive }}>{`${t('panel.switchedOffFailures')} · `}</Text>
                ) : r.pausedReason === 'ended' && !r.enabled ? (
                  <Text>{`${t('panel.ended')} · `}</Text>
                ) : r.signInWait ? (
                  <Text style={{ color: c.destructive }}>{`${t('panel.signInWait')} · `}</Text>
                ) : failed.has(r.id) ? (
                  <Text style={{ color: c.destructive }}>{`${t('panel.lastRunFailed')} · `}</Text>
                ) : null}
                {describeSchedule(r.schedule)}
                {r.enabled && r.nextRunAt
                  ? ` · ${t('panel.nextRun', { when: fmt.dayLabel(r.nextRunAt) })}`
                  : ''}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('panel.runNow')}
              hitSlop={8}
              onPress={() => run.mutate(r)}
              style={styles.play}
            >
              <Feather name="play" size={20} color={c.foreground} />
            </Pressable>
            <Switch
              value={r.enabled}
              onValueChange={() => toggle.mutate(r)}
              trackColor={{ true: c.primary, false: c.border }}
              thumbColor={r.enabled ? c.primaryForeground : undefined}
              accessibilityLabel={t('panel.toggle')}
            />
          </Block>
        ))}
      </View>
    </View>
  );
}

/** How many logos the summary row stacks before it stops. */
const STACKED_LOGOS = 4;

/** The apps this bot may use, as one row; it opens the screen with each one's switch. */
function BotApps({ bot }: { bot: Bot }) {
  const c = useColors();
  const { data: connections = [] } = useConnections();
  const on = connections.filter((x) => x.allBots || x.botIds.includes(bot.id));
  const troubled = connections.filter((x) => x.status !== 'connected').length;
  return (
    <View>
      <SectionHead
        title={t('panel.apps')}
        action={t('panel.addApp')}
        plus
        onAction={() => nav.apps({ botId: bot.id })}
      />
      {connections.length === 0 ? (
        <Block onPress={() => nav.apps({ botId: bot.id })}>
          <Text style={[styles.muted, { color: c.mutedForeground }]}>{t('panel.noApps')}</Text>
        </Block>
      ) : (
        <Block onPress={() => nav.botApps(bot.id)} style={styles.line}>
          <View style={styles.logos}>
            {(on.length ? on : connections).slice(0, STACKED_LOGOS).map((x, i) => (
              <View
                key={x.id}
                style={[styles.logo, { borderColor: c.background, marginLeft: i === 0 ? 0 : -8 }]}
              >
                <AppLogo id={x.catalogId} name={x.name} size={24} />
              </View>
            ))}
          </View>
          <View style={styles.grow}>
            <Text style={[styles.name, { color: c.foreground }]} numberOfLines={1}>
              {t('panel.appsOn', { on: on.length, total: connections.length })}
            </Text>
            {troubled > 0 ? (
              <Text style={[styles.sub, { color: c.amber }]} numberOfLines={1}>
                {t('panel.appsTrouble', { count: troubled })}
              </Text>
            ) : null}
          </View>
          <Feather name="chevron-right" size={22} color={c.mutedForeground} />
        </Block>
      )}
    </View>
  );
}

/** The skills in the library, each with its switch for this bot. */
function BotSkills({ bot }: { bot: Bot }) {
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const { data: skills = [] } = useSkills();
  const toggle = useMutation({
    mutationFn: (v: { id: string; on: boolean }) => api.setSkillBot(v.id, bot.id, v.on),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills', origin] }),
    onError: toastError,
  });
  return (
    <View>
      <SectionHead
        title={t('panel.skills')}
        action={skills.length ? t('panel.manageSkills') : t('skills.new')}
        plus={!skills.length}
        onAction={() => nav.settings('skills')}
      />
      {skills.length === 0 ? (
        <Block onPress={() => nav.settings('skills')}>
          <Text style={[styles.muted, { color: c.mutedForeground }]}>{t('panel.noSkills')}</Text>
        </Block>
      ) : null}
      <View style={styles.list}>
        {skills.map((k) => (
          <Block key={k.id} style={styles.line}>
            <View style={styles.grow}>
              <Text style={[styles.name, styles.mono, { color: c.foreground }]} numberOfLines={1}>
                {k.name}
              </Text>
              <Text style={[styles.sub, { color: c.mutedForeground }]} numberOfLines={2}>
                {k.description}
              </Text>
            </View>
            <Switch
              value={k.botIds.includes(bot.id)}
              disabled={toggle.isPending}
              onValueChange={(on) => toggle.mutate({ id: k.id, on })}
              trackColor={{ true: c.primary, false: c.border }}
              thumbColor={k.botIds.includes(bot.id) ? c.primaryForeground : undefined}
              accessibilityLabel={k.name}
            />
          </Block>
        ))}
      </View>
    </View>
  );
}

/** What the bot may do and where it sits in the list. */
function BotFacts({ bot }: { bot: Bot }) {
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const { data: groups = [] } = useGroups();
  const [sheet, setSheet] = useState<'mode' | 'group' | null>(null);
  const update = useMutation({
    mutationFn: (patch: BotUpdate) => api.updateBot(bot.id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bots', origin] }),
    onError: toastError,
  });
  const group = groups.find((g) => g.id === bot.groupId);
  const modeItems: SheetItem[] = PERMISSION_MODES.map((m) => ({
    label: t(MODE_LABEL[m]),
    selected: m === shownMode(bot.permissionMode),
    onPress: () => update.mutate({ permissionMode: m }),
  }));
  const noGroup = bot.isManager ? t('panel.manager') : t('panel.none');
  const groupItems: SheetItem[] = [
    { label: noGroup, selected: !group, onPress: () => update.mutate({ groupId: null }) },
    ...groups.map((g) => ({
      label: g.name,
      selected: g.id === group?.id,
      onPress: () => update.mutate({ groupId: g.id }),
    })),
  ];
  const busyMode = update.isPending && !!update.variables && 'permissionMode' in update.variables;
  return (
    <View>
      <SectionHead title={t('panel.bot')} />
      <Fact icon="shield" label={t('panel.permissions')}>
        <Choice
          value={t(MODE_LABEL[shownMode(bot.permissionMode)])}
          busy={busyMode}
          onPress={() => setSheet('mode')}
        />
      </Fact>
      {/* An older server has no switch to show. */}
      {typeof bot.internet === 'boolean' ? (
        <Fact icon="globe" label={t('panel.internet')}>
          <Switch
            value={bot.internet}
            disabled={update.isPending}
            onValueChange={(internet) => update.mutate({ internet })}
            trackColor={{ true: c.primary, false: c.muted }}
            thumbColor={bot.internet ? c.primaryForeground : undefined}
            accessibilityLabel={t('panel.internet')}
            accessibilityHint={t('bot.internetHint')}
          />
        </Fact>
      ) : null}
      <Fact icon="file-text" label={t('panel.group')}>
        <Choice value={group?.name ?? noGroup} onPress={() => setSheet('group')} />
      </Fact>
      <Sheet
        open={sheet === 'mode'}
        onClose={() => setSheet(null)}
        title={t('panel.permissions')}
        items={modeItems}
      />
      <Sheet
        open={sheet === 'group'}
        onClose={() => setSheet(null)}
        title={t('panel.group')}
        items={groupItems}
      />
    </View>
  );
}

/** One line of the bot's facts: its icon and name, with the control at the right. */
function Fact({ icon, label, children }: { icon: IconName; label: string; children: ReactNode }) {
  const c = useColors();
  return (
    <View style={styles.fact}>
      <Feather name={icon} size={20} color={c.mutedForeground} />
      <Text style={[styles.factLabel, { color: c.foreground }]} numberOfLines={1}>
        {label}
      </Text>
      {children}
    </View>
  );
}

/** The current choice on a small rounded button that opens the list of choices. */
function Choice({ value, busy, onPress }: { value: string; busy?: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={value}
      onPress={onPress}
      disabled={busy}
      style={({ pressed }) => [
        styles.choice,
        { backgroundColor: pressed ? c.accent : c.muted },
        busy && { opacity: 0.5 },
      ]}
    >
      <Text style={[styles.choiceText, { color: c.foreground }]} numberOfLines={1}>
        {value}
      </Text>
      <Feather name="chevron-down" size={16} color={c.mutedForeground} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 24 },
  list: { gap: 8 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  grow: { flex: 1, minWidth: 0 },
  name: { fontSize: 17, fontWeight: '500' },
  mono: {
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontWeight: '400',
    fontSize: 16,
  },
  sub: { fontSize: 13, lineHeight: 18, marginTop: 1 },
  muted: { fontSize: 16, lineHeight: 22 },
  play: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  logos: { flexDirection: 'row' },
  logo: { borderRadius: 14, borderWidth: 2 },
  fact: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 },
  factLabel: { flex: 1, fontSize: 17 },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 34,
    maxWidth: 200,
    borderRadius: 17,
    paddingHorizontal: 14,
  },
  choiceText: { fontSize: 16, fontWeight: '500', flexShrink: 1 },
});
