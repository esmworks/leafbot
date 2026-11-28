import {
  planPace,
  planTone,
  ROUTINE_GATE_MODES,
  USAGE_RANGES,
  type PlanWindow,
  type UsageRange,
  type UsageReport,
} from '@leafbot/shared';
import { useState, type ReactNode } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { Loading, Note, PillButton, Row, Section, Segments, SwitchRow } from '@/components/page';
import { fileSize, shareFile } from '@/components/panel/files';
import { ChoiceRow, Hint, Pad, Rows, useSaveSettings } from './common/controls';
import { usd } from './more/money';
import { UnusedCard } from './more/Unused';
import { BotMark, DailyChart, ShareBar, UsageCard, UsageLine } from './more/usageParts';
import { locale, t } from '@/i18n';
import { formatters } from '@/lib/format';
import { useBots, useSettings, useStorage, useUsage } from '@/lib/queries';
import { nav } from '@/lib/nav';
import { useColors } from '@/lib/theme';

/** The bot filter's value for every bot; bot ids never take this form. */
const ALL = '*';

/** The "usage" settings section's content: a total, the cost per day, per bot, model and routine. */
const fmt = formatters(locale, t);

export function UsageSection() {
  const c = useColors();
  const [days, setDays] = useState<UsageRange>(30);
  const [botId, setBotId] = useState<string | null>(null);
  const { data, isPending, isError } = useUsage(days, botId ?? undefined);
  const { data: bots = [] } = useBots();
  const [busy, setBusy] = useState(false);
  return (
    <>
      <View style={styles.head}>
        <Text style={[styles.small, { color: c.mutedForeground }]}>{t('usage.total')}</Text>
        <Text style={[styles.total, { color: c.foreground }]}>{data ? usd(data.total.costUsd) : '–'}</Text>
        <Text style={[styles.small, { color: c.mutedForeground }]}>
          {data ? t('usage.turnCount', { count: data.total.turns }) : ' '}
        </Text>
      </View>
      <Segments
        value={String(days)}
        onChange={(v) => setDays(Number(v) as UsageRange)}
        options={USAGE_RANGES.map((d) => ({ value: String(d), label: t(`usage.range.${d}`) }))}
      />
      <Section>
        <ChoiceRow
          icon="cpu"
          label={t('usage.botFilter')}
          value={botId ?? ALL}
          options={[
            { value: ALL, label: t('usage.allBots') },
            ...bots.map((b) => ({ value: b.id, label: b.name })),
          ]}
          onChange={(v) => setBotId(v === ALL ? null : v)}
        />
      </Section>
      {isPending ? (
        <Loading />
      ) : isError || !data ? (
        <Note>{t('usage.failed')}</Note>
      ) : (
        <Report data={data} filtered={botId !== null} onPickBot={setBotId} />
      )}
      <PlanUsage plan={data?.plan} />
      <MonthLimit month={data?.month} />
      <RoutineGate gate={data?.gate} />
      <PromiseNet net={data?.promises} />
      <TidyNet net={data?.tidy} />
      <SkillNet net={data?.skillSuggestions} />
      <BackgroundNet calls={data?.background} />
      <Parallel parallel={data?.parallel} />
      <Storage />
      <UnusedCard />
      <PillButton
        icon="download"
        label={t('usage.downloadCsv')}
        busy={busy}
        onPress={async () => {
          setBusy(true);
          await shareFile(`/api/usage/turns.csv?days=${days}`, 'leafbot-usage.csv');
          setBusy(false);
        }}
      />
    </>
  );
}

/**
 * How much room the bots' folders take on the server, with each bot's largest conversations.
 * Read only: room is freed by deleting a conversation, which a row opens.
 */
