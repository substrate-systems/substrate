/**
 * The monthly digest's records (`send-monthly-whats-new-digest`, D1, D2, D4
 * and D6): each month's releases and notes files, the model's ranking, the
 * operator's blind pick and decision, and the final selection that the
 * sending half queues.
 *
 * A month moves through a closed set of states. Every move is one UPDATE
 * that names the state it leaves, so a daily run and an operator action that
 * meet change the month once and the loser reads the new state.
 *
 *   waiting_for_notes -> waiting_for_model -> awaiting_approval -> ready_to_queue -> queued
 *   any of the first three -> skipped | lapsed
 *   ready_to_queue | queued -> skipped          (the operator's stop)
 */

import { executeExomemSql, type ExomemSql } from "../db";
import type { ListedRelease } from "./github";
import type { MonthState } from "./states";
import {
  monthNotes,
  parseNoteIds,
  parseNotesFile,
  resolveSelection,
  type MonthNote,
  type NoteId,
  type ReleaseNotes,
} from "./notes";

export type SkipReason = "operator" | "quiet" | "too_few_notes";
export type ModelStatus = "not_configured" | "unavailable";
export type Decision = "approved" | "edited" | "automatic";
export type ReleaseProblem = "no_asset" | "unfetched" | "unreadable";

export type MonthRecord = {
  month: string;
  state: MonthState;
  skipReason: SkipReason | null;
  releasesListedAt: Date | null;
  lastCheckedAt: Date | null;
  modelStatus: ModelStatus | null;
  /** The model name that configuration asked for. */
  modelId: string | null;
  /** The model that the API reported on the answer: with `promptVersion`, the ranking's identity. */
  modelReported: string | null;
  promptVersion: string | null;
  modelSelection: NoteId[] | null;
  blindPick: NoteId[] | null;
  decision: Decision | null;
  finalSelection: NoteId[] | null;
  decidedAt: Date | null;
  /** Set with the decision: the delivery job queues nothing for the month before this time. */
  sendAfter: Date | null;
  /** Digests the delivery job has queued so far. */
  queuedCount: number;
};

export type ReleaseRecord = {
  version: string;
  publishedAt: Date;
  /** `null` while the notes are missing. */
  release: ReleaseNotes | null;
  problem: ReleaseProblem | null;
  acceptedWithoutAt: Date | null;
};

type MonthRow = Record<string, unknown>;

const asDate = (value: unknown): Date | null => (value ? new Date(value as string | Date) : null);

function monthRecord(row: MonthRow): MonthRecord {
  // The columns hold identifiers this module wrote; a row that does not read back is corrupt, not "none".
  const ids = (value: unknown): NoteId[] | null => {
    if (value === null || value === undefined) return null;
    const parsed = parseNoteIds(value);
    if (!parsed)
      throw new Error("what's new digest: a stored selection is not a list of note identifiers");
    return parsed;
  };
  return {
    month: String(row.month),
    state: row.state as MonthState,
    skipReason: (row.skip_reason as SkipReason | null) ?? null,
    releasesListedAt: asDate(row.releases_listed_at),
    lastCheckedAt: asDate(row.last_checked_at),
    modelStatus: (row.model_status as ModelStatus | null) ?? null,
    modelId: (row.model_id as string | null) ?? null,
    modelReported: (row.model_reported as string | null) ?? null,
    promptVersion: (row.prompt_version as string | null) ?? null,
    modelSelection: ids(row.model_selection),
    blindPick: ids(row.blind_pick),
    decision: (row.decision as Decision | null) ?? null,
    finalSelection: ids(row.final_selection),
    decidedAt: asDate(row.decided_at),
    sendAfter: asDate(row.send_after),
    queuedCount: Number(row.queued_count),
  };
}

export async function ensureMonth(month: string): Promise<void> {
  await executeExomemSql`
    /* exomem:whats-new-digest-ensure-month */
    INSERT INTO exomem_whats_new_digest_months (month, state)
    VALUES (${month}, 'waiting_for_notes')
    ON CONFLICT (month) DO NOTHING
  `;
}

