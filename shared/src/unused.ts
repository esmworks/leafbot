import { z } from 'zod';

/** A skill or bot not used for this many days, and made at least this long ago, is listed as unused. */
export const UNUSED_DAYS = 60;

/**
 * What has sat unused, worked out with no AI from what is recorded: skills no bot read for a task,
 * connections no bot can reach or that wait for a sign-in, and bots with no turn. Only what the
 * person may remove or archive is listed, and nothing goes by itself.
 */
export const UnusedReport = z.object({
  skills: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      uses: z.number().int(),
      lastUsedAt: z.string().nullable(),
    }),
  ),
  connections: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      /** `noBot`: open to no bot; `signedOut`: waits for a sign-in, so no bot can use it. */
      reason: z.enum(['noBot', 'signedOut']),
    }),
  ),
  bots: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      /** Its latest turn; null for a bot that never had one. */
      lastTurnAt: z.string().nullable(),
    }),
  ),
});
export type UnusedReport = z.infer<typeof UnusedReport>;
