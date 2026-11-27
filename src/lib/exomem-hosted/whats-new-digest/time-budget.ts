/**
 * The daily route's time budget (`send-monthly-whats-new-digest`, D4). The route
 * has a function limit (`maxDuration` in the route file); a run that reaches it
 * is killed, possibly between two writes. So each outbound call gets the time
 * the budget leaves, a call the budget cannot cover is not started, and the run
 * stops with the month still waiting. The next daily run resumes from the
 * month's record, so stopping early loses nothing.
 */

/** A call given less than this cannot finish, so it is not started. */
const MIN_CALL_MS = 2_000;

/**
 * The timeout for one call that would take at most `wantedMs`: all of it, or
 * what the budget leaves. `null` when the budget cannot cover `floorMs` (the
 * least that makes the call worth starting). No deadline means no limit.
 */
export function timeoutWithin(
  deadlineAt: number | undefined,
  wantedMs: number,
  floorMs: number = MIN_CALL_MS
): number | null {
  if (deadlineAt === undefined) return wantedMs;
  const left = deadlineAt - Date.now();
  return left < floorMs ? null : Math.min(wantedMs, left);
}