/**
 * Lapses every earlier month that still waits: once this month's selection is
 * built, an earlier month can never send, so no owner gets two months at once.
 */
export async function lapseEarlierMonths(month: string): Promise<number> {
  const { rowCount } = await executeExomemSql`
    /* exomem:whats-new-digest-lapse */
    UPDATE exomem_whats_new_digest_months
    SET state = 'lapsed', updated_at = now()
    WHERE month < ${month} AND state IN ('waiting_for_notes', 'waiting_for_model', 'awaiting_approval')
  `;
  return rowCount ?? 0;
}

/** One query behind every read of month rows: a month, only the countable ones, or the newest few. */
async function readMonths(filter: {
  month?: string;
  countableOnly?: boolean;
  limit: number;
}): Promise<MonthRecord[]> {
  const { rows } = await executeExomemSql`
    /* exomem:whats-new-digest-read-months */
    SELECT month, state, skip_reason, releases_listed_at, last_checked_at, model_status,
           model_id, model_reported, prompt_version, model_selection, blind_pick, decision, final_selection,
           decided_at, send_after, queued_count
    FROM exomem_whats_new_digest_months
    WHERE (${filter.month ?? null}::text IS NULL OR month = ${filter.month ?? null})
      AND (NOT ${filter.countableOnly ?? false}::boolean
           OR (blind_pick IS NOT NULL AND model_selection IS NOT NULL AND model_id IS NOT NULL
               AND model_reported IS NOT NULL AND prompt_version IS NOT NULL))
    ORDER BY month DESC LIMIT ${filter.limit}
  `;
  return rows.map(monthRecord);
}

export async function getMonth(month: string): Promise<MonthRecord | null> {
  return (await readMonths({ month, limit: 1 }))[0] ?? null;
}

/** The newest months, newest first. The operator's list reads a bounded window. */
export function listMonths(limit: number): Promise<MonthRecord[]> {
  return readMonths({ limit });
}

/**
 * Months with a blind pick and a ranking on record, whatever the operator then
 * decided: the measurement's input (measurement.ts). Bounded to the last ten
 * years (a month a row).
 */
export function listCountableMonths(): Promise<MonthRecord[]> {
  return readMonths({ countableOnly: true, limit: 120 });
}

export async function listReleases(
  month: string,
  options: { versions?: readonly string[]; sql?: ExomemSql } = {}
): Promise<ReleaseRecord[]> {
  const versions = options.versions ? [...options.versions] : null;
  const { rows } = await (options.sql ?? executeExomemSql)`
    /* exomem:whats-new-digest-list-releases */
    SELECT version, published_at, notes_file, problem, accepted_without_at
    FROM exomem_whats_new_digest_releases
    WHERE month = ${month} AND (${versions}::text[] IS NULL OR version = ANY(${versions}::text[]))
    ORDER BY published_at DESC, version DESC
  `;
  return rows.map((row) => {
    const version = String(row.version);
    let release: ReleaseNotes | null = null;
    if (row.notes_file) {
      // Stored files passed this reader once; one that no longer does is corrupt, not "no notes".
      const parsed = parseNotesFile(JSON.stringify(row.notes_file), version);
      if (!parsed.ok)
        throw new Error(
          `what's new digest: the stored notes file of release ${version} is unreadable`
        );
      release = parsed.release ?? { version, releasedOn: "", notes: [] };
    }
    return {
      version,
      publishedAt: new Date(row.published_at as string | Date),
      release,
      problem: (row.problem as ReleaseProblem | null) ?? null,
      acceptedWithoutAt: asDate(row.accepted_without_at),
    };
  });
}

/** The month's notes, from the releases whose notes are read, in the stable order the identifiers refer to. */
export function notesOfReleases(releases: readonly ReleaseRecord[]): MonthNote[] {
  return monthNotes(
    releases.flatMap((record) =>
      record.release && record.release.notes.length > 0 ? [record.release] : []
    )
  );
}

/** Releases whose notes are missing and that the operator did not accept without. */
export function missingReleases(releases: readonly ReleaseRecord[]): ReleaseRecord[] {
  return releases.filter((record) => !record.release && !record.acceptedWithoutAt);
}

