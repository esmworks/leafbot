import {
  askText,
  duration,
  findingText,
  healthFix,
  type Routine,
  type RoutineHealthFinding,
} from '@leafbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Text } from 'react-native';
import { confirm, toast, toastError } from '@/components/overlay';
import { Row, Section } from '@/components/page';
import { usd } from '@/components/settings/more/money';
import { Pad, Rows } from '@/components/settings/common/controls';
import { locale, t } from '@/i18n';
import { formatters } from '@/lib/format';
import { nav } from '@/lib/nav';
import { useRoutineHealth } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { loadStored, writeStored } from '@/lib/stored';
import { useColors } from '@/lib/theme';

const fmt = formatters(locale, t);

/**
 * A routine's health on its page, as on the web: how its runs of the last 30 days ended, what they
 * cost, and what in them is worth changing, each with what can be done about it.
 */
export function RoutineHealthSection({ routine, locked }: { routine: Routine; locked: boolean }) {
  const { data } = useRoutineHealth();
  const h = data?.find((x) => x.routineId === routine.id);
  if (!h) return null;
  const open = h.runs.total - h.runs.ok - h.runs.quiet - h.runs.failed;
  const facts = [
    t('health.window'),
    t('health.runs', { total: h.runs.total, ok: h.runs.ok, quiet: h.runs.quiet, failed: h.runs.failed }),
    ...(open > 0 ? [t('health.open', { count: open })] : []),
    ...(h.runs.skipped > 0 ? [t('health.skipped', { count: h.runs.skipped })] : []),
    t('health.cost', { cost: usd(h.costUsd) }) +
      (h.unpricedRuns ? ` (${t('health.unpriced', { count: h.unpricedRuns })})` : ''),
    ...(h.avgMs !== null ? [t('health.avg', { time: duration(h.avgMs, t) })] : []),
  ];
  return (
    <Section
      title={t('health.title')}
      footer={h.since ? t('health.since', { when: fmt.dayLabel(h.since) }) : t('health.notMeasured')}
    >
      <Rows>
        <Row label={t(`health.status.${h.status}`)} detail={facts.join(' · ')} detailLines={0} />
        {h.findings.map((f) => (
          <Finding key={`${f.id}-${f.step ?? ''}`} routine={routine} finding={f} locked={locked} />
        ))}
        {h.hidden > 0 ? <Row label={t('health.hidden', { count: h.hidden })} /> : null}
      </Rows>
    </Section>
  );
}

function Finding({
  routine,
  finding,
  locked,
}: {
  routine: Routine;
  finding: RoutineHealthFinding;
  /** The page has changes not saved: applying would put them out of step with the saved routine. */
  locked: boolean;
}) {
  const api = useApi();
  const { origin } = useServer();
  const c = useColors();
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['routines', origin] });
    void qc.invalidateQueries({ queryKey: ['routine-health', origin] });
  };
  const fix = healthFix(routine, finding);
  const ask = askText(routine, finding, t);
  const apply = useMutation({
    mutationFn: async () => {
      if (!fix) return null;
      const yes = await confirm({
        title: t('health.applyConfirm', { step: fix.step, from: fix.from, to: fix.to }),
        confirmLabel: t('health.apply'),
      });
      if (!yes) return null;
      const before = routine.steps ?? [];
      await api.updateRoutine(routine.id, { steps: fix.steps });
      return before;
    },
    onSuccess: (before) => {
      if (!before) return;
      refresh();
      toast(t('health.applied'), {
        action: {
          label: t('health.undo'),
          onPress: () =>
            void api
              .updateRoutine(routine.id, { steps: before })
              .then(() => {
                toast(t('health.undone'));
                refresh();
              })
              .catch(toastError),
        },
      });
    },
    onError: toastError,
  });
  const asking = useMutation({
    // The message waits in the bot's main conversation for the person to read and send; nothing
    // is sent from here.
    mutationFn: async () => {
      const main = await api.mainThread(routine.botId);
      const key = `leafbot.draft.${origin}.${main.id}`;
      const kept = await loadStored<string>(key);
      writeStored(key, kept?.trim() ? `${kept}\n\n${ask}` : ask!);
      nav.chat(routine.botId, { threadId: main.id });
    },
    onError: toastError,
  });
  const dismiss = useMutation({
    mutationFn: () => api.dismissRoutineHealth(routine.id, finding.id),
    onSuccess: refresh,
    onError: toastError,
  });
  return (
    <>
      <Pad>
        <Text style={{ color: c.foreground, fontSize: 15 }}>{findingText(finding, t, usd)}</Text>
      </Pad>
      {fix ? (
        <Row
          icon="check"
          label={t('health.apply')}
          detail={locked ? t('health.saveFirst') : null}
          disabled={locked}
          busy={apply.isPending}
          onPress={() => apply.mutate()}
          chevron={false}
        />
      ) : null}
      {ask ? (
        <Row
          icon="message-circle"
          label={t('health.ask')}
          busy={asking.isPending}
          onPress={() => asking.mutate()}
          chevron={false}
        />
      ) : null}
      <Row
        icon="eye-off"
        label={t('health.dismiss')}
        busy={dismiss.isPending}
        onPress={() => dismiss.mutate()}
        chevron={false}
      />
    </>
  );
}
