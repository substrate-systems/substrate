/**
 * A value the server either knows or says why it does not. Unknown is a visible
 * state with a reason, never a zero, an empty string or an invented date.
 * `Reason` narrows the reasons a field can give.
 */
export type Known<T, Reason extends string = string> =
  | { value: T; reason: null }
  | { value: null; reason: Reason };

export function known<T>(value: T): { value: T; reason: null } {
  return { value, reason: null };
}

export function unknown<Reason extends string>(reason: Reason): { value: null; reason: Reason } {
  return { value: null, reason };
}
