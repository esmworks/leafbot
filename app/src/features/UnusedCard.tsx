import { UNUSED_DAYS } from '@leafbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useUnused } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { Card, Row } from './SettingsPage';

type Kind = 'skill' | 'connection' | 'bot';

/**
 * Skills and bots not used for a while, and connections no bot can use, each with the usual way to
 * clear it away. Nothing here goes by itself; a skill or connection removed is gone for good, so
 * that is asked first, and a bot archived can be taken back.
 */
export function UnusedCard() {
  const t = useT();
  const { dayLabel } = useFormat();
  const { data } = useUnused();
  if (!data) return null;
  const empty = !data.skills.length && !data.connections.length && !data.bots.length;
  return (
    <Card title={t('unused.title')}>
      <Row
        label={empty ? t('unused.none') : t('unused.found')}
        hint={t('unused.hint', { days: UNUSED_DAYS })}
      />
      {data.skills.map((s) => (
        <Item
          key={s.id}
          kind="skill"
          id={s.id}
          name={s.name}
          hint={
            s.lastUsedAt ? t('unused.skillLast', { when: dayLabel(s.lastUsedAt) }) : t('unused.skillNever')
          }
        />
      ))}
      {data.connections.map((c) => (
        <Item
          key={c.id}
          kind="connection"
          id={c.id}
          name={c.name}
          hint={c.reason === 'noBot' ? t('unused.connectionNoBot') : t('unused.connectionSignedOut')}
        />
      ))}
      {data.bots.map((b) => (
        <Item
          key={b.id}
          kind="bot"
          id={b.id}
          name={b.name}
          hint={b.lastTurnAt ? t('unused.botLast', { when: dayLabel(b.lastTurnAt) }) : t('unused.botNever')}
        />
      ))}
    </Card>
  );
}

function Item({ kind, id, name, hint }: { kind: Kind; id: string; name: string; hint: string }) {
  const t = useT();
  const qc = useQueryClient();
  const fail = (e: unknown) => toast.error((e as Error).message);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['unused'] });
    void qc.invalidateQueries({
      queryKey: [kind === 'skill' ? 'skills' : kind === 'connection' ? 'connections' : 'bots'],
    });
  };
  const act = useMutation({
    mutationFn: async () => {
      if (kind === 'skill') {
        if (!confirm(t('unused.removeSkillConfirm', { name }))) return false;
        await api.removeSkill(id);
      } else if (kind === 'connection') {
        if (!confirm(t('unused.removeConnectionConfirm', { name }))) return false;
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
      if (useUi.getState().botId === id) useUi.getState().selectBot(null);
      toast.success(t('sidebarMenu.archived', { name }), {
        // Long enough to notice the wrong bot went and take it back.
        duration: 10_000,
        action: {
          label: t('sidebarMenu.undo'),
          onClick: () => void api.restoreBot(id).then(refresh, fail),
        },
      });
    },
    onError: fail,
  });
  return (
    <Row label={`${t(`unused.kind.${kind}`)} · ${name}`} hint={hint}>
      <Button
        type="button"
        size="sm"
        variant={kind === 'bot' ? 'secondary' : 'ghost'}
        className="rounded-full"
        disabled={act.isPending}
        onClick={() => act.mutate()}
      >
        {kind === 'bot' ? t('unused.archive') : t('unused.remove')}
      </Button>
    </Row>
  );
}