function Storage() {
  const { data, isPending, isError } = useStorage();
  const { data: bots = [] } = useBots();
  /** A size the walk did not finish counting is at least what it says. */
  const size = (bytes: number, partial = false) =>
    partial ? t('storage.atLeast', { size: fileSize(bytes) }) : fileSize(bytes);
  const largest = Math.max(
    1,
    ...(data ? [...data.bots, ...data.groups, data.staged].map((r) => r.bytes) : []),
  );
  return (
    <Section title={t('storage.title')}>
      {isPending ? (
        <Loading />
      ) : isError || !data ? (
        <Note>{t('storage.failed')}</Note>
      ) : (
        <Rows>
          <Row
            label={size(data.total, data.capped)}
            detail={data.capped ? t('storage.capped') : t('storage.hint')}
            detailLines={0}
          />
          {data.bots
            .filter((b) => b.bytes > 0 || b.partial)
            .map((b) => {
              const bot = bots.find((x) => x.id === b.botId);
              return (
                <View key={b.botId}>
                  <UsageSize
                    lead={<BotMark name={b.name ?? '?'} color={bot?.color} avatar={bot?.avatar} />}
                    name={b.name ?? t('storage.removedBot')}
                    note={b.archived ? t('usage.archived') : null}
                    size={size(b.bytes, b.partial)}
                    share={b.bytes / largest}
                  />
                  {b.own.bytes > 0 ? (
                    <Row label={t('storage.ownFolder')} value={size(b.own.bytes, b.own.partial)} />
                  ) : null}
                  {b.threads.map((th) =>
                    b.name && th.title !== null ? (
                      <Row
                        key={th.threadId}
                        label={th.title || t('chat.newThread')}
                        value={size(th.bytes, th.partial)}
                        onPress={() => nav.chat(b.botId, { threadId: th.threadId })}
                      />
                    ) : (
                      <Row
                        key={th.threadId}
                        label={t('storage.removedThread')}
                        value={size(th.bytes, th.partial)}
                      />
                    ),
                  )}
                </View>
              );
            })}
          {data.groups
            .filter((g) => g.bytes > 0 || g.partial)
            .map((g) => (
              <UsageSize
                key={g.groupId}
                name={t('storage.group', { name: g.name ?? t('storage.removedGroup') })}
                size={size(g.bytes, g.partial)}
                share={g.bytes / largest}
              />
            ))}
          {data.staged.bytes > 0 || data.staged.partial ? (
            <Row
              label={t('storage.staged')}
              detail={t('storage.stagedHint')}
              value={size(data.staged.bytes, data.staged.partial)}
            />
          ) : null}
        </Rows>
      )}
    </Section>
  );
}

/** A folder's line: who it belongs to, its size, and its part of the largest. */
function UsageSize({
  lead,
  name,
  note,
  size,
  share,
}: {
  lead?: ReactNode;
  name: string;
  note?: string | null;
  size: string;
  share: number;
}) {
  const c = useColors();
  return (
    <Pad>
      <View style={styles.sizeRow}>
        {lead}
        <View style={styles.sizeName}>
          <Text style={[styles.sizeLabel, { color: c.foreground }]} numberOfLines={1}>
            {name}
            {note ? <Text style={{ color: c.mutedForeground }}>{` · ${note}`}</Text> : null}
          </Text>
          <ShareBar share={share} />
        </View>
        <Text style={[styles.small, { color: c.foreground }]}>{size}</Text>
      </View>
    </Pad>
  );
}

/** This month's spending against the limit, and the limit itself (empty or 0 for none). */
function MonthLimit({ month }: { month?: UsageReport['month'] }) {
  const c = useColors();
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  const [draft, setDraft] = useState<string | null>(null);
  const limit = settings?.monthlyLimitUsd ?? 0;
  const value = draft ?? (limit ? String(limit) : '');
  const commit = () => {
    if (draft === null) return;
    const n = Number(draft.replace(',', '.'));
    setDraft(null);
    if (!Number.isFinite(n) || n < 0 || n === limit) return;
    save.mutate({ monthlyLimitUsd: Math.round(n * 100) / 100 });
  };
  const share = month && month.limitUsd > 0 ? Math.min(1, month.costUsd / month.limitUsd) : 0;
  return (
    <Section title={t('usage.month')}>
      <Rows>
        <Row
          label={month ? usd(month.costUsd) : '–'}
          detail={
            month && month.limitUsd > 0
              ? t('usage.monthOf', { limit: usd(month.limitUsd) })
              : t('usage.noLimit')
          }
          right={
            <View style={styles.limit}>
              <Text style={[styles.small, { color: c.mutedForeground }]}>{t('usage.limit')}</Text>
              <TextInput
                value={value}
                onChangeText={setDraft}
                onBlur={commit}
                onSubmitEditing={commit}
                keyboardType="decimal-pad"
                placeholder="0"
                placeholderTextColor={c.mutedForeground}
                accessibilityLabel={t('usage.limit')}
                style={[
                  styles.input,
                  { color: c.foreground, borderColor: c.border, backgroundColor: c.muted },
                ]}
              />
            </View>
          }
        />
        {month && month.limitUsd > 0 ? (
          <Pad>
            <ShareBar share={share} color={share >= 1 ? c.destructive : share >= 0.8 ? c.amber : c.success} />
          </Pad>
        ) : null}
      </Rows>
    </Section>
  );
}

const PLAN_LABELS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'] as const;

function planLabel(w: PlanWindow): string {
  if (w.label) return w.label;
  const known = PLAN_LABELS.find((k) => k === w.kind);
  return known ? t(`usage.plan.${known}`) : w.kind;
}

