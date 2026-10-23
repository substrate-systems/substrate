"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/exomem/Button";
import { Modal } from "@/components/exomem/Modal";
import type { CloudImport } from "@/lib/exomem/cloud-import-contract";
import { folderImportFiles, type ImportFile } from "@/lib/exomem-hosted/cloud-import-browser";
import {
  readBrowserImport,
  requestBrowserImport,
} from "@/lib/exomem-hosted/cloud-import-browser-api";
import {
  BrowserImportUpload,
  type ImportProgress,
} from "@/lib/exomem-hosted/cloud-import-browser-upload";
import { friendlyHostedError, HostedBrowserError } from "@/lib/exomem-hosted/hosted-browser";
import { count, shortDateTime } from "./home-format";
import styles from "./home.module.css";
import dialog from "./home-storage.module.css";

function finished(operation: CloudImport): boolean {
  if (operation.requested_state === "discard_requested" && operation.observed_state !== "discarded")
    return false;
  // These terminal observations are C5 protocol states, fixed by migration 0061.
  return ["done", "failed", "expired", "discarded"].includes(operation.observed_state);
}

function observation(operation: CloudImport): string {
  if (
    operation.requested_state === "uploaded" &&
    (operation.observed_state === "pending" || operation.observed_state === "key_ready")
  )
    return "Encrypted upload accepted. Waiting for Exomem to check and stage the files.";
  if (!finished(operation) && operation.requested_state === "discard_requested")
    return "Removal requested. Waiting for Exomem to remove the staged files and finish cleanup.";
  if (!finished(operation) && operation.requested_state === "cancelled")
    return "Cancellation requested. Waiting for Exomem to finish cleanup.";
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
      return "Files staged. Ask your assistant to review them in Adoption Studio before filing them as Sources.";
    case "discarded":
      return "Staged files removed. Your original folder and already filed Sources remain unchanged.";
    case "failed":
      return "The import failed. Your original folder remains unchanged.";
    case "expired":
      return "The import expired. Choose the folder again to start a new upload.";
    default:
      return `Exomem reported an unfamiliar state: ${operation.observed_state}. Completion is unconfirmed.`;
  }
}

