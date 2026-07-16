// Pure, DOM-free state model for the hosted adoption journey. Node-testable
// exactly like home-state.ts. Mirrors the semantics of the packaged Adoption
// Studio UI model (exomem design.md Decision 3 / §UI architecture digest):
// folders default ON, the model records only EXPLICIT choices, and the engine
// materializes the concrete file set from {include, exclude, overrides,
// include_junk} with deeper rules overriding their ancestors.

import type { AdoptionSelection } from "@/lib/exomem-hosted/hosted-browser";
import { nextStatusPollDelayMs } from "../home/home-state";

export type SelectionModel = {
  folders: Record<string, boolean>;
  files: Record<string, boolean>;
  includeJunk: boolean;
};

export type SelectionRules = {
  include?: string[];
  exclude?: string[];
  overrides?: string[];
  include_junk?: boolean;
};

export type InventoryRow = { path: string; eligible: boolean; junk?: boolean };

export type FolderNode = { path: string; depth: number; files: number; notes: number };

export type PlanTotals = { copy?: number; skip_unsupported?: number; skip_junk?: number };

export type PlanItem = {
  original_path?: string;
  title?: string;
  target_name?: string;
};

export type RunOutcome = { status?: string; code?: string; reason?: string };

export type RunDoc = {
  run_id: string;
  phase: string;
  run_ref?: string;
  scan_summary?: {
    totals?: Record<string, unknown>;
    junk_counts?: Record<string, unknown>;
  };
  inventory?: InventoryRow[];
  selection?: { rules?: SelectionRules };
  plan?: { plan_id?: string; totals?: PlanTotals; items?: PlanItem[] };
  outcomes?: Record<string, RunOutcome>;
  verified_unchanged?: number;
  verified_total?: number;
  progress?: { done?: number; total?: number };
  error?: { reason?: string };
};

export type AdoptStep =
  | "start"
  | "findings"
  | "choose"
  | "preview"
  | "organize"
  | "suggestions"
  | "question";

export type AdoptScreen =
  | "start"
  | "scanning"
  | "findings"
  | "choose"
  | "preview"
  | "applying"
  | "result"
  | "handoff"
  | "proposals"
  | "question"
  | "done"
  | "cancelled"
  | "failed"
  | "unknown";

export type ProposalItem = { ref: string; fingerprint: string; title?: string; kind?: string };

export type AnswerHit = { title?: string; excerpt?: string; path?: string };

// --- Selection model --------------------------------------------------------

export function initialSelection(): SelectionModel {
  return { folders: {}, files: {}, includeJunk: false };
}

function underFolder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

function has(record: Record<string, boolean>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function toggleFolder(sel: SelectionModel, path: string, on: boolean): SelectionModel {
  // A folder rule is authoritative for its subtree: clear descendant rules and
  // per-file overrides so the new rule fully determines what is under it.
  const folders: Record<string, boolean> = { [path]: on };
  for (const [key, value] of Object.entries(sel.folders)) {
    if (key !== path && !underFolder(key, path)) folders[key] = value;
  }
  const files: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(sel.files)) {
    if (!underFolder(key, path)) files[key] = value;
  }
  return { ...sel, folders, files };
}

export function overrideFile(sel: SelectionModel, path: string, on: boolean): SelectionModel {
  return { ...sel, files: { ...sel.files, [path]: on } };
}

// Effective ON/OFF for one file: an explicit override wins, else the deepest
// covering folder rule wins, else the folders-default-ON baseline.
export function isFileSelected(sel: SelectionModel, path: string): boolean {
  if (has(sel.files, path)) return sel.files[path];
  let best: string | null = null;
  for (const folder of Object.keys(sel.folders)) {
    if (underFolder(path, folder) && (best === null || folder.length > best.length)) best = folder;
  }
  if (best !== null) return sel.folders[best];
  return true;
}

export function folderState(
  sel: SelectionModel,
  tree: FolderNode[],
  path: string
): "checked" | "unchecked" | "mixed" {
  const on = has(sel.folders, path) ? sel.folders[path] : true;
  for (const node of tree) {
    const child = node.path;
    if (child === path || !underFolder(child, path)) continue;
    if (has(sel.folders, child) && sel.folders[child] !== on) return "mixed";
  }
  for (const file of Object.keys(sel.files)) {
    if (underFolder(file, path) && sel.files[file] !== on) return "mixed";
  }
  return on ? "checked" : "unchecked";
}

