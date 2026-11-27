import type { DigestOverview, MonthDetail } from "@/lib/exomem-hosted/whats-new-digest/approval";
import { MAX_PICKS, MIN_PICKS } from "@/lib/exomem-hosted/whats-new-digest/pick-bounds";

export type NoteView = MonthDetail["notes"][number];
export type NoteRef = { version: string; position: number };

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

/** The month's state as a short label, computed from what the server holds. */
export function stateLabel(month: MonthDetail, modelConfigured: boolean, now: number): string {
  switch (month.state) {
    case "waiting_for_notes": {
      const { listedAt, failure } = month.releaseList;
      if (failure?.status === "not_configured") return "GitHub token not configured";
      // Not read is not "no releases": say so, and when the last try was.
      if (listedAt === null)
        return failure
          ? `Release list not read, last try ${timeLabel(failure.at)}`
          : "Release list not read yet";
      return `Waiting for notes: ${month.releases.missing.length} ${month.releases.missing.length === 1 ? "release" : "releases"}`;
    }
    case "waiting_for_model":
      if (!modelConfigured || month.modelStatus === "not_configured") return "Model not configured";
      return month.modelStatus === "unavailable"
        ? "Model did not answer, retries at the next daily run"
        : "Waiting for the model's ranking";
    case "awaiting_approval":
      return month.blindPick === null ? "Waiting for your pick" : "Waiting for your decision";
    case "ready_to_queue": {
      const how =
        month.decision === "automatic"
          ? "sent without approval"
          : month.decision === "edited"
            ? "approved after your edit"
            : "approved as ranked";
      return month.sendAfter && Date.parse(month.sendAfter) > now
        ? `Ready, sends after ${timeLabel(month.sendAfter)}, ${how}`
        : `Ready to queue, ${how}`;
    }
    case "queued":
      return `Queued: ${month.queuedCount} ${month.queuedCount === 1 ? "digest" : "digests"}`;
    case "skipped":
      if (month.skipReason === "quiet") return "Skipped: quiet month";
      if (month.skipReason === "too_few_notes")
        return `Skipped: ${month.notes.length} notes, under ${MIN_PICKS}`;
      if (month.decision !== null) return "Stopped after approval";
      if (month.rankingPending) return "Skipped on your pick of none, ranking pending";
      return month.blindPick?.length === 0 ? "Skipped on your pick of none" : "Skipped";
    case "lapsed":
      return "Lapsed, not approved";
  }
}

export type Figure = { label: string; value: string };

/** What the month holds, as labelled values: each says what it is, and an unread value says so. */
export function monthFigures(month: MonthDetail): Figure[] {
  const figures: Figure[] = [
    {
      label: "Releases",
      value: month.releaseList.listedAt === null ? "Not read" : String(month.releases.total),
    },
  ];
  const { failure } = month.releaseList;
  if (failure)
    figures.push({
      label: "Release list, last try",
      value: `${timeLabel(failure.at)}, ${failure.detail}`,
    });
  // While notes are missing the month lists none, so a count would read as zero.
  if (month.state !== "waiting_for_notes")
    figures.push({ label: "Notes", value: String(month.notes.length) });
  if (month.releases.acceptedWithout > 0)
    figures.push({
      label: "Accepted without notes",
      value: String(month.releases.acceptedWithout),
    });
  if (month.modelId) {
    figures.push({ label: "Ranked by", value: month.modelId });
    if (month.modelReported && month.modelReported !== month.modelId)
      figures.push({ label: "Model reported", value: month.modelReported });
    if (month.promptVersion) figures.push({ label: "Prompt", value: month.promptVersion });
  }
  return figures;
}

