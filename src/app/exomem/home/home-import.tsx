"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/exomem/Button";
import { Modal } from "@/components/exomem/Modal";
import { cloudImportFinished, type CloudImport } from "@/lib/exomem/cloud-import-contract";
import {
  forecastImport,
  type ImportFile,
  type ImportForecast,
} from "@/lib/exomem-hosted/cloud-import-browser";
import {
  readBrowserImport,
  readImportFiling,
  wakeImportFiling,
  requestBrowserImport,
} from "@/lib/exomem-hosted/cloud-import-browser-api";
import {
  browserStorageRoom,
  discardOtherKeptCiphertext,
  otherKeptCiphertext,
  storedImportCiphertext,
  sweepKeptCiphertext,
} from "@/lib/exomem-hosted/cloud-import-browser-file";
import {
  BrowserImportUpload,
  keptCopyRetired,
  type ImportProgress,
} from "@/lib/exomem-hosted/cloud-import-browser-upload";
import { importArchive, uploadOrigin } from "@/lib/exomem-hosted/cloud-import-envelope";
import {
  addToSelection,
  selectImportFiles,
  selectionCollection,
  type IncludeChoices,
  type PickedItem,
  type SelectionPart,
  type SelectionTotals,
} from "@/lib/exomem-hosted/cloud-import-selection";
import {
  ImportStop,
  importPaused,
  importStopFrom,
  type ImportStopNext,
} from "@/lib/exomem-hosted/cloud-import-stop";
import { friendlyHostedError, HostedBrowserError } from "@/lib/exomem-hosted/hosted-browser";
import type { HomeStorage } from "./home-api";
import { byteSize, count, shortDateTime } from "./home-format";
import {
  filingRowText,
  filingWakeDue,
  ImportFiling,
  type FilingRead,
} from "./home-import-filing";
import {
  browserFree,
  ImportLimits,
  ImportProgressView,
  ImportReference,
  type BrowserRoom,
} from "./home-import-panels";
import { carriesFiles, droppedItems, ImportPicker, SelectionSummary } from "./home-import-picker";
import styles from "./home.module.css";
import dialog from "./home-storage.module.css";

const BROWSER_CLEANUP_WARNING =
  "Browser cleanup failed. A temporary encrypted file may remain on this device. " +
  "Clear this site's stored data in browser settings to remove it. This also signs you out.";

const NOTHING_EXTRA: IncludeChoices = { gitignored: false };
// Progress arrives per encrypted chunk; the dialog redraws at this pace instead.
const PROGRESS_REDRAW_MS = 250;
// The cell's filing record is one small read; the dialog follows it closely, the row less so.
const FILING_READ_OPEN_MS = 5_000;
const FILING_READ_CLOSED_MS = 15_000;
// The label is part of the series file, whose size the preflight measures; it settles first.
const LABEL_SETTLE_MS = 400;

/** A finished forecast belongs to the archive it measured. */
type Preflight = {
  archive: ImportFile[];
  measuredAt: number;
} & (
  | { forecast: ImportForecast; room: BrowserRoom; others: SelectionTotals | null }
  | { failed: string }
);

/** Why this page's upload is not running, shown until the person acts on it. */
type Stop =
  | { kind: "paused"; unavailable: boolean; phase: ImportProgress["phase"] | null }
  | { kind: "failed"; importId: string; code: string | null; text: string; next: ImportStopNext };

const NEXT_STEP: Record<ImportStopNext, string> = {
  resume: "Resume to try again, or cancel the import.",
  choose: "Choose the files again to continue.",
  cancel: "Cancel this import, then start a new one.",
  status: "Check the import’s current status above.",
};

