import { UNUSED_DAYS, type UnusedReport } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { confirm, toast, toastError } from '@/components/overlay';
import { Row, Section } from '@/components/page';
import { Rows } from '../common/controls';
import { locale, t, type MessageKey } from '@/i18n';
import { formatters } from '@/lib/format';
import { useApi, useServer } from '@/lib/server';

const fmt = formatters(locale, t);

type Kind = 'skill' | 'connection' | 'bot';

/**
 * Skills and bots not used for a while, and connections no bot can use, each with the usual way to
 * clear it away. Nothing here goes by itself; a skill or connection removed is gone for good, so
 * that is asked first, and a bot archived can be taken back.
 */
export function UnusedCard() {
  const api = useApi();
  const { origin } = useServer();
  const { data } = useQuery({ queryKey: ['unused', origin], queryFn: api.unused, staleTime: 60_000 });
  if (!data) return null;
  const empty = !data.skills.length && !data.connections.length && !data.bots.length;
  return (
    <Section title={t('unused.title')}>
      <Rows>
        <Row
          label={empty ? t('unused.none') : t('unused.found')}
          detail={t('unused.hint', { days: UNUSED_DAYS })}
          detailLines={0}
        />
        {data.skills.map((s) => (
          <Item
            key={s.id}
            kind="skill"
            id={s.id}
            name={s.name}
            hint={
              s.lastUsedAt
                ? t('unused.skillLast', { when: fmt.dayLabel(s.lastUsedAt) })
                : t('unused.skillNever')
            }
          />
        ))}
        {data.connections.map((c) => (
          <Item key={c.id} kind="connection" id={c.id} name={c.name} hint={reasonText(c.reason)} />
        ))}
        {data.bots.map((b) => (
          <Item
            key={b.id}
            kind="bot"
            id={b.id}
            name={b.name}
            hint={
              b.lastTurnAt ? t('unused.botLast', { when: fmt.dayLabel(b.lastTurnAt) }) : t('unused.botNever')
            }
          />
        ))}
      </Rows>
    </Section>
  );
}

const reasonText = (reason: UnusedReport['connections'][number]['reason']) =>
  reason === 'noBot' ? t('unused.connectionNoBot') : t('unused.connectionSignedOut');

function Item({ kind, id, name, hint }: { kind: Kind; id: string; name: string; hint: string }) {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['unused', origin] });
    void qc.invalidateQueries({
      queryKey: [kind === 'skill' ? 'skills' : kind === 'connection' ? 'connections' : 'bots', origin],
    });
  };
  const act = useMutation({
    mutationFn: async () => {
      if (kind === 'skill') {
        if (!(await ask(t('unused.removeSkillConfirm', { name })))) return false;
        await api.removeSkill(id);
      } else if (kind === 'connection') {
        if (!(await ask(t('unused.removeConnectionConfirm', { name })))) return false;
        await api.removeConnection(id);
      } else {
        await api.archiveBot(id);
      }
      return true;
    },
    onSuccess: (done) => {
      if (!done) return;
      refresh();
      if (kind !== 'bot') return;
      toast(t('sidebarMenu.archived', { name }), {
        action: {
          label: t('sidebarMenu.undo'),
          onPress: () => void api.restoreBot(id).then(refresh, toastError),
        },
      });
    },
    onError: toastError,
  });
  return (
    <Row
      label={`${t(`unused.kind.${kind}` as MessageKey)} · ${name}`}
      detail={hint}
      value={kind === 'bot' ? t('unused.archive') : t('unused.remove')}
      chevron={false}
      busy={act.isPending}
      onPress={() => act.mutate()}
    />
  );
}

/** A removal that cannot be undone, asked in the phone's alert. */
const ask = (title: string) => confirm({ title, destructive: true, confirmLabel: t('unused.remove') });
