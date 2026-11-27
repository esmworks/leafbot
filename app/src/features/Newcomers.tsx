import type { PersonInfo } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { ActionCard, ActionCardCheck, ActionCardList } from '@/components/ui/action-card';
import { personName } from '@/features/PeopleTab';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { isSpace } from '@/lib/places';
import { useGroups, useManagesServer } from '@/lib/queries';

/** Those who wait for their team spaces to be chosen; only those who look after the server ask. */
export function useNewcomers() {
  const manages = useManagesServer();
  return useQuery({ queryKey: ['newcomers'], queryFn: api.newcomers, enabled: manages }).data ?? [];
}

/**
 * Someone who came and waits for their team spaces, asked of those who look after the server. Once
 * one of them chooses (even none), the person is placed for everyone.
 */
export function NewcomerCard({ person, onClose }: { person: PersonInfo; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: groups = [] } = useGroups();
  const spaces = groups.filter(isSpace);
  const [chosen, setChosen] = useState<string[]>([]);
  const place = useMutation({
    mutationFn: () => api.placeNewcomer(person.id, chosen),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['newcomers'] });
      void qc.invalidateQueries({ queryKey: ['groups'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const name = personName(person, t('people.owner'));
  const toggle = (id: string, on: boolean) => setChosen((c) => (on ? [...c, id] : c.filter((x) => x !== id)));
  return (
    <ActionCard
      role="dialog"
      aria-label={t('newcomer.joined', { name })}
      className="pointer-events-auto"
      title={t('newcomer.joined', { name })}
      description={spaces.length ? t('newcomer.choose') : t('newcomer.noSpaces')}
      closeLabel={t('actionCard.close')}
      onClose={onClose}
      actionLabel={t('newcomer.done')}
      onAction={() => place.mutate()}
      busy={place.isPending}
    >
      {spaces.length > 0 && (
        <ActionCardList>
          {spaces.map((g) => (
            <ActionCardCheck
              key={g.id}
              checked={chosen.includes(g.id)}
              onCheckedChange={(on) => toggle(g.id, on)}
            >
              {g.name}
            </ActionCardCheck>
          ))}
        </ActionCardList>
      )}
    </ActionCard>
  );
}
