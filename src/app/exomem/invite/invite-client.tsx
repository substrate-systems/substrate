"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  friendlyHostedError,
  HostedBrowserError,
  postPublicJson,
  takeFragmentToken,
} from "@/lib/exomem-hosted/hosted-browser";
import styles from "../private-shell.module.css";
import { inviteRefusal } from "./invite-refusal";

type InviteState =
  | { kind: "checking" }
  | { kind: "ready"; email: string; expiresAt: string }
  | { kind: "accepting"; email: string; expiresAt: string }
  // `retryable` decides which of two very different things went wrong. A spent
  // or malformed invitation needs a fresh link; a service that is not admitting
  // right now needs the same link, later. Telling someone to ask for a new link
  // while the response underneath says their invitation is still valid is the
  // page contradicting itself.
  | { kind: "error"; message: string; retryable: boolean };

function failure(error: unknown): InviteState {
  return {
    kind: "error",
    message: friendlyHostedError(error),
    retryable: error instanceof HostedBrowserError && error.retryable,
  };
}

export default function InviteClient() {
  const tokenRef = useRef<string | null>(null);
  const startedRef = useRef(false);
  const [state, setState] = useState<InviteState>({ kind: "checking" });
  // Held across a retryable failure so the same invitation can be offered again
  // without the person going back to their email.
  const acceptedRef = useRef<{ email: string; expiresAt: string } | null>(null);

  const inspect = useCallback(async () => {
    const token = tokenRef.current;
    if (!token) return;
    setState({ kind: "checking" });
    try {
      const result = await postPublicJson("/api/exomem/access/inspect", { token });
      if (typeof result.email !== "string" || typeof result.expiresAt !== "string") {
        throw new Error("invalid invite response");
      }
      acceptedRef.current = { email: result.email, expiresAt: result.expiresAt };
      setState({ kind: "ready", email: result.email, expiresAt: result.expiresAt });
    } catch (error) {
      setState(failure(error));
    }
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    tokenRef.current = takeFragmentToken();
    if (!tokenRef.current) {
      // No token means nothing to press again, which is why this refusal is the
      // one case declared non-retryable regardless of any envelope.
      setState({
        kind: "error",
        message: "This invite link is incomplete or has expired.",
        retryable: false,
      });
      return;
    }
    void inspect();
  }, [inspect]);

  /** Offer the same invitation again — from wherever it got as far as. */
  function retry() {
    const invitation = acceptedRef.current;
    if (!tokenRef.current) return;
    if (invitation) setState({ kind: "ready", ...invitation });
    else void inspect();
  }

  async function accept() {
    if (state.kind !== "ready" || !tokenRef.current) return;
    setState({ kind: "accepting", email: state.email, expiresAt: state.expiresAt });
    try {
      const result = await postPublicJson("/api/exomem/access/redeem", {
        token: tokenRef.current,
      });
      tokenRef.current = null;
      window.location.replace(
        typeof result.destination === "string" ? result.destination : "/exomem/home"
      );
    } catch (error) {
      setState(failure(error));
    }
  }

  return (
    <section className={styles.card} aria-labelledby="invite-title">
      <p className={styles.eyebrow}>Your private memory</p>
      <h1 className={styles.title} id="invite-title">
        Start your Exomem.
      </h1>
      {state.kind === "checking" ? (
        <>
          <p className={styles.lede}>Checking your private invitation…</p>
          <div className={styles.spinner} role="status" aria-label="Checking invite" />
        </>
      ) : state.kind === "error" ? (
        <>
          <p className={styles.lede}>{inviteRefusal(state.retryable).lede}</p>
          <p className={`${styles.status} ${styles.error}`} role="alert">
            {state.message}
          </p>
          {inviteRefusal(state.retryable).offerRetry ? (
            <div className={styles.form}>
              <button className={styles.button} type="button" onClick={retry}>
                Try again
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <p className={styles.lede}>
            Exomem keeps things you want to remember and helps you find them again. No setup,
            folders, or technical knowledge needed.
          </p>
          <span className={styles.boundEmail}>
            This invitation belongs to <strong>{state.email}</strong>
          </span>
          <div className={styles.form}>
            <button
              className={styles.button}
              type="button"
              onClick={accept}
              disabled={state.kind === "accepting"}
            >
              {state.kind === "accepting" ? "Creating your Exomem…" : "Accept invitation"}
            </button>
            <p className={styles.status} aria-live="polite">
              The link can be used once. Your browser will stay signed in on this device.
            </p>
          </div>
        </>
      )}
    </section>
  );
}