export function ImportDocuments({
  csrfToken,
  onAccountLost,
}: {
  csrfToken: string;
  onAccountLost: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState(false);
  const [operation, setOperation] = useState<CloudImport | null>(null);
  const [files, setFiles] = useState<ImportFile[]>([]);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [retryAvailable, setRetryAvailable] = useState(false);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [readMessage, setReadMessage] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const upload = useRef<BrowserImportUpload | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Navigation ends page-session retries; the server still owns import cleanup.
      void upload.current
        ?.dispose()
        .catch(() => console.warn("Encrypted import file cleanup failed."));
    };
  }, []);

  const fail = useCallback(
    (error: unknown) => {
      if (!mounted.current) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (error instanceof HostedBrowserError && error.status === 401) {
        onAccountLost();
        return;
      }
      setMessage(
        error instanceof Error && !(error instanceof HostedBrowserError)
          ? error.message
          : friendlyHostedError(error)
      );
    },
    [onAccountLost]
  );

  const importId = operation?.import_id;
  const terminal = operation ? finished(operation) : false;
  useEffect(() => {
    if (!open || busy) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const value = await readBrowserImport(csrfToken, importId, controller.signal);
        if (controller.signal.aborted) return;
        setOperation(value);
        setChecked(true);
        setReadMessage(null);
        if (!value || finished(value)) return;
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
      }
      timer = setTimeout(() => void read(), 2500);
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, busy, importId, fail, csrfToken]);

  async function send() {
    if (!upload.current) {
      upload.current = new BrowserImportUpload(files, csrfToken);
      setAttemptId(upload.current.id);
      setOperation(null);
    }
    setBusy(true);
    setRetryAvailable(false);
    setMessage(null);
    let accepted = false;
    try {
      await upload.current.resume(
        (value) => {
          if (value.requested_state === "uploaded") accepted = true;
          if (mounted.current) setOperation(value);
        },
        (value) => {
          if (mounted.current) setProgress(value);
        }
      );
      if (accepted) {
        upload.current = null;
        if (mounted.current) {
          setFiles([]);
          setAttemptId(null);
        }
      }
    } catch (error) {
      if (mounted.current) setRetryAvailable(true);
      fail(error);
    } finally {
      if (mounted.current) {
        setBusy(false);
        setProgress(null);
      }
    }
  }

  async function change(action: "cancel" | "discard") {
    if (!operation) return;
    setBusy(true);
    setRetryAvailable(false);
    setMessage(null);
    const currentUpload = upload.current;
    currentUpload?.pause();
    try {
      const value = await requestBrowserImport(csrfToken, operation.import_id, action);
      if (mounted.current) {
        setOperation(value);
        setConfirmDiscard(false);
      }
      if (mounted.current) {
        setFiles([]);
        setAttemptId(null);
        setRetryAvailable(false);
      }
    } catch (error) {
      fail(error);
    } finally {
      // Recording server intent must not depend on deletion of the browser's temporary file.
      try {
        await currentUpload?.dispose();
        if (upload.current === currentUpload) upload.current = null;
      } catch (error) {
        fail(error);
      }
      if (mounted.current) setBusy(false);
    }
  }

  const canResume =
    retryAvailable && (!operation || operation.requested_state === "requested") && !terminal;
  const canSelect = checked && !busy && (!operation || terminal) && !canResume;
  const selectionBytes = files.reduce((total, { file }) => total + file.size, 0);
  return (
    <>
      <div className={styles.row}>
        <div className={styles.rowText}>
          <span className={styles.rowTitle}>Import documents</span>
          <span className={styles.rowBody}>
            Bring in a folder privately, then review it with your assistant.
          </span>
        </div>
        <Button size="account" onClick={() => setOpen(true)}>
          Import…
        </Button>
      </div>
      {open && (
        <Modal
          open
          title="Import documents"
          width={420}
          phoneFullWidth
          placement="top"
          onClose={() => {
            upload.current?.pause();
            setOpen(false);
          }}
        >
          <div className={dialog.content}>
            <p className={dialog.text}>
              Files are encrypted in your browser. Your original folder stays unchanged. This adds
              documents for review; it does not migrate an existing Exomem vault’s identities or
              history.
            </p>
            {!checked && (
              <p className={dialog.text} role="status">
                Checking previous imports…
              </p>
            )}
            {operation && (
              <>
                <p className={dialog.text} role="status">
                  {observation(operation)}
                </p>
                <p className={dialog.text}>
                  {count(operation.declared_files)} files · {count(operation.declared_bytes)} bytes.
                  Observed {shortDateTime(operation.updated_at)}.
                </p>
                {operation.error_code && (
                  <p className={dialog.text}>Exomem reported: {operation.error_code}</p>
                )}
              </>
            )}
            {progress && (
              <p className={dialog.text} role="status">
                {progress.phase === "encrypting"
                  ? "Encrypting your files on this device…"
                  : progress.phase === "uploading"
                    ? `Uploading encrypted data: ${count(progress.bytes)} of ${count(progress.total)} bytes.`
                    : progress.phase === "reporting"
                      ? "Confirming the encrypted upload…"
                      : "Preparing the import…"}
              </p>
            )}
            {canSelect && (
              <>
                <input
                  ref={(node) => {
                    input.current = node;
                    node?.setAttribute("webkitdirectory", "");
                  }}
                  type="file"
                  multiple
                  className="sr-only"
                  aria-label="Folder to import"
                  onChange={(event) => {
                    const selected = Array.from(event.currentTarget.files ?? []);
                    event.currentTarget.value = "";
                    try {
                      const next = folderImportFiles(selected);
                      const previous = upload.current;
                      upload.current = null;
                      setFiles(next);
                      setAttemptId(null);
                      setRetryAvailable(false);
                      setMessage(null);
                      void previous?.dispose().catch(fail);
                    } catch (error) {
                      fail(error);
                    }
                  }}
                />
                <Button size="dialog" onClick={() => input.current?.click()}>
                  Choose a folder
                </Button>
                {files.length > 0 && attemptId === null && (
                  <>
                    <p className={dialog.text}>
                      {count(files.length)} files · {count(selectionBytes)} bytes selected.
                    </p>
                    <Button
                      variant="primary"
                      size="dialog"
                      working={busy}
                      onClick={() => void send()}
                    >
                      Encrypt and upload
                    </Button>
                  </>
                )}
              </>
            )}
            {busy && progress && (
              <Button size="dialog" onClick={() => upload.current?.pause()}>
                Pause upload
              </Button>
            )}
            {!busy && canResume && (
              <Button variant="primary" size="dialog" onClick={() => void send()}>
                Retry this upload
              </Button>
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
            {!busy && operation?.observed_state === "done" && !confirmDiscard && (
              <Button size="dialog" onClick={() => setConfirmDiscard(true)}>
                Remove staged files…
              </Button>
            )}
            {confirmDiscard && (
              <>
                <p className={dialog.text}>
                  Remove the staged originals for this import? Already filed Sources and your
                  original folder stay unchanged.
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
            <p className={dialog.text}>
              Keep this page open to retry the same encrypted file. After a reload, an unfinished
              upload needs cancellation and a fresh start.
            </p>
            <Button
              variant="ghost"
              size="dialog"
              onClick={() => {
                upload.current?.pause();
                setOpen(false);
              }}
            >
              Close
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