/**
 * Records a full read of the month's release list: new releases enter as
 * missing, a release that already has its file keeps it, and one that listed
 * no asset before may list it now. One statement for the whole list.
 */
export async function saveListing(month: string, listed: readonly ListedRelease[]): Promise<void> {
  const byVersion = new Map<string, ListedRelease>();
  for (const release of listed)
    if (!byVersion.has(release.version)) byVersion.set(release.version, release);
  const releases = [...byVersion.values()];
  await executeExomemSql`
    /* exomem:whats-new-digest-save-listing */
    INSERT INTO exomem_whats_new_digest_releases (month, version, published_at, asset_url, problem)
    SELECT ${month}, listed.version, listed.published_at, listed.asset_url,
           CASE WHEN listed.asset_url IS NULL THEN 'no_asset' ELSE 'unfetched' END
    FROM unnest(${releases.map((r) => r.version)}::text[], ${releases.map((r) => r.publishedAt.toISOString())}::timestamptz[],
                ${releases.map((r) => r.assetUrl)}::text[]) AS listed(version, published_at, asset_url)
    ON CONFLICT (month, version) DO UPDATE
      SET asset_url = EXCLUDED.asset_url,
          problem = CASE WHEN EXCLUDED.asset_url IS NULL THEN 'no_asset'
                         WHEN exomem_whats_new_digest_releases.problem = 'unreadable'
                              AND exomem_whats_new_digest_releases.asset_url = EXCLUDED.asset_url THEN 'unreadable'
                         ELSE 'unfetched' END
      WHERE exomem_whats_new_digest_releases.notes_file IS NULL
  `;
  await executeExomemSql`
    UPDATE exomem_whats_new_digest_months
    SET releases_listed_at = now(), last_checked_at = now(), updated_at = now()
    WHERE month = ${month}
  `;
}

export async function touchMonth(month: string): Promise<void> {
  await executeExomemSql`
    UPDATE exomem_whats_new_digest_months SET last_checked_at = now() WHERE month = ${month}
  `;
}

/** A release whose file is still to fetch: it lists an asset, has no file and was not accepted without. */
export async function releasesToFetch(
  month: string,
  limit: number
): Promise<Array<{ version: string; assetUrl: string }>> {
  const { rows } = await executeExomemSql`
    /* exomem:whats-new-digest-to-fetch */
    SELECT version, asset_url FROM exomem_whats_new_digest_releases
    WHERE month = ${month} AND notes_file IS NULL AND accepted_without_at IS NULL AND asset_url IS NOT NULL
    ORDER BY published_at DESC LIMIT ${limit}
  `;
  return rows.map((row) => ({ version: String(row.version), assetUrl: String(row.asset_url) }));
}

export type FetchedFile =
  | { version: string; file: unknown }
  | { version: string; problem: "unfetched" | "unreadable" };

/** Keeps each fetched file with its release, once; one statement for the batch. */
export async function saveFetchedFiles(
  month: string,
  results: readonly FetchedFile[]
): Promise<void> {
  if (results.length === 0) return;
  await executeExomemSql`
    /* exomem:whats-new-digest-save-files */
    UPDATE exomem_whats_new_digest_releases AS release
    SET notes_file = incoming.file::jsonb, problem = incoming.problem
    FROM unnest(${results.map((r) => r.version)}::text[],
                ${results.map((r) => ("file" in r ? JSON.stringify(r.file) : null))}::text[],
                ${results.map((r) => ("problem" in r ? r.problem : null))}::text[]) AS incoming(version, file, problem)
    WHERE release.month = ${month} AND release.version = incoming.version AND release.notes_file IS NULL
  `;
}

/** Moves the month on once its list is read and every release that is not accepted without has its notes. */
export async function advanceWhenNotesComplete(month: string): Promise<boolean> {
  const { rowCount } = await executeExomemSql`
    /* exomem:whats-new-digest-notes-complete */
    UPDATE exomem_whats_new_digest_months AS m
    SET state = 'waiting_for_model', updated_at = now()
    WHERE m.month = ${month} AND m.state = 'waiting_for_notes' AND m.releases_listed_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM exomem_whats_new_digest_releases AS r
        WHERE r.month = m.month AND r.notes_file IS NULL AND r.accepted_without_at IS NULL)
  `;
  return (rowCount ?? 0) > 0;
}