export function selectionCounts(
  inventory: InventoryRow[],
  sel: SelectionModel
): { selectedNotes: number; selectableNotes: number; junkAvailable: number; junkIncluded: number } {
  let selectableNotes = 0;
  let selectedNotes = 0;
  let junkAvailable = 0;
  for (const row of inventory) {
    if (row.junk) junkAvailable += 1;
    if (!row.eligible) continue;
    selectableNotes += 1;
    if (isFileSelected(sel, row.path)) selectedNotes += 1;
  }
  return {
    selectedNotes,
    selectableNotes,
    junkAvailable,
    junkIncluded: sel.includeJunk ? junkAvailable : 0,
  };
}

// Translate explicit choices into the engine payload. The engine materializes
// additively from explicit rules with path-specificity ordering, so every
// untouched default-on root must be sent as an explicit include entry, an OFF
// file override is a file-path exclude, and only ON file overrides ride the
// add-only `overrides` list.
export function selectionPayload(sel: SelectionModel, roots: string[]): AdoptionSelection {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const [key, value] of Object.entries(sel.folders)) (value ? include : exclude).push(key);
  for (const root of roots) {
    if (!has(sel.folders, root)) include.push(root);
  }
  const overrides: string[] = [];
  for (const [key, value] of Object.entries(sel.files)) (value ? overrides : exclude).push(key);
  return {
    include: include.sort(),
    exclude: exclude.sort(),
    overrides: overrides.sort(),
    includeJunk: sel.includeJunk,
  };
}

// Inverse of selectionPayload: rebuild the explicit-choice model from a run's
// persisted selection rules so resuming never silently resets the user's
// exclusions and overrides. File-vs-folder is decided by inventory membership.
export function selectionFromRules(
  rules: SelectionRules | null | undefined,
  inventoryPaths: string[]
): SelectionModel | null {
  if (!rules) return null;
  const files = new Set(inventoryPaths);
  const sel: SelectionModel = { folders: {}, files: {}, includeJunk: rules.include_junk === true };
  for (const path of rules.include ?? []) {
    if (files.has(path)) sel.files[path] = true;
    else sel.folders[path] = true;
  }
  for (const path of rules.exclude ?? []) {
    if (files.has(path)) sel.files[path] = false;
    else sel.folders[path] = false;
  }
  for (const path of rules.overrides ?? []) sel.files[path] = true;
  return sel;
}

export function selectionRoots(inventory: InventoryRow[]): string[] {
  const roots = new Set<string>();
  for (const row of inventory) {
    if (!row.eligible) continue;
    const cut = row.path.indexOf("/");
    roots.add(cut === -1 ? row.path : row.path.slice(0, cut));
  }
  return [...roots].sort();
}

// Depth-capped folder node list derived from inventory paths for the
// tri-state tree (depth ≤ 3, matching the packaged studio's derivation).
export function derivedTree(inventory: InventoryRow[]): FolderNode[] {
  const folders = new Map<string, FolderNode>();
  for (const row of inventory) {
    const parts = row.path.split("/");
    for (let depth = 1; depth < parts.length && depth <= 3; depth += 1) {
      const folder = parts.slice(0, depth).join("/");
      if (!folders.has(folder)) folders.set(folder, { path: folder, depth, files: 0, notes: 0 });
    }
    const parent = parts.slice(0, -1).join("/");
    const node = parent ? folders.get(parent) : undefined;
    if (node) {
      node.files += 1;
      if (row.eligible) node.notes += 1;
    }
  }
  return [...folders.values()];
}

export function topFolders(inventory: InventoryRow[]): FolderNode[] {
  return derivedTree(inventory).filter((node) => node.depth === 1);
}

// --- Run polling -------------------------------------------------------------

const TRANSIENT_PHASES = new Set(["created", "scanning", "applying"]);

export function isTransientPhase(phase: string | null | undefined): boolean {
  return typeof phase === "string" && TRANSIENT_PHASES.has(phase);
}

