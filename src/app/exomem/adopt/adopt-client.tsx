"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  adoptionProposalContext,
  adoptionRunStatus,
  applyAdoptionPlan,
  approveAdoptionProposal,
  friendlyHostedError,
  HostedBrowserError,
  listAdoptionProposals,
  newRetryKey,
  planAdoptionRun,
  postAdoptionFile,
  postPrivateJson,
  rejectAdoptionProposal,
  retryAdoptionApply,
  selectAdoptionScope,
  startAdoptionRun,
} from "@/lib/exomem-hosted/hosted-browser";
import styles from "../private-shell.module.css";
import { createSingleFlight } from "../home/home-state";
import {
  type AdoptStep,
  type AnswerHit,
  type ProposalItem,
  type RunDoc,
  type SelectionModel,
  answerHits,
  derivedTree,
  failureGroups,
  flattenProposals,
  folderState,
  initialSelection,
  isFileSelected,
  isTransientPhase,
  junkTotal,
  legalStep,
  newStagingRunSlug,
  nextRunPollDelayMs,
  outcomesToResult,
  overrideFile,
  parseRunDoc,
  phaseScreen,
  planBullets,
  scanTotals,
  selectionCounts,
  selectionFromRules,
  selectionPayload,
  selectionRoots,
  stagingPathForRun,
  toggleFolder,
  topFolders,
  verificationLine,
} from "./adopt-state";

const FILE_PAGE = 200;
const STALE_CODES = new Set(["ADOPTION_SOURCE_CHANGED", "PLAN_STALE"]);

type ProposalContext = Record<string, unknown>;
type ProposalDetail = { item: ProposalItem; context: ProposalContext | null };

function isStale(error: unknown): error is HostedBrowserError {
  return error instanceof HostedBrowserError && STALE_CODES.has(error.code);
}

