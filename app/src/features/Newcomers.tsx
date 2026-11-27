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

/** The newcomers this device closed the box of without choosing; kept here, not on the server. */
const CLOSED_KEY = 'leafbot.newcomers.closed';

function readClosed(): string[] {
  try {
    const raw = localStorage.getItem(CLOSED_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * A card at the bottom right for each person who came and waits for their team spaces, over the
 * app of those who look after the server. It stays until one of them chooses the spaces (even none),
 * which places the person for everyone, or closes it, which puts it away on this device only; the
 * person is still listed in Today.
 */
export function NewcomerBoxes() {
  const newcomers = useNewcomers();
  const [closed, setClosed] = useState(readClosed);
  const close = (id: string) =>
    setClosed((c) => {
      const next = [...c, id];
      try {
        localStorage.setItem(CLOSED_KEY, JSON.stringify(next));
      } catch {
        // Without storage it is put away until the app opens again.
      }
      return next;
    });
  const shown = newcomers.filter((p) => !closed.includes(p.id));
  if (!shown.length) return null;
  return (
    // On a phone it sits above the bar at the bottom of the list.
    <div className="pointer-events-none fixed end-4 bottom-24 z-40 flex max-h-[calc(100%-7rem)] max-w-[calc(100vw-2rem)] flex-col-reverse gap-3 overflow-y-auto p-0.5 md:bottom-4 md:max-h-[calc(100%-2rem)]">
      {shown.map((p) => (
        <NewcomerCard key={p.id} person={p} onClose={() => close(p.id)} />
      ))}
    </div>
  );
}

function NewcomerCard({ person, onClose }: { person: PersonInfo; onClose: () => void }) {
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
      closeLabel={t('newcomer.close')}
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