function observation(operation: CloudImport): string {
  if (
    operation.requested_state === "uploaded" &&
    (operation.observed_state === "pending" || operation.observed_state === "key_ready")
  )
    return "Encrypted upload accepted. Waiting for Evermatter to check and stage the files.";
  if (!cloudImportFinished(operation) && operation.requested_state === "discard_requested")
    return "Removal requested. Waiting for Evermatter to remove the staged files and finish cleanup.";
  if (!cloudImportFinished(operation) && operation.requested_state === "cancelled")
    return "Cancellation requested. Waiting for Evermatter to finish cleanup.";
  switch (operation.observed_state) {
    case "pending":
      return "Preparing a private encryption key. Your assistant may be briefly unavailable.";
    case "key_ready":
      return "Ready for the encrypted upload.";
    case "importing":
      return "Checking and staging your files. The upload is not a completed import yet.";
    case "cleanup_running":
    case "cleanup_stopping":
    case "cleanup_discard_stopping":
      return "Finishing cleanup. Your assistant resumes after the import hold ends.";
    case "cleanup_pending":
      return "Cleanup needs another attempt. This import remains open; no completed outcome is confirmed.";
    case "done":
      return operation.kind === "adopt"
        ? "Files staged. Ask your assistant to review them in Adoption Studio before filing them as Sources."
        : "Evermatter completed this import. Review its content with your connected assistant.";
    case "discarded":
      return "Staged files removed. Your original folder and already filed Sources remain unchanged.";
    case "failed":
      return "The import failed. Your original folder remains unchanged.";
    case "expired":
      return "The import expired. Choose the files again to start a new upload.";
    default:
      return `Evermatter reported an unfamiliar state: ${operation.observed_state}. Completion is unconfirmed.`;
  }
}

/** The Home row's one-line state while the dialog is closed. */
function rowProgress(progress: ImportProgress): string {
  switch (progress.phase) {
    case "encrypting":
      return `Encrypting: ${count(progress.files)} of ${count(progress.totalFiles)} files.`;
    case "verifying":
      return `Checking the encrypted copy: ${byteSize(progress.bytes)} of ${byteSize(progress.total)}.`;
    case "uploading":
      return `Uploading: ${byteSize(progress.bytes)} of ${byteSize(progress.total)}.`;
    case "preparing":
      return "Preparing the import.";
    case "linking":
      return "Waiting for the upload links.";
    case "reporting":
      return "Confirming the upload.";
  }
}

function pausedText(stop: Extract<Stop, { kind: "paused" }>): string {
  if (stop.unavailable) return "Paused until uploads are available again.";
  if (stop.phase === "uploading" || stop.phase === "reporting" || stop.phase === "verifying")
    return "Paused. Parts already uploaded from this page are kept.";
  return stop.phase === "linking"
    ? "Paused. This browser keeps the encrypted copy for when you resume."
    : "Paused. Encryption starts again from the beginning when you resume.";
}

