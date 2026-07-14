"use client";

import { useEffect, useRef, useState } from "react";
import {
  friendlyHostedError,
  postPublicJson,
  takeFragmentToken,
} from "@/lib/exomem-hosted/hosted-browser";
import styles from "../private-shell.module.css";

type InviteState =
  | { kind: "checking" }
  | { kind: "ready"; email: string; expiresAt: string }
  | { kind: "accepting"; email: string; expiresAt: string }
  | { kind: "error"; message: string };

export default function InviteClient() {
  const tokenRef = useRef<string | null>(null);
  const startedRef = useRef(false);
  const [state, setState] = useState<InviteState>({ kind: "checking" });

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const token = takeFragmentToken();
    tokenRef.current = token;
    if (!token) {
      setState({ kind: "error", message: "This invite link is incomplete or has expired." });
      return;
    }
    void postPublicJson("/api/exomem/access/inspect", { token })
      .then((result) => {
        if (typeof result.email !== "string" || typeof result.expiresAt !== "string") {
          throw new Error("invalid invite response");
        }
        setState({ kind: "ready", email: result.email, expiresAt: result.expiresAt });
      })
      .catch((error) => setState({ kind: "error", message: friendlyHostedError(error) }));
  }, []);

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
      setState({ kind: "error", message: friendlyHostedError(error) });
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
          <p className={styles.lede}>
            We could not open this invitation. Ask the person who invited you for a fresh link.
          </p>
          <p className={`${styles.status} ${styles.error}`} role="alert">
            {state.message}
          </p>
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