/** The Claude plan's usage windows, each a bar with a line where the window's time stands. */
function PlanUsage({ plan }: { plan?: UsageReport['plan'] }) {
  const c = useColors();
  // The time the page opened: the marks stay put while it is read.
  const [now] = useState(() => Date.now());
  if (!plan?.windows.length) return null;
  return (
    <Section title={t('usage.plan')}>
      <Pad>
        {plan.windows.map((w) => {
          const pace = planPace(w, now);
          const used = w.used ?? 0;
          const tone = planTone(w, now);
          const color = tone === 'near' ? c.destructive : tone === 'ahead' ? '#f59e0b' : c.primary;
          return (
            <View key={w.kind} style={styles.planRow}>
              <Text style={[styles.planName, { color: c.foreground }]}>{planLabel(w)}</Text>
              <Text style={[styles.small, { color: c.mutedForeground }]}>
                {w.used === null ? '–' : t('usage.plan.used', { percent: Math.round(used * 100) })}
                {w.resetsAt ? ` · ${t('usage.plan.resets', { time: fmt.dayLabel(w.resetsAt) })}` : ''}
              </Text>
              <View>
                <ShareBar share={used} color={color} />
                {pace !== null ? (
                  <View
                    style={[styles.paceMark, { left: `${pace * 100}%`, backgroundColor: c.foreground }]}
                  />
                ) : null}
              </View>
            </View>
          );
        })}
        <Hint>{t('usage.plan.hint')}</Hint>
        <Hint>{t('usage.plan.seen', { time: fmt.dayLabel(plan.at) })}</Hint>
      </Pad>
    </Section>
  );
}

/** How many turns may run at once; 0 leaves it to the server. */
function Parallel({ parallel }: { parallel?: UsageReport['parallel'] }) {
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  // A server older than the setting does not offer it.
  if (!parallel || settings?.maxTurns === undefined) return null;
  return (
    <Section>
      <ChoiceRow
        icon="layers"
        label={t('usage.parallel')}
        value={String(settings.maxTurns)}
        options={[0, 1, 2, 3, 4, 5, 6, 8, 10].map((n) => ({
          value: String(n),
          label: n === 0 ? t('usage.parallel.default', { count: parallel.serverDefault }) : String(n),
        }))}
        onChange={(v) => save.mutate({ maxTurns: Number(v) })}
      />
      <Pad>
        <Hint>{t('usage.parallel.hint')}</Hint>
      </Pad>
    </Section>
  );
}
/**
 * The small-model check before routine runs that a watched page, an app's check or a webhook
 * started: off, watching only, or on; and over the period, what it cost and what it would have saved.
 */
function RoutineGate({ gate }: { gate?: UsageReport['gate'] }) {
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  const mode = settings?.routineGate;
  // A server older than the check does not offer it.
  if (!mode) return null;
  return (
    <Section title={t('usage.gate')}>
      <Pad>
        <Segments
          value={mode}
          onChange={(m) => m !== mode && save.mutate({ routineGate: m })}
          options={ROUTINE_GATE_MODES.map((m) => ({ value: m, label: t(`usage.gate.choice.${m}`) }))}
        />
        <Hint>{t(`usage.gate.${mode}Hint`)}</Hint>
        {gate ? (
          <>
            <Hint>{t('usage.gate.checks', { count: gate.checks, cost: usd(gate.costUsd) })}</Hint>
            {gate.skippable > 0 ? (
              <Hint>
                {t('usage.gate.skippable', { count: gate.skippable, cost: usd(gate.skippableCostUsd) })}
              </Hint>
            ) : null}
            {gate.skipped > 0 ? <Hint>{t('usage.gate.skipped', { count: gate.skipped })}</Hint> : null}
          </>
        ) : null}
      </Pad>
    </Section>
  );
}

/** The promise safety net: on or off, and over the period what its looks at replies cost. */
function PromiseNet({ net }: { net?: UsageReport['promises'] }) {
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  const on = settings?.promiseKeeper;
  // A server older than the net does not offer it.
  if (on === undefined) return null;
  return (
    <Section title={t('usage.promises')} footer={t('usage.promises.hint')}>
      <SwitchRow
        label={t('usage.promises.on')}
        value={on}
        onChange={(promiseKeeper) => save.mutate({ promiseKeeper })}
      />
      {net ? (
        <Pad>
          <Hint>
            {t('usage.promises.checks', { count: net.checks, cost: usd(net.costUsd), found: net.found })}
          </Hint>
        </Pad>
      ) : null}
    </Section>
  );
}

