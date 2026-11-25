import { z } from "zod";

/**
 * What Home sends to and reads from the cell's import filer (evermatter change
 * `file-imports-on-the-cell`). Every shape that pairs with that change lives here, so the real
 * cell reply is reconciled in one file:
 *
 * - the reserved series file that travels inside the encrypted archive, with `filing` and
 *   `origin`;
 * - the `adoption_studio` status call with `view: "filing"`, and the `file` call with
 *   `wait: false` that registers a stage under the caller's login and wakes its filer;
 * - the filing record both calls answer.
 *
 * The record is the contract settled with the cell on 2026-11-25 (the cell change's design.md
 * is its canonical home). Home reads only what it shows: the cell's `person` text and a stop's
 * `reason` are for agents, so they are not parsed and never reach the browser.
 */

/** The cell's reserved file at an import stage's root (`import_stage.SERIES_FILE`). */
export const SERIES_FILE = ".exomem-series.json";

// The coarse families of the device and browser that uploaded an import. A closed set that
// the cell's provenance fields record verbatim; anything else is `other`, never free text.
export const UPLOAD_DEVICE_FAMILIES = ["phone", "tablet", "desktop", "other"] as const;
export const UPLOAD_BROWSER_FAMILIES = ["chrome", "safari", "firefox", "edge", "other"] as const;
export type UploadDeviceFamily = (typeof UPLOAD_DEVICE_FAMILIES)[number];
export type UploadBrowserFamily = (typeof UPLOAD_BROWSER_FAMILIES)[number];

/** The person's own words for where an import came from; bounded so the series file stays small. */
export const ORIGIN_LABEL_MAX = 120;

export type UploadOrigin = {
  label?: string;
  device_family: UploadDeviceFamily;
  browser_family: UploadBrowserFamily;
};

/**
 * The series file's content. `label` is the collection name and `paths` lists every member but
 * the series file itself, as the cell's `Series.listing` expects.
 */
export type ImportSeries = {
  label?: string;
  paths: string[];
  filing: "cell";
  origin: UploadOrigin;
};

/** The one status call Home makes for an import's filing; the stage path is built here only. */
export function filingStatusArguments(importId: string) {
  return { action: "status", path: `_Imports/${importId}`, view: "filing" } as const;
}

/** The wake call: registers the stage under the caller's login and returns its filing record. */
export function filingWakeArguments(importId: string) {
  return { action: "file", path: `_Imports/${importId}`, wait: false } as const;
}

// The cell's codes are tokens of its closed sets (stop codes and left-out reasons, in either
// case); only that shape reaches the page or a log line.
const Code = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const Count = z.number().int().nonnegative();
const Timestamp = z.iso.datetime({ offset: true });

export const FILING_LEFT_OUT_LIMIT = 100;

const FilingProgress = z.object({
  /** Members the stage holds, not counting the series file; null when the cell does not know. */
  total: Count.nullable(),
  filed: Count,
  /** Members skipped because the vault already holds the same bytes. */
  skipped_duplicates: Count,
  failed: Count,
  left_out: Count,
  /** What is still to file; null whenever `total` is. */
  remaining: Count.nullable(),
});

/** The left-out members, present once filing is done: counts by reason and the first ones. */
const FilingLeftOut = z.object({
  by_reason: z.record(Code, Count),
  items: z
    .array(z.object({ path: z.string().min(1).max(4096), code: Code }))
    .max(FILING_LEFT_OUT_LIMIT),
  truncated: z.boolean(),
});

/** What the person must do before filing can carry on. */
const FilingNeed = z.object({
  // `free_space`, `login` and `support` today; Home words those and passes over another one.
  need: z.string().regex(/^[a-z][a-z_]{0,31}$/),
  /** For free space: the bytes the vault must gain, when the cell knows them. */
  bytes: Count.nullable().optional(),
});

export const filingRecord = z.object({
  /** `unknown`: the filer has no record for this stage, so no counts are known. */
  state: z.enum(["working", "parked", "done", "discarded", "unknown"]),
  /** When the cell wrote the record; absent when unknown. */
  as_of: Timestamp.optional(),
  progress: FilingProgress.nullable().default(null),
  left_out: FilingLeftOut.nullable().default(null),
  /** Why filing stopped; set while parked. */
  stop: z.object({ code: Code }).nullable().default(null),
  needs: z.array(FilingNeed).max(16).default([]),
  /** Files handled per minute over the last calls; null until two calls covered filed work. */
  rate: z
    .object({ files_per_minute: z.number().nonnegative(), over_calls: Count })
    .nullable()
    .default(null),
});
export type FilingRecord = z.infer<typeof filingRecord>;

/**
 * What Home's filing route answers: the cell's record, a cell that does not offer the filing
 * view (Home then offers the assistant prompt), or a cell that cannot answer now.
 */
export const filingViewReply = z.discriminatedUnion("state", [
  z.object({ state: z.literal("live"), filing: filingRecord }),
  z.object({ state: z.literal("not_offered") }),
  z.object({
    state: z.literal("unavailable"),
    reason: z.enum([
      "CELL_STOPPED",
      "CELL_NOT_READY",
      "CELL_UNREACHABLE",
      "HOME_CLIENT_DISABLED",
      "ACCOUNT_ACCESS_CLOSED",
      // The cell offers the view, but its record does not match the shape above.
      "FILING_UNREADABLE",
    ]),
  }),
]);
export type FilingView = z.infer<typeof filingViewReply>;
