"use client";

import { FormEvent, useRef, useState } from "react";
import styles from "../private-shell.module.css";
import {
  paidInviteHeadroom,
  parseOperatorCapacity,
  requiresComplimentaryConfirmation,
  type InviteSource,
  type OperatorCapacity,
} from "./operator-state";

type OperatorErrorBody = {
  error?: { code?: unknown };
};

class OperatorRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
  }
}

async function operatorRequest(
  path: string,
  bearer: string,
  init: { method?: "POST"; body?: string } = {}
): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    headers: {
      Authorization: `Bearer ${bearer}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const body = (await response.json().catch(() => ({}))) as OperatorErrorBody &
    Record<string, unknown>;
  if (!response.ok) {
    throw new OperatorRequestError(
      response.status,
      typeof body.error?.code === "string" ? body.error.code : "OPERATOR_REQUEST_FAILED"
    );
  }
  return body;
}

function operatorMessage(error: unknown): string {
  if (!(error instanceof OperatorRequestError)) return "The operator request failed. Try again.";
  switch (error.code) {
    case "ADMIN_UNAUTHORIZED":
      return "That admin bearer was not accepted.";
    case "CAPACITY_UNAVAILABLE":
      return "No paid alpha slots remain.";
    case "INVALID_EMAIL":
      return "Enter a valid email address.";
    case "EMAIL_DELIVERY_UNAVAILABLE":
      return "The invitation could not be delivered. Try again.";
    case "RATE_LIMITED":
      return "Too many requests. Wait a moment and try again.";
    default:
      return error.status >= 500
        ? "The operator service is temporarily unavailable."
        : "The operator request was not accepted.";
  }
}

async function readCapacity(bearer: string): Promise<OperatorCapacity> {
  const body = await operatorRequest("/api/exomem/admin/capacity", bearer);
  const capacity = parseOperatorCapacity(body.capacity);
  if (!capacity) throw new Error("invalid capacity response");
  return capacity;
}

function gibibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(bytes % 1024 ** 3 === 0 ? 0 : 1)} GiB`;
}