/** The memory tidy-up's calls over the period, as on the web. */
function TidyNet({ net }: { net?: UsageReport['tidy'] }) {
  if (!net) return null;
  return (
    <Section title={t('usage.tidy')}>
      <Pad>
        <Hint>
          {t('usage.tidy.checks', {
            sets: net.sets,
            sources: net.sources,
            cost: usd(net.costUsd),
            changed: net.changed,
          })}
        </Hint>
      </Pad>
    </Section>
  );
}

/** The skill suggestions' calls over the period, as on the web. */
function SkillNet({ net }: { net?: UsageReport['skillSuggestions'] }) {
  if (!net) return null;
  return (
    <Section title={t('usage.skillSuggestions')}>
      <Pad>
        <Hint>
          {t('usage.skillSuggestions.checks', {
            count: net.checks,
            cost: usd(net.costUsd),
            found: net.found,
          })}
        </Hint>
      </Pad>
    </Section>
  );
}

/** The other background calls over the period, one line per kind, as on the web. */
function BackgroundNet({ calls }: { calls?: UsageReport['background'] }) {
  if (!calls?.length) return null;
  return (
    <Section title={t('usage.background')}>
      <Rows>
        {calls.map((c) => (
          <Row
            key={c.kind}
            label={t(`usage.background.${c.kind}`)}
            detail={t('usage.background.line', { count: c.calls, cost: usd(c.costUsd) })}
          />
        ))}
      </Rows>
    </Section>
  );
}

function Report({
  data,
  filtered,
  onPickBot,
}: {
  data: UsageReport;
  filtered: boolean;
  onPickBot: (botId: string) => void;
}) {
  const { data: bots = [] } = useBots();
  const byId = new Map(bots.map((b) => [b.id, b]));
  const share = (cost: number) => (data.total.costUsd > 0 ? cost / data.total.costUsd : 0);
  return (
    <>
      <Section title={t('usage.daily')}>
        <Pad>
          <DailyChart daily={data.daily} />
        </Pad>
      </Section>
      {!filtered ? (
        <UsageCard title={t('usage.bots')} empty={data.bots.length === 0}>
          {data.bots.map((b) => {
            const bot = byId.get(b.botId);
            return (
              <UsageLine
                key={b.botId}
                lead={<BotMark name={b.name || '–'} color={bot?.color} avatar={bot?.avatar} />}
                name={b.name || '–'}
                note={b.archived ? t('usage.archived') : null}
                turns={b.turns}
                cost={b.costUsd}
                share={share(b.costUsd)}
                onPress={() => onPickBot(b.botId)}
              />
            );
          })}
        </UsageCard>
      ) : null}
      <UsageCard title={t('usage.models')} empty={data.models.length === 0}>
        {data.models.map((m) => (
          <UsageLine
            key={`${m.engine}:${m.model}`}
            name={m.model || (m.engine ? t('usage.defaultModel') : t('usage.unknownModel'))}
            note={
              m.engine === 'acp'
                ? t('bot.engine.acp', { name: m.model ?? '' })
                : m.engine
                  ? t(`bot.engine.${m.engine}`)
                  : null
            }
            turns={m.turns}
            cost={m.costUsd}
            share={share(m.costUsd)}
          />
        ))}
      </UsageCard>
      {data.routines?.length ? (
        <UsageCard title={t('usage.routines')} empty={false}>
          {data.routines.map((r) => {
            const bot = r.botId ? byId.get(r.botId) : undefined;
            return (
              <UsageLine
                key={r.routineId}
                name={r.name}
                note={bot && !filtered ? bot.name : null}
                turns={r.turns}
                cost={r.costUsd}
                share={share(r.costUsd)}
              />
            );
          })}
        </UsageCard>
      ) : null}
      <View style={styles.notes}>
        <Note>{t('usage.estimate')}</Note>
        {data.total.unpriced > 0 ? <Note>{t('usage.unpriced', { count: data.total.unpriced })}</Note> : null}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  sizeRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  sizeName: { flex: 1, minWidth: 0, gap: 6 },
  sizeLabel: { fontSize: 15 },
  small: { fontSize: 15 },
  planRow: { gap: 6, marginBottom: 14 },
  planName: { fontSize: 16, fontWeight: '500' },
  paceMark: {
    position: 'absolute',
    top: -3,
    bottom: -3,
    width: 2,
    marginLeft: -1,
    borderRadius: 1,
    opacity: 0.6,
  },
  total: { fontSize: 32, fontWeight: '600', fontVariant: ['tabular-nums'] },
  limit: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: {
    width: 84,
    height: 38,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    fontSize: 17,
    textAlign: 'right',
  },
  head: { paddingHorizontal: 16 },
  // Lined up with the section titles; each note adds a little of its own.
  notes: { gap: 4, paddingHorizontal: 12 },
});
