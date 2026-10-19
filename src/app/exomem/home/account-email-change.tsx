"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/exomem/Button";
import { Modal } from "@/components/exomem/Modal";
import { TextField } from "@/components/exomem/TextField";
import {
  csrfCookie,
  friendlyHostedError,
  HostedBrowserError,
} from "@/lib/exomem-hosted/hosted-browser";
import {
  readEmailChange,
  requestEmailChange,
  SignedOutError,
  type HomeAccount,
  type HomeEmailChange,
} from "./home-api";
import { dayMonthTime } from "./home-format";
import home from "./home.module.css";
import styles from "./account-email-change.module.css";

type FormAccount = { email: string; csrfToken: string };

function deliveryText(state: string | undefined): string {
  // The outbox schema fixes these delivery states.
  switch (state) {
    case "pending":
    case "leased":
      return "queued";
    case "sent":
      return "sent";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "not available";
  }
}

export function AccountEmailChange({
  account,
  csrfToken,
  onAccountChanged,
  onAccountRefresh,
}: {
  account: HomeAccount;
  csrfToken: string;
  onAccountChanged: () => void;
  onAccountRefresh: () => void;
}) {
  const [binding, setBinding] = useState<FormAccount | null>(null);
  const [view, setView] = useState<HomeEmailChange | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const alive = useRef(false);
  const reading = useRef(false);
  const hadPending = useRef(false);
  const queuedRequest = useRef<string | null>(null);
  const nextPollAt = useRef(0);

  const accountChanged = useCallback(() => {
    queuedRequest.current = null;
    setBinding(null);
    setView(null);
    onAccountChanged();
  }, [onAccountChanged]);

  const refresh = useCallback(async () => {
    if (!csrfToken || csrfToken !== csrfCookie()) {
      accountChanged();
      return;
    }
    if (reading.current) return;
    reading.current = true;
    const trackedRequest = queuedRequest.current;
    try {
      const next = await readEmailChange();
      if (!alive.current) return;
      if (csrfToken !== csrfCookie()) {
        accountChanged();
        return;
      }
      // A read begun before this POST cannot settle its newly queued request.
      if (trackedRequest !== queuedRequest.current) return;
      if (!next) {
        setReadFailed(true);
        return;
      }
      if (trackedRequest !== null && next.pending?.requestId !== trackedRequest) {
        queuedRequest.current = null;
        setBinding(null);
        onAccountRefresh();
      } else if (hadPending.current && !next.pending) onAccountRefresh();
      hadPending.current = next.pending !== null;
      setView(next);
      setReadFailed(false);
      nextPollAt.current =
        Date.now() + (next.pending || next.receipts?.state === "pending" ? 3_000 : 30_000);
    } catch (error) {
      if (!alive.current) return;
      if (csrfToken !== csrfCookie()) accountChanged();
      else if (trackedRequest !== queuedRequest.current) return;
      else if (error instanceof SignedOutError) accountChanged();
      else setReadFailed(true);
    } finally {
      reading.current = false;
    }
  }, [csrfToken, accountChanged, onAccountRefresh]);

  useEffect(() => {
    alive.current = true;
    queueMicrotask(() => {
      if (alive.current) void refresh();
    });
    const poll = () => {
      if (document.visibilityState !== "visible") return;
      if (csrfToken !== csrfCookie()) {
        accountChanged();
        return;
      }
      if (Date.now() >= nextPollAt.current) void refresh();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(poll, 3_000);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, csrfToken, accountChanged]);

  const pending = view?.pending;
  const receipts = view?.receipts;
  const receiptTrouble = receipts?.state === "conflict" || receipts?.state === "failed";

  function open() {
    if (!csrfToken || csrfToken !== csrfCookie()) {
      accountChanged();
      return;
    }
    // Freeze both values once. An accepted new session remounts this component and discards the draft.
    setBinding({ email: account.email, csrfToken });
  }

  return (
    <>
      <div className={home.row}>
        <div className={home.rowText}>
          <span className={home.rowTitle}>Email</span>
          <span className={home.rowMeta}>{account.email}</span>
        </div>
        <Button size="account" onClick={open}>
          Change
        </Button>
      </div>
      {(view === null || readFailed || pending || receipts?.state || receipts?.available) && (
        <div className={home.inlineStatus} role="status">
          {view === null && !readFailed && <p className={styles.status}>Checking email status…</p>}
          {readFailed && (
            <p className={styles.status}>
              Email status couldn’t be refreshed.
              {view ? " Showing the last check." : " Try again in a moment."}
            </p>
          )}
          {pending && (
            <p className={styles.status}>
              Change pending: {pending.proposedEmail}. Links expire{" "}
              {dayMonthTime(pending.expiresAt)}. Nothing changes until the new address confirms.
            </p>
          )}
          {pending && (
            <p className={styles.status}>
              Confirmation: {deliveryText(pending.delivery?.email_change_confirmation)}. Notice to
              your current inbox: {deliveryText(pending.delivery?.email_change_cancellation)}.
            </p>
          )}
          {receipts?.state === "pending" && (
            <p className={styles.status}>
              {receipts.available
                ? "Paddle’s receipt address update is pending."
                : "The receipt update is waiting for a billing customer."}
            </p>
          )}
          {receipts?.state === "conflict" && (
            <p className={styles.status}>
              Paddle refused the receipt address because another customer uses it. Your Exomem email
              change still stands.
            </p>
          )}
          {receipts?.state === "failed" && (
            <p className={styles.status}>
              Paddle couldn’t update the receipt address. Your Exomem email change still stands.
            </p>
          )}
          {receipts && (receipts.state !== null || receipts.available) && (
            <p className={styles.status}>
              {receipts.knownEmail &&
              receipts.observedAt &&
              receipts.observationSource === "paddle_customer" ? (
                <>
                  {receipts.state === "synchronized"
                    ? "Receipt address verified"
                    : "Last known receipt address"}
                  : {receipts.knownEmail}. Checked with Paddle {dayMonthTime(receipts.observedAt)}.
                </>
              ) : (
                "Receipt address not yet verified with Paddle."
              )}
            </p>
          )}
          {receiptTrouble && (
            <p className={styles.status}>
              Choose another address, or{" "}
              <a className={home.inlineButton} href="/exomem/support">
                write to support
              </a>{" "}
              and quote {account.supportReference}.
            </p>
          )}
        </div>
      )}
      {binding && (
        <EmailChangeDialog
          binding={binding}
          supportReference={account.supportReference}
          view={view}
          readFailed={readFailed}
          onQueued={(requestId) => {
            queuedRequest.current = requestId;
            nextPollAt.current = 0;
            void refresh();
          }}
          onClose={() => {
            queuedRequest.current = null;
            setBinding(null);
          }}
          onAccountChanged={accountChanged}
        />
      )}
    </>
  );
}

function EmailChangeDialog({
  binding,
  supportReference,
  view,
  readFailed,
  onQueued,
  onClose,
  onAccountChanged,
}: {
  binding: FormAccount;
  supportReference: string;
  view: HomeEmailChange | null;
  readFailed: boolean;
  onQueued: (requestId: string) => void;
  onClose: () => void;
  onAccountChanged: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [queued, setQueued] = useState<{
    requestId: string;
    email: string;
    expiresAt: string;
  } | null>(null);
  const alive = useRef(false);
  const receipt = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!queued) return;
    const heading = receipt.current?.closest("dialog")?.querySelector("h2");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }, [queued]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!binding.csrfToken || binding.csrfToken !== csrfCookie()) {
      onAccountChanged();
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await requestEmailChange(draft.trim(), binding.csrfToken);
      if (!alive.current) return;
      if (!result || binding.csrfToken !== csrfCookie()) {
        onAccountChanged();
        return;
      }
      setQueued({ requestId: result.requestId, email: draft.trim(), expiresAt: result.expiresAt });
      onQueued(result.requestId);
    } catch (error) {
      if (!alive.current) return;
      if (
        binding.csrfToken !== csrfCookie() ||
        (error instanceof HostedBrowserError && error.status === 401)
      ) {
        onAccountChanged();
        return;
      }
      setMessage(friendlyHostedError(error));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const pending = queued && view?.pending?.requestId === queued.requestId ? view.pending : null;
  const confirmationSent = pending?.delivery?.email_change_confirmation === "sent";
  const noticeSent = pending?.delivery?.email_change_cancellation === "sent";
  const confirmationFailed = pending?.delivery?.email_change_confirmation === "failed";
  const noticeFailed = pending?.delivery?.email_change_cancellation === "failed";
  const sentEmail = pending?.proposedEmail ?? queued?.email;
  return (
    <Modal
      open
      onClose={onClose}
      title={queued ? "Check both inboxes" : "Change your email"}
      width={420}
      placement="top"
      phoneFullWidth
    >
      {queued ? (
        <>
          <p ref={receipt} className={home.dialogText}>
            {confirmationSent ? (
              <>Open the link we sent to {sentEmail}</>
            ) : confirmationFailed ? (
              <>The confirmation to {sentEmail} wasn’t delivered</>
            ) : (
              <>A confirmation link is queued for {sentEmail}</>
            )}
            . It expires {dayMonthTime(queued.expiresAt)}. Nothing changes until you confirm.{" "}
            {noticeSent ? (
              <>We also told {binding.email}, in case it wasn’t you.</>
            ) : noticeFailed ? (
              <>The notice to {binding.email} wasn’t delivered.</>
            ) : (
              <>The notice to {binding.email} is queued too.</>
            )}
          </p>
          {readFailed && (
            <p className={home.dialogText} role="status">
              Delivery status couldn’t be refreshed. Showing the last check.
            </p>
          )}
          {(confirmationFailed || noticeFailed) && (
            <p className={home.dialogText}>Close this and choose Change to request new links.</p>
          )}
          <div className={styles.done}>
            <Button variant="primary" size="dialog" onClick={onClose}>
              Done
            </Button>
          </div>
        </>
      ) : (
        <form className={styles.form} onSubmit={(event) => void submit(event)}>
          <p className={home.dialogText}>
            This is where sign-in links and receipts go. It doesn’t change your notes or your
            connected apps.
          </p>
          <p className={styles.help}>
            Can’t open that inbox any more?{" "}
            <a className={home.inlineButton} href="/exomem/support">
              Write to support
            </a>{" "}
            and quote {supportReference}. We check it’s you another way.
          </p>
          <TextField
            label="New email"
            type="email"
            autoComplete="email"
            required
            maxLength={254}
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
          />
          {message && (
            <p className={home.dialogText} role="alert">
              {message}
            </p>
          )}
          <div className={styles.actions}>
            <Button type="submit" variant="primary" size="dialog" working={busy}>
              {busy ? "Queuing the links…" : "Send the links"}
            </Button>
            <Button variant="ghost" size="dialog" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
