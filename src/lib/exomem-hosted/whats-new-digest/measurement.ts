/**
 * The measurement that can replace the operator's approval
 * (`send-monthly-whats-new-digest`, D2).
 *
 * A month counts when it has a recorded blind pick and a model ranking, under
 * one model and prompt, whatever the operator then decided. Its score is the
 * notes in both picks divided by the LARGER of the two pick counts, so a model
 * that pads to 6 is penalised. A month where exactly one side picked none
 * scores 0: the model and the operator disagree on whether to send. A month
 * where both picked none is quiet and does not count.
 *
 * The identity of a ranking is the model name that configuration asked for,
 * the model that the API reported, and the prompt's hash. The count restarts
 * when any of them changes. After three counted months under one identity,
 * every score at or above two thirds offers the switch, and a later counted
 * month under that identity that scores below two thirds withdraws the offer.
 *
 * Three months at two thirds is the operator's accepted risk for lifting
 * approval, not a confidence-bounded measurement: with three months and
 * 3 to 6 notes each, a model that is wrong about half the time can still pass.
 */

import { noteKey } from "./notes";
import type { MonthRecord, SwitchRecord } from "./months";

export const MONTHS_TO_MEASURE = 3;

/** What identifies a ranking for the measurement and for the recorded switch. */
export type RankingIdentity = {
  modelId: string;
  modelReported: string;
  promptVersion: string;
};

const sameIdentity = (a: RankingIdentity, b: RankingIdentity): boolean =>
  a.modelId === b.modelId &&
  a.modelReported === b.modelReported &&
  a.promptVersion === b.promptVersion;

export type MonthShare = RankingIdentity & {
  month: string;
  /** Notes in both the model's picks and the operator's. */
  both: number;
  operatorPicks: number;
  modelPicks: number;
  /** Two thirds or more of the larger pick count, in integers. */
  passes: boolean;
};

export function shareOf(month: MonthRecord): MonthShare | null {
  const model = month.modelSelection;
  const operator = month.blindPick;
  if (!model || !operator || !month.modelId || !month.modelReported || !month.promptVersion) {
    return null;
  }
  // A quiet month: neither side picked anything. It tells nothing about the model.
  if (model.length === 0 && operator.length === 0) return null;
  const modelKeys = new Set(model.map(noteKey));
  // When one side picked none, nothing overlaps, so the score is 0.
  const both = operator.filter((id) => modelKeys.has(noteKey(id))).length;
  const larger = Math.max(model.length, operator.length);
  return {
    month: month.month,
    modelId: month.modelId,
    modelReported: month.modelReported,
    promptVersion: month.promptVersion,
    both,
    operatorPicks: operator.length,
    modelPicks: model.length,
    passes: 3 * both >= 2 * larger,
  };
}

export type Measurement = {
  /** The counted months since the identity last changed, oldest first. */
  run: MonthShare[];
  /** The first three of the run: the months the verdict reads. */
  measured: MonthShare[];
  complete: boolean;
  allPass: boolean;
  /** The first three pass, but a later counted month of the run scored below two thirds. */
  withdrawn: boolean;
  /** The run's configured model name and prompt are the ones configured now. */
  currentConfiguration: boolean;
  /** The page may offer the switch. */
  offered: boolean;
};

export function measure(
  countableMonths: readonly MonthRecord[],
  configured: { modelId: string; promptVersion: string }
): Measurement {
  const counted = countableMonths
    .map(shareOf)
    .filter((share): share is MonthShare => share !== null)
    .sort((a, b) => a.month.localeCompare(b.month));
  const last = counted[counted.length - 1];
  const run: MonthShare[] = [];
  for (let index = counted.length - 1; index >= 0; index -= 1) {
    const share = counted[index];
    if (!sameIdentity(share, last)) break;
    run.unshift(share);
  }
  const measured = run.slice(0, MONTHS_TO_MEASURE);
  const complete = measured.length === MONTHS_TO_MEASURE;
  const allPass = complete && measured.every((share) => share.passes);
  const withdrawn = allPass && run.slice(MONTHS_TO_MEASURE).some((share) => !share.passes);
  // The model that the API reports is known only once a call is made, so "now" is the name and the prompt.
  const currentConfiguration =
    run.length > 0 &&
    last.modelId === configured.modelId &&
    last.promptVersion === configured.promptVersion;
  return {
    run,
    measured,
    complete,
    allPass,
    withdrawn,
    currentConfiguration,
    offered: allPass && !withdrawn && currentConfiguration,
  };
}

/**
 * Whether the operator's recorded switch lets a month that was just ranked
 * send without approval. It holds for the identity it was measured under: a
 * change to the model name, the model the API reports, or the prompt needs
 * approval again until a new measurement. `ranked` is the identity of the
 * ranking that was just made.
 */
export function switchApplies(record: SwitchRecord | null, ranked: RankingIdentity): boolean {
  return (
    record?.sendWithoutApproval === true &&
    record.modelId !== null &&
    record.modelReported !== null &&
    record.promptVersion !== null &&
    sameIdentity(
      {
        modelId: record.modelId,
        modelReported: record.modelReported,
        promptVersion: record.promptVersion,
      },
      ranked
    )
  );
}
