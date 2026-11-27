/**
 * What the operator sees of the months and what they can do to one
 * (`send-monthly-whats-new-digest`, D2 and D6). The blind pick comes first:
 * until it is on record, a month's detail carries neither the model's ranking
 * nor an email built from it, so the operator's pick is never shaped by it.
 */

import { exomemErrors, ExomemHostedError } from "../errors";
import { parseMonthName, whatsNewDigestConfig } from "./config";
import { previewWhatsNewDigestEmail } from "./email";
import {
  MONTHS_TO_MEASURE,
  measure,
  switchApplies,
  type Measurement,
  type MonthShare,
} from "./measurement";
import { MAX_PICKS, MIN_PICKS, WHATS_NEW_PROMPT_VERSION } from "./model";
import { unsubscribeKeyConfigured } from "./unsubscribe";
import {
  acceptWithout,
  advanceWhenNotesComplete,
  currentSwitch,
  decideMonth,
  getMonth,
  listCountableMonths,
  listMonths,
  listReleases,
  missingReleases,
  needsRanking,
  notesOfReleases,
  recordBlindPick,
  recordSwitch,
  skipMonth,
  stopMonth,
  type MonthRecord,
  type ReleaseProblem,
  type SkipReason,
  type SwitchRecord,
} from "./months";
import { noteKey, parseNoteIds, resolveSelection, type MonthNote, type NoteId } from "./notes";
import type { MonthState } from "./states";

function digestError(code: string, status: number, message: string): ExomemHostedError {
  return new ExomemHostedError({ code, status, message });
}

const errors = {
  unknownMonth: () =>
    digestError("WHATS_NEW_DIGEST_MONTH_UNKNOWN", 404, "no digest month has that name"),
  state: () =>
    digestError(
      "WHATS_NEW_DIGEST_STATE",
      409,
      "the month is not in a state that takes this action"
    ),
  blindFirst: () =>
    digestError(
      "WHATS_NEW_DIGEST_BLIND_PICK_FIRST",
      409,
      "record your own pick before you decide this month"
    ),
  selection: () =>
    digestError(
      "WHATS_NEW_DIGEST_SELECTION_INVALID",
      400,
      `a selection is ${MIN_PICKS} to ${MAX_PICKS} different notes of the month`
    ),
  switchNotOffered: () =>
    digestError(
      "WHATS_NEW_DIGEST_SWITCH_NOT_OFFERED",
      409,
      "the measurement does not offer sending without approval"
    ),
  invalid: () => exomemErrors.invalidRequest(),
};

export { parseMonthName };

const configured = () => ({
  modelId: whatsNewDigestConfig().modelId,
  promptVersion: WHATS_NEW_PROMPT_VERSION,
});

export type MonthSummary = {
  month: string;
  state: MonthState;
  skipReason: SkipReason | null;
  modelStatus: MonthRecord["modelStatus"];
  decision: MonthRecord["decision"];
  lastCheckedAt: string | null;
  /** When a ready month's digests may start to queue; `null` before a decision. */
  sendAfter: string | null;
};

export type DigestOverview = {
  /** The server's time (ISO) when it read this: the page's stop-window sentences are relative to it. */
  at: string;
  months: MonthSummary[];
  /** The key and model are configured now; a month waits in "model not configured" while they are not. */
  modelConfigured: boolean;
  /** The first month the daily route builds (`YYYY-MM`); `null` while unset, and then it builds nothing. */
  firstMonth: string | null;
  /** The unsubscribe key is set; while it is not, an approved month queues nothing. */
  unsubscribeKeyConfigured: boolean;
  model: { modelId: string; promptVersion: string };
  measurement: {
    run: MonthShare[];
    measured: MonthShare[];
    monthsToMeasure: number;
    complete: boolean;
    allPass: boolean;
    /** The first three pass, but a later counted month scored below two thirds. */
    withdrawn: boolean;
    offered: boolean;
  };
  /** The operator's recorded choice, and whether it applies to the identity of the latest ranking. */
  switch: { sendWithoutApproval: boolean; recordedAt: string | null; applies: boolean };
};

const MONTHS_LISTED = 24;

