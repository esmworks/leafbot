import { z } from 'zod';
import type { NoticeEvent } from './events.js';
import { LOCALES } from './i18n';
import { Id } from './schemas.js';

/** Which notices reach a device: every reply and request, only requests, or none. */
export const PushLevel = z.enum(['all', 'needsYou', 'off']);
export type PushLevel = z.infer<typeof PushLevel>;

/** Muted bots and until when (ms since the epoch); null keeps a bot muted until unmuted. */
export const PushMutes = z.record(Id, z.number().int().nullable());
export type PushMutes = z.infer<typeof PushMutes>;

/**
 * A phone app asking for notifications while it is closed. The token comes from the phone's
 * push service; the level and mutes are the choices made in the app on that phone.
 */
export const PushDeviceSet = z.object({
  token: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{32,200}$/),
  platform: z.enum(['ios']),
  locale: z.enum(LOCALES),
  level: PushLevel,
  mutes: PushMutes.default({}),
});
export type PushDeviceSet = z.infer<typeof PushDeviceSet>;

/**
 * A Live Activity the iPhone app started on the lock screen for a conversation's work: Apple's
 * token for that one activity, and the language its words are written in.
 */
export const LiveActivitySet = z.object({
  token: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{32,400}$/),
  locale: z.enum(LOCALES),
  /** When the phone started it (ms since the epoch), so a token Apple replaces keeps the count. */
  since: z.number().int().positive().optional(),
});
export type LiveActivitySet = z.infer<typeof LiveActivitySet>;

/**
 * The name the phone's Live Activity layout is registered under, which every update must carry,
 * and the phases of the work it shows.
 */
export const LIVE_ACTIVITY_NAME = 'BotWork';
export type LiveActivityPhase = 'working' | 'waiting' | 'done' | 'failed' | 'stopped';

/** What a Live Activity shows; the words come already in the person's language. */
export interface LiveActivityProps {
  bot: string;
  state: string;
  phase: LiveActivityPhase;
  /** When the work began (ms since the epoch): the lock screen counts the time from it itself. */
  since: number;
}

/** The Apple key that lets this server send notifications to the iPhone app. */
export const ApnsSet = z.object({
  teamId: z
    .string()
    .trim()
    .regex(/^[A-Z0-9]{10}$/),
  keyId: z
    .string()
    .trim()
    .regex(/^[A-Z0-9]{10}$/),
  bundleId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/)
    .max(155),
  /** The contents of the .p8 file Apple gives once. */
  key: z.string().min(100).max(4000),
});
export type ApnsSet = z.infer<typeof ApnsSet>;

/** Whether the server can send to iPhones; the key itself never leaves the server. */
export interface ApnsStatus {
  configured: boolean;
  teamId: string | null;
  keyId: string | null;
  bundleId: string | null;
}

/** Whether a notice is worth a notification on a device with these choices. */
export function pushWanted(
  e: Pick<NoticeEvent, 'kind' | 'botId'>,
  level: PushLevel,
  mutes: PushMutes,
  now = Date.now(),
): boolean {
  if (level === 'off') return false;
  if (level === 'needsYou' && e.kind === 'reply') return false;
  if (e.botId in mutes) {
    const until = mutes[e.botId];
    if (until === null || until === undefined || until > now) return false;
  }
  return true;
}
