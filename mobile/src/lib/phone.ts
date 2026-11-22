import {
  PHONE_KINDS,
  PHONE_MAX_ITEMS,
  type PhoneAnswer,
  type PhoneAsk,
  type PhoneContact,
  type PhoneEvent,
  type PhoneKind,
  type PhoneLocation,
} from '@leafbot/shared';
import { useCallback } from 'react';
import { loadStored, useStored, writeStored } from './stored';

/** What the phone's own permission says for one kind. */
export type PhonePermission = 'granted' | 'denied' | 'undetermined';

/** The phone's calendar, contacts and location; the app's is `expoDevice`, tests give their own. */
export interface PhoneDevice {
  permission(kind: PhoneKind): Promise<PhonePermission>;
  /** Asks the phone's own permission; whether it was given. */
  request(kind: PhoneKind): Promise<boolean>;
  calendar(from: Date, to: Date): Promise<PhoneEvent[]>;
  contacts(query: string): Promise<PhoneContact[]>;
  location(): Promise<PhoneLocation>;
}

/** What the person lets bots on this server read from this phone, kept per server. */
export const shareKey = (origin: string) => `phone-share:${origin}`;

export async function sharedKinds(origin: string): Promise<PhoneKind[]> {
  const v = await loadStored<unknown>(shareKey(origin));
  return Array.isArray(v) ? v.filter((k): k is PhoneKind => PHONE_KINDS.includes(k)) : [];
}

/** The kinds to offer the server now: switched on here, with the phone's permission given. */
export async function offeredKinds(shared: readonly PhoneKind[], device: PhoneDevice): Promise<PhoneKind[]> {
  const given = await Promise.all(
    shared.map(async (k) => ((await device.permission(k).catch(() => 'denied')) === 'granted' ? k : null)),
  );
  return given.filter((k): k is PhoneKind => k !== null);
}

const cut = (s: string | null | undefined, max: number) => (s ? s.slice(0, max) : null);

/**
 * Answers a bot's question from the server. It is answered only while the person keeps the kind on
 * here and the phone's permission is given; each answer is cut to what the server takes.
 */
export async function answerPhone(
  ask: PhoneAsk,
  shared: readonly PhoneKind[],
  device: PhoneDevice,
): Promise<PhoneAnswer> {
  if (!PHONE_KINDS.includes(ask?.kind) || !shared.includes(ask.kind)) return { ok: false, reason: 'off' };
  try {
    if ((await device.permission(ask.kind)) !== 'granted') return { ok: false, reason: 'denied' };
    if (ask.kind === 'calendar') {
      const from = new Date(ask.from);
      const to = new Date(ask.to);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from)
        return { ok: false, reason: 'failed' };
      const events = (await device.calendar(from, to))
        .sort((a, b) => a.start.localeCompare(b.start))
        .slice(0, PHONE_MAX_ITEMS)
        .map((e) => ({
          ...e,
          title: e.title.slice(0, 500),
          location: cut(e.location, 500),
          calendar: cut(e.calendar, 200),
        }));
      return { ok: true, kind: 'calendar', events };
    }
    if (ask.kind === 'contacts') {
      const contacts = (await device.contacts(String(ask.query).slice(0, 100)))
        .slice(0, PHONE_MAX_ITEMS)
        .map((c) => ({
          name: c.name.slice(0, 300),
          phones: c.phones.slice(0, 10).map((p) => p.slice(0, 100)),
          emails: c.emails.slice(0, 10).map((m) => m.slice(0, 300)),
          company: cut(c.company, 300),
        }));
      return { ok: true, kind: 'contacts', contacts };
    }
    const l = await device.location();
    return { ok: true, kind: 'location', location: { ...l, place: cut(l.place, 500) } };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/** Listeners told when what this phone shares changes, so the socket offers it again. */
const changed = new Set<() => void>();
export function onShareChange(fn: () => void): () => void {
  changed.add(fn);
  return () => void changed.delete(fn);
}

/**
 * What this phone shares with the bots of a server, and a switch per kind. Turning one on asks the
 * phone's own permission first and stays off when it is not given.
 */
export function usePhoneShare(
  origin: string,
  device: PhoneDevice,
): [PhoneKind[], (kind: PhoneKind, on: boolean) => Promise<'on' | 'off' | 'denied'>] {
  const [stored] = useStored<PhoneKind[]>(shareKey(origin), []);
  const kinds = Array.isArray(stored) ? stored.filter((k) => PHONE_KINDS.includes(k)) : [];
  const set = useCallback(
    async (kind: PhoneKind, on: boolean) => {
      const now = await sharedKinds(origin);
      if (on && !(await device.request(kind).catch(() => false))) return 'denied' as const;
      const next = on ? [...new Set([...now, kind])] : now.filter((k) => k !== kind);
      writeStored(shareKey(origin), next.length ? next : undefined);
      changed.forEach((fn) => fn());
      return on ? ('on' as const) : ('off' as const);
    },
    [origin, device],
  );
  return [kinds, set];
}