export async function describeOverview(): Promise<DigestOverview> {
  const [months, decided, recordedSwitch] = await Promise.all([
    listMonths(MONTHS_LISTED),
    listCountableMonths(),
    currentSwitch(),
  ]);
  const model = configured();
  const measurement: Measurement = measure(decided, model);
  // The model that the API reports is known only from a ranking: the switch holds
  // while the latest ranking was made under the identity it was measured under.
  const latestRanked = months.find((month) => month.modelReported !== null);
  return {
    at: new Date().toISOString(),
    months: months.map((month) => ({
      month: month.month,
      state: month.state,
      skipReason: month.skipReason,
      modelStatus: month.modelStatus,
      decision: month.decision,
      lastCheckedAt: month.lastCheckedAt?.toISOString() ?? null,
      sendAfter: month.sendAfter?.toISOString() ?? null,
    })),
    modelConfigured: whatsNewDigestConfig().anthropicApiKey !== null,
    firstMonth: whatsNewDigestConfig().firstMonth,
    unsubscribeKeyConfigured: unsubscribeKeyConfigured(),
    model,
    measurement: {
      run: measurement.run,
      measured: measurement.measured,
      monthsToMeasure: MONTHS_TO_MEASURE,
      complete: measurement.complete,
      allPass: measurement.allPass,
      withdrawn: measurement.withdrawn,
      offered: measurement.offered,
    },
    switch: {
      sendWithoutApproval: recordedSwitch?.sendWithoutApproval === true,
      recordedAt: recordedSwitch?.recordedAt.toISOString() ?? null,
      applies:
        latestRanked?.modelReported != null &&
        switchApplies(recordedSwitch, { ...model, modelReported: latestRanked.modelReported }),
    },
  };
}

type NoteView = NoteId & { title: string | null; text: string };

const view = (note: MonthNote): NoteView => ({
  version: note.version,
  position: note.position,
  title: note.title,
  text: note.text,
});

export type MonthDetail = {
  /** The server's time (ISO) when it read this month. */
  at: string;
  month: string;
  state: MonthState;
  skipReason: SkipReason | null;
  modelStatus: MonthRecord["modelStatus"];
  modelId: string | null;
  modelReported: string | null;
  promptVersion: string | null;
  /** The month is skipped after the operator's blind pick and its ranking is not in yet: it is still to be recorded. */
  rankingPending: boolean;
  releases: {
    total: number;
    acceptedWithout: number;
    missing: Array<{ version: string; publishedAt: string; problem: ReleaseProblem }>;
  };
  /** The month's notes to pick from; empty while a release's notes are missing and not accepted without. */
  notes: NoteView[];
  /** `null` until recorded; `[]` is "none". */
  blindPick: NoteId[] | null;
  canPickBlind: boolean;
  /** Only after the blind pick is on record. */
  model: { selection: NoteView[]; leftOut: NoteView[] } | null;
  decision: MonthRecord["decision"];
  finalSelection: NoteView[] | null;
  /** When the digests may start to queue: later than now means the operator's stop window is open. */
  sendAfter: string | null;
  /** The operator may stop the month: it is ready to queue or queued. */
  canStop: boolean;
  /** Digests the delivery job has queued for the month so far. */
  queuedCount: number;
  /** The email of the final selection, or of the model's when the month is undecided. */
  email: { subject: string; light: string; dark: string; text: string } | null;
};

export async function describeMonth(month: string): Promise<MonthDetail> {
  const record = await getMonth(month);
  if (!record) throw errors.unknownMonth();
  const releases = await listReleases(month);
  const missing = missingReleases(releases);
  const notesKnown = record.state !== "waiting_for_notes" && missing.length === 0;
  const notes = notesKnown ? notesOfReleases(releases) : [];
  const byKey = new Map(notes.map((note) => [noteKey(note), note]));
  const pick = (ids: readonly NoteId[] | null): NoteView[] | null =>
    ids
      ? ids.flatMap((id) => (byKey.has(noteKey(id)) ? [view(byKey.get(noteKey(id))!)] : []))
      : null;

  const revealed = record.blindPick !== null;
  const modelSelection = revealed ? pick(record.modelSelection) : null;
  const picked = new Set((record.modelSelection ?? []).map(noteKey));
  const shown = record.finalSelection ? pick(record.finalSelection) : modelSelection;
  return {
    at: new Date().toISOString(),
    month,
    state: record.state,
    skipReason: record.skipReason,
    modelStatus: record.modelStatus,
    modelId: record.modelId,
    modelReported: record.modelReported,
    promptVersion: record.promptVersion,
    rankingPending: needsRanking(record) && record.state === "skipped",
    releases: {
      total: releases.length,
      acceptedWithout: releases.filter((release) => release.acceptedWithoutAt).length,
      missing: missing.map((release) => ({
        version: release.version,
        publishedAt: release.publishedAt.toISOString(),
        problem: release.problem ?? "unfetched",
      })),
    },
    notes: notes.map(view),
    blindPick: record.blindPick,
    canPickBlind:
      record.blindPick === null &&
      notesKnown &&
      (record.state === "waiting_for_model" || record.state === "awaiting_approval"),
    model: modelSelection
      ? {
          selection: modelSelection,
          leftOut: notes.filter((note) => !picked.has(noteKey(note))).map(view),
        }
      : null,
    decision: record.decision,
    finalSelection: pick(record.finalSelection),
    sendAfter: record.sendAfter?.toISOString() ?? null,
    canStop: record.state === "ready_to_queue" || record.state === "queued",
    queuedCount: record.queuedCount,
    // The email is built from the ranking, so it also waits for the blind pick (unless the month is decided).
    email:
      shown && shown.length >= MIN_PICKS && (revealed || record.finalSelection)
        ? previewWhatsNewDigestEmail({ month, notes: shown })
        : null,
  };
}

