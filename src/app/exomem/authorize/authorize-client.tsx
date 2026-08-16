"use client";

import { Fragment, FormEvent, ReactNode, useState } from "react";
import { friendlyHostedError, postPublicJson } from "@/lib/exomem-hosted/hosted-browser";
import styles from "../private-shell.module.css";
import { ConsentSection, consentSections } from "./consent-audience";
import { redeemInvitationUrl } from "./invite-resume";

type AuthorizeClientProps = {
  confirmation: string;
  nonce: string;
  signedIn: boolean;
  reviewerEnabled: boolean;
};

export default function AuthorizeClient({
  confirmation,
  nonce,
  signedIn,
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
      <form action="/api/exomem/oauth/authorize/complete" className="mt-8" method="post">
        <input name="nonce" type="hidden" value={nonce} />
        <input name="confirmation" type="hidden" value={confirmation} />
        <button className="rounded bg-black px-4 py-2 text-white" type="submit">
          Connect
        </button>
      </form>
    ),
    // Nobody pastes a URL into a form, and they do not have to: `redeem` mints
    // the authorization code itself when an OAuth continuation cookie is
    // present, so clicking the link in the invitation email IN THIS BROWSER
    // completes the connection with no return trip. Say that, rather than
    // asking for the link.
    "check-email": (
      <p className={styles.lede}>
        Open the Exomem invitation email on this device and click the link in it. Your Exomem will
        be created and this app connected in one step — you will not need to come back to this page.
      </p>
    ),
    "sign-in": (
      <p className={styles.status}>
        Already set up Exomem on another device? <a href="/exomem/sign-in">Sign in instead</a> — you
        will come straight back here.
      </p>
    ),
    // The paste path stays, demoted, for the one case the email link cannot
    // serve: the invitation opened in a different browser from the one the app
    // is connecting. That is rare, and it is not the headline.
    "paste-invitation": (
      <details className="mt-8">
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
            {redeemingInvitation ? "Setting up your Exomem…" : "Accept invitation and connect"}
          </button>
          <p
            className={`${styles.status} ${invitationError ? styles.error : ""}`}
            role={invitationError ? "alert" : undefined}
            aria-live="polite"
          >
            {invitationError || "The whole address from the email, including the part after the #."}
          </p>
        </form>
      </details>
    ),
    // Reviewer credentials are an internal marketplace-review path, not a
    // user-facing one. Behind a disclosure so an invited person never sees a
    // username and password field they are supposed to ignore: on 2026-08-16 it
    // sat above the invitation field, which is the one they needed.
    reviewer: (
      <details className="mt-10">
        <summary className={styles.status} style={{ cursor: "pointer" }}>
          Reviewer access
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
  };

  return (
    <>
      {consentSections({ signedIn, reviewerEnabled }).map((section) => (
        <Fragment key={section}>{blocks[section]}</Fragment>
      ))}
    </>
  );
}
