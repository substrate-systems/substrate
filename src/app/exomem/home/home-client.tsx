"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  friendlyHostedError,
  getPrivateJson,
  HostedBrowserError,
  inferMemoryTitle,
  newRetryKey,
  postPrivateFile,
  postPrivateJson,
} from "@/lib/exomem-hosted/hosted-browser";
import styles from "../private-shell.module.css";
import {
  type Lifecycle,
  type LifecycleState,
  type InstallAction,
  createSingleFlight,
  nextStatusPollDelayMs,
  parseInstallActions,
  parseLifecycleResponse,
} from "./home-state";

type Tab = "remember" | "recall";

function lifecycleCopy(state: LifecycleState): { eyebrow: string; title: string; body: string } {
  switch (state) {
    case "preparing":
      return {
        eyebrow: "Preparing your private space",
        title: "Your Exomem is taking shape.",
        body: "This usually takes a minute or two. You can leave this page open; it will continue automatically.",
      };
    case "degraded":
      return {
        eyebrow: "Temporarily unavailable",
        title: "Your memories are safe.",
        body: "Exomem is having trouble waking up. We are retrying without moving your data anywhere else.",
      };
    case "suspended":
      return {
        eyebrow: "Paused",
        title: "Your Exomem is paused.",
        body: "Your memories remain stored, but capture and recall are unavailable until access is resumed.",
      };
    case "deletion_pending":
      return {
        eyebrow: "Deletion in progress",
        title: "Closing your Exomem.",
        body: "Access is now closed while the private vault and its hosted copies are removed.",
      };
    case "deleted":
      return {
        eyebrow: "Deleted",
        title: "This Exomem has been removed.",
        body: "The hosted memory product is gone. Any other Substrate account or product is unaffected.",
      };
    default:
      return {
        eyebrow: "Opening your private space",
        title: "One moment.",
        body: "Checking your Exomem…",
      };
  }
}

function readableResult(value: unknown): string {
  if (value === null || value === undefined) return "No matching memory yet.";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "No matching memory yet.";
    return value
      .slice(0, 5)
      .map((item) => readableResult(item))
      .join("\n\n");
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const key of [
      "hits",
      "results",
      "memories",
      "items",
      "attention",
      "suggestions",
      "queue",
      "folders",
      "entries",
    ]) {
      if (Array.isArray(object[key])) return readableResult(object[key]);
    }
    const title = [object.title, object.name, object.path].find(
      (candidate) => typeof candidate === "string"
    );
    const excerpt = [object.excerpt, object.snippet, object.summary, object.content].find(
      (candidate) => typeof candidate === "string"
    );
    if (title || excerpt) return [title, excerpt].filter(Boolean).join("\n");
    if (object.data !== undefined) return readableResult(object.data);
    const simple = Object.entries(object)
      .filter(
        ([key, item]) =>
          !key.toLowerCase().includes("id") &&
          (typeof item === "string" || typeof item === "number")
      )
      .slice(0, 8)
      .map(([key, item]) => `${key.replaceAll("_", " ")}: ${String(item)}`);
    if (simple.length) return simple.join("\n");
    return "A matching memory was found.";
  }
  return "No matching memory yet.";
}

