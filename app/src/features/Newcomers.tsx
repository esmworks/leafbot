import type { PersonInfo } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
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
 * A box at the bottom right, in the app's own green so it does not pass for part of the page, for each person who came and waits for their team spaces, over the app
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
    // On a phone it sits above the bar at the bottom of the list.
    <div className="pointer-events-none fixed end-4 bottom-24 z-40 flex max-h-[calc(100%-7rem)] w-80 max-w-[calc(100vw-2rem)] flex-col-reverse gap-3 overflow-y-auto md:bottom-4 md:max-h-[calc(100%-2rem)]">
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
      className="pointer-events-auto rounded-2xl bg-[var(--brand)] p-4 text-sm text-white shadow-xl ring-1 ring-black/10"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-white/15">
          <UserPlus className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{t('newcomer.joined', { name })}</div>
          <p className="mt-0.5 text-xs text-white/80">
            {spaces.length ? t('newcomer.choose') : t('newcomer.noSpaces')}
          </p>
        </div>
        <button
          type="button"
          className="-me-1 -mt-1 flex size-7 shrink-0 items-center justify-center rounded-lg text-white/80 hover:bg-white/15 hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
          onClick={onClose}
          aria-label={t('newcomer.close')}
          title={t('newcomer.close')}
        >
          <X className="size-4" />
        </button>
      </div>
      {spaces.length > 0 && (
        <div className="mt-3 space-y-1">
          {spaces.map((g) => (
            <label
              key={g.id}
              className="flex cursor-pointer items-center gap-2.5 rounded-md bg-white/10 px-2.5 py-1.5 hover:bg-white/15"
            >
              <input
                type="checkbox"
                className="size-4 accent-white"
                checked={chosen.includes(g.id)}
                onChange={(e) => toggle(g.id, e.target.checked)}
              />
              <span className="min-w-0 truncate">{g.name}</span>
            </label>
          ))}
        </div>
      )}
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          className="h-8 rounded-sm bg-white px-4 text-sm font-medium text-[var(--brand)] hover:bg-white/90 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none disabled:opacity-60"
          disabled={place.isPending}
          onClick={() => place.mutate()}
        >
          {t('newcomer.done')}
        </button>
      </div>
    </section>
  );
}
