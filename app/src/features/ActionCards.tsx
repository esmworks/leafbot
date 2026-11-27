import { create } from 'zustand';
import { NewcomerCard, useNewcomers } from '@/features/Newcomers';
import { RoomAddedCard, useRoomsAddedTo } from '@/features/Rooms';
import { SecondYesCard, useSecondYes } from '@/features/SecondYes';
import { SpaceRequestCard, useSpaceRequests } from '@/features/SpaceRequests';

/** The cards this device closed without answering; kept here, not on the server. */
const CLOSED_KEY = 'leafbot.actionCards.closed';

/** How many closed cards a device remembers; far more than ever wait at once. */
const KEEP_CLOSED = 200;

function readClosed(): string[] {
  try {
    const raw = localStorage.getItem(CLOSED_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function keep(ids: string[]) {
  try {
    localStorage.setItem(CLOSED_KEY, JSON.stringify(ids));
  } catch {
    // Without storage a card is put away until the app opens again.
  }
}

/**
 * Which cards are put away on this device. Today opens one again: a card closed by mistake is
 * not lost while its question waits.
 */
export const useClosedCards = create<{
  closed: string[];
  close: (id: string) => void;
  reopen: (id: string) => void;
}>((set) => ({
  closed: readClosed(),
  close: (id) =>
    set(({ closed }) => {
      // Only the latest are kept, so the list does not grow with every card ever closed. Not
      // pruned by what still waits: a list still loading would drop a card closed a moment ago.
      const next = [...closed.filter((x) => x !== id), id].slice(-KEEP_CLOSED);
      keep(next);
      return { closed: next };
    }),
  reopen: (id) =>
    set(({ closed }) => {
      const next = closed.filter((x) => x !== id);
      keep(next);
      return { closed: next };
    }),
}));

/**
 * The questions that wait on this person and need nothing else to answer, as cards at the bottom
 * right over the app: someone new to place in team spaces and someone asking to join a closed one
 * (for those who look after the server), a step that waits for this person's second yes, and a
 * room someone put them in. A card stays until it is answered, or closed, which puts it away on this
 * device only; Today still lists the questions.
 */
export function ActionCards() {
  const newcomers = useNewcomers();
  const requests = useSpaceRequests();
  const second = useSecondYes();
  const added = useRoomsAddedTo();
  const { closed, close } = useClosedCards();
  const open = <T extends { id: string }>(list: T[]) => list.filter((x) => !closed.includes(x.id));
  const cards = [
    ...open(second).map((s) => <SecondYesCard key={s.id} item={s} onClose={() => close(s.id)} />),
    ...open(requests).map((r) => <SpaceRequestCard key={r.id} request={r} onClose={() => close(r.id)} />),
    ...open(newcomers).map((p) => <NewcomerCard key={p.id} person={p} onClose={() => close(p.id)} />),
    ...open(added).map((r) => <RoomAddedCard key={r.id} room={r} onClose={() => close(r.id)} />),
  ];
  if (!cards.length) return null;
  return (
    // On a phone it sits above the bar at the bottom of the list. The stack scrolls when it runs
    // taller than the screen.
    <div className="pointer-events-none fixed end-4 bottom-24 z-40 flex max-h-[calc(100%-7rem)] max-w-[calc(100vw-2rem)] flex-col-reverse gap-3 overflow-y-auto p-0.5 md:bottom-4 md:max-h-[calc(100%-2rem)]">
      {cards}
    </div>
  );
}