function isDrift(error: unknown): error is HostedBrowserError {
  return error instanceof HostedBrowserError && error.code === "REVIEW_ITEM_CHANGED";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function relativeDir(file: File): string | null {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
  const cut = relative.lastIndexOf("/");
  return cut > 0 ? relative.slice(0, cut) : null;
}

export default function AdoptClient() {
  const [run, setRun] = useState<RunDoc | null>(null);
  const [step, setStep] = useState<AdoptStep>("start");
  const [selection, setSelection] = useState<SelectionModel>(initialSelection());
  const [intake, setIntake] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [noticeError, setNoticeError] = useState(false);
  const [stale, setStale] = useState<string | null>(null);
  const [confirmingApply, setConfirmingApply] = useState(false);
  const [openFolder, setOpenFolder] = useState("");
  const [filesShown, setFilesShown] = useState(FILE_PAGE);
  const [proposals, setProposals] = useState<ProposalItem[] | null>(null);
  const [detail, setDetail] = useState<ProposalDetail | null>(null);
  const [confirmingProposal, setConfirmingProposal] = useState(false);
  const [askQuery, setAskQuery] = useState("");
  const [answers, setAnswers] = useState<AnswerHit[] | null>(null);

  const uploadSlugRef = useRef<string | null>(null);
  const startKeyRef = useRef(newRetryKey());
  const retryKeysRef = useRef(new Map<string, string>());
  const statusFlightRef = useRef(createSingleFlight<Record<string, unknown>>());

  // The server phase always wins: derive the legal step (and screen) from the
  // run document rather than trusting the last requested step.
  const effectiveStep = run ? legalStep(run.phase, step) : step;
  const screen = run ? phaseScreen(run, effectiveStep) : "start";
  const rows = run?.inventory ?? [];

  function stableKey(scope: string): string {
    const existing = retryKeysRef.current.get(scope);
    if (existing) return existing;
    const key = newRetryKey();
    retryKeysRef.current.set(scope, key);
    return key;
  }

  function settleKey(scope: string): void {
    retryKeysRef.current.delete(scope);
  }

  function fail(error: unknown): void {
    setNotice(friendlyHostedError(error));
    setNoticeError(true);
  }

  // Poll the run while its phase is transient, coalesced through the shared
  // single-flight so overlapping refreshes cannot land stale documents.
  useEffect(() => {
    if (!run || !isTransientPhase(run.phase)) return;
    const runId = run.run_id;
    let cancelled = false;
    let timer: number | undefined;

    function schedule(attempt: number): void {
      const delay = nextRunPollDelayMs("applying", attempt);
      if (delay === null || cancelled) return;
      timer = window.setTimeout(() => {
        void statusFlightRef.current(() => adoptionRunStatus(runId))
          .then((response) => {
            if (cancelled) return;
            const next = parseRunDoc(response.data);
            if (next) setRun(next);
            if (!next || isTransientPhase(next.phase)) schedule(attempt + 1);
          })
          .catch(() => {
            if (!cancelled) schedule(attempt + 1);
          });
      }, delay);
    }

    schedule(0);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [run?.run_id, run?.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadProposals = useCallback(async () => {
    if (!run) return;
    const response = await listAdoptionProposals(run.run_ref ?? null);
    setProposals(flattenProposals(response.data));
  }, [run]);

  // Entering the suggestions step is always click-driven; load on entry.
  function goToProposals(): void {
    setStep("suggestions");
    setProposals(null);
    void loadProposals().catch(fail);
  }

  async function refreshRun(runId: string): Promise<RunDoc | null> {
    const response = await statusFlightRef.current(() => adoptionRunStatus(runId));
    const doc = parseRunDoc(response.data);
    if (doc) setRun(doc);
    return doc;
  }

  async function bringIn(): Promise<void> {
    if (!intake.length || busy) return;
    setBusy(true);
    setNoticeError(false);
    const slug = uploadSlugRef.current ?? newStagingRunSlug();
    uploadSlugRef.current = slug;
    try {
      for (let index = 0; index < intake.length; index += 1) {
        setNotice(`Uploading ${index + 1} of ${intake.length}: ${intake[index].name}…`);
        await postAdoptionFile(intake[index], slug, relativeDir(intake[index]));
      }
      setNotice("Looking through your files…");
      const response = await startAdoptionRun(
        { path: stagingPathForRun(slug) },
        startKeyRef.current
      );
      let doc = parseRunDoc(response.data);
      if (doc && (!doc.inventory || isTransientPhase(doc.phase))) {
        doc = (await refreshRun(doc.run_id)) ?? doc;
      }
      if (!doc) throw new Error("invalid adoption run response");
      uploadSlugRef.current = null;
      startKeyRef.current = newRetryKey();
      const resumed = selectionFromRules(
        doc.selection?.rules,
        (doc.inventory ?? []).map((row) => row.path)
      );
      setSelection(resumed ?? initialSelection());
      setRun(doc);
      setStep("findings");
      setNotice("");
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  async function toPreview(): Promise<void> {
    if (!run || busy) return;
    setBusy(true);
    setNoticeError(false);
    setNotice("Working out exactly what will happen…");
    const payload = selectionPayload(selection, selectionRoots(rows));
    const selectScope = `select:${run.run_id}:${JSON.stringify(payload)}`;
    const planScope = `plan:${run.run_id}`;
    try {
      await selectAdoptionScope(run.run_id, payload, stableKey(selectScope));
      settleKey(selectScope);
      const response = await planAdoptionRun(run.run_id, stableKey(planScope));
      settleKey(planScope);
      const doc = parseRunDoc(response.data);
      if (!doc) throw new Error("invalid adoption plan response");
      setRun(doc);
      setStale(null);
      setStep("preview");
      setNotice("");
    } catch (error) {
      if (isStale(error)) {
        setStep("preview");
        setStale(
          `Your folder changed since we looked: ${error.message} Nothing has been copied yet.`
        );
        setNotice("");
      } else {
        fail(error);
      }
    } finally {
      setBusy(false);
    }
  }

  // Re-checking replaces only the run document; the selection model stays as
  // the user left it, so a stale plan never resets their choices.
  async function recheck(): Promise<void> {
    if (!run || busy) return;
    setBusy(true);
    setNotice("Re-checking your files…");
    setNoticeError(false);
    try {
      await refreshRun(run.run_id);
      setStale(null);
      setStep("choose");
      setNotice("");
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  async function applyPlan(): Promise<void> {
    const planId = run?.plan?.plan_id;
    if (!run || typeof planId !== "string" || busy) return;
    setBusy(true);
    setNoticeError(false);
    const scope = `apply:${run.run_id}:${planId}`;
    try {
      const response = await applyAdoptionPlan(run.run_id, planId, stableKey(scope));
      settleKey(scope);
      setConfirmingApply(false);
      const doc = parseRunDoc(response.data);
      if (doc) setRun(doc);
      else await refreshRun(run.run_id);
      setStep("start");
      setNotice("");
    } catch (error) {
      setConfirmingApply(false);
      if (isStale(error)) {
        setStep("preview");
        setStale(
          `Your folder changed since we looked: ${error.message} Nothing has been copied yet.`
        );
      } else {
        fail(error);
      }
    } finally {
      setBusy(false);
    }
  }

  async function retryFailed(paths: string[]): Promise<void> {
    const planId = run?.plan?.plan_id;
    if (!run || typeof planId !== "string" || busy) return;
    setBusy(true);
    setNoticeError(false);
    setNotice("Bringing the rest of your files in…");
    const scope = `retry:${run.run_id}:${planId}:${paths.join(",")}`;
    try {
      const response = await retryAdoptionApply(run.run_id, planId, paths, stableKey(scope));
      settleKey(scope);
      const doc = parseRunDoc(response.data);
      if (doc) setRun(doc);
      else await refreshRun(run.run_id);
      setNotice("");
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  async function openProposal(item: ProposalItem): Promise<void> {
    setDetail({ item, context: null });
    setNoticeError(false);
    try {
      const response = await adoptionProposalContext(item.ref, item.fingerprint);
      setDetail({ item, context: record(response.data) });
    } catch (error) {
      setDetail(null);
      if (isDrift(error)) {
        setNotice(
          "This suggestion is out of date — the files changed since it was made. Nothing was changed; the list has been refreshed."
        );
        setNoticeError(true);
        await loadProposals().catch(fail);
        return;
      }
      fail(error);
    }
  }

  async function approve(): Promise<void> {
    if (!detail?.context || busy) return;
    const { item, context } = detail;
    const expectedHash = text(record(context.target).content_hash) ?? undefined;
    setBusy(true);
    setNoticeError(false);
    const scope = `approve:${item.ref}:${item.fingerprint}`;
    try {
      await approveAdoptionProposal(
        {
          ref: item.ref,
          expectedFingerprint: item.fingerprint,
          why: "Approved from adoption review",
          expectedHash,
        },
        stableKey(scope)
      );
      settleKey(scope);
      setConfirmingProposal(false);
      setDetail(null);
      setNotice("Done — the change was made.");
      await loadProposals().catch(fail);
    } catch (error) {
      setConfirmingProposal(false);
      if (isDrift(error)) {
        setDetail(null);
        setNotice("This suggestion is out of date — nothing was changed; the list has been refreshed.");
        setNoticeError(true);
        await loadProposals().catch(fail);
      } else {
        fail(error);
      }
    } finally {
      setBusy(false);
    }
  }

  async function reject(): Promise<void> {
    if (!detail || busy) return;
    const { item } = detail;
    setBusy(true);
    setNoticeError(false);
    const scope = `reject:${item.ref}:${item.fingerprint}`;
    try {
      await rejectAdoptionProposal(
        { ref: item.ref, expectedFingerprint: item.fingerprint },
        stableKey(scope)
      );
      settleKey(scope);
      setDetail(null);
      setNotice("Dismissed. Nothing was changed.");
      await loadProposals().catch(fail);
    } catch (error) {
      if (isDrift(error)) {
        setDetail(null);
        setNotice("This suggestion is out of date — nothing was changed; the list has been refreshed.");
        setNoticeError(true);
        await loadProposals().catch(fail);
      } else {
        fail(error);
      }
    } finally {
      setBusy(false);
    }
  }

  async function ask(): Promise<void> {
    const query = askQuery.trim();
    if (!query || busy) return;
    setBusy(true);
    setNoticeError(false);
    setNotice("Asking your Exomem…");
    setAnswers(null);
    try {
      const response = await postPrivateJson("/api/exomem/commands/ask_memory", {
        query,
        mode: "keyword",
        detail: "compact",
        rerank: false,
        limit: 5,
      });
      setAnswers(answerHits(response.data));
      setNotice("");
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  function startOver(): void {
    setRun(null);
    setStep("start");
    setSelection(initialSelection());
    setIntake([]);
    setProposals(null);
    setDetail(null);
    setStale(null);
    setAnswers(null);
    setAskQuery("");
    setNotice("");
    setNoticeError(false);
    uploadSlugRef.current = null;
    startKeyRef.current = newRetryKey();
    retryKeysRef.current.clear();
  }

  const status = (
    <p className={`${styles.status} ${noticeError ? styles.error : ""}`} aria-live="polite">
      {notice}
    </p>
  );

  function renderStart() {
    const totalBytes = intake.reduce((sum, file) => sum + file.size, 0);
    return (
      <>
        <p className={styles.eyebrow}>Bring your notes in</p>
        <h1 className={styles.title} id="adopt-title">
          Copy your existing notes into Exomem.
        </h1>
        <p className={styles.lede}>
          Pick your files — or a ZIP of a whole folder. Exomem looks through them, shows you
          exactly what it found, and copies in only what you approve. Copies, never moves: every
          original stays exactly where it is.
        </p>
        <div className={styles.form}>
          <label className={styles.quietButton} aria-disabled={busy}>
            {intake.length ? "Choose different files" : "Choose files or a ZIP"}
            <input
              type="file"
              hidden
              multiple
              disabled={busy}
              onChange={(event) => {
                setIntake(Array.from(event.currentTarget.files ?? []));
                event.currentTarget.value = "";
              }}
            />
          </label>
          {intake.length > 0 && (
            <p className={styles.secondaryCopy}>
              {intake.length} {intake.length === 1 ? "file" : "files"} selected ·{" "}
              {(totalBytes / (1024 * 1024)).toFixed(1)} MB
            </p>
          )}
          <button
            className={styles.button}
            type="button"
            onClick={() => void bringIn()}
            disabled={busy || !intake.length}
          >
            {busy ? "Working…" : "Look through these files"}
          </button>
        </div>
        {busy && <div className={styles.spinner} role="status" aria-label="Uploading files" />}
        {status}
      </>
    );
  }

  function renderScanning() {
    return (
      <>
        <p className={styles.eyebrow}>Looking around</p>
        <h1 className={styles.title} id="adopt-title">
          Looking through your files…
        </h1>
        <p className={styles.lede}>
          This usually takes under a minute. Nothing is copied or changed while we look.
        </p>
        <div className={styles.spinner} role="status" aria-label="Scanning files" />
        {status}
      </>
    );
  }

  function renderFindings() {
    if (!run) return null;
    const totals = scanTotals(run);
    const junk = junkTotal(run);
    const tiles: [number, string][] = [
      [totals.files, "files"],
      [totals.dirs, "folders"],
      [totals.markdown, "notes & text"],
      [totals.binary, "photos & other"],
      [junk, "look like junk"],
    ];
    return (
      <>
        <p className={styles.eyebrow}>Here&rsquo;s what we found</p>
        <h1 className={styles.title} id="adopt-title">
          A look inside your files.
        </h1>
        <div className={styles.secondaryRow}>
          {tiles.map(([value, label]) => (
            <div key={label}>
              <strong>{value}</strong>
              <p className={styles.secondaryCopy}>{label}</p>
            </div>
          ))}
        </div>
        {totals.binary > 0 && (
          <p className={styles.secondaryCopy}>
            Photos, PDFs and other non-text files: {totals.binary} — this brings in text notes
            only. They stay put; you can add them later.
          </p>
        )}
        {junk > 0 && (
          <p className={styles.secondaryCopy}>
            Probably junk — {junk} files (empty files, sync-conflict copies). We&rsquo;ll skip
            these unless you say otherwise.
          </p>
        )}
        <div className={styles.buttonGroup}>
          <button
            className={styles.button}
            type="button"
            onClick={() => setStep("choose")}
            disabled={busy}
          >
            Choose what comes in
          </button>
          <button className={styles.quietButton} type="button" onClick={startOver} disabled={busy}>
            Start over
          </button>
        </div>
        {status}
      </>
    );
  }

  function renderChoose() {
    if (!run) return null;
    // Rows show top-level folders, but tri-state must see the FULL depth-capped
    // tree so a deeper folder rule marks its ancestors as mixed. Files staged
    // without a subdirectory have no folder row — list them directly.
    const roots = topFolders(rows);
    const tree = derivedTree(rows);
    const rootFiles = rows.filter((row) => !row.path.includes("/"));
    const counts = selectionCounts(rows, selection);
    const junk = junkTotal(run);
    const openRows = openFolder
      ? rows.filter(
          (row) => row.path === openFolder || row.path.startsWith(`${openFolder}/`)
        )
      : [];
    return (
      <>
        <p className={styles.eyebrow}>You choose</p>
        <h1 className={styles.title} id="adopt-title">
          Choose what comes in.
        </h1>
        <p className={styles.lede}>
          Everything starts selected. Untick a folder to leave it out, or open it to pick
          individual files.
        </p>
        <ul role="tree" aria-label="Folders">
          {roots.map((folder) => {
            const state = folderState(selection, tree, folder.path);
            return (
              <li key={folder.path} role="treeitem" aria-selected={state === "checked"}>
                <label>
                  <input
                    type="checkbox"
                    checked={state === "checked"}
                    ref={(node) => {
                      if (node) node.indeterminate = state === "mixed";
                    }}
                    onChange={(event) =>
                      setSelection(toggleFolder(selection, folder.path, event.target.checked))
                    }
                  />{" "}
                  <strong>{folder.path}</strong>{" "}
                  <span className={styles.secondaryCopy}>
                    {folder.files} files · {folder.notes} notes
                  </span>
                </label>{" "}
                <button
                  className={styles.quietButton}
                  type="button"
                  aria-expanded={openFolder === folder.path}
                  onClick={() => {
                    setOpenFolder(openFolder === folder.path ? "" : folder.path);
                    setFilesShown(FILE_PAGE);
                  }}
                >
                  {openFolder === folder.path ? "hide files" : "see files"}
                </button>
              </li>
            );
          })}
        </ul>
        {rootFiles.length > 0 && (
          <ul role="group" aria-label="Files">
            {rootFiles.slice(0, FILE_PAGE).map((row) => (
              <li key={row.path}>
                <label>
                  <input
                    type="checkbox"
                    checked={isFileSelected(selection, row.path)}
                    disabled={!row.eligible}
                    onChange={(event) =>
                      setSelection(overrideFile(selection, row.path, event.target.checked))
                    }
                  />{" "}
                  {row.eligible ? row.path : `${row.path} — can't be copied yet (not a text file)`}
                </label>
              </li>
            ))}
          </ul>
        )}
        {openFolder && (
          <div>
            <p className={styles.secondaryCopy}>
              Showing {Math.min(filesShown, openRows.length)} of {openRows.length}
            </p>
            <ul role="group" aria-label={`Files in ${openFolder}`}>
              {openRows.slice(0, filesShown).map((row) => (
                <li key={row.path}>
                  <label>
                    <input
                      type="checkbox"
                      checked={isFileSelected(selection, row.path)}
                      disabled={!row.eligible}
                      onChange={(event) =>
                        setSelection(overrideFile(selection, row.path, event.target.checked))
                      }
                    />{" "}
                    {row.eligible ? row.path : `${row.path} — can't be copied yet (not a text file)`}
                  </label>
                </li>
              ))}
            </ul>
            {openRows.length > filesShown && (
              <button
                className={styles.quietButton}
                type="button"
                onClick={() => setFilesShown(filesShown + FILE_PAGE)}
              >
                Show {FILE_PAGE} more
              </button>
            )}
          </div>
        )}
        {junk > 0 && (
          <label className={styles.secondaryCopy}>
            <input
              type="checkbox"
              checked={selection.includeJunk}
              onChange={(event) =>
                setSelection({ ...selection, includeJunk: event.target.checked })
              }
            />{" "}
            Include the {junk} probably-junk files too
          </label>
        )}
        <p className={styles.secondaryCopy}>
          {counts.selectedNotes} of {counts.selectableNotes} text notes selected ·{" "}
          {selection.includeJunk ? `${counts.junkIncluded} junk included` : "junk skipped"}
        </p>
        <div className={styles.buttonGroup}>
          <button
            className={styles.button}
            type="button"
            onClick={() => void toPreview()}
            disabled={busy || counts.selectedNotes === 0}
          >
            {busy ? "Working…" : "Check the plan"}
          </button>
          <button
            className={styles.quietButton}
            type="button"
            onClick={() => setStep("findings")}
            disabled={busy}
          >
            Back
          </button>
        </div>
        {status}
      </>
    );
  }

  function renderPreview() {
    if (!run) return null;
    const totals = run.plan?.totals;
    const { bullets, copy } = planBullets(totals);
    const items = run.plan?.items ?? [];
    return (
      <>
        <p className={styles.eyebrow}>Exactly what will happen</p>
        <h1 className={styles.title} id="adopt-title">
          The plan, in full.
        </h1>
        {stale && (
          <div className={styles.result} role="alert">
            <p className={styles.resultTitle}>Your files changed since we looked</p>
            <p className={styles.resultBody}>{stale}</p>
            <button
              className={styles.quietButton}
              type="button"
              onClick={() => void recheck()}
              disabled={busy}
            >
              Re-check and keep my choices
            </button>
          </div>
        )}
        {!stale && (
          <>
            <p className={styles.lede}>
              Exomem will COPY {copy} files into its own library. Copies, never moves: every
              original stays exactly where it is.
            </p>
            <ul>
              {bullets.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {items.length > 0 && (
              <details className={styles.secondary}>
                <summary className={styles.summary}>
                  See every file ({Math.min(FILE_PAGE, items.length)} shown of {items.length})
                </summary>
                <ul className={styles.secondaryBody}>
                  {items.slice(0, FILE_PAGE).map((item, index) => (
                    <li key={item.original_path ?? index}>
                      {item.original_path} → copied in as &ldquo;
                      {item.title ?? item.target_name ?? ""}&rdquo;
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className={styles.buttonGroup}>
              <button
                className={styles.button}
                type="button"
                onClick={() => setConfirmingApply(true)}
                disabled={busy || typeof run.plan?.plan_id !== "string"}
              >
                Copy {copy} files in
              </button>
              <button
                className={styles.quietButton}
                type="button"
                onClick={() => setStep("choose")}
                disabled={busy}
              >
                Back to choosing
              </button>
            </div>
          </>
        )}
        {confirmingApply && (
          <div
            className={styles.result}
            role="dialog"
            aria-modal="true"
            aria-labelledby="adopt-confirm-title"
          >
            <p className={styles.resultTitle} id="adopt-confirm-title">
              Copy {copy} files into Exomem?
            </p>
            <p className={styles.resultBody}>
              This adds copies to Exomem&rsquo;s library. Your originals are not touched.
            </p>
            <div className={styles.buttonGroup}>
              <button
                className={styles.button}
                type="button"
                onClick={() => void applyPlan()}
                disabled={busy}
              >
                {busy ? "Copying…" : "Yes, copy them in"}
              </button>
              <button
                className={styles.quietButton}
                type="button"
                onClick={() => setConfirmingApply(false)}
                disabled={busy}
              >
                Not yet
              </button>
            </div>
          </div>
        )}
        {status}
      </>
    );
  }

  function renderApplying() {
    const progress = run?.progress;
    return (
      <>
        <p className={styles.eyebrow}>Bringing your files in</p>
        <h1 className={styles.title} id="adopt-title">
          Copying…
        </h1>
        <p className={styles.lede}>
          {typeof progress?.done === "number" && typeof progress?.total === "number"
            ? `Copied ${progress.done} of ${progress.total}.`
            : "Bringing your files in…"}{" "}
          Your originals are untouched either way.
        </p>
        <div className={styles.spinner} role="status" aria-label="Copying files" />
        {status}
      </>
    );
  }

  function renderResult() {
    if (!run) return null;
    const { copied, failed } = outcomesToResult(run);
    const groups = failureGroups(failed);
    return (
      <>
        <p className={styles.eyebrow}>Done copying</p>
        <h1 className={styles.title} id="adopt-title">
          {failed.length
            ? `${copied.length} files are in · ${failed.length} couldn't be copied`
            : `All set — ${copied.length} files are in.`}
        </h1>
        <p className={styles.lede}>{verificationLine(run)}</p>
        {groups.map((group) => (
          <div key={group.code} className={styles.result}>
            <p className={styles.resultTitle}>{group.reason}</p>
            <p className={styles.resultBody}>{group.paths.join("\n")}</p>
          </div>
        ))}
        <div className={styles.buttonGroup}>
          {failed.length > 0 && typeof run.plan?.plan_id === "string" && (
            <button
              className={styles.button}
              type="button"
              onClick={() => void retryFailed(failed.map((item) => item.path))}
              disabled={busy}
            >
              Try those {failed.length} again
            </button>
          )}
          <button
            className={styles.quietButton}
            type="button"
            onClick={goToProposals}
            disabled={busy}
          >
            Review suggestions
          </button>
          <button
            className={styles.quietButton}
            type="button"
            onClick={() => setStep("question")}
            disabled={busy}
          >
            Skip to your first question
          </button>
        </div>
        {status}
      </>
    );
  }

  function renderProposalDetail() {
    if (!detail) return null;
    if (!detail.context) {
      return (
        <div className={styles.result}>
          <p className={styles.resultBody}>Loading suggestion…</p>
        </div>
      );
    }
    const payload = record(detail.context.payload);
    const target = record(detail.context.target);
    const title = text(payload.title);
    const relationType = text(payload.relation_type);
    const from = text(payload.from) ?? text(payload.subject_path);
    const to = text(payload.to) ?? text(payload.duplicate_of);
    const entityName = text(payload.name);
    const summary = text(payload.summary);
    const content = text(payload.content);
    const excerpt = text(target.excerpt);
    const contentHash = text(target.content_hash);
    return (
      <div className={styles.result}>
        <p className={styles.resultTitle}>What it wants to do</p>
        {title && <p className={styles.resultBody}>{title}</p>}
        {(relationType || (from && to)) && (
          <p className={styles.resultBody}>
            {relationType ?? "relates_to"}: {from ?? ""} → {to ?? ""}
          </p>
        )}
        {entityName && (
          <p className={styles.resultBody}>
            {text(payload.entity_type) ?? "entity"}: {entityName}
          </p>
        )}
        {summary && <p className={styles.secondaryCopy}>{summary}</p>}
        {content && <pre className={styles.resultBody}>{content}</pre>}
        {excerpt && (
          <>
            <p className={styles.resultTitle}>Current target</p>
            <pre className={styles.resultBody}>{excerpt}</pre>
          </>
        )}
        {contentHash && (
          <p className={styles.secondaryCopy}>Target checksum: {contentHash}</p>
        )}
        <div className={styles.buttonGroup}>
          <button
            className={styles.button}
            type="button"
            onClick={() => setConfirmingProposal(true)}
            disabled={busy}
          >
            Make this change
          </button>
          <button
            className={styles.quietButton}
            type="button"
            onClick={() => void reject()}
            disabled={busy}
          >
            No thanks
          </button>
          <button
            className={styles.quietButton}
            type="button"
            onClick={() => setDetail(null)}
            disabled={busy}
          >
            Back to the list
          </button>
        </div>
        {confirmingProposal && (
          <div role="dialog" aria-modal="true" aria-labelledby="adopt-proposal-confirm-title">
            <p className={styles.resultTitle} id="adopt-proposal-confirm-title">
              Make this change?
            </p>
            <p className={styles.resultBody}>
              {detail.item.title ?? "Apply this suggestion. You can review the result afterwards."}
            </p>
            <div className={styles.buttonGroup}>
              <button
                className={styles.button}
                type="button"
                onClick={() => void approve()}
                disabled={busy}
              >
                {busy ? "Applying…" : "Make this change"}
              </button>
              <button
                className={styles.quietButton}
                type="button"
                onClick={() => setConfirmingProposal(false)}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  function renderProposals() {
    return (
      <>
        <p className={styles.eyebrow}>Suggestions from your assistant</p>
        <h1 className={styles.title} id="adopt-title">
          Review suggestions.
        </h1>
        <p className={styles.lede}>
          Each suggestion is applied only after you approve it — inspect exactly what will be
          written first.
        </p>
        {detail ? (
          renderProposalDetail()
        ) : (
          <>
            {proposals === null ? (
              <div className={styles.spinner} role="status" aria-label="Loading suggestions" />
            ) : proposals.length === 0 ? (
              <p className={styles.secondaryCopy}>No suggestions to review yet.</p>
            ) : (
              <ul>
                {proposals.map((item) => (
                  <li key={item.ref}>
                    <button
                      className={styles.quietButton}
                      type="button"
                      onClick={() => void openProposal(item)}
                    >
                      {item.title ?? item.ref}
                      {item.kind ? ` · ${item.kind}` : ""}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className={styles.buttonGroup}>
              <button
                className={styles.quietButton}
                type="button"
                onClick={() => void loadProposals().catch(fail)}
                disabled={busy}
              >
                Check again
              </button>
              <button
                className={styles.quietButton}
                type="button"
                onClick={() => setStep("question")}
                disabled={busy}
              >
                On to your first question
              </button>
            </div>
          </>
        )}
        {status}
      </>
    );
  }

  function renderQuestion() {
    return (
      <>
        <p className={styles.eyebrow}>Your first question</p>
        <h1 className={styles.title} id="adopt-title">
          Ask your notes something.
        </h1>
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void ask();
          }}
        >
          <label className={styles.label} htmlFor="adopt-ask">
            What do your notes say about…
          </label>
          <input
            className={styles.input}
            id="adopt-ask"
            name="query"
            value={askQuery}
            onChange={(event) => setAskQuery(event.target.value)}
            placeholder="What do my notes say about the garden plan?"
          />
          <button className={styles.button} type="submit" disabled={busy || !askQuery.trim()}>
            {busy ? "Asking…" : "Ask"}
          </button>
        </form>
        {answers !== null && (
          <div className={styles.result} aria-live="polite">
            <p className={styles.resultTitle}>From your Exomem</p>
            {answers.length === 0 ? (
              <p className={styles.resultBody}>
                Nothing matched yet. Try different words — or give Exomem a minute to settle in,
                then ask again.
              </p>
            ) : (
              answers.map((hit, index) => (
                <div key={hit.path ?? index}>
                  <p className={styles.resultTitle}>{hit.title ?? hit.path}</p>
                  {hit.excerpt && <p className={styles.resultBody}>{hit.excerpt}</p>}
                  {hit.path && <p className={styles.secondaryCopy}>from {hit.path}</p>}
                </div>
              ))
            )}
          </div>
        )}
        {status}
      </>
    );
  }

  function renderTerminal(kind: "done" | "cancelled" | "failed" | "unknown") {
    if (!run) return null;
    const copiedCount = outcomesToResult(run).copied.length;
    const copy =
      kind === "done"
        ? `All done — ${copiedCount} files are part of your Exomem now.`
        : kind === "cancelled"
          ? copiedCount
            ? `Stopped. The ${copiedCount} files already copied are safe; your originals are untouched either way.`
            : "Stopped. Nothing was copied or changed."
          : kind === "failed"
            ? `We couldn't finish. ${run.error?.reason ? `${run.error.reason}. ` : ""}Nothing was changed — your originals are untouched.`
            : "We lost track of this run. Nothing was changed — your originals are untouched.";
    return (
      <>
        <p className={styles.eyebrow}>
          {kind === "done" ? "All set" : kind === "failed" ? "Something went wrong" : "Stopped"}
        </p>
        <h1 className={styles.title} id="adopt-title">
          {kind === "done" ? "Your notes are in." : "Nothing else was changed."}
        </h1>
        <p className={styles.lede}>{copy}</p>
        <div className={styles.buttonGroup}>
          {kind === "done" && (
            <button
              className={styles.quietButton}
              type="button"
              onClick={() => setStep("question")}
            >
              Ask your first question
            </button>
          )}
          <button className={styles.quietButton} type="button" onClick={startOver}>
            Start over
          </button>
        </div>
        {status}
      </>
    );
  }

  function renderScreen() {
    switch (screen) {
      case "start":
        return renderStart();
      case "scanning":
        return renderScanning();
      case "findings":
        return renderFindings();
      case "choose":
        return renderChoose();
      case "preview":
        return renderPreview();
      case "applying":
        return renderApplying();
      case "handoff":
      case "result":
        return renderResult();
      case "proposals":
        return renderProposals();
      case "question":
        return renderQuestion();
      case "done":
        return renderTerminal("done");
      case "cancelled":
        return renderTerminal("cancelled");
      case "failed":
        return renderTerminal("failed");
      default:
        return renderTerminal("unknown");
    }
  }

  return (
    <section className={styles.card} aria-labelledby="adopt-title">
      {renderScreen()}
    </section>
  );
}