// The adoption run is a cell-owned job Home polls via the `status` registry
// command on the SAME single-flight 3s→30s schedule as the lifecycle poll —
// never the provisioner durability queue.
export function nextRunPollDelayMs(
  phase: string | null | undefined,
  attempt: number
): number | null {
  return nextStatusPollDelayMs(
    {
      state: isTransientPhase(phase) ? "preparing" : "ready",
      code: "ADOPTION_RUN_POLL",
      retryable: true,
    },
    attempt
  );
}

// --- Phase → screen gating ----------------------------------------------------

const POST_APPLY_STEPS: AdoptStep[] = ["organize", "suggestions", "question"];
const LEGAL_STEPS: Record<string, { allowed: AdoptStep[]; fallback: AdoptStep }> = {
  selecting: { allowed: ["findings", "choose", "preview"], fallback: "findings" },
  planned: { allowed: ["findings", "choose", "preview"], fallback: "preview" },
  applied: { allowed: POST_APPLY_STEPS, fallback: "start" },
  partial: { allowed: POST_APPLY_STEPS, fallback: "start" },
  done: { allowed: POST_APPLY_STEPS, fallback: "start" },
};

// Only reviewable steps are routable; transient phases are phase-driven.
export function legalStep(phase: string, astep: AdoptStep): AdoptStep {
  const spec = LEGAL_STEPS[phase];
  if (!spec) return "start";
  return spec.allowed.includes(astep) ? astep : spec.fallback;
}

// The server phase always wins over the requested step.
export function phaseScreen(run: { phase?: string } | null, astep: AdoptStep): AdoptScreen {
  const phase = run?.phase;
  if (!phase) return "start";
  switch (phase) {
    case "created":
    case "scanning":
      return "scanning";
    case "selecting":
      if (astep === "choose") return "choose";
      if (astep === "preview") return "preview";
      return "findings";
    case "planned":
      if (astep === "choose") return "choose";
      if (astep === "findings") return "findings";
      return "preview";
    case "applying":
      return "applying";
    case "applied":
    case "partial":
      if (astep === "organize") return "handoff";
      if (astep === "suggestions") return "proposals";
      if (astep === "question") return "question";
      return "result";
    case "done":
      if (astep === "organize") return "handoff";
      if (astep === "suggestions") return "proposals";
      if (astep === "question") return "question";
      return "done";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}

// --- Plan preview and apply-result presentation --------------------------------

export function planBullets(totals: PlanTotals | undefined): {
  bullets: string[];
  total: number;
  copy: number;
  unsupported: number;
  junk: number;
} {
  const copy = Number(totals?.copy ?? 0);
  const unsupported = Number(totals?.skip_unsupported ?? 0);
  const junk = Number(totals?.skip_junk ?? 0);
  return {
    bullets: [
      `${copy} text notes will be copied in`,
      `${unsupported} photos & other files stay put (not copied — not supported yet)`,
      `${junk} junk files will be skipped`,
      "0 files will be changed, moved, or deleted — always",
    ],
    total: copy + unsupported + junk,
    copy,
    unsupported,
    junk,
  };
}

const FAILURE_REASONS: Record<string, string> = {
  UNSUPPORTED_IMPORT_TYPE: "This kind of file isn't supported yet.",
  ALREADY_GOVERNED: "Already in Exomem's library — no copy needed.",
  NOT_FOUND: "This file moved or was removed after the scan.",
  SOURCE_CHANGED: "This file changed after we looked, so we left it untouched.",
  BATCH_ROLLED_BACK: "Nothing was written for this file — a safety check undid the batch.",
};

export type FailureGroup = { code: string; reason: string; paths: string[] };

export function failureGroups(
  failed: { path: string; code?: string; reason?: string }[]
): FailureGroup[] {
  const groups = new Map<string, FailureGroup>();
  for (const item of failed) {
    const code = item.code || "UNKNOWN";
    const reason =
      FAILURE_REASONS[code] ??
      (item.reason ? `Couldn't be copied: ${item.reason}` : "Couldn't be copied.");
    const group = groups.get(code) ?? { code, reason, paths: [] };
    group.paths.push(item.path);
    groups.set(code, group);
  }
  return [...groups.values()];
}

// Per-item apply detail lives ONLY in the run document's `outcomes` map
// (keyed by original path); derive copied/failed from it, never from a
// synthetic apply_result list.
export function outcomesToResult(run: RunDoc): {
  copied: ({ original_path: string } & RunOutcome)[];
  failed: { path: string; code?: string; reason?: string }[];
} {
  const copied: ({ original_path: string } & RunOutcome)[] = [];
  const failed: { path: string; code?: string; reason?: string }[] = [];
  for (const [path, outcome] of Object.entries(run.outcomes ?? {})) {
    if (outcome.status === "applied" || outcome.status === "already-applied") {
      copied.push({ original_path: path, ...outcome });
    } else if (outcome.status === "failed") {
      failed.push({ path, code: outcome.code, reason: outcome.reason });
    }
  }
  return { copied, failed };
}

// Honest verification line: claim the checksum re-check ONLY when the run
// carries the real top-level verified_unchanged/verified_total counts.
export function verificationLine(run: RunDoc): string {
  if (typeof run.verified_unchanged === "number" && typeof run.verified_total === "number") {
    return `We double-checked your originals: ${run.verified_unchanged} of ${run.verified_total} are byte-for-byte unchanged (checksums match).`;
  }
  return "We didn't re-check your originals this time — but nothing was moved, edited, or deleted.";
}

// --- Response parsing -----------------------------------------------------------

export function parseRunDoc(value: unknown): RunDoc | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const doc = value as Record<string, unknown>;
  if (typeof doc.run_id !== "string" || !doc.run_id || typeof doc.phase !== "string") return null;
  const inventory = Array.isArray(doc.inventory)
    ? doc.inventory
        .filter(
          (row): row is Record<string, unknown> =>
            !!row && typeof row === "object" && !Array.isArray(row) && typeof row.path === "string"
        )
        .map((row) => ({
          path: row.path as string,
          eligible: row.eligible === true,
          junk: row.junk === true,
        }))
    : undefined;
  return { ...(doc as unknown as RunDoc), ...(inventory ? { inventory } : {}) };
}

