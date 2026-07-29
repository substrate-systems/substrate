"use client";

import { FormEvent, useState } from "react";
import { friendlyHostedError, postPublicJson } from "@/lib/exomem-hosted/hosted-browser";
import styles from "../private-shell.module.css";
import { redeemInvitationUrl } from "./invite-resume";

type AuthorizeClientProps = {
  confirmation: string;
  nonce: string;
  reviewerEnabled: boolean;
};

export default function AuthorizeClient({
  confirmation,
  nonce,
  reviewerEnabled,
}: AuthorizeClientProps) {
  const [invitationUrl, setInvitationUrl] = useState("");
  const [redeemingInvitation, setRedeemingInvitation] = useState(false);
  const [invitationError, setInvitationError] = useState("");
  const [reviewerUsername, setReviewerUsername] = useState("");
  const [reviewerPassword, setReviewerPassword] = useState("");
  const [reviewerSubmitting, setReviewerSubmitting] = useState(false);
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
      window.location.assign(result.destination);
    } catch {
      setReviewerPassword("");
      setReviewerError("Reviewer sign-in failed. Check the credentials and try again.");
      setReviewerSubmitting(false);
    }
  }

  return (
    <>
      <form action="/api/exomem/oauth/authorize/complete" className="mt-8" method="post">
        <input name="nonce" type="hidden" value={nonce} />
        <input name="confirmation" type="hidden" value={confirmation} />
        <button className="rounded bg-black px-4 py-2 text-white" type="submit">
          Continue
        </button>
      </form>
      {reviewerEnabled ? (
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
          <button className={styles.quietButton} type="submit" disabled={reviewerSubmitting}>
            {reviewerSubmitting ? "Signing in…" : "Sign in as reviewer"}
          </button>
          <p
            className={`${styles.status} ${reviewerError ? styles.error : ""}`}
            role={reviewerError ? "alert" : undefined}
            aria-live="polite"
          >
            {reviewerError}
          </p>
        </form>
      ) : null}
      <form className={styles.form} noValidate onSubmit={useInvitation}>
        <label className={styles.label} htmlFor="exomem-invitation-url">
          Use your invitation
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
          {redeemingInvitation ? "Using invitation…" : "Use invitation"}
        </button>
        <p
          className={`${styles.status} ${invitationError ? styles.error : ""}`}
          role={invitationError ? "alert" : undefined}
          aria-live="polite"
        >
          {invitationError || "Paste the complete invitation link from your email."}
        </p>
      </form>
    </>
  );
}
