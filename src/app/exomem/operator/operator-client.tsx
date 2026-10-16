"use client";

import { FormEvent, useRef, useState } from "react";
import { Button } from "@/components/exomem/Button";
import { RadioCard } from "@/components/exomem/RadioCard";
import { Switch } from "@/components/exomem/Switch";
import { TextField } from "@/components/exomem/TextField";
import { ThemeToggle } from "@/components/exomem/ThemeToggle";
import { Wordmark } from "@/components/exomem/Wordmark";
import phone from "@/components/exomem/phone.module.css";
import {
  EXOMEM_INVITE_KINDS,
  INVITATION_NAME_MAX,
  INVITATION_NOTE_MAX,
  inviteeNameRequired,
  inviterEmailAllowed,
  inviterNameRequired,
  type ExomemInviteKind,
} from "@/lib/exomem-hosted/invitation-contract";
import {
  invitationBlocked,
  invitationRequestBody,
  parseOperatorCapacity,
  requiresComplimentaryConfirmation,
  type OperatorCapacity,
} from "./operator-state";
import home from "../home/home.module.css";
import styles from "./operator.module.css";

const KIND_LABELS: Record<ExomemInviteKind, string> = {
  standard: "Paid",
  friend: "Friend (paid, friend price)",
  covered: "Covered (complimentary)",
};
const KIND_NAMES: Record<ExomemInviteKind, string> = {
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

/** Home's header: the page's name beside the wordmark, and Lock where Home has Sign out. */
function OperatorHeader({ onLock }: { onLock?: () => void }) {
  return (
    <header className={home.header}>
      <span className={home.headerStart}>
        <span className={home.wordmark}>
          <Wordmark />
        </span>
        <span className={`${home.nav} ${home.navCurrent}`}>Private operator</span>
      </span>
      <span className={home.headerEnd}>
        <ThemeToggle />
        {onLock ? (
          <button
            type="button"
            className={`${home.inlineButton} ${phone.hitArea}`}
            onClick={onLock}
          >
            Lock
          </button>
        ) : null}
      </span>
    </header>
  );
}

export default function OperatorClient() {
  const bearerRef = useRef<string | null>(null);
  const [bearer, setBearer] = useState("");
  const [capacity, setCapacity] = useState<OperatorCapacity | null>(null);
  const [authenticating, setAuthenticating] = useState(false);
  const [email, setEmail] = useState("");
  const [kind, setKind] = useState<ExomemInviteKind>("standard");
  const [inviterName, setInviterName] = useState("");
  const [inviterEmail, setInviterEmail] = useState("");
  const [inviteeName, setInviteeName] = useState("");
  const [note, setNote] = useState("");
  const [complimentaryConfirmed, setComplimentaryConfirmed] = useState(false);
  const inviteeNameNeeded = inviteeNameRequired(kind, inviterEmail.trim() !== "");
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
      <>
        <OperatorHeader />
        <section className={home.column} aria-labelledby="operator-auth-title">
          <div className={home.statusText}>
            <h1 className={home.headline} id="operator-auth-title">
              Alpha access.
            </h1>
            <span className={home.statusLine}>
              Enter the existing Exomem admin bearer. It stays only in this page and is discarded on
              refresh.
            </span>
          </div>
          <form className={styles.form} onSubmit={authenticate}>
            <TextField
              label="Admin bearer"
              type="password"
              value={bearer}
              onChange={(event) => setBearer(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              invalid={error}
            />
            <div>
              <Button
                variant="primary"
                size="page"
                type="submit"
                disabled={!bearer.trim()}
                working={authenticating}
              >
                {authenticating ? "Checking…" : "Open controls"}
              </Button>
              <p
                className={home.billingStatus}
                role={error ? "alert" : "status"}
                aria-live="polite"
              >
                {message}
              </p>
            </div>
          </form>
        </section>
      </>
    );
  }

  const blocked = invitationBlocked(capacity);
  const figures: Array<[label: string, value: string | number]> = [
    ["Cloud places free", capacity.freePlaces === null ? "Unknown" : capacity.freePlaces],
    ["Invitations out", capacity.outstandingInvitations],
    [
      "Cells live",
      capacity.freePlaces === null
        ? capacity.liveCells
        : `${capacity.liveCells}/${capacity.observedSlots}`,
    ],
    [
      "Capacity observed",
      capacity.newestObservationAt
        ? new Date(capacity.newestObservationAt).toLocaleString([], {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "Never",
    ],
  ];
  return (
    <>
      <OperatorHeader onLock={lock} />
      <div className={`${home.column} ${styles.column}`}>
        <h1 className={home.headline}>Alpha invitations.</h1>

        <section className={home.section} aria-labelledby="operator-capacity-title">
          <h2 className={home.sectionTitle} id="operator-capacity-title">
            Cloud capacity
          </h2>
          <dl className={home.panel}>
            {figures.map(([label, value]) => (
              <div className={home.row} key={label}>
                <dt className={home.rowTitle}>{label}</dt>
                <dd className={styles.figure}>{value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className={home.section} aria-labelledby="operator-invite-title">
          <h2 className={home.sectionTitle} id="operator-invite-title">
            New invitation
          </h2>
          <div className={home.panel}>
            <form className={`${styles.form} ${styles.panelForm}`} onSubmit={sendInvite}>
              <TextField
                label="Invitee's email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                required
              />

              <fieldset className={home.fieldset}>
                <legend className={styles.legend}>Access</legend>
                <div className={styles.choices}>
                  {EXOMEM_INVITE_KINDS.map((option) => (
                    <RadioCard
                      key={option}
                      name="operator-kind"
                      value={option}
                      checked={kind === option}
                      onChange={() => {
                        setKind(option);
                        setComplimentaryConfirmed(false);
                      }}
                      detail={null}
                    >
                      {KIND_LABELS[option]}
                    </RadioCard>
                  ))}
                </div>
              </fieldset>

              {/* Keyed on the required state, so an "Enter …" error clears when the field turns optional. */}
              <TextField
                key={inviterNameRequired(kind) ? "inviter-required" : "inviter-optional"}
                label={inviterNameRequired(kind) ? "Inviter's name" : "Inviter's name (optional)"}
                type="text"
                value={inviterName}
                maxLength={INVITATION_NAME_MAX}
                onChange={(event) => setInviterName(event.target.value)}
                autoComplete="off"
                required={inviterNameRequired(kind)}
              />

              {inviterEmailAllowed(kind) ? (
                <TextField
                  label="Inviter's email (optional, for the used and ended notices)"
                  type="email"
                  value={inviterEmail}
                  onChange={(event) => setInviterEmail(event.target.value)}
                  autoComplete="off"
                />
              ) : null}

              <TextField
                key={inviteeNameNeeded ? "invitee-required" : "invitee-optional"}
                label={inviteeNameNeeded ? "Invitee's name" : "Invitee's name (optional)"}
                type="text"
                value={inviteeName}
                maxLength={INVITATION_NAME_MAX}
                onChange={(event) => setInviteeName(event.target.value)}
                autoComplete="off"
                required={inviteeNameNeeded}
              />

              {/* One line: the library has no multi-line field. The note's line breaks show
                  only in the plain-text email; the invitation page and HTML email run it on. */}
              <TextField
                label="Note from the inviter (optional)"
                type="text"
                value={note}
                maxLength={INVITATION_NOTE_MAX}
                onChange={(event) => setNote(event.target.value)}
                autoComplete="off"
              />

              {kind === "covered" ? (
                <Switch
                  label="Confirm this person will not be asked to subscribe."
                  checked={complimentaryConfirmed}
                  onChange={setComplimentaryConfirmed}
                />
              ) : null}

              <div>
                <Button
                  variant="primary"
                  size="page"
                  type="submit"
                  working={sending}
                  disabled={
                    !email.trim() ||
                    blocked ||
                    requiresComplimentaryConfirmation(kind, complimentaryConfirmed)
                  }
                >
                  {sending ? "Sending…" : `Send ${KIND_NAMES[kind]} invitation`}
                </Button>
                <p
                  className={home.billingStatus}
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
              </div>
            </form>
          </div>
        </section>
      </div>
    </>
  );
}
