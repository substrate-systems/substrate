/**
 * The daily route's work (`send-monthly-whats-new-digest`, D1 and D4): build
 * the previous month's selection, once, then wait for the operator. Safe to
 * repeat: each step reads the month's state and moves it one way, so a second
 * run on the same day changes nothing, and a missed day heals on the next run.
 *
 * It queues no email. An approved month is stored with its final ordered
 * selection (`ready_to_queue`); the delivery job's fan-out (fan-out.ts) takes
 * it from there. It builds nothing before the configured first month. It stops
 * early when the caller's time budget (`deadlineAt`) is spent, leaving the month
 * waiting for the next daily run.
 */

import { whatsNewDigestConfig, type WhatsNewDigestConfig } from "./config";
import {
  fetchNotesFileText,
  GitHubNotConfigured,
  GitHubUnavailable,
  listMonthReleases,
  monthOf,
} from "./github";
import { switchApplies } from "./measurement";
import { rankMonthNotes } from "./model";
import {
  advanceWhenNotesComplete,
  AUTOMATIC_SEND_DELAY_MS,
  currentSwitch,
  decideMonth,
  ensureMonth,
  getMonth,
  lapseEarlierMonths,
  listReleases,
  missingReleases,
  needsRanking,
  notesOfReleases,
  recordListFailure,
  recordModelStatus,
  recordRanking,
  releasesToFetch,
  saveFetchedFiles,
  saveListing,
  skipForTooFewNotes,
  skipMonth,
  type FetchedFile,
  type ListStatus,
} from "./months";
import { parseNotesFile } from "./notes";
import { MIN_PICKS } from "./pick-bounds";
import type { MonthState } from "./states";
import { timeoutWithin } from "./time-budget";

/** A run fetches at most this many notes files, so a first run over a large month stays inside the route's time. */
const FETCHES_PER_RUN = 150;
const FETCH_CONCURRENCY = 8;

export type RunSummary = {
  month: string;
  /** `null` when the run built nothing: no first month is configured, or this month is before it. */
  state: MonthState | null;
  /** The configured first month (`EXOMEM_WHATS_NEW_FIRST_MONTH`), `null` while unset or malformed. */
  firstMonth: string | null;
  /** The first month is set to something that is not a `YYYY-MM` month, so nothing is built. */
  firstMonthMalformed: boolean;
  /**
   * Whether the month's release list was read at the last try: `read`, or the reason it was not.
   * `null` when no month was built, or the month closed before its list was ever tried.
   */
  releaseList: "read" | ListStatus | null;
  /** Releases still without readable notes that the operator has not accepted without. */
  missingReleases: number;
  lapsedMonths: number;
};

export type RunOptions = {
  now?: Date;
  config?: WhatsNewDigestConfig;
  githubFetch?: typeof fetch;
  modelFetch?: typeof fetch;
  retryDelayMs?: number;
  /** Epoch milliseconds after which the run starts no call and no further batch. */
  deadlineAt?: number;
};

/** The previous calendar month in UTC: the month this run builds. */
export function previousMonth(now: Date): string {
  return monthOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
}

/**
 * Reads the month's release list and fetches each missing notes file once. A list that cannot
 * be read is recorded on the month, when and why, and leaves it waiting for the next daily run.
 */
async function collectNotes(
  month: string,
  config: WhatsNewDigestConfig,
  options: RunOptions
): Promise<void> {
  try {
    await saveListing(
      month,
      await listMonthReleases(month, config, options.githubFetch, options.deadlineAt)
    );
  } catch (error) {
    if (!(error instanceof GitHubUnavailable)) throw error;
    await recordListFailure(
      month,
      error instanceof GitHubNotConfigured ? "not_configured" : "unavailable",
      error.message
    );
    return;
  }
  const pending = await releasesToFetch(month, FETCHES_PER_RUN);
  const results: FetchedFile[] = [];
  for (let at = 0; at < pending.length; at += FETCH_CONCURRENCY) {
    // Out of time: keep what is fetched, and the next daily run takes the rest.
    if (timeoutWithin(options.deadlineAt, 1) === null) break;
    const batch = pending.slice(at, at + FETCH_CONCURRENCY);
    results.push(
      ...(await Promise.all(
        batch.map(async ({ version, assetUrl }): Promise<FetchedFile> => {
          let text: string;
          try {
            text = await fetchNotesFileText(
              assetUrl,
              config,
              options.githubFetch,
              options.deadlineAt
            );
          } catch {
            return { version, problem: "unfetched" };
          }
          const parsed = parseNotesFile(text, version);
          return parsed.ok
            ? { version, file: JSON.parse(text) }
            : { version, problem: "unreadable" };
        })
      ))
    );
  }
  await saveFetchedFiles(month, results);
  await advanceWhenNotesComplete(month);
}

