"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import {
  friendlyHostedError,
  postPublicJson,
  takeFragmentToken,
} from "@/lib/exomem-hosted/hosted-browser";
import styles from "../private-shell.module.css";

type SignInMode = "checking" | "form" | "sending" | "sent" | "confirm" | "redeeming" | "error";

export default function SignInClient() {
  const startedRef = useRef(false);
  const tokenRef = useRef<string | null>(null);
  const [mode, setMode] = useState<SignInMode>("checking");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");

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
    setMode("sending");
    setMessage("");
    try {
      await postPublicJson("/api/exomem/access/magic-link", { email });
      setMode("sent");
    } catch (error) {
      setMessage(friendlyHostedError(error));
      setMode("error");
    }
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
        <>
          <p className={styles.lede}>
            Check your email. If that address has an Exomem, a private sign-in link is on its way.
          </p>
          <p className={styles.status}>You can close this page.</p>
        </>
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
