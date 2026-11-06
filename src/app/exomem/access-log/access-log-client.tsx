"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/exomem/Button";
import { Notice } from "@/components/exomem/Notice";
import { TextField } from "@/components/exomem/TextField";
import { ThemeToggle } from "@/components/exomem/ThemeToggle";
import { Wordmark } from "@/components/exomem/Wordmark";
import { csrfCookie } from "@/lib/exomem-hosted/hosted-browser";
import type { readAccessLog } from "@/lib/exomem-hosted/cloud-access-log";
import { Section } from "../home/home-chrome";
import home from "../home/home.module.css";
import styles from "./access-log.module.css";

type View = Awaited<ReturnType<typeof readAccessLog>>;
const api = "/api/exomem/cloud/access-log";
async function readView(before?: string): Promise<View | null> {
  const response = await fetch(`${api}${before ? `?before=${encodeURIComponent(before)}` : ""}`, {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error();
  return response.json();
}
function time(value: unknown): string {
  if (typeof value !== "string") return "unavailable";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "unavailable";
}
async function send(path: string, body: Record<string, unknown>) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-exomem-csrf": csrfCookie() },
    credentials: "same-origin",
    cache: "no-store",
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("That request did not finish. Check your code or try again.");
  return response.json();
}
export default function AccessLogClient() {
  const [view, setView] = useState<View | null>(null);
  const [state, setState] = useState<"loading" | "signin" | "ready" | "failed">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<{ code: string; expiresAt: string } | null>(null);
  const receive = useCallback((body: View | null, before?: string) => {
    setMessage(null);
    if (!body) {
      setState("signin");
      return;
    }
    setView((previous) =>
      before && previous ? { ...body, entries: [...previous.entries, ...body.entries] } : body
    );
    setState("ready");
  }, []);
  const failed = useCallback(() => {
    setState("failed");
    setMessage("The access log cannot be read right now. Try again.");
  }, []);
  async function load(before?: string) {
    try {
      receive(await readView(before), before);
    } catch {
      failed();
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    void readView().then(
      (body) => {
        if (active) receive(body);
      },
      () => {
        if (active) failed();
      }
    );
    return () => {
      active = false;
    };
  }, [receive, failed]);
  async function recover(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const challenge = await send(`${api}/challenge`, {});
      await send(`${api}/recover`, { code: code.trim(), challenge: challenge.challenge });
      setCode("");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That request did not finish.");
    } finally {
      setBusy(false);
    }
  }
  async function saveRecovery() {
    if (!view) return;
    setBusy(true);
    setMessage(null);
    try {
      setSaved(await send(`${api}/recovery`, { cellId: view.cellId }));
    } catch {
      setMessage("A recovery code could not be created. Deletion can still proceed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header className={home.header}>
        <span className={home.headerStart}>
          <a href="/exomem/home" aria-label="Exomem home">
            <Wordmark />
          </a>
          <span className={home.nav}>Access log</span>
        </span>
        <ThemeToggle />
      </header>
      <div className={`${home.column} ${styles.column}`}>
        <div>
          <h1 className={home.headline}>Access log</h1>
          <p className={styles.muted}>
            This log lists what the record received. It cannot prove every access was recorded. A
            node session does not list each read inside it.
          </p>
        </div>
        {message && (
          <div role="alert">
            <Notice attention>{message}</Notice>
          </div>
        )}
        {state === "loading" && <p role="status">Reading the access log…</p>}
        {state === "signin" && (
          <Section title="Read a retained log">
            <form className={styles.form} onSubmit={recover}>
              <p className={styles.muted}>
                Use the recovery code you saved before deleting your Exomem. It grants access to
                that log only.
              </p>
              <TextField
                label="Recovery code"
                code
                type="password"
                autoComplete="off"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
              />
              <Button type="submit" working={busy}>
                Read access log
              </Button>
              <p className={styles.muted}>
                If you lost the code, this log cannot be recovered.{" "}
                <a href="/exomem/start">Sign in</a> to read an active Exomem’s log.
              </p>
            </form>
          </Section>
        )}
        {state === "failed" && (
          <Button
            working={busy}
            onClick={() => {
              setBusy(true);
              void load();
            }}
          >
            Try again
          </Button>
        )}
        {state === "ready" && view && (
          <>
            <Notice>
              Collection window: {time(view.window.start)} to {time(view.window.end)}. Coverage is{" "}
              {view.coverage}. Gaps and unavailable evidence do not mean no access occurred.
            </Notice>
            <Section title="Received events">
              <div className={styles.events}>
                {view.entries.length === 0 && (
                  <p className={styles.muted}>
                    No received events appear in this collection window.
                  </p>
                )}
                {view.entries.map((entry) => (
                  <article className={styles.event} key={String(entry.id)}>
                    <div className={home.rowTitle}>
                      {String(entry.action)} · {String(entry.identity_tier)}
                    </div>
                    <div className={styles.muted}>
                      {time(entry.source_at)} · received {time(entry.received_at)}
                    </div>
                    <dl className={styles.details}>
                      <dt>Identity</dt>
                      <dd>{String(entry.identity ?? "unavailable")}</dd>
                      <dt>Target</dt>
                      <dd>{String(entry.target ?? "unavailable")}</dd>
                      <dt>Node</dt>
                      <dd>{String(entry.node ?? "unavailable")}</dd>
                      <dt>Stated reason</dt>
                      <dd>{String(entry.reason ?? "unavailable")}</dd>
                      {entry.kind === "node_session" && (
                        <>
                          <dt>Session end</dt>
                          <dd>{time(entry.session_end_at)}</dd>
                          <dt>Authentication</dt>
                          <dd>{String(entry.authentication_method ?? "unavailable")}</dd>
                          <dt>Fingerprint</dt>
                          <dd>
                            {String(entry.fingerprint_kind ?? "unavailable")}{" "}
                            {String(entry.fingerprint ?? "")}
                          </dd>
                        </>
                      )}
                    </dl>
                  </article>
                ))}
                {view.next && (
                  <Button
                    working={busy}
                    onClick={() => {
                      setBusy(true);
                      void load(view.next!);
                    }}
                  >
                    Earlier events
                  </Button>
                )}
              </div>
            </Section>
            <Section title="Placement and gaps">
              <div className={styles.events}>
                {!view.placements.length && (
                  <p className={styles.muted}>
                    Placement history is unavailable. The current cell location cannot reconstruct
                    it.
                  </p>
                )}
                {view.placements.map((placement) => (
                  <div
                    className={styles.event}
                    key={`${String(placement.pod_uid)}:${String(placement.first_observed_at)}`}
                  >
                    <div>
                      {String(placement.node)} ·{" "}
                      {placement.gap
                        ? "heartbeat gap or unavailable heartbeat"
                        : "partial heartbeat evidence"}
                    </div>
                    <div className={styles.muted}>
                      {String(placement.workload_kind)} · Pod {String(placement.pod_uid)} ·{" "}
                      {String(placement.phase ?? "unavailable")}.
                    </div>
                    <div className={styles.muted}>
                      Observed {time(placement.first_observed_at)} to{" "}
                      {time(placement.last_observed_at)}.
                    </div>
                    <div className={styles.muted}>
                      Last generated heartbeat: {time(placement.heartbeat?.source_at)}. Provider
                      event: {time(placement.heartbeat?.provider_at)}.
                    </div>
                  </div>
                ))}
                {view.placementGaps.map((gap, index) => (
                  <div className={styles.event} key={`placement:${index}`}>
                    Placement unknown from {time(gap.start)} to {time(gap.end)}.
                  </div>
                ))}
                {view.gaps.map((gap, index) => (
                  <div className={styles.event} key={`${String(gap.node)}:${index}`}>
                    {String(gap.node)} · heartbeat gap from {time(gap.start)} to {time(gap.end)}.
                    Provider event: {time(gap.provider_at)}.
                  </div>
                ))}
                {view.shipperMetrics.map((metric) => (
                  <div
                    className={styles.muted}
                    key={`${String(metric.node)}:${String(metric.target)}`}
                  >
                    {String(metric.node)} · {String(metric.target)}:{" "}
                    {String(metric.result ?? "unavailable")} · observed {time(metric.source_at)}
                  </div>
                ))}
              </div>
            </Section>
            {!view.restricted && (
              <Section title="Keep this log after deletion">
                <div className={styles.form}>
                  <p className={styles.muted}>
                    Save a recovery code before deleting your Exomem. Deletion proceeds whether you
                    save it. We keep no recovery email.
                  </p>
                  <Button working={busy} onClick={() => void saveRecovery()}>
                    Create recovery code
                  </Button>
                  {saved && (
                    <>
                      <TextField label="Save this recovery code" code readOnly value={saved.code} />
                      <p className={styles.muted}>
                        It expires {time(saved.expiresAt)}. Losing it means losing access to the
                        retained log.
                      </p>
                    </>
                  )}
                </div>
              </Section>
            )}
          </>
        )}
      </div>
    </>
  );
}
