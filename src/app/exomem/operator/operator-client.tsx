"use client";

import { FormEvent, useRef, useState } from "react";
import styles from "../private-shell.module.css";
import {
  invitationBlocked,
  invitationRequestBody,
  parseOperatorCapacity,
  requiresComplimentaryConfirmation,
  type InviteKind,
  type OperatorCapacity,
} from "./operator-state";

const KIND_LABELS: Record<InviteKind, string> = {
  standard: "Paid",
  friend: "Friend (paid, friend price)",
  covered: "Covered (complimentary)",
};
const KIND_NAMES: Record<InviteKind, string> = {
  standard: "paid",
  friend: "friend",
  covered: "covered",
};

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
      return "No Cloud places are free.";
    case "INVALID_EMAIL":
      return "Enter a valid email address.";
    case "INVITATION_FIELDS_INVALID":
      return "Check the names and note. Friend and covered invitations need the inviter's name, and the inviter's email needs the invitee's name.";
    case "FRIEND_PRICE_UNAVAILABLE":
      return "Paddle could not confirm the friend price. Nothing was sent. Try again later.";
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

export default function OperatorClient() {
  const bearerRef = useRef<string | null>(null);
  const [bearer, setBearer] = useState("");
  const [capacity, setCapacity] = useState<OperatorCapacity | null>(null);
  const [authenticating, setAuthenticating] = useState(false);
  const [email, setEmail] = useState("");
  const [kind, setKind] = useState<InviteKind>("standard");
  const [inviterName, setInviterName] = useState("");
  const [inviterEmail, setInviterEmail] = useState("");
  const [inviteeName, setInviteeName] = useState("");
  const [note, setNote] = useState("");
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

  function clearDraft() {
    setEmail("");
    setKind("standard");
    setInviterName("");
    setInviterEmail("");
    setInviteeName("");
    setNote("");
    setComplimentaryConfirmed(false);
  }

  function lock() {
    bearerRef.current = null;
    setCapacity(null);
    setBearer("");
    clearDraft();
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
      requiresComplimentaryConfirmation(kind, complimentaryConfirmed)
    ) {
      return;
    }
    setSending(true);
    setError(false);
    setMessage("");
    try {
      await operatorRequest("/api/exomem/admin/invites", activeBearer, {
        method: "POST",
        body: JSON.stringify(
          invitationRequestBody({ email, kind, inviterName, inviterEmail, inviteeName, note })
        ),
      });
      const sentKind = kind;
      clearDraft();
      setMessage(`The ${KIND_NAMES[sentKind]} invitation is queued.`);
      try {
        setCapacity(await readCapacity(activeBearer));
      } catch {
        setMessage("Invitation queued. Refresh capacity before sending another.");
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

  const blocked = invitationBlocked(capacity);
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

      <div className={styles.capacityGrid} aria-label="Cloud capacity">
        <div className={styles.capacityMetric}>
          <span className={styles.label}>Cloud places free</span>
          <strong className={styles.capacityValue}>
            {capacity.freePlaces === null ? "Unknown" : capacity.freePlaces}
          </strong>
        </div>
        <div className={styles.capacityMetric}>
          <span className={styles.label}>Invitations out</span>
          <strong className={styles.capacityValue}>{capacity.outstandingInvitations}</strong>
        </div>
        <div className={styles.capacityMetric}>
          <span className={styles.label}>Cells live</span>
          <strong className={styles.capacityValue}>
            {capacity.freePlaces === null
              ? capacity.liveCells
              : `${capacity.liveCells}/${capacity.observedSlots}`}
          </strong>
        </div>
        <div className={styles.capacityMetric}>
          <span className={styles.label}>Capacity observed</span>
          <strong className={styles.capacityValue}>
            {capacity.newestObservationAt
              ? new Date(capacity.newestObservationAt).toLocaleString([], {
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "Never"}
          </strong>
        </div>
      </div>

      <form className={styles.form} onSubmit={sendInvite}>
        <label className={styles.label} htmlFor="operator-email">
          Invitee&apos;s email
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

        <label className={styles.label} htmlFor="operator-kind">
          Access
        </label>
        <select
          className={styles.input}
          id="operator-kind"
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as InviteKind);
            setComplimentaryConfirmed(false);
          }}
        >
          {(Object.keys(KIND_LABELS) as InviteKind[]).map((option) => (
            <option key={option} value={option}>
              {KIND_LABELS[option]}
            </option>
          ))}
        </select>

        <label className={styles.label} htmlFor="operator-inviter-name">
          {kind === "standard" ? "Inviter's name (optional)" : "Inviter's name"}
        </label>
        <input
          className={styles.input}
          id="operator-inviter-name"
          type="text"
          value={inviterName}
          maxLength={60}
          onChange={(event) => setInviterName(event.target.value)}
          autoComplete="off"
          required={kind !== "standard"}
        />

        {kind === "friend" ? (
          <>
            <label className={styles.label} htmlFor="operator-inviter-email">
              Inviter&apos;s email (optional, for the used and ended notices)
            </label>
            <input
              className={styles.input}
              id="operator-inviter-email"
              type="email"
              value={inviterEmail}
              onChange={(event) => setInviterEmail(event.target.value)}
              autoComplete="off"
            />
          </>
        ) : null}

        <label className={styles.label} htmlFor="operator-invitee-name">
          Invitee&apos;s name (optional)
        </label>
        <input
          className={styles.input}
          id="operator-invitee-name"
          type="text"
          value={inviteeName}
          maxLength={60}
          onChange={(event) => setInviteeName(event.target.value)}
          autoComplete="off"
        />

        <label className={styles.label} htmlFor="operator-note">
          Note from the inviter (optional)
        </label>
        <textarea
          className={styles.input}
          id="operator-note"
          value={note}
          maxLength={280}
          rows={3}
          onChange={(event) => setNote(event.target.value)}
        />

        {kind === "covered" ? (
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
            blocked ||
            requiresComplimentaryConfirmation(kind, complimentaryConfirmed)
          }
        >
          {sending ? "Sending…" : `Send ${KIND_NAMES[kind]} invitation`}
        </button>
      </form>
      <p
        className={`${styles.status} ${error ? styles.error : ""}`}
        role={error ? "alert" : "status"}
        aria-live="polite"
      >
        {message ||
          (capacity.freePlaces === null
            ? "Cloud capacity has not been observed recently. Invitations wait until it is."
            : blocked
              ? "Cloud capacity is full."
              : "Paid access is the default.")}
      </p>
    </section>
  );
}
