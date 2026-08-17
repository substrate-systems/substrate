"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  friendlyHostedError,
  postPublicJson,
  takeFragmentToken,
} from "@/lib/exomem-hosted/hosted-browser";
import styles from "../private-shell.module.css";
import { RESEND_COOLDOWN_SECONDS, sentScreen } from "./sign-in-copy";

type SignInMode = "checking" | "form" | "sending" | "sent" | "confirm" | "redeeming" | "error";

export default function SignInClient() {
  const startedRef = useRef(false);
  const tokenRef = useRef<string | null>(null);
  const [mode, setMode] = useState<SignInMode>("checking");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const token = takeFragmentToken();
    if (!token) {
      setMode("form");
      return;
    }
    tokenRef.current = token;
    setMode("confirm");
  }, []);

  // Only ticks while the "sent" screen is holding a resend back.
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((left) => left - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  const sendLink = useCallback(async (address: string) => {
    setMode("sending");
    setMessage("");
    try {
      await postPublicJson("/api/exomem/access/magic-link", { email: address });
      setCooldown(RESEND_COOLDOWN_SECONDS);
      setMode("sent");
    } catch (error) {
      setMessage(friendlyHostedError(error));
      setMode("error");
    }
  }, []);

  function redeemLink() {
    if (!tokenRef.current || mode !== "confirm") return;
    setMode("redeeming");
    void postPublicJson("/api/exomem/access/magic-link/redeem", { token: tokenRef.current })
      .then((result) => {
        tokenRef.current = null;
        window.location.replace(
          typeof result.destination === "string" ? result.destination : "/exomem/home"
        );
      })
      .catch((error) => {
        setMessage(friendlyHostedError(error));
        setMode("error");
      });
  }

  async function requestLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await sendLink(email);
  }

  const busy = mode === "checking" || mode === "redeeming";
  return (
    <section className={styles.card} aria-labelledby="signin-title">
      <p className={styles.eyebrow}>Welcome back</p>
      <h1 className={styles.title} id="signin-title">
        Open your Exomem.
      </h1>
      {busy ? (
        <>
          <p className={styles.lede}>Signing you in…</p>
          <div className={styles.spinner} role="status" aria-label="Signing in" />
        </>
      ) : mode === "sent" ? (
        (() => {
          const screen = sentScreen(cooldown);
          return (
            <>
              <p className={styles.lede}>{screen.lede}</p>
              <p className={styles.status}>{screen.expiry}</p>
              <div className={styles.form}>
                <button
                  className={styles.button}
                  type="button"
                  disabled={screen.resendLabel === null}
                  onClick={() => void sendLink(email)}
                >
                  {screen.resendLabel ?? screen.waitingLabel}
                </button>
              </div>
            </>
          );
        })()
      ) : mode === "confirm" ? (
        <>
          <p className={styles.lede}>
            Continue only if you requested this sign-in link in this browser.
          </p>
          <div className={styles.form}>
            <button className={styles.button} type="button" onClick={redeemLink}>
              Continue sign-in
            </button>
          </div>
        </>
      ) : (
        <>
          <p className={styles.lede}>
            Enter the email address that received your invitation. We will send you a private,
            one-time sign-in link.
          </p>
          <form className={styles.form} onSubmit={requestLink}>
            <label className={styles.label} htmlFor="exomem-email">
              Email address
            </label>
            <input
              className={styles.input}
              id="exomem-email"
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <button className={styles.button} type="submit" disabled={mode === "sending"}>
              {mode === "sending" ? "Sending…" : "Email me a sign-in link"}
            </button>
          </form>
          <p
            className={`${styles.status} ${mode === "error" ? styles.error : ""}`}
            role={mode === "error" ? "alert" : undefined}
            aria-live="polite"
          >
            {mode === "error" ? message : "No password to remember."}
          </p>
        </>
      )}
    </section>
  );
}
