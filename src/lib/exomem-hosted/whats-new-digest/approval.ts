/**
 * What the operator sees of the months and what they can do to one
 * (`send-monthly-whats-new-digest`, D2 and D6). The blind pick comes first:
 * until it is on record, a month's detail carries neither the model's ranking
 * nor an email built from it, so the operator's pick is never shaped by it.
 */

import { exomemErrors, ExomemHostedError } from "../errors";
import { parseMonthName, whatsNewDigestConfig } from "./config";
import { previewWhatsNewDigestEmail } from "./email";
import { measure, switchApplies, type Measurement, type MonthShare } from "./measurement";
import { MAX_PICKS, MIN_PICKS, WHATS_NEW_PROMPT_VERSION } from "./model";
import { unsubscribeKeyConfigured } from "./unsubscribe";
import {
  acceptWithout,
  advanceWhenNotesComplete,
  currentSwitch,
  decideMonth,
  getMonth,
  listDecidedMonths,
  listMonths,
  listReleases,
  missingReleases,
  notesOfReleases,
  recordBlindPick,
  recordSwitch,
  settleQuietMonth,
  skipMonth,
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
};

export type DigestOverview = {
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
    offered: boolean;
  };
  /** The operator's recorded choice, and whether it applies to the model and prompt configured now. */
  switch: { sendWithoutApproval: boolean; recordedAt: string | null; applies: boolean };
};

const MONTHS_LISTED = 24;

export async function describeOverview(): Promise<DigestOverview> {
  const [months, decided, recordedSwitch] = await Promise.all([
    listMonths(MONTHS_LISTED),
    listDecidedMonths(),
    currentSwitch(),
  ]);
  const model = configured();
  const measurement: Measurement = measure(decided, model);
  return {
    months: months.map((month) => ({
      month: month.month,
      state: month.state,
      skipReason: month.skipReason,
      modelStatus: month.modelStatus,
      decision: month.decision,
      lastCheckedAt: month.lastCheckedAt?.toISOString() ?? null,
    })),
    modelConfigured: whatsNewDigestConfig().anthropicApiKey !== null,
    firstMonth: whatsNewDigestConfig().firstMonth,
    unsubscribeKeyConfigured: unsubscribeKeyConfigured(),
    model,
    measurement: {
      run: measurement.run,
      measured: measurement.measured,
      monthsToMeasure: 3,
      complete: measurement.complete,
      allPass: measurement.allPass,
      offered: measurement.offered,
    },
    switch: {
      sendWithoutApproval: recordedSwitch?.sendWithoutApproval === true,
      recordedAt: recordedSwitch?.recordedAt.toISOString() ?? null,
      applies: switchApplies(recordedSwitch, model),
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
  month: string;
  state: MonthState;
  skipReason: SkipReason | null;
  modelStatus: MonthRecord["modelStatus"];
  modelId: string | null;
  promptVersion: string | null;
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
    month,
    state: record.state,
    skipReason: record.skipReason,
    modelStatus: record.modelStatus,
    modelId: record.modelId,
    promptVersion: record.promptVersion,
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
 * The operator's actions on a month. `blind_pick` and `edit` take `selection`;
 * `accept_missing` takes `versions`; `approve` and `skip` take the month alone;
 * `set_switch` takes `on` and no month. Each returns the month's new detail.
 */
export async function applyDigestAction(
  body: Record<string, unknown>
): Promise<MonthDetail | DigestOverview> {
  if (body.action === "set_switch") {
    if (typeof body.on !== "boolean") throw errors.invalid();
    const model = configured();
    if (body.on) {
      const measurement = measure(await listDecidedMonths(), model);
      if (!measurement.offered) throw errors.switchNotOffered();
      await recordSwitch({
        sendWithoutApproval: true,
        ...model,
        shares: measurement.measured.map(({ month, both, operatorPicks }) => ({
          month,
          both,
          operatorPicks,
        })),
      } satisfies Omit<SwitchRecord, "recordedAt">);
    } else {
      await recordSwitch({
        sendWithoutApproval: false,
        modelId: null,
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
      await settleQuietMonth(month);
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
    default:
      throw errors.invalid();
  }
  return describeMonth(month);
}
