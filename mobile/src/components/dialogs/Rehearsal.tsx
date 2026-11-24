import type { Rehearsal as RehearsalRun, ReplayableRun, Routine } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { toastError } from '@/components/overlay';
import { PillButton, Section } from '@/components/page';
import { Chip, ChipRow, ChoiceRow, Hint, Pad, Rows } from '@/components/settings/common/controls';
import { usd } from '@/components/settings/more/money';
import { locale, t, type MessageKey } from '@/i18n';
import { formatters } from '@/lib/format';
import { useServer, useApi } from '@/lib/server';
import { useColors } from '@/lib/theme';
import { clock, rehearsalSeconds, startedBySomething, triggerKey } from '@/lib/turns';

const fmt = formatters(locale, t);
const NONE = 'none';

/**
 * Tries a routine once without doing anything, with the instruction as it is typed in the form and,
 * for a routine something else starts, with what started one of its last runs. The result lists
 * what the bot would have done and what it really did (only reading).
 */
export function Rehearsal({ routine, prompt }: { routine: Routine; prompt: string }) {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [replay, setReplay] = useState<string | null>(null);
  const { data: rehearsals = [] } = useQuery({
    queryKey: ['routine-rehearsals', origin, routine.id],
    queryFn: () => api.routineRehearsals(routine.id),
    enabled: open,
    // The server pushes no progress of its own, so a running rehearsal is asked about again.
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'running') ? 2000 : false),
  });
  const offersReplay = startedBySomething(routine);
  const { data: runs = [] } = useQuery({
    queryKey: ['routine-replayable', origin, routine.id],
    queryFn: () => api.routineReplayable(routine.id),
    enabled: open && offersReplay,
  });
  const replayable = runs.filter((r) => r.replayable);
  // The latest run that kept its input is the default.
  const picked = replay ?? replayable[0]?.runId ?? NONE;
  const shown = rehearsals.find((r) => r.id === chosen) ?? rehearsals[0] ?? null;
  const running = rehearsals.some((r) => r.status === 'running');
  const typed = prompt.trim();
  const draft = typed !== routine.prompt;

  const start = useMutation({
    mutationFn: () =>
      api.rehearseRoutine(routine.id, {
        ...(typed ? { prompt: typed } : {}),
        ...(picked !== NONE ? { replayRunId: picked } : {}),
      }),
    onSuccess: (r) => {
      setChosen(r.id);
      void qc.invalidateQueries({ queryKey: ['routine-rehearsals', origin, routine.id] });
    },
    // The server says plainly when this person may not rehearse the routine.
    onError: toastError,
  });

  const options = [
    { value: NONE, label: t('rehearsal.replayNone') },
    ...replayable.map((r: ReplayableRun) => ({
      value: r.runId,
      label: t('rehearsal.replayRun', { when: fmt.dayLabel(r.startedAt), trigger: t(triggerKey(r.trigger)) }),
    })),
  ];

  return (
    <Section>
      <Rows>
        <Pad>
          <PillButton
            icon="activity"
            label={t('rehearsal.title')}
            variant={open ? 'primary' : 'secondary'}
            onPress={() => {
              setOpen(!open);
              // Opened again, the latest run that kept its input is the default again.
              setReplay(null);
            }}
          />
        </Pad>
        {open ? (
          <Pad>
            <Hint>{t('rehearsal.hint')}</Hint>
            <Hint>{draft ? t('rehearsal.draftNote') : t('rehearsal.savedNote')}</Hint>
          </Pad>
        ) : null}
        {open && offersReplay ? (
          <>
            <ChoiceRow label={t('rehearsal.replay')} value={picked} options={options} onChange={setReplay} />
            {runs.some((r) => !r.replayable) || !runs.length ? (
              <Pad>
                {runs.some((r) => !r.replayable) ? <Hint>{t('rehearsal.replayOlder')}</Hint> : null}
                {!runs.length ? <Hint>{t('rehearsal.replayNoRuns')}</Hint> : null}
              </Pad>
            ) : null}
          </>
        ) : null}
        {open ? (
          <Pad>
            <PillButton
              icon="play"
              variant="primary"
              label={running ? t('rehearsal.running') : t('rehearsal.run')}
              busy={start.isPending || running}
              disabled={!typed || start.isPending || running}
              onPress={() => start.mutate()}
            />
            {rehearsals.length > 1 ? (
              <ChipRow>
                {rehearsals.map((r) => (
                  <Chip
                    key={r.id}
                    on={r.id === shown?.id}
                    label={fmt.dayLabel(r.startedAt)}
                    onPress={() => setChosen(r.id)}
                  />
                ))}
              </ChipRow>
            ) : null}
            {shown ? <Result rehearsal={shown} /> : null}
            <Hint>{t('rehearsal.kept')}</Hint>
          </Pad>
        ) : null}
      </Rows>
    </Section>
  );
}

