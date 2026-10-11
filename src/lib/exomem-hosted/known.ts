/**
 * A value the server either knows or says why it does not. Unknown is a visible
 * state with a reason, never a zero, an empty string or an invented date.
 */
export type Known<T> = { value: T; reason: null } | { value: null; reason: string };

export function known<T>(value: T): Known<T> {
  return { value, reason: null };
}

export function unknown<T>(reason: string): Known<T> {
  return { value: null, reason };
}