/** The operator accepts the month without these releases. Only releases whose notes are still missing take it. */
export async function acceptWithout(month: string, versions: readonly string[]): Promise<number> {
  const { rowCount } = await executeExomemSql`
    /* exomem:whats-new-digest-accept-without */
    UPDATE exomem_whats_new_digest_releases AS r
    SET accepted_without_at = now()
    FROM exomem_whats_new_digest_months AS m
    WHERE r.month = ${month} AND m.month = r.month AND m.state = 'waiting_for_notes'
      AND r.notes_file IS NULL AND r.accepted_without_at IS NULL AND r.version = ANY (${[...versions]}::text[])
  `;
  return rowCount ?? 0;
}

/** The month has too few notes for the bar: nothing to rank, nothing to send. */
export async function skipForTooFewNotes(month: string): Promise<boolean> {
  return skipFrom(month, "waiting_for_model", "too_few_notes");
}

async function skipFrom(
  month: string,
  from: MonthState | "open",
  reason: SkipReason
): Promise<boolean> {
  const { rowCount } = await executeExomemSql`
    /* exomem:whats-new-digest-skip */
    UPDATE exomem_whats_new_digest_months
    SET state = 'skipped', skip_reason = ${reason}, decided_at = now(), updated_at = now()
    WHERE month = ${month}
      AND ((${from} = 'open' AND state IN ('waiting_for_notes', 'waiting_for_model', 'awaiting_approval')) OR state = ${from})
  `;
  return (rowCount ?? 0) > 0;
}

export async function skipMonth(month: string, reason: SkipReason): Promise<boolean> {
  return skipFrom(month, "open", reason);
}

/**
 * A month that still needs its ranking: it waits for the model, or the operator
 * skipped it after a blind pick before the ranking came in. The skipped month's
 * ranking is still recorded, because the measurement counts every month with a
 * blind pick and a ranking, whatever the operator then decided (measurement.ts).
 */
export const needsRanking = (record: MonthRecord): boolean =>
  record.modelSelection === null &&
  (record.state === "waiting_for_model" ||
    (record.state === "skipped" && record.skipReason === "operator" && record.blindPick !== null));

export async function recordModelStatus(month: string, status: ModelStatus): Promise<void> {
  // The same months `needsRanking` names.
  await executeExomemSql`
    UPDATE exomem_whats_new_digest_months
    SET model_status = ${status}, last_checked_at = now(), updated_at = now()
    WHERE month = ${month} AND model_selection IS NULL
      AND (state = 'waiting_for_model'
           OR (state = 'skipped' AND skip_reason = 'operator' AND blind_pick IS NOT NULL))
  `;
}

export type Ranking = {
  picks: readonly NoteId[];
  modelId: string;
  modelReported: string;
  promptVersion: string;
};

/**
 * Records the model's ranking, with the identity it was made under. A month
 * that waited for it moves on to the operator; a skipped month (see
 * `needsRanking`) keeps its state, and reads as quiet when the model also
 * picked none.
 */
export async function recordRanking(month: string, ranking: Ranking): Promise<boolean> {
  const { rowCount } = await executeExomemSql`
    /* exomem:whats-new-digest-record-ranking */
    UPDATE exomem_whats_new_digest_months
    SET state = CASE WHEN state = 'waiting_for_model' THEN 'awaiting_approval' ELSE state END,
        skip_reason = CASE WHEN state = 'skipped' AND jsonb_array_length(${JSON.stringify(ranking.picks)}::jsonb) = 0
                           THEN 'quiet' ELSE skip_reason END,
        model_status = NULL, model_id = ${ranking.modelId}, model_reported = ${ranking.modelReported},
        prompt_version = ${ranking.promptVersion}, model_selection = ${JSON.stringify(ranking.picks)}::jsonb,
        model_ranked_at = now(), last_checked_at = now(), updated_at = now()
    WHERE month = ${month} AND model_selection IS NULL
      AND (state = 'waiting_for_model'
           OR (state = 'skipped' AND skip_reason = 'operator' AND blind_pick IS NOT NULL))
  `;
  return (rowCount ?? 0) > 0;
}

