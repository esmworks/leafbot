import type { PersonInfo } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus, X } from 'lucide-react';
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
 * A box at the top right for each person who came and waits for their team spaces, over the app
 * of those who look after the server. It stays until one of them chooses the spaces (even none),
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
    <div className="pointer-events-none fixed end-4 top-14 z-40 flex max-h-[calc(100%-4.5rem)] w-80 max-w-[calc(100vw-2rem)] flex-col gap-3 overflow-y-auto">
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
    <section
      role="dialog"
      aria-label={t('newcomer.joined', { name })}
      className="pointer-events-auto rounded-2xl border bg-popover p-4 text-sm text-popover-foreground shadow-lg"
    >
      <div className="flex items-center gap-2 font-medium">
        <UserPlus className="size-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate">{t('newcomer.joined', { name })}</span>
        <Button
          variant="ghost"
          size="icon"
          className="-me-2 size-7 rounded-lg"
          onClick={onClose}
          aria-label={t('newcomer.close')}
          title={t('newcomer.close')}
        >
          <X className="size-4" />
        </Button>
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
      </div>
    </section>
  );
}
