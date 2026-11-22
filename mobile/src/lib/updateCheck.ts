/** How long after one look for an update the app looks again when it comes back to the front. */
export const UPDATE_CHECK_EVERY_MS = 60 * 60 * 1000;

/** Whether to look for an update now, given when the app last looked (null: not yet). */
export function shouldCheck(last: number | null, now: number): boolean {
  return last === null || now - last >= UPDATE_CHECK_EVERY_MS;
}