/** The selection a request names: 3 to 6 different notes of the month, in its order. */
async function monthSelection(
  month: string,
  value: unknown,
  allowNone: boolean
): Promise<NoteId[]> {
  const ids = parseNoteIds(value);
  if (!ids) throw errors.invalid();
  if (allowNone && ids.length === 0) return [];
  if (ids.length < MIN_PICKS || ids.length > MAX_PICKS) throw errors.selection();
  const notes = notesOfReleases(await listReleases(month));
  if (!resolveSelection(notes, ids)) throw errors.selection();
  return ids;
}

async function requireMonth(value: unknown): Promise<MonthRecord> {
  const month = parseMonthName(value);
  if (!month) throw errors.invalid();
  const record = await getMonth(month);
  if (!record) throw errors.unknownMonth();
  return record;
}

/**
 * The operator's actions on a month. `blind_pick` and `edit` take `selection`
 * (a blind pick of none skips the month); `accept_missing` takes `versions`;
 * `approve`, `skip` and `stop` take the month alone; `set_switch` takes `on` and
 * no month. Each returns the month's new detail.
 */
export async function applyDigestAction(
  body: Record<string, unknown>
): Promise<MonthDetail | DigestOverview> {
  if (body.action === "set_switch") {
    if (typeof body.on !== "boolean") throw errors.invalid();
    const model = configured();
    if (body.on) {
      const measurement = measure(await listCountableMonths(), model);
      if (!measurement.offered) throw errors.switchNotOffered();
      // The identity measured: the same on each of the three months.
      const { modelId, modelReported, promptVersion } = measurement.measured[0];
      await recordSwitch({
        sendWithoutApproval: true,
        modelId,
        modelReported,
        promptVersion,
        shares: measurement.measured.map(({ month, both, operatorPicks, modelPicks }) => ({
          month,
          both,
          operatorPicks,
          modelPicks,
        })),
      } satisfies Omit<SwitchRecord, "recordedAt">);
    } else {
      await recordSwitch({
        sendWithoutApproval: false,
        modelId: null,
        modelReported: null,
        promptVersion: null,
        shares: [],
      });
    }
    return describeOverview();
  }

  const record = await requireMonth(body.month);
  const { month } = record;
  switch (body.action) {
    case "blind_pick": {
      const picks = await monthSelection(month, body.selection, true);
      if (!(await recordBlindPick(month, picks))) throw errors.state();
      break;
    }
    case "accept_missing": {
      const versions = Array.isArray(body.versions) ? body.versions : null;
      if (
        !versions ||
        versions.length === 0 ||
        versions.some((version) => typeof version !== "string")
      ) {
        throw errors.invalid();
      }
      if ((await acceptWithout(month, versions as string[])) === 0) throw errors.state();
      await advanceWhenNotesComplete(month);
      break;
    }
    case "approve": {
      if (record.blindPick === null) throw errors.blindFirst();
      const model = record.modelSelection ?? [];
      // The model's "none" has no selection to approve: the operator edits one in, or skips.
      if (model.length < MIN_PICKS) throw errors.selection();
      if (!(await decideMonth(month, "approved", model))) throw errors.state();
      break;
    }
    case "edit": {
      if (record.blindPick === null) throw errors.blindFirst();
      const selection = await monthSelection(month, body.selection, false);
      if (!(await decideMonth(month, "edited", selection))) throw errors.state();
      break;
    }
    case "skip":
      if (!(await skipMonth(month, "operator"))) throw errors.state();
      break;
    case "stop":
      if (!(await stopMonth(month))) throw errors.state();
      break;
    default:
      throw errors.invalid();
  }
  return describeMonth(month);
}
