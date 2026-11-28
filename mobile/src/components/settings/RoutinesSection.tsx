import { useMutation, useQueryClient } from '@tanstack/react-query';
import { needsAttention } from '@leafbot/shared';
import { Switch } from 'react-native';
import { toastError } from '@/components/overlay';
import { Avatar } from '@/components/Avatar';
import { Empty, Row, Section } from '@/components/page';
import { Rows } from './common/controls';
import { describeSchedule } from '@/components/panel/schedule';
import { locale, t } from '@/i18n';
import { formatters } from '@/lib/format';
import { nav } from '@/lib/nav';
import { useBots, useRoutineHealth, useRoutines } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

const fmt = formatters(locale, t);

/** The "routines" settings section's content, under the section's own title bar. */
export function RoutinesSection() {
  const api = useApi();
  const { origin } = useServer();
  const c = useColors();
  const { data: routines = [] } = useRoutines();
  const { data: bots = [] } = useBots();
  const { data: health = [] } = useRoutineHealth();
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (r: { id: string; enabled: boolean }) => api.updateRoutine(r.id, { enabled: !r.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['routines', origin] }),
    onError: toastError,
  });
  // Routines are added from a bot's panel, as the empty text says.
  if (!routines.length) {
    return (
      <Section>
        <Empty icon="clock" text={t('routines.empty')} />
      </Section>
    );
  }
  return (
    <Section>
      <Rows>
        {routines.map((r) => {
          const bot = bots.find((b) => b.id === r.botId);
          // Only a routine that wants a look says how it stands; the rest would only add noise.
          const h = health.find((x) => x.routineId === r.id);
          return (
            <Row
              key={r.id}
              label={r.name}
              detail={[
                h && needsAttention(h) ? t(`health.status.${h.status}`) : null,
                bot?.name,
                describeSchedule(r.schedule),
                r.reportOnly ? t('routine.reportOnlyShort') : null,
                r.pausedReason === 'failures' && !r.enabled ? t('panel.switchedOffFailures') : null,
                r.pausedReason === 'ended' && !r.enabled ? t('panel.ended') : null,
                r.lastRunAt ? t('routines.lastRun', { when: fmt.dayLabel(r.lastRunAt) }) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              onPress={() => nav.routine({ botId: r.botId, routineId: r.id })}
              chevron={false}
              right={
                <>
                  {bot ? <Avatar name={bot.name} color={bot.color} avatar={bot.avatar} size={28} /> : null}
                  <Switch
                    value={r.enabled}
                    onValueChange={() => toggle.mutate(r)}
                    trackColor={{ true: c.primary, false: c.muted }}
                    thumbColor={r.enabled ? c.primaryForeground : undefined}
                    accessibilityLabel={r.name}
                  />
                </>
              }
            />
          );
        })}
      </Rows>
    </Section>
  );
}
