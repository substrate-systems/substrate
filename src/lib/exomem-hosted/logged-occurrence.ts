/**
 * The 1st, 2nd, 4th, 8th... occurrence: loud for a lasting fault, never one line per request.
 * The caller keeps its own counter and logs when this returns true.
 */
export function loggedOccurrence(count: number): boolean {
  return (count & (count - 1)) === 0;
}