/** The settings the daily run and the send depend on, each as its state. */
export function setupFigures(overview: DigestOverview): Figure[] {
  const { firstMonth, firstMonthMalformed, unsubscribeKeys } = overview;
  return [
    {
      label: "First month",
      value: firstMonthMalformed
        ? "Malformed, nothing is built"
        : firstMonth === null
          ? "Not set, nothing is built"
          : monthTitle(firstMonth),
    },
    {
      label: "GitHub token",
      value: overview.githubConfigured ? "Set" : "Not set, months wait",
    },
    { label: "Model key", value: overview.modelConfigured ? "Set" : "Not set, months wait" },
    {
      label: "Unsubscribe key",
      value: unsubscribeKeys.current === "ok" ? "Set" : "Not set or malformed, nothing is queued",
    },
    {
      label: "Previous unsubscribe key",
      value:
        unsubscribeKeys.previous === "malformed"
          ? "Malformed, nothing is queued"
          : unsubscribeKeys.previous === "ok"
            ? "Set"
            : "None",
    },
  ];
}

/** The measurement as labelled values: how many months count, and the identity they were ranked under. */
export function measurementFigures(measurement: DigestOverview["measurement"]): Figure[] {
  const figures: Figure[] = [{ label: "Counted months", value: String(measurement.run.length) }];
  const [first] = measurement.run;
  if (first) {
    figures.push({ label: "Model", value: first.modelId });
    figures.push({ label: "Model reported", value: first.modelReported });
    figures.push({ label: "Prompt", value: first.promptVersion });
  }
  return figures;
}

/** How a month is scored, for the heading's tooltip: the page shows the figures, not the rules. */
export function measurementRule(monthsToMeasure: number): string {
  return `A month counts when it has your blind pick and the model's ranking, whatever you then decided. Both picked none: quiet, not counted. One picked none: it scores 0. Otherwise the score is the notes in both picks over the larger pick count. Two thirds in each of the first ${monthsToMeasure} counted months offers sending without approval. A change of model, reported model or prompt restarts the count.`;
}

/** Where sending without approval stands, as one labelled value. */
export function switchFigure(overview: DigestOverview): Figure {
  const { switch: recorded, measurement } = overview;
  const label = "Send without approval";
  if (recorded.sendWithoutApproval && !recorded.applies)
    return {
      label,
      value: `Recorded${recorded.recordedAt ? ` ${timeLabel(recorded.recordedAt)}` : ""}, not in effect: model or prompt changed`,
    };
  if (measurement.withdrawn)
    return { label, value: "Withdrawn: a later month scored under two thirds" };
  if (measurement.complete) return { label, value: "Not offered: a month scored under two thirds" };
  const left = Math.max(0, measurement.monthsToMeasure - measurement.measured.length);
  return {
    label,
    value: `Not offered yet: ${left} more counted ${left === 1 ? "month" : "months"}`,
  };
}

/** Why Approve and Edit are not open for a month the operator can still act on, from what holds them. */
export function lockedReason(month: MonthDetail): string {
  switch (month.state) {
    case "waiting_for_notes":
      return "Locked: notes missing";
    case "waiting_for_model":
      return "Locked: waiting for the ranking";
    default:
      return "Locked: record your pick first";
  }
}

/** A selection can be sent to the server: 3 to 6 notes, or none where the page allows it. */
export function selectionAllowed(count: number, allowNone: boolean): boolean {
  return (allowNone && count === 0) || (count >= MIN_PICKS && count <= MAX_PICKS);
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
  return picks.length >= MAX_PICKS ? [...picks] : [...picks, noteRef(note)];
}

export function requestMessage(code: string): string {
  switch (code) {
    case "ADMIN_UNAUTHORIZED":
      return "That admin bearer was not accepted.";
    case "WHATS_NEW_DIGEST_BLIND_PICK_FIRST":
      return "Record your own pick first.";
    case "WHATS_NEW_DIGEST_SELECTION_INVALID":
      return `A selection is ${MIN_PICKS} to ${MAX_PICKS} different notes of the month.`;
    case "WHATS_NEW_DIGEST_STATE":
      return "The month changed while the page was open. Reload it and try again.";
    case "WHATS_NEW_DIGEST_SWITCH_NOT_OFFERED":
      return "The measurement does not offer sending without approval.";
    case "RATE_LIMITED":
      return "Too many requests. Wait a moment and try again.";
    default:
      return "The request was not accepted. Try again.";
  }
}