export default function HomeClient() {
  const [lifecycle, setLifecycle] = useState<Lifecycle>({
    state: "loading",
    code: "TENANT_PREPARING",
    retryable: true,
  });
  const [tab, setTab] = useState<Tab>("remember");
  const [content, setContent] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [noticeError, setNoticeError] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [failedUpload, setFailedUpload] = useState<File | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [secondaryBusy, setSecondaryBusy] = useState(false);
  const [exportState, setExportState] = useState<{
    exportId: string | null;
    state: "processing" | "available" | "failed";
  } | null>(null);
  const [deletionRequested, setDeletionRequested] = useState(false);
  const [billing, setBilling] = useState<{
    source: "complimentary" | "paddle";
    state: string;
    portalAvailable: boolean;
  } | null>(null);
  const [installActions, setInstallActions] = useState<InstallAction[]>([]);
  const retryKeyRef = useRef(newRetryKey());
  const retryContentRef = useRef("");
  const uploadRetryRef = useRef<{ file: File } | null>(null);
  const uploadInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const statusSingleFlightRef = useRef(createSingleFlight<Lifecycle>());
  const exportRetryKeyRef = useRef(newRetryKey());

  const loadStatus = useCallback(async (): Promise<Lifecycle> => {
    try {
      const response = await getPrivateJson("/api/exomem/status");
      const next = parseLifecycleResponse(response);
      if (!next) throw new Error("invalid status");
      return next;
    } catch (error) {
      if (error instanceof HostedBrowserError && error.status === 401) throw error;
      return { state: "degraded", code: "CELL_UNAVAILABLE", retryable: true };
    }
  }, []);

  const refreshStatus = useCallback(async (): Promise<Lifecycle | null> => {
    let next: Lifecycle;
    try {
      next = await statusSingleFlightRef.current(loadStatus);
    } catch (error) {
      if (mountedRef.current && error instanceof HostedBrowserError && error.status === 401) {
        window.location.replace("/exomem/sign-in");
      }
      return null;
    }
    if (!mountedRef.current) return null;
    setLifecycle((current) =>
      next.requestId || !current.requestId ? next : { ...next, requestId: current.requestId }
    );
    return next;
  }, [loadStatus]);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    let timer: number | undefined;

    async function poll(attempt: number): Promise<void> {
      const next = await refreshStatus();
      if (cancelled || !next) return;
      const delay = nextStatusPollDelayMs(next, attempt);
      if (delay !== null) {
        timer = window.setTimeout(() => void poll(attempt + 1), delay);
      }
    }

    void poll(0);
    return () => {
      cancelled = true;
      mountedRef.current = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refreshStatus]);

  useEffect(() => {
    if (lifecycle.state !== "ready") return;
    void getPrivateJson("/api/exomem/account")
      .then((response) => {
        setInstallActions(parseInstallActions(response));
        const value = response.billing;
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        const candidate = value as Record<string, unknown>;
        if (
          (candidate.source === "complimentary" || candidate.source === "paddle") &&
          typeof candidate.state === "string" &&
          typeof candidate.portalAvailable === "boolean"
        ) {
          setBilling({
            source: candidate.source,
            state: candidate.state,
            portalAvailable: candidate.portalAvailable,
          });
        }
      })
      .catch(() => undefined);
  }, [lifecycle.state]);

  async function remember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const memory = content.trim();
    if (!memory || busy) return;
    if (retryContentRef.current !== memory) {
      retryContentRef.current = memory;
      retryKeyRef.current = newRetryKey();
    }
    setBusy(true);
    setNotice("Saving this memory…");
    setNoticeError(false);
    setResult(null);
    try {
      const title = inferMemoryTitle(memory);
      await postPrivateJson(
        "/api/exomem/commands/remember",
        { title, content: memory, note_type: "insight", suggestions: false },
        { idempotencyKey: retryKeyRef.current }
      );
      setNotice("Saved. Checking that it is ready to find…");
      setContent("");
      try {
        const recalled = await postPrivateJson("/api/exomem/commands/ask_memory", {
          query: `${title} ${memory.slice(0, 120)}`,
          mode: "keyword",
          detail: "compact",
          rerank: false,
          limit: 5,
        });
        setResult(readableResult(recalled.data));
        setNotice("Saved — and found again.");
      } catch {
        setNotice("Saved. Search may need another moment to warm up.");
      }
      retryContentRef.current = "";
      retryKeyRef.current = newRetryKey();
    } catch (error) {
      setNotice(friendlyHostedError(error));
      setNoticeError(true);
    } finally {
      setBusy(false);
    }
  }

  async function recall(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const term = query.trim();
    if (!term || busy) return;
    setBusy(true);
    setNotice("Looking through your memories…");
    setNoticeError(false);
    setResult(null);
    try {
      const response = await postPrivateJson("/api/exomem/commands/ask_memory", {
        query: term,
        mode: "keyword",
        detail: "compact",
        rerank: false,
        limit: 8,
      });
      setResult(readableResult(response.data));
      setNotice("");
    } catch (error) {
      setNotice(friendlyHostedError(error));
      setNoticeError(true);
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File | undefined, attempt: "selection" | "retry") {
    if (!file || uploadInFlightRef.current) return;
    uploadInFlightRef.current = true;
    if (attempt === "selection" || uploadRetryRef.current?.file !== file) {
      uploadRetryRef.current = { file };
    }
    setUploading(true);
    setNotice(`Saving ${file.name}…`);
    setNoticeError(false);
    try {
      await postPrivateFile(file);
      uploadRetryRef.current = null;
      setFailedUpload(null);
      setNotice(`${file.name} is now part of your Exomem.`);
    } catch (error) {
      setFailedUpload(file);
      setNotice(friendlyHostedError(error));
      setNoticeError(true);
    } finally {
      uploadInFlightRef.current = false;
      setUploading(false);
    }
  }

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    setNotice("Signing out…");
    setNoticeError(false);
    try {
      await postPrivateJson("/api/exomem/access/logout", {});
    } catch {
      setNotice("We could not sign you out. Your session is still active. Try again.");
      setNoticeError(true);
      setSigningOut(false);
      return;
    }
    window.location.replace("/exomem/sign-in");
  }

  async function refreshExports() {
    try {
      const response = await getPrivateJson("/api/exomem/exports");
      const exports = Array.isArray(response.exports) ? response.exports : [];
      const latest = exports[0];
      if (latest && typeof latest === "object" && !Array.isArray(latest)) {
        const record = latest as Record<string, unknown>;
        if (
          (record.state === "processing" ||
            record.state === "available" ||
            record.state === "failed") &&
          (record.exportId === null || typeof record.exportId === "string")
        ) {
          setExportState({ exportId: record.exportId, state: record.state });
          setNotice(
            record.state === "available"
              ? "Your verified export is ready."
              : record.state === "failed"
                ? "The export could not be completed. Try again."
                : "Your export is still being prepared."
          );
          setNoticeError(record.state === "failed");
        }
      }
    } catch (error) {
      setNotice(friendlyHostedError(error));
      setNoticeError(true);
    }
  }

  async function requestExport() {
    setNotice("Starting a verified export…");
    setNoticeError(false);
    try {
      await postPrivateJson(
        "/api/exomem/exports",
        {},
        {
          idempotencyKey: exportRetryKeyRef.current,
        }
      );
      exportRetryKeyRef.current = newRetryKey();
      setExportState({ exportId: null, state: "processing" });
      setNotice("Your export is being prepared. You can keep using this page.");
    } catch (error) {
      setNotice(friendlyHostedError(error));
      setNoticeError(true);
    }
  }

  async function requestDeletion() {
    setNotice("Sending a fresh deletion confirmation…");
    setNoticeError(false);
    try {
      await postPrivateJson("/api/exomem/deletion/request", {});
      setDeletionRequested(true);
      setNotice("Check your email to review and confirm deletion. Nothing has been deleted yet.");
    } catch (error) {
      setNotice(friendlyHostedError(error));
      setNoticeError(true);
    }
  }

  async function openBilling() {
    setNotice("Opening secure billing…");
    setNoticeError(false);
    try {
      const response = await postPrivateJson("/api/exomem/billing/portal", {});
      const destination = response.portalUrl;
      if (typeof destination !== "string") throw new Error("missing billing destination");
      window.location.assign(destination);
    } catch (error) {
      setNotice(friendlyHostedError(error));
      setNoticeError(true);
    }
  }

  async function loadSecondary(kind: "recent" | "review" | "connections") {
    setSecondaryBusy(true);
    setNoticeError(false);
    setNotice(
      kind === "recent"
        ? "Looking at your recent memory…"
        : kind === "review"
          ? "Checking what may need attention…"
          : "Checking possible connections…"
    );
    try {
      const response =
        kind === "recent"
          ? await postPrivateJson("/api/exomem/commands/browse_memory", {
              path: "",
              mode: "overview",
              max_depth: 2,
              samples: 5,
              include_hidden: false,
            })
          : await postPrivateJson("/api/exomem/commands/review_memory", {
              mode: kind === "review" ? "attention" : "relation-queue",
              limit: 5,
              state: "open",
            });
      setResult(readableResult(response.data));
      setNotice("");
    } catch (error) {
      setNotice(friendlyHostedError(error));
      setNoticeError(true);
    } finally {
      setSecondaryBusy(false);
    }
  }

  if (lifecycle.state !== "ready") {
    const copy = lifecycleCopy(lifecycle.state);
    return (
      <section className={styles.card} aria-labelledby="lifecycle-title">
        <div className={styles.workspaceHeader}>
          <div>
            <p className={styles.eyebrow}>{copy.eyebrow}</p>
            <h1 className={styles.title} id="lifecycle-title">
              {copy.title}
            </h1>
          </div>
          <button
            className={styles.quietButton}
            type="button"
            onClick={() => void signOut()}
            disabled={signingOut}
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
        <p className={styles.lede}>{copy.body}</p>
        {(lifecycle.state === "loading" || lifecycle.state === "preparing") && (
          <div className={styles.spinner} role="status" aria-label="Preparing Exomem" />
        )}
        <div className={styles.secondaryRow}>
          <div>
            <strong>Service status</strong>
            <p className={styles.secondaryCopy}>
              Support reference: {lifecycle.requestId ?? "not available yet"}
            </p>
          </div>
          {lifecycle.state !== "deleted" && (
            <button
              className={styles.quietButton}
              type="button"
              onClick={() => void refreshStatus()}
            >
              Check again
            </button>
          )}
        </div>
        <p className={`${styles.status} ${noticeError ? styles.error : ""}`} aria-live="polite">
          {notice}
        </p>
      </section>
    );
  }

  return (
    <section className={styles.card} aria-labelledby="home-title">
      <div className={styles.workspaceHeader}>
        <div>
          <p className={styles.eyebrow}>
            <span className={styles.stateDot} aria-hidden="true" /> Ready
          </p>
          <h1 className={styles.title} id="home-title">
            What should I remember?
          </h1>
        </div>
        <button
          className={styles.quietButton}
          type="button"
          onClick={() => void signOut()}
          disabled={signingOut}
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>

      <div className={styles.tabs} role="tablist" aria-label="Exomem actions">
        <button
          className={`${styles.tab} ${tab === "remember" ? styles.activeTab : ""}`}
          role="tab"
          aria-selected={tab === "remember"}
          type="button"
          onClick={() => setTab("remember")}
        >
          Remember
        </button>
        <button
          className={`${styles.tab} ${tab === "recall" ? styles.activeTab : ""}`}
          role="tab"
          aria-selected={tab === "recall"}
          type="button"
          onClick={() => setTab("recall")}
        >
          Find something
        </button>
      </div>

      {tab === "remember" ? (
        <form className={styles.form} onSubmit={remember}>
          <label className={styles.label} htmlFor="memory-content">
            A thought, decision, detail, or anything you want later
          </label>
          <textarea
            className={styles.textarea}
            id="memory-content"
            name="memory"
            autoFocus
            required
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="Kim prefers the morning train. The reference number is…"
          />
          <button className={styles.button} type="submit" disabled={busy || !content.trim()}>
            {busy ? "Remembering…" : "Remember this"}
          </button>
        </form>
      ) : (
        <form className={styles.form} onSubmit={recall}>
          <label className={styles.label} htmlFor="memory-query">
            What are you trying to remember?
          </label>
          <input
            className={styles.input}
            id="memory-query"
            name="query"
            autoFocus
            required
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="When does the locksmith arrive?"
          />
          <button className={styles.button} type="submit" disabled={busy || !query.trim()}>
            {busy ? "Looking…" : "Find it"}
          </button>
        </form>
      )}

      <p className={`${styles.status} ${noticeError ? styles.error : ""}`} aria-live="polite">
        {notice}
      </p>
      {result !== null && (
        <div className={styles.result} aria-live="polite">
          <p className={styles.resultTitle}>From your Exomem</p>
          <p className={styles.resultBody}>{result}</p>
        </div>
      )}

      <details className={styles.secondary}>
        <summary className={styles.summary}>Files, status, and account</summary>
        <div className={styles.secondaryBody}>
          <div className={styles.secondaryRow}>
            <div>
              <strong>Memory overview</strong>
              <p className={styles.secondaryCopy}>
                Recent structure, review items, and suggested connections.
              </p>
            </div>
            <div className={styles.buttonGroup}>
              <button
                className={styles.quietButton}
                type="button"
                disabled={secondaryBusy}
                onClick={() => void loadSecondary("recent")}
              >
                Recent
              </button>
              <button
                className={styles.quietButton}
                type="button"
                disabled={secondaryBusy}
                onClick={() => void loadSecondary("review")}
              >
                Review
              </button>
              <button
                className={styles.quietButton}
                type="button"
                disabled={secondaryBusy}
                onClick={() => void loadSecondary("connections")}
              >
                Connections
              </button>
            </div>
          </div>
          <div className={styles.secondaryRow}>
            <div>
              <strong>Add a file</strong>
              <p className={styles.secondaryCopy}>Keep a document or image with your memories.</p>
            </div>
            <div className={styles.buttonGroup}>
              <label className={styles.quietButton} aria-disabled={uploading}>
                {uploading ? "Uploading…" : "Choose file"}
                <input
                  type="file"
                  hidden
                  disabled={uploading}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    void upload(file, "selection");
                  }}
                />
              </label>
              {failedUpload && (
                <button
                  className={styles.quietButton}
                  type="button"
                  disabled={uploading}
                  onClick={() => void upload(failedUpload, "retry")}
                >
                  Retry upload
                </button>
              )}
            </div>
          </div>
          <div className={styles.secondaryRow}>
            <div>
              <strong>Service status</strong>
              <p className={styles.secondaryCopy}>Your private memory cell is ready.</p>
            </div>
            <button className={styles.quietButton} type="button" onClick={refreshStatus}>
              Refresh
            </button>
          </div>
          <div className={styles.secondaryRow}>
            <div>
              <strong>Billing</strong>
              <p className={styles.secondaryCopy}>
                {billing?.source === "paddle"
                  ? `Paddle billing · ${billing.state}`
                  : "Complimentary alpha — no payment needed."}
              </p>
            </div>
            {billing?.portalAvailable ? (
              <button
                className={styles.quietButton}
                type="button"
                onClick={() => void openBilling()}
              >
                Manage billing
              </button>
            ) : null}
          </div>
          {installActions.map((action) => (
            <div className={styles.secondaryRow} key={action.platform}>
              <div>
                <strong>Connect with {action.platform === "claude" ? "Claude" : "ChatGPT"}</strong>
                <p className={styles.secondaryCopy}>Native install · version {action.version}</p>
              </div>
              <a className={styles.quietButton} href={action.installUrl}>
                Install in {action.platform === "claude" ? "Claude" : "ChatGPT"}
              </a>
            </div>
          ))}
          <div className={styles.secondaryRow}>
            <div>
              <strong>Verified export</strong>
              <p className={styles.secondaryCopy}>
                Make a portable copy of your canonical Markdown and files.
              </p>
            </div>
            {exportState?.state === "available" && exportState.exportId ? (
              <a
                className={styles.quietButton}
                href={`/api/exomem/exports/${encodeURIComponent(exportState.exportId)}/download`}
              >
                Download export
              </a>
            ) : exportState?.state === "processing" ? (
              <button className={styles.quietButton} type="button" onClick={refreshExports}>
                Check progress
              </button>
            ) : (
              <button className={styles.quietButton} type="button" onClick={requestExport}>
                Prepare export
              </button>
            )}
          </div>
          <div className={styles.secondaryRow}>
            <div>
              <strong>Delete Exomem</strong>
              <p className={styles.secondaryCopy}>
                Removes only Exomem after a fresh email confirmation.
              </p>
            </div>
            <button
              className={styles.dangerButton}
              type="button"
              onClick={requestDeletion}
              disabled={deletionRequested}
            >
              {deletionRequested ? "Confirmation sent" : "Email confirmation"}
            </button>
          </div>
        </div>
      </details>
    </section>
  );
}
