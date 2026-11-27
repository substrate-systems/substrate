/**
 * The daily route's work (`send-monthly-whats-new-digest`, D1 and D4): build
 * the previous month's selection, once, then wait for the operator. Safe to
 * repeat: each step reads the month's state and moves it one way, so a second
 * run on the same day changes nothing, and a missed day heals on the next run.
 *
 * It queues no email. An approved month is stored with its final ordered
 * selection (`ready_to_queue`); the delivery job's fan-out (fan-out.ts) takes
 * it from there. It builds nothing before the configured first month.
 */

import { whatsNewDigestConfig, type WhatsNewDigestConfig } from "./config";
import { fetchNotesFileText, GitHubUnavailable, listMonthReleases, monthOf } from "./github";
import { switchApplies } from "./measurement";
import { MIN_PICKS, rankMonthNotes, WHATS_NEW_PROMPT_VERSION } from "./model";
import {
  advanceWhenNotesComplete,
  currentSwitch,
  decideMonth,
  ensureMonth,
  getMonth,
  lapseEarlierMonths,
  listReleases,
  missingReleases,
  notesOfReleases,
  recordModelStatus,
  recordRanking,
  releasesToFetch,
  saveFetchedFiles,
  saveListing,
  settleQuietMonth,
  skipForTooFewNotes,
  skipMonth,
  touchMonth,
  type FetchedFile,
} from "./months";
import { parseNotesFile } from "./notes";
import type { MonthState } from "./states";

/** A run fetches at most this many notes files, so a first run over a large month stays inside the route's time. */
const FETCHES_PER_RUN = 150;
const FETCH_CONCURRENCY = 8;

export type RunSummary = {
  month: string;
  /** `null` when the run built nothing: no first month is configured, or this month is before it. */
  state: MonthState | null;
  /** The configured first month (`EXOMEM_WHATS_NEW_FIRST_MONTH`), `null` while unset. */
  firstMonth: string | null;
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
};

/** The previous calendar month in UTC: the month this run builds. */
export function previousMonth(now: Date): string {
  return monthOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
}

/** Reads the month's release list and fetches each missing notes file once. A failure leaves the month waiting. */
async function collectNotes(
  month: string,
  config: WhatsNewDigestConfig,
  options: RunOptions
): Promise<void> {
  try {
    await saveListing(month, await listMonthReleases(month, config, options.githubFetch));
  } catch (error) {
    if (!(error instanceof GitHubUnavailable)) throw error;
    await touchMonth(month);
    return;
  }
  const pending = await releasesToFetch(month, FETCHES_PER_RUN);
  const results: FetchedFile[] = [];
  for (let at = 0; at < pending.length; at += FETCH_CONCURRENCY) {
    const batch = pending.slice(at, at + FETCH_CONCURRENCY);
    results.push(
      ...(await Promise.all(
        batch.map(async ({ version, assetUrl }): Promise<FetchedFile> => {
          let text: string;
          try {
            text = await fetchNotesFileText(assetUrl, config, options.githubFetch);
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

/** One ranking call for the month, then the move the record's state asks for. */
async function rankMonth(
  month: string,
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
  });
  if (outcome.kind !== "ranked") {
    await recordModelStatus(month, outcome.kind);
    return;
  }
  if (!(await recordRanking(month, outcome))) return;
  if (
    switchApplies(await currentSwitch(), {
      modelId: config.modelId,
      promptVersion: WHATS_NEW_PROMPT_VERSION,
    })
  ) {
    // The operator's recorded switch: no approval, and no blind pick to wait for.
    if (outcome.picks.length >= MIN_PICKS) await decideMonth(month, "automatic", outcome.picks);
    else await skipMonth(month, "quiet");
    return;
  }
  await settleQuietMonth(month);
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
  if (record?.state === "waiting_for_model") {
    await rankMonth(month, config, options);
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
    missingReleases: missing,
    lapsedMonths,
  };
}
