/**
 * What one owner's digest holds (`send-monthly-whats-new-digest`, D3): the
 * selected notes that the owner's cell already runs. The queue pass and the
 * send-time check both call this, so an owner is held to one rule.
 */

import { compareReleaseVersions, releaseVersion } from "../release-tag";
import { versionTuple, type MonthNote } from "./notes";
import { MIN_PICKS } from "./pick-bounds";

/**
 * The notes of `selection` from releases at or below the release that the
 * cell runs, in the selection's order. `null` means no digest for this owner:
 * the running release is unknown or not a release tag, or fewer than 3 notes
 * are left. `runningTag` is the cell's release tag as Substrate records it
 * (`v1.2.3`); a note's version is the bare `1.2.3`. Versions compare as three
 * numbers, never as text.
 */
export function notesForRunningRelease(
  selection: readonly MonthNote[],
  runningTag: string | null
): MonthNote[] | null {
  const running = runningTag === null ? null : releaseVersion(runningTag);
  if (!running) return null;
  const kept = selection.filter((note) => {
    const version = versionTuple(note.version);
    return version !== null && compareReleaseVersions(version, running) <= 0;
  });
  return kept.length >= MIN_PICKS ? kept : null;
}
