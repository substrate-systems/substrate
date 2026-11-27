/**
 * The measurement that can replace the operator's approval
 * (`send-monthly-whats-new-digest`, D2).
 *
 * A counted month is one the operator approved or edited, with a blind pick on
 * record, that was not quiet. Its share is the notes in both picks divided by
 * the operator's picks; a month where the model returned none, or the
 * operator picked none, shares 0. The count restarts when the model or the
 * prompt changes. After three counted months under one model and prompt,
 * every share at or above two thirds offers the switch.
 */

import { noteKey } from "./notes";
import type { MonthRecord, SwitchRecord } from "./months";

export const MONTHS_TO_MEASURE = 3;

export type MonthShare = {
  month: string;
  /** Notes in both the model's picks and the operator's. */
  both: number;
  /** The operator's blind picks: the share's denominator. */
  operatorPicks: number;
  modelId: string;
  promptVersion: string;
  /** Two thirds or more, in integers. */
  passes: boolean;
};

export function shareOf(month: MonthRecord): MonthShare | null {
  const model = month.modelSelection;
  const operator = month.blindPick;
  if (!model || !operator || !month.modelId || !month.promptVersion) return null;
  if (month.decision !== "approved" && month.decision !== "edited") return null;
  // A quiet month: neither side picked anything. It tells nothing about the model.
  if (model.length === 0 && operator.length === 0) return null;
  const modelKeys = new Set(model.map(noteKey));
  const both = operator.filter((id) => modelKeys.has(noteKey(id))).length;
  return {
    month: month.month,
    both,
    operatorPicks: operator.length,
    modelId: month.modelId,
    promptVersion: month.promptVersion,
    passes: operator.length > 0 && 3 * both >= 2 * operator.length,
  };
}

export type Measurement = {
  /** The counted months since the model or prompt last changed, oldest first. */
  run: MonthShare[];
  /** The first three of the run: the months the verdict reads. */
  measured: MonthShare[];
  complete: boolean;
  allPass: boolean;
  /** The model and prompt of the run are the ones configured now. */
  currentConfiguration: boolean;
  /** The page may offer the switch. */
  offered: boolean;
};

export function measure(
  decidedMonths: readonly MonthRecord[],
  configured: { modelId: string; promptVersion: string }
): Measurement {
  const counted = decidedMonths
    .map(shareOf)
    .filter((share): share is MonthShare => share !== null)
    .sort((a, b) => a.month.localeCompare(b.month));
  const last = counted[counted.length - 1];
  const run: MonthShare[] = [];
  for (let index = counted.length - 1; index >= 0; index -= 1) {
    const share = counted[index];
    if (share.modelId !== last.modelId || share.promptVersion !== last.promptVersion) break;
    run.unshift(share);
  }
  const measured = run.slice(0, MONTHS_TO_MEASURE);
  const complete = measured.length === MONTHS_TO_MEASURE;
  const allPass = complete && measured.every((share) => share.passes);
  const currentConfiguration =
    run.length > 0 &&
    last.modelId === configured.modelId &&
    last.promptVersion === configured.promptVersion;
  return {
    run,
    measured,
    complete,
    allPass,
    currentConfiguration,
    offered: allPass && currentConfiguration,
  };
}

/**
 * Whether the operator's recorded switch lets this month send without
 * approval. It holds for the model and prompt it was measured under: a change
 * to either needs approval again until a new measurement.
 */
export function switchApplies(
  record: SwitchRecord | null,
  configured: { modelId: string; promptVersion: string }
): boolean {
  return (
    record?.sendWithoutApproval === true &&
    record.modelId === configured.modelId &&
    record.promptVersion === configured.promptVersion
  );
}
