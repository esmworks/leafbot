import type { PersonInfo } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
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
 * A card for each person who came and waits for their team spaces, at the top of the sidebar of
 * those who look after the server. Choosing (even none) places them for everyone; "Later" only
 * puts the card away on this screen until the app opens again.
 */
export function NewcomerCards() {
  const newcomers = useNewcomers();
  const [later, setLater] = useState<string[]>([]);
  const shown = newcomers.filter((p) => !later.includes(p.id));
  if (!shown.length) return null;
  return (
    <div className="mb-2 space-y-2 px-1">
      {shown.map((p) => (
        <NewcomerCard key={p.id} person={p} onLater={() => setLater((l) => [...l, p.id])} />
      ))}
    </div>
  );
}

function NewcomerCard({ person, onLater }: { person: PersonInfo; onLater: () => void }) {
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
    <section aria-label={t('newcomer.joined', { name })} className="rounded-xl border bg-card/70 p-3 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <UserPlus className="size-4 shrink-0 text-primary" />
        <span className="min-w-0 truncate">{t('newcomer.joined', { name })}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {spaces.length ? t('newcomer.choose') : t('newcomer.noSpaces')}
      </p>
      {spaces.length > 0 && (
        <div className="mt-2 space-y-1">
          {spaces.map((g) => (
            <label key={g.id} className="flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-accent/50">
              <input
                type="checkbox"
                checked={chosen.includes(g.id)}
                onChange={(e) => toggle(g.id, e.target.checked)}
              />
              <span className="min-w-0 truncate">{g.name}</span>
            </label>
          ))}
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <Button size="sm" className="rounded-lg" disabled={place.isPending} onClick={() => place.mutate()}>
          {t('newcomer.done')}
        </Button>
        <Button size="sm" variant="ghost" className="rounded-lg" onClick={onLater}>
          {t('newcomer.later')}
        </Button>
      </div>
    </section>
  );
}
