import type { MonthDetail } from "@/lib/exomem-hosted/whats-new-digest/approval";

export type NoteView = MonthDetail["notes"][number];
export type NoteRef = { version: string; position: number };

/** A digest is 3 to 6 notes (the server refuses anything else). */
export const MIN_NOTES = 3;
export const MAX_NOTES = 6;

export const noteKey = (note: NoteRef): string => `${note.version}#${note.position}`;
export const noteRef = ({ version, position }: NoteRef): NoteRef => ({ version, position });

/** "November 2026" for `2026-11`. */
export function monthTitle(month: string): string {
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${month}-01T00:00:00Z`)
  );
}

/** One sentence that says where the month stands, computed from what the server holds. */
export function stateSentence(month: MonthDetail, modelConfigured: boolean): string {
  switch (month.state) {
    case "waiting_for_notes":
      return `Waiting for the notes of ${month.releases.missing.length} ${month.releases.missing.length === 1 ? "release" : "releases"}.`;
    case "waiting_for_model":
      if (!modelConfigured || month.modelStatus === "not_configured") {
        return "Model not configured. The month waits, and no call is made.";
      }
      return month.modelStatus === "unavailable"
        ? "The model did not answer. The next daily run tries again."
        : "Waiting for the model's ranking at the next daily run.";
    case "awaiting_approval":
      return month.blindPick === null
        ? "Waiting for your own pick, then your decision."
        : "Waiting for your decision.";
    case "ready_to_queue":
      return month.decision === "automatic"
        ? "Ready to queue: sent on without approval."
        : month.decision === "edited"
          ? "Ready to queue: approved after your edit."
          : "Ready to queue: approved as ranked.";
    case "skipped":
      return month.skipReason === "quiet"
        ? "Skipped: a quiet month, the model and you picked none."
        : month.skipReason === "too_few_notes"
          ? `Skipped: ${month.notes.length} notes is under the bar of ${MIN_NOTES}.`
          : "Skipped: nothing is sent for this month.";
    case "lapsed":
      return "Lapsed, not approved. Nothing is sent for this month.";
  }
}

/** A selection can be sent to the server: 3 to 6 notes, or none where the page allows it. */
export function selectionAllowed(count: number, allowNone: boolean): boolean {
  return (allowNone && count === 0) || (count >= MIN_NOTES && count <= MAX_NOTES);
}

/** The list with the item at `index` moved by `delta` places, or the same list when it cannot move. */
export function moved<T>(items: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (target < 0 || target >= items.length) return [...items];
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Adds or removes a note from an ordered pick, stopping at the maximum. */
export function toggled(picks: readonly NoteRef[], note: NoteRef): NoteRef[] {
  const key = noteKey(note);
  if (picks.some((pick) => noteKey(pick) === key))
    return picks.filter((pick) => noteKey(pick) !== key);
  return picks.length >= MAX_NOTES ? [...picks] : [...picks, noteRef(note)];
}

export function requestMessage(code: string): string {
  switch (code) {
    case "ADMIN_UNAUTHORIZED":
      return "That admin bearer was not accepted.";
    case "WHATS_NEW_DIGEST_BLIND_PICK_FIRST":
      return "Record your own pick first.";
    case "WHATS_NEW_DIGEST_SELECTION_INVALID":
      return `A selection is ${MIN_NOTES} to ${MAX_NOTES} different notes of the month.`;
    case "WHATS_NEW_DIGEST_STATE":
      return "The month changed while the page was open. Reload it and try again.";
    case "WHATS_NEW_DIGEST_SWITCH_NOT_OFFERED":
      return "The measurement does not offer sending without approval.";
    case "RATE_LIMITED":
      return "Too many requests. Wait a moment and try again.";
    default:
      return "The request was not accepted.";
  }
}
