"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/exomem/Button";
import { ThemeToggle } from "@/components/exomem/ThemeToggle";
import { Wordmark } from "@/components/exomem/Wordmark";
import {
  friendlyHostedError,
  HostedBrowserError,
  postPrivateJson,
  takeFragmentToken,
} from "@/lib/exomem-hosted/hosted-browser";
import home from "../home/home.module.css";
import styles from "./delete.module.css";

type State = "checking" | "ready" | "deleting" | "pending" | "error";

// The page the deletion email opens. No board draws it: it keeps the current page's
// words and steps, set in the Exomem system.
export default function DeleteClient() {
  const startedRef = useRef(false);
  const tokenRef = useRef<string | null>(null);
  const [state, setState] = useState<State>("checking");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    // The link carries its one-time token in the fragment; read it once, then clear it.
    const token = takeFragmentToken();
    tokenRef.current = token;
    queueMicrotask(() => {
      if (token) {
        setState("ready");
      } else {
        setMessage("This deletion link is incomplete or has expired.");
        setState("error");
      }
    });
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
    <>
      <header className={home.header}>
        <span className={home.wordmark}>
          <Wordmark />
        </span>
        <span className={home.headerEnd}>
          <ThemeToggle align="end" />
        </span>
      </header>
      <section className={`${home.column} ${styles.column}`} aria-labelledby="delete-title">
        <span className={styles.label}>Permanent action</span>
        <h1 className={home.headline} id="delete-title">
          Delete your Exomem?
        </h1>
        {state === "pending" ? (
          <>
            <p className={styles.text}>
              Deletion is in progress. Access is closed while the vault, its backups and exports,
              storage, and encryption keys are verified as removed.
            </p>
            <p className={styles.status} role="status">
              Your shared Substrate identity and any other product remain untouched.
            </p>
          </>
        ) : (
          <>
            <p className={styles.text}>
              This permanently removes your Cloud memory vault, its files, exports, and encryption
              keys. It does not delete your shared Substrate identity or unrelated products.
            </p>
            <div>
              <Button
                variant="primary"
                size="page"
                working={state === "deleting"}
                disabled={state !== "ready" && state !== "deleting"}
                onClick={() => void confirm()}
              >
                {state === "deleting" ? "Starting deletion…" : "Permanently delete my Exomem"}
              </Button>
            </div>
            <p
              className={styles.status}
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
    </>
  );
}
