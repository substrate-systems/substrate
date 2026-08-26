"use client";

import { useEffect, useRef, useState } from "react";
import {
  friendlyHostedError,
  HostedBrowserError,
  postPrivateJson,
  takeFragmentToken,
} from "@/lib/exomem-hosted/hosted-browser";
import styles from "../private-shell.module.css";

type State = "checking" | "ready" | "deleting" | "pending" | "error";

export default function DeleteClient() {
  const startedRef = useRef(false);
  const tokenRef = useRef<string | null>(null);
  const [state, setState] = useState<State>("checking");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    tokenRef.current = takeFragmentToken();
    if (!tokenRef.current) {
      setMessage("This deletion link is incomplete or has expired.");
      setState("error");
      return;
    }
    setState("ready");
  }, []);

  async function confirm() {
    if (!tokenRef.current || state !== "ready") return;
    setState("deleting");
    try {
      await postPrivateJson("/api/exomem/deletion/confirm", { token: tokenRef.current });
      tokenRef.current = null;
      setState("pending");
    } catch (error) {
      setMessage(
        error instanceof HostedBrowserError && error.status === 401
          ? "Sign in to Exomem on this device, then request a fresh deletion email."
          : friendlyHostedError(error)
      );
      setState("error");
    }
  }

  return (
    <section className={styles.card} aria-labelledby="delete-title">
      <p className={styles.eyebrow}>Permanent action</p>
      <h1 className={styles.title} id="delete-title">
        Delete your Exomem?
      </h1>
      {state === "pending" ? (
        <>
          <p className={styles.lede}>
            Deletion is in progress. Access is closed while the vault, hosted exports, storage, and
            encryption keys are verified as removed.
          </p>
          <p className={styles.status} role="status">
            You can close this page. We&apos;ll email you when deletion is complete. Your shared
            Substrate identity and any other product remain untouched.
          </p>
        </>
      ) : (
        <>
          <p className={styles.lede}>
            This permanently removes your hosted memory vault, its files, exports, and encryption
            keys. It does not delete your shared Substrate identity or unrelated products.
          </p>
          <div className={styles.form}>
            <button
              className={styles.dangerButton}
              type="button"
              onClick={confirm}
              disabled={state !== "ready"}
            >
              {state === "deleting" ? "Starting deletion…" : "Permanently delete my Exomem"}
            </button>
          </div>
          <p
            className={`${styles.status} ${state === "error" ? styles.error : ""}`}
            role={state === "error" ? "alert" : undefined}
            aria-live="polite"
          >
            {state === "checking"
              ? "Checking this one-time confirmation…"
              : state === "error"
                ? message
                : "There is no undo after you confirm."}
          </p>
        </>
      )}
    </section>
  );
}
