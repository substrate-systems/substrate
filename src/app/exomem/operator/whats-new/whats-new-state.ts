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

/** "27 Nov 2026, 19:04 UTC" for an ISO time. */
export function timeLabel(iso: string): string {
  return `${new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(iso))} UTC`;
}

/** The month's state as the list shows it: a ready month inside its stop window says when it sends. */
export function listedState(
  entry: { state: string; sendAfter: string | null },
  now: number
): string {
  return entry.state === "ready_to_queue" && entry.sendAfter && Date.parse(entry.sendAfter) > now
    ? `ready, sends after ${timeLabel(entry.sendAfter)}`
    : entry.state.replaceAll("_", " ");
}

/** One sentence that says where the month stands, computed from what the server holds. */
export function stateSentence(month: MonthDetail, modelConfigured: boolean, now: number): string {
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
    case "ready_to_queue": {
      const how =
        month.decision === "automatic"
          ? "sent on without approval"
          : month.decision === "edited"
            ? "approved after your edit"
            : "approved as ranked";
      return month.sendAfter && Date.parse(month.sendAfter) > now
        ? `Ready, sends after ${timeLabel(month.sendAfter)} (${how}). Stop it before then if it should not go.`
        : `Ready to queue: ${how}.`;
    }
    case "queued":
      return `Queued: ${month.queuedCount} ${month.queuedCount === 1 ? "digest" : "digests"} went to the outbox. Each sends behind every other email.`;
    case "skipped":
      if (month.skipReason === "quiet")
        return "Skipped: a quiet month, the model and you picked none.";
      if (month.skipReason === "too_few_notes")
        return `Skipped: ${month.notes.length} notes is under the bar of ${MIN_NOTES}.`;
      if (month.decision !== null)
        return "Stopped after approval. Digests still waiting in the outbox are cancelled when they would send.";
      if (month.rankingPending)
        return "Skipped on your pick of none. The model's ranking is still to be recorded for the measurement.";
      return month.blindPick?.length === 0
        ? "Skipped on your pick of none. The model's ranking is recorded for the measurement."
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