export default function OperatorClient() {
  const bearerRef = useRef<string | null>(null);
  const [bearer, setBearer] = useState("");
  const [capacity, setCapacity] = useState<OperatorCapacity | null>(null);
  const [authenticating, setAuthenticating] = useState(false);
  const [email, setEmail] = useState("");
  const [source, setSource] = useState<InviteSource>("paid");
  const [complimentaryConfirmed, setComplimentaryConfirmed] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const candidate = bearer.trim();
    if (!candidate || authenticating) return;
    setAuthenticating(true);
    setError(false);
    setMessage("");
    try {
      const nextCapacity = await readCapacity(candidate);
      bearerRef.current = candidate;
      setBearer("");
      setCapacity(nextCapacity);
    } catch (requestError) {
      bearerRef.current = null;
      setCapacity(null);
      setError(true);
      setMessage(operatorMessage(requestError));
    } finally {
      setAuthenticating(false);
    }
  }

  function lock() {
    bearerRef.current = null;
    setCapacity(null);
    setBearer("");
    setEmail("");
    setSource("paid");
    setComplimentaryConfirmed(false);
    setMessage("");
    setError(false);
  }

  async function sendInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const activeBearer = bearerRef.current;
    if (
      !activeBearer ||
      !capacity ||
      sending ||
      !email.trim() ||
      requiresComplimentaryConfirmation(source, complimentaryConfirmed)
    ) {
      return;
    }
    setSending(true);
    setError(false);
    setMessage("");
    try {
      await operatorRequest("/api/exomem/admin/invites", activeBearer, {
        method: "POST",
        body: JSON.stringify({ email, source }),
      });
      setEmail("");
      setSource("paid");
      setComplimentaryConfirmed(false);
      setMessage(`${source === "paid" ? "Paid" : "Complimentary"} invitation sent.`);
      try {
        setCapacity(await readCapacity(activeBearer));
      } catch {
        setMessage("Invitation sent. Refresh capacity before sending another.");
      }
    } catch (requestError) {
      if (requestError instanceof OperatorRequestError && requestError.status === 401) lock();
      setError(true);
      setMessage(operatorMessage(requestError));
    } finally {
      setSending(false);
    }
  }

  if (!capacity) {
    return (
      <section className={styles.card} aria-labelledby="operator-auth-title">
        <p className={styles.eyebrow}>Private operator</p>
        <h1 className={styles.title} id="operator-auth-title">
          Alpha access.
        </h1>
        <p className={styles.lede}>
          Enter the existing Exomem admin bearer. It stays only in this page and is discarded on
          refresh.
        </p>
        <form className={styles.form} onSubmit={authenticate}>
          <label className={styles.label} htmlFor="operator-bearer">
            Admin bearer
          </label>
          <input
            className={styles.input}
            id="operator-bearer"
            type="password"
            value={bearer}
            onChange={(event) => setBearer(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            className={styles.button}
            type="submit"
            disabled={!bearer.trim() || authenticating}
          >
            {authenticating ? "Checking…" : "Open controls"}
          </button>
        </form>
        <p
          className={`${styles.status} ${error ? styles.error : ""}`}
          role={error ? "alert" : "status"}
          aria-live="polite"
        >
          {message}
        </p>
      </section>
    );
  }

  const headroom = paidInviteHeadroom(capacity);
  const paidBlocked = source === "paid" && headroom === 0;
  return (
    <section className={styles.card} aria-labelledby="operator-title">
      <div className={styles.workspaceHeader}>
        <div>
          <p className={styles.eyebrow}>Private operator</p>
          <h1 className={styles.title} id="operator-title">
            Alpha invitations.
          </h1>
        </div>
        <button className={styles.quietButton} type="button" onClick={lock}>
          Lock
        </button>
      </div>

      <div className={styles.capacityGrid} aria-label="Alpha capacity">
        <div className={styles.capacityMetric}>
          <span className={styles.label}>Paid slots free</span>
          <strong className={styles.capacityValue}>{headroom}</strong>
        </div>
        <div className={styles.capacityMetric}>
          <span className={styles.label}>Paid invites out</span>
          <strong className={styles.capacityValue}>{capacity.outstandingPaidInvites}</strong>
        </div>
        <div className={styles.capacityMetric}>
          <span className={styles.label}>Runtime reserved</span>
          <strong className={styles.capacityValue}>
            {capacity.reservedRuntimeSlots}/{capacity.runtimeCapacitySlots}
          </strong>
        </div>
        <div className={styles.capacityMetric}>
          <span className={styles.label}>Storage reserved</span>
          <strong className={styles.capacityValue}>
            {gibibytes(capacity.reservedStorageBytes)} / {gibibytes(capacity.storageCapacityBytes)}
          </strong>
        </div>
      </div>

      <form className={styles.form} onSubmit={sendInvite}>
        <label className={styles.label} htmlFor="operator-email">
          Friend&apos;s email
        </label>
        <input
          className={styles.input}
          id="operator-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          required
        />

        <label className={styles.label} htmlFor="operator-source">
          Access
        </label>
        <select
          className={styles.input}
          id="operator-source"
          value={source}
          onChange={(event) => {
            setSource(event.target.value as InviteSource);
            setComplimentaryConfirmed(false);
          }}
        >
          <option value="paid">Paid — €5/month</option>
          <option value="complimentary">Complimentary</option>
        </select>

        {source === "complimentary" ? (
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={complimentaryConfirmed}
              onChange={(event) => setComplimentaryConfirmed(event.target.checked)}
            />
            Confirm this person will not be asked to subscribe.
          </label>
        ) : null}

        <button
          className={styles.button}
          type="submit"
          disabled={
            sending ||
            !email.trim() ||
            paidBlocked ||
            requiresComplimentaryConfirmation(source, complimentaryConfirmed)
          }
        >
          {sending
            ? "Sending…"
            : source === "paid"
              ? "Send paid invitation"
              : "Send complimentary invitation"}
        </button>
      </form>
      <p
        className={`${styles.status} ${error ? styles.error : ""}`}
        role={error ? "alert" : "status"}
        aria-live="polite"
      >
        {message || (paidBlocked ? "Paid alpha capacity is full." : "Paid access is the default.")}
      </p>
    </section>
  );
}