function Result({ rehearsal: r }: { rehearsal: RehearsalRun }) {
  const c = useColors();
  const took = rehearsalSeconds(r);
  const would = r.steps.filter((s) => s.kind === 'would');
  const ran = r.steps.filter((s) => s.kind === 'ran');
  return (
    <View style={styles.result}>
      <Text style={[styles.small, { color: c.mutedForeground }]}>
        <Text style={[styles.strong, { color: c.foreground }]}>
          {t(`rehearsal.status.${r.status}` as MessageKey)}
        </Text>
        {r.draft ? ` · ${t('rehearsal.draftTag')}` : ''}
        {r.model ? ` · ${t('rehearsal.modelTag', { model: r.model })}` : ''}
        {took !== null ? ` · ${t('rehearsal.duration', { time: clock(took) })}` : ''}
        {r.costUsd !== null ? ` · ${t('rehearsal.cost', { cost: usd(r.costUsd) })}` : ''}
      </Text>
      {r.error ? (
        <Text style={[styles.body, { color: c.destructive }]}>
          {t('rehearsal.error', { message: r.error })}
        </Text>
      ) : null}
      <Report title={t('rehearsal.report')} text={r.report} empty={t('rehearsal.noReport')} />
      {r.replay ? (
        <Report
          title={t('rehearsal.actual', { when: fmt.dayLabel(r.replay.startedAt) })}
          text={r.replay.report ?? ''}
          empty={t('rehearsal.noActual')}
        />
      ) : null}
      <Steps title={t('rehearsal.would')} steps={would} empty={t('rehearsal.wouldNone')} numbered />
      <Steps title={t('rehearsal.ran')} steps={ran} empty={t('rehearsal.ranNone')} />
    </View>
  );
}

function Report({ title, text, empty }: { title: string; text: string; empty: string }) {
  const c = useColors();
  return (
    <View style={styles.block}>
      <Text style={[styles.title, { color: c.mutedForeground }]}>{title}</Text>
      <View style={[styles.report, { backgroundColor: c.muted }]}>
        {text.trim() ? (
          <Text selectable style={[styles.body, { color: c.foreground }]}>
            {text}
          </Text>
        ) : (
          <Text style={[styles.body, { color: c.mutedForeground }]}>{empty}</Text>
        )}
      </View>
    </View>
  );
}

function Steps({
  title,
  steps,
  empty,
  numbered,
}: {
  title: string;
  steps: RehearsalRun['steps'];
  empty: string;
  numbered?: boolean;
}) {
  const c = useColors();
  return (
    <View style={styles.block}>
      <Text style={[styles.title, { color: c.mutedForeground }]}>{title}</Text>
      {steps.length ? (
        steps.map((s, i) => (
          <Text key={`${s.at}-${i}`} style={[styles.body, { color: c.foreground }]}>
            {numbered ? `${i + 1}. ` : ''}
            {s.summary}
          </Text>
        ))
      ) : (
        <Text style={[styles.body, { color: c.mutedForeground }]}>{empty}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  result: { gap: 12, paddingTop: 4 },
  block: { gap: 4 },
  title: { fontSize: 14, fontWeight: '600' },
  small: { fontSize: 14, lineHeight: 20 },
  strong: { fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 22 },
  report: { borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
});
