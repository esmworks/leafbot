import type { PersonInfo } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { personName } from '@/features/PeopleTab';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { isSpace } from '@/lib/places';
import { useGroups, useManagesServer } from '@/lib/queries';
import './newcomer-card.css';

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
 * app of those who look after the server; its own dark colours keep it apart from the page. It stays until one of them chooses the spaces (even none),
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
    // The look of this card is adapted from Uiverse.io by iconicchandu
    // (https://uiverse.io/iconicchandu/slimy-pug-17, MIT License, Copyright (c) iconicchandu);
    // its styles and the notice are in newcomer-card.css.
    <section
      role="dialog"
      aria-label={t('newcomer.joined', { name })}
      className="newcomer-card pointer-events-auto"
    >
      <div className="newcomer-card__border" aria-hidden />
      <div className="newcomer-card__head">
        <div className="min-w-0">
          <span className="newcomer-card__title">{t('newcomer.joined', { name })}</span>
          <p className="newcomer-card__paragraph">
            {spaces.length ? t('newcomer.choose') : t('newcomer.noSpaces')}
          </p>
        </div>
        <button
          type="button"
          className="newcomer-card__close"
          onClick={onClose}
          aria-label={t('newcomer.close')}
          title={t('newcomer.close')}
        >
          <X className="size-4" />
        </button>
      </div>
      <hr className="newcomer-card__line" />
      {spaces.length > 0 && (
        <ul className="newcomer-card__list">
          {spaces.map((g) => (
            <li key={g.id}>
              <label className="newcomer-card__item">
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={chosen.includes(g.id)}
                  onChange={(e) => toggle(g.id, e.target.checked)}
                />
                <span className="newcomer-card__check" aria-hidden>
                  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
                    <path
                      clipRule="evenodd"
                      d="M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 0 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z"
                      fillRule="evenodd"
                    />
                  </svg>
                </span>
                <span className="newcomer-card__text min-w-0 truncate">{g.name}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="newcomer-card__button"
        disabled={place.isPending}
        onClick={() => place.mutate()}
      >
        {t('newcomer.done')}
      </button>
    </section>
  );
}