/**
 * The operator's pick comes before the page shows the model's ranking, and it
 * never changes: it is the measurement's answer key. A pick of none skips the
 * month at once, in the same statement (as the approved design says: "or none
 * to skip the month"); the ranking is still recorded for the measurement. The
 * skip reads as quiet when the model already returned none.
 */
export async function recordBlindPick(month: string, picks: readonly NoteId[]): Promise<boolean> {
  const none = picks.length === 0;
  const { rowCount } = await executeExomemSql`
    /* exomem:whats-new-digest-blind-pick */
    UPDATE exomem_whats_new_digest_months
    SET blind_pick = ${JSON.stringify(picks)}::jsonb, blind_picked_at = now(),
        state = CASE WHEN ${none}::boolean THEN 'skipped' ELSE state END,
        skip_reason = CASE WHEN NOT ${none}::boolean THEN skip_reason
                           WHEN model_selection = '[]'::jsonb THEN 'quiet' ELSE 'operator' END,
        decided_at = CASE WHEN ${none}::boolean THEN now() ELSE decided_at END,
        updated_at = now()
    WHERE month = ${month} AND state IN ('waiting_for_model', 'awaiting_approval') AND blind_pick IS NULL
  `;
  return (rowCount ?? 0) > 0;
}

/** The operator's stop window after a month goes out on the standing switch (D2, D4). */
export const AUTOMATIC_SEND_DELAY_MS = 24 * 60 * 60 * 1000;

/**
 * The month is approved, edited or sent on the operator's standing switch: its
 * final selection is stored with the earliest time its digests may queue.
 * An approval queues at once; the switch waits a day, so the operator can stop it.
 */
export async function decideMonth(
  month: string,
  decision: Decision,
  selection: readonly NoteId[],
  sendAfter: Date | null = null
): Promise<boolean> {
  const { rowCount } = await executeExomemSql`
    /* exomem:whats-new-digest-decide */
    UPDATE exomem_whats_new_digest_months
    SET state = 'ready_to_queue', decision = ${decision}, final_selection = ${JSON.stringify(selection)}::jsonb,
        decided_at = now(), send_after = COALESCE(${sendAfter?.toISOString() ?? null}::timestamptz, now()),
        updated_at = now()
    WHERE month = ${month} AND state = 'awaiting_approval'
  `;
  return (rowCount ?? 0) > 0;
}

/**
 * The operator stops a month that is ready to queue or queued: it becomes
 * skipped and keeps its approval and its progress. The fan-out takes only
 * ready months, and a digest still in the outbox is cancelled at send time,
 * because a skipped month has no sendable selection (`sendableSelection`).
 */
export async function stopMonth(month: string): Promise<boolean> {
  const { rowCount } = await executeExomemSql`
    /* exomem:whats-new-digest-stop */
    UPDATE exomem_whats_new_digest_months
    SET state = 'skipped', skip_reason = 'operator', updated_at = now()
    WHERE month = ${month} AND state IN ('ready_to_queue', 'queued')
  `;
  return (rowCount ?? 0) > 0;
}

export type SwitchRecord = {
  sendWithoutApproval: boolean;
  /** The identity measured: the configured name, the model the API reported, and the prompt's hash. */
  modelId: string | null;
  modelReported: string | null;
  promptVersion: string | null;
  shares: Array<{ month: string; both: number; operatorPicks: number; modelPicks: number }>;
  recordedAt: Date;
};

