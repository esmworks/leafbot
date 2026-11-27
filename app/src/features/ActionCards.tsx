import { useState } from 'react';
import { NewcomerCard, useNewcomers } from '@/features/Newcomers';
import { SecondYesCard, useSecondYes } from '@/features/SecondYes';

/** The cards this device closed without answering; kept here, not on the server. */
const CLOSED_KEY = 'leafbot.actionCards.closed';

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
 * The questions that wait on this person and need nothing else to answer, as cards at the bottom
 * right over the app: someone new to place in team spaces (for those who look after the server)
 * and a step that waits for this person's second yes. A card stays until it is answered, or closed,
 * which puts it away on this device only; Today still lists it.
 */
export function ActionCards() {
  const newcomers = useNewcomers();
  const second = useSecondYes();
  const [closed, setClosed] = useState(readClosed);
  const waiting = new Set([...newcomers.map((p) => p.id), ...second.map((s) => s.id)]);
  const close = (id: string) =>
    setClosed((c) => {
      // Those answered since are dropped, so the list does not grow with every card ever closed.
      const next = [...c.filter((x) => waiting.has(x)), id];
      try {
        localStorage.setItem(CLOSED_KEY, JSON.stringify(next));
      } catch {
        // Without storage it is put away until the app opens again.
      }
      return next;
    });
  const people = newcomers.filter((p) => !closed.includes(p.id));
  const steps = second.filter((s) => !closed.includes(s.id));
  if (!people.length && !steps.length) return null;
  return (
    // On a phone it sits above the bar at the bottom of the list. The newest card is nearest the
    // corner; the stack scrolls when it runs taller than the screen.
    <div className="pointer-events-none fixed end-4 bottom-24 z-40 flex max-h-[calc(100%-7rem)] max-w-[calc(100vw-2rem)] flex-col-reverse gap-3 overflow-y-auto p-0.5 md:bottom-4 md:max-h-[calc(100%-2rem)]">
      {steps.map((s) => (
        <SecondYesCard key={s.id} item={s} onClose={() => close(s.id)} />
      ))}
      {people.map((p) => (
        <NewcomerCard key={p.id} person={p} onClose={() => close(p.id)} />
      ))}
    </div>
  );
}
