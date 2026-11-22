import type { Rehearsal, Routine } from '@leafbot/shared';

/** The catalog key naming what started a run; anything unknown reads as "by hand or from a script". */
export const triggerKey = (trigger: string | null) =>
  trigger === 'watch' || trigger === 'webhook' || trigger === 'email' || trigger === 'whatsapp'
    ? (`rehearsal.trigger.${trigger}` as const)
    : ('rehearsal.trigger.manual' as const);

/**
 * Whether anything starts the routine besides its schedule, so a replay is worth offering. The
 * web and the phone app both ask this, so it is answered in one place.
 */
export const startedBySomething = (
  r: Pick<
    Routine,
    | 'watchUrl'
    | 'check'
    | 'webhookToken'
    | 'emailTrigger'
    | 'whatsappGroup'
    | 'whatsappPeople'
    | 'slackReaction'
    | 'tableTrigger'
  >,
) =>
  !!r.watchUrl ||
  !!r.check ||
  !!r.webhookToken ||
  r.emailTrigger ||
  !!r.whatsappGroup ||
  !!r.whatsappPeople ||
  !!r.slackReaction ||
  !!r.tableTrigger;

/** Whole seconds a rehearsal took; null while it is still going. */
export const rehearsalSeconds = (r: Pick<Rehearsal, 'startedAt' | 'finishedAt'>) =>
  r.finishedAt ? Math.max(0, Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000)) : null;

/** Seconds as m:ss. */
export const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