export function scanTotals(run: RunDoc): {
  files: number;
  dirs: number;
  markdown: number;
  binary: number;
} {
  const totals = run.scan_summary?.totals ?? {};
  return {
    files: Number(totals.files ?? 0),
    dirs: Number(totals.dirs ?? 0),
    markdown: Number(totals.markdown ?? 0),
    binary: Number(totals.binary ?? 0),
  };
}

export function junkTotal(run: RunDoc): number {
  const fromCounts = Object.values(run.scan_summary?.junk_counts ?? {}).reduce(
    (sum: number, value) => sum + Number(value ?? 0),
    0
  );
  return fromCounts || (run.inventory ?? []).filter((row) => row.junk).length;
}

export function flattenProposals(value: unknown): ProposalItem[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const data = value as Record<string, unknown>;
  const rows: unknown[] = Array.isArray(data.items)
    ? data.items
    : Array.isArray(data.groups)
      ? data.groups.flatMap((group: unknown) =>
          group && typeof group === "object" && Array.isArray((group as { items?: unknown }).items)
            ? ((group as { items: unknown[] }).items ?? [])
            : []
        )
      : [];
  const items: ProposalItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const item = row as Record<string, unknown>;
    if (typeof item.ref !== "string" || typeof item.fingerprint !== "string") continue;
    items.push({
      ref: item.ref,
      fingerprint: item.fingerprint,
      title: typeof item.title === "string" ? item.title : undefined,
      kind: typeof item.kind === "string" ? item.kind : undefined,
    });
  }
  return items;
}

export function answerHits(value: unknown): AnswerHit[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const data = value as Record<string, unknown>;
  const rows = [data.hits, data.results, data.items].find(Array.isArray) ?? [];
  const hits: AnswerHit[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const hit = row as Record<string, unknown>;
    const title = typeof hit.title === "string" ? hit.title : undefined;
    const excerpt = typeof hit.excerpt === "string" ? hit.excerpt : undefined;
    const path = typeof hit.path === "string" ? hit.path : undefined;
    if (!title && !path) continue;
    hits.push({ title, excerpt, path });
  }
  return hits;
}

// --- Staging run slug ------------------------------------------------------------

// Must satisfy the upload route's run-id slug validation (transfers.ts).
export const STAGING_RUN_SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function newStagingRunSlug(): string {
  return crypto.randomUUID();
}

export function stagingPathForRun(slug: string): string {
  if (!STAGING_RUN_SLUG.test(slug)) throw new Error("invalid adoption staging run slug");
  return `_Staging/adoption/${slug}`;
}