/**
 * One ranking call for the month, then the move the record's state asks for.
 * `wasWaiting` is false for a month the operator already skipped: its ranking is
 * recorded and nothing else moves.
 */
async function rankMonth(
  month: string,
  wasWaiting: boolean,
  config: WhatsNewDigestConfig,
  options: RunOptions
): Promise<void> {
  const notes = notesOfReleases(await listReleases(month));
  // Fewer notes than the bar cannot make a digest: no call, no email.
  if (notes.length < MIN_PICKS) {
    await skipForTooFewNotes(month);
    return;
  }
  const outcome = await rankMonthNotes(notes, config, {
    fetchImpl: options.modelFetch,
    retryDelayMs: options.retryDelayMs,
    deadlineAt: options.deadlineAt,
  });
  // No time left for a call: the month stays as it is and the next daily run ranks it.
  if (outcome.kind === "out_of_time") return;
  if (outcome.kind !== "ranked") {
    await recordModelStatus(month, outcome.kind);
    return;
  }
  // A skipped month (the operator's blind none) only gets its ranking recorded for the measurement.
  if (!(await recordRanking(month, outcome)) || !wasWaiting) return;
  // The recorded switch holds only for the identity it was measured under, the model the API reported included.
  if (switchApplies(await currentSwitch(), outcome)) {
    // No approval and no blind pick to wait for, but a day's window in which the operator can stop the month.
    if (outcome.picks.length >= MIN_PICKS) {
      await decideMonth(
        month,
        "automatic",
        outcome.picks,
        new Date(Date.now() + AUTOMATIC_SEND_DELAY_MS)
      );
    } else await skipMonth(month, "quiet");
  }
  // Otherwise the month waits for the operator's pick and decision.
}

export async function runWhatsNewDigestSelection(options: RunOptions = {}): Promise<RunSummary> {
  const config = options.config ?? whatsNewDigestConfig();
  const month = previousMonth(options.now ?? new Date());
  // D1: only a month whose releases all carry a notes file can be built, so the
  // first month is the operator's to set. Months compare as `YYYY-MM` text.
  if (config.firstMonth === null || month < config.firstMonth) {
    return {
      month,
      state: null,
      firstMonth: config.firstMonth,
      firstMonthMalformed: config.firstMonthMalformed,
      releaseList: null,
      missingReleases: 0,
      lapsedMonths: 0,
    };
  }
  await ensureMonth(month);
  const lapsedMonths = await lapseEarlierMonths(month);

  let record = await getMonth(month);
  if (record?.state === "waiting_for_notes") {
    await collectNotes(month, config, options);
    record = await getMonth(month);
  }
  if (record && needsRanking(record)) {
    await rankMonth(month, record.state === "waiting_for_model", config, options);
    record = await getMonth(month);
  }
  if (!record)
    throw new Error("what's new digest: the month's record is missing after it was created");
  const missing =
    record.state === "waiting_for_notes" ? missingReleases(await listReleases(month)).length : 0;
  return {
    month,
    state: record.state,
    firstMonth: config.firstMonth,
    firstMonthMalformed: config.firstMonthMalformed,
    releaseList: record.listStatus ?? (record.releasesListedAt ? "read" : null),
    missingReleases: missing,
    lapsedMonths,
  };
}
