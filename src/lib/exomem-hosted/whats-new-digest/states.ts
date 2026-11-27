/**
 * The months' closed set of states (`send-monthly-whats-new-digest`). No imports, so the
 * operator page can read it. The migration's CHECK and the SQL in months.ts spell the same names.
 */

export type MonthState =
  | "waiting_for_notes"
  | "waiting_for_model"
  | "awaiting_approval"
  | "ready_to_queue"
  | "queued"
  | "skipped"
  | "lapsed";

/** The states in which a month still waits: the operator can skip it, and the next month's build lapses it. */
const OPEN_STATES: readonly MonthState[] = [
  "waiting_for_notes",
  "waiting_for_model",
  "awaiting_approval",
];

export const isOpenState = (state: MonthState): boolean => OPEN_STATES.includes(state);