/** The operator's current choice; `null` before any. */
export async function currentSwitch(): Promise<SwitchRecord | null> {
  const { rows } = await executeExomemSql`
    /* exomem:whats-new-digest-switch */
    SELECT send_without_approval, model_id, model_reported, prompt_version, shares, recorded_at
    FROM exomem_whats_new_digest_switch ORDER BY id DESC LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    sendWithoutApproval: row.send_without_approval === true,
    modelId: (row.model_id as string | null) ?? null,
    modelReported: (row.model_reported as string | null) ?? null,
    promptVersion: (row.prompt_version as string | null) ?? null,
    shares: row.shares as SwitchRecord["shares"],
    recordedAt: new Date(row.recorded_at as string | Date),
  };
}

export async function recordSwitch(choice: Omit<SwitchRecord, "recordedAt">): Promise<void> {
  await executeExomemSql`
    /* exomem:whats-new-digest-record-switch */
    INSERT INTO exomem_whats_new_digest_switch (send_without_approval, model_id, model_reported, prompt_version, shares)
    VALUES (${choice.sendWithoutApproval}, ${choice.modelId}, ${choice.modelReported}, ${choice.promptVersion}, ${JSON.stringify(choice.shares)}::jsonb)
  `;
}

/**
 * The notes that a final selection names, in the selection's order, read from
 * only the releases it names. `null` when a named note is not in the month's
 * stored files, which a stored selection never does while the files stay.
 */
export async function readSelectionNotes(
  month: string,
  selection: readonly NoteId[],
  sql: ExomemSql = executeExomemSql
): Promise<MonthNote[] | null> {
  const versions = [...new Set(selection.map((id) => id.version))];
  return resolveSelection(notesOfReleases(await listReleases(month, { versions, sql })), selection);
}

export type QueueingMonth = {
  month: string;
  finalSelection: NoteId[];
  /** The last tenant id the delivery job read; null before its first page. */
  cursor: string | null;
};

/**
 * The month the delivery job queues now: the newest that is ready and whose
 * send time has come (the operator's stop window), locked until the
 * transaction ends, so two overlapping ticks take turns and the second reads
 * the first's cursor. A stop waits for the lock, then finds the month moved on. Two ready months at once cannot happen
 * while a month is queued within the day it is approved; the newest wins then,
 * so an owner is never sent a stale month.
 */
export async function lockMonthToQueue(tx: ExomemSql): Promise<QueueingMonth | null> {
  const { rows } = await tx`
    /* exomem:whats-new-digest-lock-month-to-queue */
    SELECT month, final_selection, queue_cursor
    FROM exomem_whats_new_digest_months
    WHERE state = 'ready_to_queue' AND send_after <= now()
    ORDER BY month DESC LIMIT 1
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) return null;
  const finalSelection = parseNoteIds(row.final_selection);
  if (!finalSelection)
    throw new Error("what's new digest: a stored selection is not a list of note identifiers");
  return {
    month: String(row.month),
    finalSelection,
    cursor: row.queue_cursor === null ? null : String(row.queue_cursor),
  };
}

/** One page is queued: move the cursor, and when no owner is left mark the month queued so no tick scans it again. */
export async function recordQueuedPage(
  tx: ExomemSql,
  month: string,
  page: { cursor: string | null; queued: number; done: boolean }
): Promise<void> {
  await tx`
    /* exomem:whats-new-digest-record-queued-page */
    UPDATE exomem_whats_new_digest_months
    SET queue_cursor = COALESCE(${page.cursor}::uuid, queue_cursor),
        queued_count = queued_count + ${page.queued},
        state = CASE WHEN ${page.done}::boolean THEN 'queued' ELSE state END,
        queued_at = CASE WHEN ${page.done}::boolean THEN now() ELSE queued_at END,
        updated_at = now()
    WHERE month = ${month} AND state = 'ready_to_queue'
  `;
}

/**
 * The final selection of a month that is still to send: ready or queued, so
 * a month the operator skipped or that lapsed sends nothing. `null` otherwise.
 */
export async function sendableSelection(sql: ExomemSql, month: string): Promise<NoteId[] | null> {
  const { rows } = await sql`
    /* exomem:whats-new-digest-sendable-selection */
    SELECT final_selection FROM exomem_whats_new_digest_months
    WHERE month = ${month} AND state IN ('ready_to_queue', 'queued')
  `;
  return rows[0] ? parseNoteIds(rows[0].final_selection) : null;
}
