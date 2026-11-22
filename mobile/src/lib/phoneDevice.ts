import type { PhoneContact, PhoneEvent, PhoneKind, PhoneLocation } from '@leafbot/shared';
import {
  EntityTypes,
  getCalendarPermissions,
  getCalendars,
  listEvents,
  requestCalendarPermissions,
} from 'expo-calendar';
import { Contact, ContactField, getPermissionsAsync, requestPermissionsAsync } from 'expo-contacts';
import {
  Accuracy,
  getCurrentPositionAsync,
  getForegroundPermissionsAsync,
  requestForegroundPermissionsAsync,
  reverseGeocodeAsync,
} from 'expo-location';
import type { PhoneDevice, PhonePermission } from './phone';

/** How long a location fix may take before the bot is told it failed. */
const LOCATION_MS = 10_000;

const status = (p: { status: string }): PhonePermission =>
  p.status === 'granted' ? 'granted' : p.status === 'denied' ? 'denied' : 'undetermined';

const iso = (d: Date | string | undefined) => (d ? new Date(d).toISOString() : '');

/** This phone's own calendar, contacts and location, read through Expo's modules. */
export const expoDevice: PhoneDevice = {
  async permission(kind: PhoneKind) {
    if (kind === 'calendar') return status(await getCalendarPermissions());
    if (kind === 'contacts') return status(await getPermissionsAsync());
    return status(await getForegroundPermissionsAsync());
  },
  async request(kind: PhoneKind) {
    if (kind === 'calendar') return (await requestCalendarPermissions()).status === 'granted';
    if (kind === 'contacts') return (await requestPermissionsAsync()).status === 'granted';
    return (await requestForegroundPermissionsAsync()).status === 'granted';
  },
  async calendar(from: Date, to: Date): Promise<PhoneEvent[]> {
    const calendars = await getCalendars(EntityTypes.EVENT);
    if (!calendars.length) return [];
    const names = new Map(calendars.map((c) => [c.id, c.title ?? null]));
    const events = await listEvents(calendars, from, to);
    return events.map((e) => ({
      title: e.title ?? '',
      start: iso(e.startDate),
      end: iso(e.endDate),
      allDay: !!e.allDay,
      location: e.location || null,
      calendar: names.get(e.calendarId) ?? null,
    }));
  },
  async contacts(query: string): Promise<PhoneContact[]> {
    const found = await Contact.getAll({ name: query, limit: 50 });
    return Promise.all(
      found.map(async (c) => {
        const d = await c.getDetails([
          ContactField.FULL_NAME,
          ContactField.COMPANY,
          ContactField.PHONES,
          ContactField.EMAILS,
        ]);
        return {
          name: d.fullName ?? '',
          company: d.company || null,
          phones: (d.phones ?? []).map((p) => p.number ?? '').filter(Boolean),
          emails: (d.emails ?? []).map((m) => m.address ?? '').filter(Boolean),
        };
      }),
    );
  },
  async location(): Promise<PhoneLocation> {
    const fix = await Promise.race([
      getCurrentPositionAsync({ accuracy: Accuracy.Balanced }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), LOCATION_MS)),
    ]);
    const { latitude, longitude, accuracy } = fix.coords;
    const named = await reverseGeocodeAsync({ latitude, longitude }).catch(() => []);
    const a = named[0];
    const place = a
      ? [a.name, a.street, a.district, a.city, a.region, a.country]
          .filter((x, i, all) => x && all.indexOf(x) === i)
          .join(', ')
      : '';
    return {
      latitude,
      longitude,
      accuracy: accuracy ?? null,
      place: place || null,
      at: new Date(fix.timestamp).toISOString(),
    };
  },
};
