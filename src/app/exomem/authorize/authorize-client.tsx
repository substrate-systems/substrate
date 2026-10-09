"use client";

import { Fragment, FormEvent, ReactNode, useEffect, useState } from "react";
import {
  friendlyHostedError,
  HostedBrowserError,
  postPrivateJson,
  postPublicJson,
  settledCheckoutDestination,
} from "@/lib/exomem-hosted/hosted-browser";
import { usePaddle } from "@/lib/paddle";
import styles from "../private-shell.module.css";
import { ConsentSection, consentSections } from "./consent-audience";
import type { ConsentStep } from "./consent-state";
import { redeemInvitationUrl } from "./invite-resume";

type AuthorizeClientProps = {
  confirmation: string;
  nonce: string;
  step: ConsentStep;
  cellStarting: boolean;
  reviewerEnabled: boolean;
};

const SETTLE_ATTEMPTS = 10;
const SETTLE_INTERVAL_MS = 2000;

// After the Paddle overlay reports a completed payment, ask the server to settle
// the checkout. It answers with the next page: this consent page while the OAuth
// transaction is live, otherwise Home. Paddle can take a few seconds to mark the
// transaction complete, so this retries. Null means "reload this page": the
// payment webhook settled the account first, or the attempts ran out, and the
// server computes the next step from the account either way.
async function settleCheckout(transactionId: string): Promise<string | null> {
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
    let settledElsewhere = false;
    try {
      const destination = settledCheckoutDestination(
        await postPrivateJson("/api/exomem/billing/checkout", { transactionId })
      );
      if (destination) return destination;
    } catch (error) {
      // The checkout route refuses a transaction whose account already has its
      // provider customer, which is what the payment webhook records.
      settledElsewhere = error instanceof HostedBrowserError && error.status === 403;
    }
    await new Promise((resolve) => window.setTimeout(resolve, SETTLE_INTERVAL_MS));
    if (settledElsewhere) return null;
  }
  return null;
}

function SubscribeBlock() {
  const { completed, openTransactionCheckout } = usePaddle("transaction");
  const [transactionId, setTransactionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The overlay reported this page's payment as complete.
  const settling = completed && transactionId !== null;

  async function subscribe() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      // The same request Home's Subscribe button makes. The overlay opens here, so
      // the OAuth transaction this page belongs to stays in front of the visitor.
      const response = await postPrivateJson("/api/exomem/billing/checkout", {});
      const checkoutUrl = typeof response.checkoutUrl === "string" ? response.checkoutUrl : "";
      const transaction = checkoutUrl ? new URL(checkoutUrl).searchParams.get("_ptxn") : null;
      if (!transaction) throw new Error("missing checkout transaction");
      setTransactionId(transaction);
      if (!(await openTransactionCheckout(transaction))) {
        setError("Checkout could not open. Try again in a moment.");
      }
    } catch (caught) {
      setError(friendlyHostedError(caught));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!completed || !transactionId) return;
    let active = true;
    void settleCheckout(transactionId).then((destination) => {
      if (!active) return;
      if (destination) window.location.replace(destination);
      else window.location.reload();
    });
    return () => {
      active = false;
    };
  }, [completed, transactionId]);

  return (
    <div className={styles.form}>
      <button
        className={styles.button}
        type="button"
        onClick={() => void subscribe()}
        disabled={busy || settling}
      >
        {busy ? "Opening checkout…" : "Subscribe"}
      </button>
      <p
        className={`${styles.status} ${error ? styles.error : ""}`}
        role={error ? "alert" : undefined}
        aria-live="polite"
      >
        {settling
          ? "Payment received. Finishing setup…"
          : error ||
            "Paddle handles the payment. When it completes, this page moves on to Connect."}
      </p>
    </div>
  );
}

function ManageBillingButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function openPortal() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await postPrivateJson("/api/exomem/billing/portal", {});
      if (typeof response.portalUrl !== "string") throw new Error("missing billing destination");
      window.location.assign(response.portalUrl);
    } catch (caught) {
      setError(friendlyHostedError(caught));
      setBusy(false);
    }
  }

  return (
    <div className="mt-6">
      <button
        className={styles.quietButton}
        type="button"
        onClick={() => void openPortal()}
        disabled={busy}
      >
        {busy ? "Opening billing…" : "Manage billing"}
      </button>
      {error ? (
        <p className={`${styles.status} ${styles.error}`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default function AuthorizeClient({
  confirmation,
  nonce,
  step,
  cellStarting,
  reviewerEnabled,
}: AuthorizeClientProps) {
  const [invitationUrl, setInvitationUrl] = useState("");
  const [redeemingInvitation, setRedeemingInvitation] = useState(false);
  const [invitationError, setInvitationError] = useState("");
  const [reviewerUsername, setReviewerUsername] = useState("");
  const [reviewerPassword, setReviewerPassword] = useState("");
  const [reviewerSubmitting, setReviewerSubmitting] = useState(false);
  const [reviewerSignedIn, setReviewerSignedIn] = useState(false);
  const [reviewerError, setReviewerError] = useState("");

  async function useInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (redeemingInvitation) return;
    setRedeemingInvitation(true);
    setInvitationError("");
    try {
      const result = await redeemInvitationUrl(
        { invitationUrl, origin: window.location.origin },
        {
          clear: () => setInvitationUrl(""),
          post: postPublicJson,
          replace: (destination) => window.location.replace(destination),
        }
      );
      if (result === "invalid") {
        setInvitationError("Paste the complete invitation link from your email.");
        setRedeemingInvitation(false);
      }
    } catch (error) {
      setInvitationError(friendlyHostedError(error));
      setRedeemingInvitation(false);
    }
  }

  async function signInReviewer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (reviewerSubmitting) return;
    setReviewerSubmitting(true);
    setReviewerError("");
    try {
      const result = await postPublicJson("/api/exomem/access/reviewer", {
        username: reviewerUsername,
        password: reviewerPassword,
        nonce,
      });
      setReviewerPassword("");
      if (typeof result.destination !== "string" || !result.destination) {
        throw new Error("invalid reviewer authentication response");
      }
      // Say so before navigating. The redirect is the only signal a success used
      // to produce, so a slow one read as a dead button -- and the natural retry
      // then hit a failure the operator could not fix by re-typing anything.
      setReviewerSignedIn(true);
      window.location.assign(result.destination);
    } catch {
      setReviewerPassword("");
      setReviewerError(
        "Reviewer sign-in did not complete. If you have already signed in on this page, the connection request may have expired — start again from the client you are connecting."
      );
      setReviewerSubmitting(false);
    }
  }

  // Rendered from `consentSections` rather than inline conditionals, so the
  // order on screen is the order that module declares and cannot drift from
  // what its tests assert.
  const blocks: Record<ConsentSection, ReactNode> = {
    connect: (
      <>
        {cellStarting ? (
          <p className={styles.status}>
            Your Exomem is still starting. You can connect now, and its tools start working within a
            few minutes.
          </p>
        ) : null}
        <form action="/api/exomem/oauth/authorize/complete" className="mt-8" method="post">
          <input name="nonce" type="hidden" value={nonce} />
          <input name="confirmation" type="hidden" value={confirmation} />
          <button className="rounded bg-black px-4 py-2 text-white" type="submit">
            Connect
          </button>
        </form>
      </>
    ),
    // Sign-in returns here: the magic-link redemption reads this page's OAuth
    // cookie and sends the browser back to this consent page.
    "sign-in": (
      <div className={styles.form}>
        <a
          className={`${styles.button} inline-flex items-center justify-center no-underline`}
          href="/exomem/sign-in"
        >
          Sign in
        </a>
      </div>
    ),
    // Redeeming an invitation while this page's OAuth cookie is present continues
    // the connection: a complimentary invitation connects in the same step, and a
    // paid one returns here to subscribe first. The email link is the main path;
    // pasting serves the invitation opened in another browser.
    invitation: (
      <section className="mt-12">
        <h2 className="text-lg font-semibold">New here? Use your invitation</h2>
        <p className={styles.lede}>
          Open the Exomem invitation email on this device and click the link in it. With a
          complimentary invitation, this app connects in one step. If your invitation needs a
          subscription, you subscribe first and then come back here to connect.
        </p>
        <details className="mt-6">
          <summary className={styles.status} style={{ cursor: "pointer" }}>
            Cannot open the email on this device?
          </summary>
          <form className={styles.form} noValidate onSubmit={useInvitation}>
            <label className={styles.label} htmlFor="exomem-invitation-url">
              Paste your invitation link
            </label>
            <input
              className={styles.input}
              id="exomem-invitation-url"
              autoComplete="off"
              inputMode="url"
              spellCheck={false}
              type="url"
              value={invitationUrl}
              onChange={(event) => setInvitationUrl(event.target.value)}
            />
            <button className={styles.quietButton} type="submit" disabled={redeemingInvitation}>
              {redeemingInvitation ? "Setting up your Exomem…" : "Accept invitation"}
            </button>
            <p
              className={`${styles.status} ${invitationError ? styles.error : ""}`}
              role={invitationError ? "alert" : undefined}
              aria-live="polite"
            >
              {invitationError ||
                "The whole address from the email, including the part after the #."}
            </p>
          </form>
        </details>
      </section>
    ),
    // Reviewer credentials are an internal marketplace-review path, not a
    // user-facing one. Behind a disclosure so an invited person never sees a
    // username and password field they are supposed to ignore: on 2026-08-16 it
    // sat above the invitation field, which is the one they needed.
    reviewer: (
      <details className="mt-10">
        <summary className={styles.status} style={{ cursor: "pointer" }}>
          Reviewing Exomem for a directory?
        </summary>
        <form className={styles.form} noValidate onSubmit={signInReviewer}>
          <label className={styles.label} htmlFor="exomem-reviewer-username">
            Reviewer username
          </label>
          <input
            className={styles.input}
            id="exomem-reviewer-username"
            autoComplete="username"
            value={reviewerUsername}
            onChange={(event) => setReviewerUsername(event.target.value)}
          />
          <label className={styles.label} htmlFor="exomem-reviewer-password">
            Reviewer password
          </label>
          <input
            className={styles.input}
            id="exomem-reviewer-password"
            autoComplete="current-password"
            type="password"
            value={reviewerPassword}
            onChange={(event) => setReviewerPassword(event.target.value)}
          />
          <button
            className={styles.quietButton}
            type="submit"
            disabled={reviewerSubmitting || reviewerSignedIn}
          >
            {reviewerSignedIn
              ? "Signed in — continuing…"
              : reviewerSubmitting
                ? "Signing in…"
                : "Sign in as reviewer"}
          </button>
          <p
            className={`${styles.status} ${reviewerError ? styles.error : ""}`}
            role={reviewerError ? "alert" : undefined}
            aria-live="polite"
          >
            {reviewerSignedIn ? "Signed in. Taking you to the confirmation step…" : reviewerError}
          </p>
        </form>
      </details>
    ),
    subscribe: <SubscribeBlock />,
    "payment-failed": (
      <section className="mt-8">
        <p className={styles.lede} role="status">
          Your last payment failed, so Exomem is read-only until billing is fixed. You can still
          connect this app.
        </p>
        <ManageBillingButton />
      </section>
    ),
    ended: (
      <p className={styles.lede}>
        You can still export your data from <a href="/exomem/home">Home</a>. To subscribe again,{" "}
        <a href="/exomem/support">contact support</a>.
      </p>
    ),
    paused: (
      <section className="mt-8">
        <p className={styles.lede}>Resume your subscription in billing to use Exomem again.</p>
        <ManageBillingButton />
      </section>
    ),
    suspended: (
      <p className={styles.lede}>
        <a href="/exomem/support">Contact support</a> to restore access.
      </p>
    ),
  };

  return (
    <>
      {consentSections({ step, reviewerEnabled }).map((section) => (
        <Fragment key={section}>{blocks[section]}</Fragment>
      ))}
    </>
  );
}