export function ImportDocuments({
  csrfToken,
  account,
  canStart,
  storage,
  onAccountLost,
}: {
  csrfToken: string;
  /** The account's stable key; its kept copies live in a folder of their own. */
  account: string;
  canStart: boolean;
  /** The vault's last disk reading from the status poll; advisory, because it can be stale. */
  storage: HomeStorage | null;
  onAccountLost: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState(false);
  const [operation, setOperation] = useState<CloudImport | null>(null);
  // When this page last heard about the import: "measured N minutes ago" is read against it.
  const [heardAt, setHeardAt] = useState(0);
  // What the person chose so far, each pick under its own top-level name; null before any.
  const [parts, setParts] = useState<SelectionPart[] | null>(null);
  const [reading, setReading] = useState(false);
  const [include, setInclude] = useState<IncludeChoices>(NOTHING_EXTRA);
  // "Where is this from?": as typed, and as the series file states it once typing settles.
  const [label, setLabel] = useState("");
  const [settledLabel, setSettledLabel] = useState("");
  const [filing, setFiling] = useState<FilingRead | null>(null);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [localCopy, setLocalCopy] = useState<{ importId: string; bytes: number | null } | null>(
    null
  );
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [busy, setBusy] = useState(false);
  // The import ID of the upload this page holds, while it holds one.
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [stop, setStop] = useState<Stop | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [readMessage, setReadMessage] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  // Counts the owner's discards of other accounts' copies, so the preflight measures again.
  const [discards, setDiscards] = useState(0);
  const chooseButton = useRef<HTMLButtonElement>(null);
  const startButton = useRef<HTMLButtonElement>(null);
  const upload = useRef<BrowserImportUpload | null>(null);
  const latest = useRef<ImportProgress | null>(null);
  const pausedBy = useRef<"person" | "unavailable">("person");
  const mounted = useRef(true);
  const readingRef = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Unmounting pauses: the import ID names the kept ciphertext, so the next mount resumes.
      upload.current?.pause();
    };
  }, []);

  useEffect(() => {
    if (canStart) return;
    pausedBy.current = "unavailable";
    upload.current?.pause();
  }, [canStart]);

  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older engines show the leave prompt only for a set return value.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    const redraw = window.setInterval(() => setProgress(latest.current), PROGRESS_REDRAW_MS);
    // A phone that sleeps stops the upload; the screen stays on while this tab is in front.
    let wake: { release(): Promise<void> } | null = null;
    let ended = false;
    const keepAwake = () => {
      if (document.visibilityState !== "visible" || !("wakeLock" in navigator)) return;
      void navigator.wakeLock
        .request("screen")
        .then((lock) => {
          if (ended) void lock.release().catch(() => {});
          else wake = lock;
        })
        .catch(() => {});
    };
    keepAwake();
    document.addEventListener("visibilitychange", keepAwake);
    return () => {
      ended = true;
      window.removeEventListener("beforeunload", warn);
      window.clearInterval(redraw);
      document.removeEventListener("visibilitychange", keepAwake);
      void wake?.release().catch(() => {});
    };
  }, [busy]);

  useEffect(() => {
    const settle = window.setTimeout(() => setSettledLabel(label), LABEL_SETTLE_MS);
    return () => window.clearTimeout(settle);
  }, [label]);

  const failCleanup = useCallback(() => {
    if (mounted.current)
      setMessage((current) =>
        !current
          ? BROWSER_CLEANUP_WARNING
          : current.includes(BROWSER_CLEANUP_WARNING)
            ? current
            : `${current} ${BROWSER_CLEANUP_WARNING}`
      );
  }, []);

  const fail = useCallback(
    (error: unknown) => {
      if (!mounted.current || importPaused(error)) return;
      if (error instanceof HostedBrowserError && error.status === 401) {
        onAccountLost();
        return;
      }
      setMessage(importStopFrom(error)?.message ?? friendlyHostedError(error));
    },
    [onAccountLost]
  );

  const importId = operation?.import_id;
  const readImportId = open ? importId : undefined;
  const terminal = operation ? cloudImportFinished(operation) : false;
  useEffect(() => {
    // With the dialog closed, one read finds an open import, so the row can say it waits; a
    // blocked start also keeps existing imports and their cleanup reachable.
    if (busy) return;
    const discover = !open;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const value = await readBrowserImport(csrfToken, readImportId, controller.signal);
        if (controller.signal.aborted) return;
        setOperation(value);
        setHeardAt(Date.now());
        setChecked(true);
        setReadMessage(null);
        if (!value || cloudImportFinished(value)) return;
        // With the dialog closed, only an accepted upload is followed, so the row can say when
        // it is staged and filing starts.
        if (discover && value.requested_state !== "uploaded") return;
      } catch (error) {
        if (controller.signal.aborted) return;
        if (
          error instanceof HostedBrowserError &&
          (error.status === 401 || error.code === "IMPORT_ACCOUNT_CHANGED")
        ) {
          fail(error);
          return;
        }
        setReadMessage(friendlyHostedError(error));
        if (discover) return;
      }
      timer = setTimeout(() => void read(), discover ? FILING_READ_CLOSED_MS : 2500);
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, busy, canStart, readImportId, fail, csrfToken]);

  // C5's adopt import stages the upload; the cell then files it, and its filing view says how far.
  const stagedId =
    operation?.kind === "adopt" &&
    operation.observed_state === "done" &&
    operation.requested_state === "uploaded"
      ? operation.import_id
      : null;
  // When this page last woke the filer for each import; the wake's limits count per page.
  const filingWakes = useRef(new Map<string, number>());
  useEffect(() => {
    if (!stagedId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      let view: FilingRead["view"] = null;
      try {
        view = await readImportFiling(csrfToken, stagedId, controller.signal);
        // A stage the filer has not met, or one whose login ended, is registered under this one.
        const now = Date.now();
        if (
          view.state === "live" &&
          filingWakeDue(view.filing, filingWakes.current.get(stagedId), now)
        ) {
          // A wake counts once it is answered; one cut short by a new read is made again.
          const woken = await wakeImportFiling(csrfToken, stagedId, controller.signal).finally(
            () => {
              if (!controller.signal.aborted) filingWakes.current.set(stagedId, now);
            }
          );
          // Anything but the record keeps the read's view.
          if (woken.state === "live") view = woken;
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (
          error instanceof HostedBrowserError &&
          (error.status === 401 || error.code === "IMPORT_ACCOUNT_CHANGED")
        ) {
          fail(error);
          return;
        }
      }
      if (controller.signal.aborted) return;
      setFiling({ importId: stagedId, readAt: Date.now(), view });
      // Done, removed and a cell without the filer change no further.
      if (
        view?.state === "not_offered" ||
        (view?.state === "live" &&
          (view.filing.state === "done" || view.filing.state === "discarded"))
      )
        return;
      timer = setTimeout(() => void read(), open ? FILING_READ_OPEN_MS : FILING_READ_CLOSED_MS);
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [stagedId, open, csrfToken, fail]);
  const filingRead = filing && filing.importId === stagedId ? filing : null;
  // Removing the staged files while the cell files them would stop filing half way.
  const filingRuns =
    filingRead?.view?.state === "live" && filingRead.view.filing.state === "working";

  const openImport = operation && !terminal ? operation : null;
  // C5's "requested" intent is the only one that still waits for this browser's upload.
  const awaiting = openImport?.requested_state === "requested" ? openImport : null;
  const reported = awaiting !== null && awaiting.ciphertext_sha256 !== null;
  const holding = attemptId !== null && (awaiting === null || awaiting.import_id === attemptId);
  const selection = useMemo(
    () => (parts ? selectImportFiles(parts, include) : null),
    [parts, include]
  );
  // The archive is the series file and the selection; the series file asks the cell to file it.
  const archive = useMemo(
    () =>
      parts && selection && selection.files.length > 0
        ? importArchive(selection, selectionCollection(parts), uploadOrigin(navigator, settledLabel))
        : null,
    [parts, selection, settledLabel]
  );
  // Creation is idempotent only for the same declaration, so a resumed selection must match it.
  const matches =
    awaiting === null ||
    archive === null ||
    (archive.length === awaiting.declared_files &&
      archive.reduce((total, { file }) => total + file.size, 0) === awaiting.declared_bytes);
  const canChoose =
    canStart &&
    checked &&
    !busy &&
    (openImport === null ||
      (awaiting !== null && !reported && !(holding && attemptId === awaiting.import_id)));
  const measuring = canChoose && archive !== null && matches ? archive : null;

  const resumingId = awaiting?.import_id ?? null;
  useEffect(() => {
    if (!measuring) return;
    const controller = new AbortController();
    void (async () => {
      try {
        // This account's copies go only when no tab holds them and a fresh read says their
        // import has ended; a copy the sweep cannot remove stays counted in the browser's
        // usage. The open import's own copy is replaced when encryption starts.
        await sweepKeptCiphertext(account, resumingId, (id) =>
          keptCopyRetired(csrfToken, id)
        ).catch(() => {});
        const replaced = resumingId ? await storedImportCiphertext(account, resumingId) : null;
        const others = await otherKeptCiphertext(account).catch(() => null);
        const forecast = await forecastImport(measuring, undefined, controller.signal);
        const estimate = await browserStorageRoom();
        const room = estimate && {
          quota: estimate.quota,
          usage: estimate.usage - (replaced?.ciphertext.size ?? 0),
        };
        if (!controller.signal.aborted)
          setPreflight({ archive: measuring, measuredAt: Date.now(), forecast, room, others });
      } catch (error) {
        if (controller.signal.aborted) return;
        setPreflight({
          archive: measuring,
          measuredAt: Date.now(),
          failed: importStopFrom(error)?.message ?? friendlyHostedError(error),
        });
      }
    })();
    return () => controller.abort();
  }, [measuring, resumingId, account, csrfToken, discards]);
  const measured = preflight && measuring && preflight.archive === measuring ? preflight : null;

  const storedId = open && reported && !holding && !busy ? awaiting.import_id : null;
  useEffect(() => {
    if (!storedId) return;
    let current = true;
    void storedImportCiphertext(account, storedId)
      .then((stored) => {
        if (current) setLocalCopy({ importId: storedId, bytes: stored?.ciphertext.size ?? null });
      })
      .catch(() => {
        if (current) setLocalCopy({ importId: storedId, bytes: null });
      });
    return () => {
      current = false;
    };
  }, [storedId, account]);
  const stored = storedId && localCopy?.importId === storedId ? localCopy : null;
  const storedUsable =
    stored !== null && stored.bytes !== null && stored.bytes === awaiting?.ciphertext_bytes;

  /** A new selection replaces the attempt that encrypted the old one. */
  function select(next: SelectionPart[] | null) {
    const previous = upload.current;
    upload.current = null;
    setAttemptId(null);
    setStop(null);
    setParts(next && next.length ? next : null);
    void previous?.dispose().catch(failCleanup);
  }

  async function add(picked: Promise<PickedItem[]>) {
    // One pick is read at a time, so each adds to the selection the last one left.
    if (readingRef.current) return;
    readingRef.current = true;
    setMessage(null);
    setReading(true);
    try {
      const next = await addToSelection(parts ?? [], await picked);
      if (!mounted.current) return;
      if (!next.some(({ entries, leftOut }) => entries.length || leftOut.length))
        throw new ImportStop("FOLDER_EMPTY");
      select(next);
    } catch (error) {
      fail(error);
    } finally {
      readingRef.current = false;
      if (mounted.current) setReading(false);
    }
  }

  // A drop anywhere on Home adds its files, instead of the browser opening them in place of Home.
  const addRef = useRef(add);
  useEffect(() => {
    addRef.current = add;
  });
  useEffect(() => {
    const over = (event: DragEvent) => {
      if (carriesFiles(event.dataTransfer)) event.preventDefault();
    };
    const drop = (event: DragEvent) => {
      if (!event.dataTransfer || !carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      if (!canChoose) return;
      setOpen(true);
      void addRef.current(droppedItems(event.dataTransfer));
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [canChoose]);

  async function run() {
    const current = upload.current;
    if (!canStart || !current) return;
    pausedBy.current = "person";
    latest.current = null;
    setBusy(true);
    setStop(null);
    setMessage(null);
    let accepted = false;
    try {
      await current.resume(
        (value) => {
          if (value.requested_state === "uploaded") accepted = true;
          if (mounted.current) {
            setOperation(value);
            setHeardAt(Date.now());
          }
        },
        (value) => {
          const phase = latest.current?.phase;
          latest.current = value;
          // A new phase shows at once; counts within a phase redraw on the timer.
          if (mounted.current && phase !== value.phase) setProgress(value);
        }
      );
      if (accepted) {
        upload.current = null;
        if (mounted.current) {
          setParts(null);
          setLabel("");
          setAttemptId(null);
        }
      }
    } catch (error) {
      // Once the upload is accepted, only removal of the local encrypted file remains.
      if (accepted) failCleanup();
      else stopped(error, current.id);
    } finally {
      if (mounted.current) {
        setBusy(false);
        setProgress(null);
      }
    }
  }

  function stopped(error: unknown, id: string) {
    if (!mounted.current) return;
    if (importPaused(error)) {
      setStop({
        kind: "paused",
        unavailable: pausedBy.current === "unavailable",
        phase: latest.current?.phase ?? null,
      });
      return;
    }
    if (error instanceof HostedBrowserError && error.status === 401) {
      onAccountLost();
      return;
    }
    const reason = importStopFrom(error);
    if (reason?.next === "choose") {
      // The kept file objects cannot be read again; a fresh choice of the files can.
      upload.current = null;
      setAttemptId(null);
      setParts(null);
    }
    setStop({
      kind: "failed",
      importId: id,
      code: reason?.code ?? (error instanceof HostedBrowserError ? error.code : null),
      text: reason?.message ?? friendlyHostedError(error),
      next: reason?.next ?? "resume",
    });
    if (reason?.cleanupFailed) failCleanup();
  }

  function start() {
    if (!archive) return;
    const previous = upload.current;
    const resumeId = awaiting && !reported ? awaiting.import_id : undefined;
    upload.current = new BrowserImportUpload({
      files: archive,
      csrfToken,
      account,
      importId: resumeId,
    });
    setAttemptId(upload.current.id);
    if (!resumeId) setOperation(null);
    // Disposal removes the attempt's ciphertext file, which is named by its import ID.
    if (previous && previous.id !== upload.current.id) void previous.dispose().catch(failCleanup);
    void run();
  }

  function continueStored() {
    if (!awaiting) return;
    upload.current = new BrowserImportUpload({
      files: null,
      csrfToken,
      account,
      importId: awaiting.import_id,
    });
    setAttemptId(upload.current.id);
    void run();
  }

  async function discardOthers() {
    setDiscarding(true);
    setMessage(null);
    try {
      const { kept } = await discardOtherKeptCiphertext(account);
      if (kept > 0 && mounted.current)
        setMessage(
          `${count(kept)} kept ${kept === 1 ? "copy is" : "copies are"} in use in another tab or window, so ${kept === 1 ? "it stays" : "they stay"}.`
        );
    } catch (error) {
      fail(error);
    } finally {
      if (mounted.current) {
        setDiscarding(false);
        setDiscards((value) => value + 1);
        // The discard action leaves with the copies; keep focus inside the dialog.
        (startButton.current ?? chooseButton.current)?.focus();
      }
    }
  }

  function pause() {
    pausedBy.current = "person";
    upload.current?.pause();
  }

  async function change(action: "cancel" | "discard") {
    if (!operation) return;
    setBusy(true);
    setStop(null);
    setMessage(null);
    // A handle on the import's ID also reaches a ciphertext that an earlier page kept.
    const currentUpload =
      upload.current?.id === operation.import_id
        ? upload.current
        : new BrowserImportUpload({
            files: null,
            csrfToken,
            account,
            importId: operation.import_id,
          });
    currentUpload.pause();
    try {
      const value = await requestBrowserImport(csrfToken, operation.import_id, action);
      if (mounted.current) {
        setOperation(value);
        setConfirmDiscard(false);
        setParts(null);
        setAttemptId(null);
      }
    } catch (error) {
      fail(error);
    } finally {
      // Recording server intent must not depend on deletion of the browser's temporary file.
      try {
        await currentUpload.dispose();
        if (upload.current === currentUpload) upload.current = null;
      } catch {
        failCleanup();
      }
      if (mounted.current) setBusy(false);
    }
  }

  // A new selection beside a finished import: the import's lines describe the earlier one.
  const earlier = terminal && parts !== null;
  const resumable =
    canStart &&
    !busy &&
    holding &&
    stop !== null &&
    (stop.kind === "paused" || stop.next === "resume");
  const browserShort =
    measured !== null &&
    "forecast" in measured &&
    (browserFree(measured.room) ?? Infinity) < measured.forecast.ciphertextBytes;
  const rowStatus =
    busy && progress
      ? rowProgress(progress)
      : stop?.kind === "paused"
        ? "Upload paused. Open it to resume."
        : stop
          ? "Upload stopped. Open it to see why and what to do next."
          : awaiting
            ? "An upload is waiting to continue."
            : openImport?.requested_state === "uploaded"
              ? "Uploaded · checking the files"
              : stagedId
                ? filingRowText(filingRead)
                : null;
  return (
    <>
      {(canStart || operation !== null || readMessage !== null) && (
        <div className={styles.row}>
          <div className={styles.rowText}>
            <span className={styles.rowTitle}>Add files</span>
            <span className={styles.rowBody}>
              {rowStatus ??
                (canStart ? "Photos, files, folders or zips" : "Check status or finish cleanup.")}
            </span>
          </div>
          <Button size="account" onClick={() => setOpen(true)}>
            {canStart ? "Add files…" : "Status…"}
          </Button>
        </div>
      )}
      {open && (
        <Modal
          open
          title="Add files"
          width={420}
          phoneFullWidth
          placement="top"
          // Closing only hides the dialog: the work continues and the row above shows it.
          onClose={() => setOpen(false)}
        >
          <div className={dialog.content}>
            {!canStart && (
              <p className={dialog.text}>
                Starting or resuming an upload is unavailable right now.
              </p>
            )}
            {!checked && (
              <p className={dialog.text} role="status">
                Checking previous imports…
              </p>
            )}
            {/* Only C5 adopt stages files for filing; pending discard must finish first. */}
            {stagedId && operation ? (
              <>
                {earlier && <p className={dialog.text}>Earlier upload</p>}
                <ImportFiling
                  read={filingRead}
                  staged={{ bytes: operation.declared_bytes }}
                  storage={storage}
                  now={heardAt}
                />
              </>
            ) : (
              // While this page uploads, its progress is the import's state.
              operation &&
              !busy && (
                <>
                  <p className={dialog.text} role="status">
                    {earlier && "Earlier upload: "}
                    {observation(operation)}
                  </p>
                  <dl className={dialog.totals}>
                    <div>
                      <dt>{earlier ? "Earlier upload" : "Upload"}</dt>
                      <dd>{byteSize(operation.declared_bytes)}</dd>
                    </div>
                    <div>
                      <dt>Status updated</dt>
                      <dd>{shortDateTime(operation.updated_at)}</dd>
                    </div>
                  </dl>
                  {operation.error_code && (
                    <p className={dialog.text}>Evermatter reported: {operation.error_code}</p>
                  )}
                </>
              )
            )}
            {busy && progress && <ImportProgressView progress={progress} />}
            {busy && progress && (
              <>
                <Button size="dialog" onClick={pause}>
                  Pause
                </Button>
                <p className={dialog.text}>Keep this tab open until the upload finishes.</p>
              </>
            )}
            {!busy && stop?.kind === "paused" && (
              <p className={dialog.text} role="status">
                {pausedText(stop)}
              </p>
            )}
            {!busy && stop?.kind === "failed" && (
              <>
                <p className={dialog.text} role="alert">
                  {stop.text} {NEXT_STEP[stop.next]}
                </p>
                <ImportReference importId={stop.importId} code={stop.code ?? undefined} />
              </>
            )}
            {resumable && (
              <Button variant="primary" size="dialog" onClick={() => void run()}>
                Resume upload
              </Button>
            )}
            {canStart && !busy && reported && !holding && (
              <>
                {/* One button while the check runs, so the dialog's first focus is not Cancel. */}
                {(stored === null || storedUsable) && (
                  <>
                    <p className={dialog.text} role="status">
                      {stored === null
                        ? "Looking for this import’s encrypted copy in this browser…"
                        : `This browser still has the import’s encrypted copy (${byteSize(stored.bytes ?? 0)}). Continue to check it and upload it.`}
                    </p>
                    <Button
                      variant="primary"
                      size="dialog"
                      working={stored === null}
                      onClick={continueStored}
                    >
                      Continue upload
                    </Button>
                  </>
                )}
                {stored !== null && !storedUsable && (
                  <>
                    <p className={dialog.text} role="alert">
                      {stored.bytes === null
                        ? "This browser no longer has the encrypted copy for this import."
                        : "The encrypted copy in this browser does not match the one this import reported."}{" "}
                      {NEXT_STEP.cancel}
                    </p>
                    <ImportReference importId={awaiting.import_id} />
                  </>
                )}
              </>
            )}
            {canChoose && (
              <>
                {awaiting && parts === null && (
                  <p className={dialog.text} role="status">
                    Upload stopped before its encrypted copy was finished
                  </p>
                )}
                <ImportPicker
                  reading={reading}
                  again={awaiting !== null}
                  compact={parts !== null || stagedId !== null}
                  chooseButton={chooseButton}
                  onPick={(picked) => void add(picked)}
                />
                {selection && !reading && (
                  <>
                    <SelectionSummary
                      selection={selection}
                      include={include}
                      label={label}
                      onInclude={setInclude}
                      onRemove={(names) =>
                        select(parts?.filter(({ name }) => !names.includes(name)) ?? null)
                      }
                      onLabel={setLabel}
                    />
                    {!matches && awaiting && (
                      <p className={dialog.text} role="alert">
                        This selection differs from the open import’s. Choose the same files, or
                        cancel the import.
                      </p>
                    )}
                    {measuring && measured === null && (
                      <p className={dialog.text} role="status">
                        Measuring the encrypted copy…
                      </p>
                    )}
                    {measured && "failed" in measured && (
                      <p className={dialog.text} role="alert">
                        {measured.failed}
                      </p>
                    )}
                    {measured && "forecast" in measured && (
                      <ImportLimits
                        forecast={measured.forecast}
                        room={measured.room}
                        others={measured.others}
                        storage={storage}
                        now={measured.measuredAt}
                        discarding={discarding}
                        onDiscardOthers={() => void discardOthers()}
                      />
                    )}
                    {measured && "forecast" in measured && !browserShort && (
                      <Button ref={startButton} variant="primary" size="dialog" onClick={start}>
                        {awaiting ? "Encrypt and continue" : "Encrypt and upload"}
                      </Button>
                    )}
                  </>
                )}
              </>
            )}
            {!busy &&
              operation &&
              !terminal &&
              operation.requested_state !== "cancelled" &&
              operation.requested_state !== "discard_requested" && (
                <Button size="dialog" onClick={() => void change("cancel")}>
                  Cancel import
                </Button>
              )}
            {!busy && operation?.observed_state === "done" && !filingRuns && !confirmDiscard && (
              <Button size="dialog" onClick={() => setConfirmDiscard(true)}>
                Remove staged files…
              </Button>
            )}
            {confirmDiscard && (
              <>
                <p className={dialog.text}>
                  Remove the staged originals for this import? Already filed Sources and your
                  original files stay unchanged.
                </p>
                <Button size="dialog" working={busy} onClick={() => void change("discard")}>
                  Remove staged files
                </Button>
                <Button variant="ghost" size="dialog" onClick={() => setConfirmDiscard(false)}>
                  Keep them
                </Button>
              </>
            )}
            {message && (
              <p className={dialog.text} role="alert">
                {message}
              </p>
            )}
            {readMessage && (
              <p className={dialog.text} role="alert">
                {readMessage}
              </p>
            )}
            <Button variant="ghost" size="dialog" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
