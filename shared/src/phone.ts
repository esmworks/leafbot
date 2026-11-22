import { z } from 'zod';

/**
 * What a bot may read from the person's own phone, through the phone app while it is open and
 * connected: each is switched on in the app by the person, and the phone's own permission is asked
 * then. Reading only; nothing on the phone is changed.
 */
export const PHONE_KINDS = ['calendar', 'contacts', 'location'] as const;
export const PhoneKind = z.enum(PHONE_KINDS);
export type PhoneKind = z.infer<typeof PhoneKind>;

/** At most this many days of calendar are read at once. */
export const PHONE_CALENDAR_MAX_DAYS = 31;
/** At most this many calendar events or contacts come back. */
export const PHONE_MAX_ITEMS = 50;

export const PhoneAsk = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('calendar'), from: z.string().datetime(), to: z.string().datetime() }),
  z.object({ kind: z.literal('contacts'), query: z.string().trim().min(1).max(100) }),
  z.object({ kind: z.literal('location') }),
]);
export type PhoneAsk = z.infer<typeof PhoneAsk>;

export const PhoneEvent = z.object({
  title: z.string().max(500),
  start: z.string(),
  end: z.string(),
  allDay: z.boolean(),
  location: z.string().max(500).nullable(),
  calendar: z.string().max(200).nullable(),
});
export type PhoneEvent = z.infer<typeof PhoneEvent>;

export const PhoneContact = z.object({
  name: z.string().max(300),
  phones: z.array(z.string().max(100)).max(10),
  emails: z.array(z.string().max(300)).max(10),
  company: z.string().max(300).nullable(),
});
export type PhoneContact = z.infer<typeof PhoneContact>;

export const PhoneLocation = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /** Meters; null when the phone did not say. */
  accuracy: z.number().nonnegative().nullable(),
  /** A readable place (street, city), when the phone could name it. */
  place: z.string().max(500).nullable(),
  at: z.string(),
});
export type PhoneLocation = z.infer<typeof PhoneLocation>;

/** The phone's answer. `off`: the person turned this off in the app; `denied`: the phone's own permission is not given. */
export const PhoneAnswer = z.union([
  z.object({
    ok: z.literal(true),
    kind: z.literal('calendar'),
    events: z.array(PhoneEvent).max(PHONE_MAX_ITEMS),
  }),
  z.object({
    ok: z.literal(true),
    kind: z.literal('contacts'),
    contacts: z.array(PhoneContact).max(PHONE_MAX_ITEMS),
  }),
  z.object({ ok: z.literal(true), kind: z.literal('location'), location: PhoneLocation }),
  z.object({ ok: z.literal(false), reason: z.enum(['off', 'denied', 'failed']) }),
]);
export type PhoneAnswer = z.infer<typeof PhoneAnswer>;
