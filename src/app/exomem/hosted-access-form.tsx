"use client";

import { useState } from "react";

const MONO = "var(--font-mono-exo)";
const STD_EASE = "cubic-bezier(0.33,1,0.68,1)";

const isValidEmail = (v: string) => v.indexOf("@") >= 1 && v.indexOf(".") > v.indexOf("@");

type Outcome = { kind: "idle" } | { kind: "submitted" };

/** Friends-only alpha interest capture; invitation remains operator-issued. */
export default function HostedAccessForm() {
  const [email, setEmail] = useState("");
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const [hint, setHint] = useState("");
  const [pending, setPending] = useState(false);

  const focusAmber = (e: { currentTarget: HTMLElement }) => {
    e.currentTarget.style.borderColor = "var(--exo-amber)";
  };
  const blurBorder = (e: { currentTarget: HTMLElement }) => {
    e.currentTarget.style.borderColor = "var(--exo-border-input)";
  };

  const request = async () => {
    const value = email.trim();
    if (!isValidEmail(value)) {
      setHint("Enter a valid email to express interest.");
      return;
    }
    setPending(true);
    setHint("");
    try {
      const response = await fetch("/api/exomem/interest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: value }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean } | null;
      if (!response.ok || !body) {
        setHint(
          response.status === 429
            ? "Too many attempts. Try again a little later."
            : "We couldn’t complete that. Please try again."
        );
        return;
      }
      setOutcome({ kind: "submitted" });
    } catch {
      setHint("We couldn’t complete that. Please try again.");
    } finally {
      setPending(false);
    }
  };

  if (outcome.kind !== "idle") {
    return (
      <div
        style={{
          marginTop: "28px",
          display: "flex",
          alignItems: "baseline",
          gap: "12px",
          fontFamily: MONO,
          fontSize: "13px",
        }}
      >
        <span aria-hidden="true" style={{ color: "var(--exo-amber)" }}>
          ✓
        </span>
        <div>
          <p style={{ margin: 0, color: "var(--fg-primary)" }}>
            We’ll be in touch if there’s a fit.
          </p>
          <p
            style={{
              margin: "6px 0 0",
              fontSize: "12px",
              color: "var(--fg-tertiary)",
              fontFamily: "var(--font-inter), system-ui, sans-serif",
              fontWeight: 300,
            }}
          >
            This is an interest request, not an automatic invitation. Exomem is free and open source
            if you’d rather run it yourself today.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        marginTop: "28px",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: "12px" }}>
        <input
          type="email"
          aria-label="Email address"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setHint("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void request();
          }}
          onFocus={focusAmber}
          onBlur={blurBorder}
          style={{
            flex: "1 1 260px",
            minWidth: 0,
            background: "var(--bg-elevated)",
            border: "1px solid var(--exo-border-input)",
            borderRadius: "8px",
            padding: "12px 16px",
            fontFamily: MONO,
            fontSize: "13px",
            color: "var(--fg-primary)",
            transition: `border-color 200ms ${STD_EASE}`,
          }}
        />
        <button
          type="button"
          onClick={() => void request()}
          disabled={pending}
          style={{
            flex: "none",
            background: "var(--fg-primary)",
            color: "var(--bg-base)",
            border: "none",
            borderRadius: "8px",
            padding: "12px 22px",
            fontFamily: MONO,
            fontSize: "13px",
            fontWeight: 500,
            cursor: pending ? "default" : "pointer",
            opacity: pending ? 0.6 : 1,
            transition: `opacity 200ms ${STD_EASE}`,
          }}
          onMouseEnter={(e) => {
            if (!pending) e.currentTarget.style.opacity = "0.88";
          }}
          onMouseLeave={(e) => {
            if (!pending) e.currentTarget.style.opacity = "1";
          }}
        >
          {pending ? "Sending…" : "Express interest"}
        </button>
      </div>
      <p
        aria-live="polite"
        style={{
          margin: 0,
          fontSize: "12px",
          fontWeight: 300,
          color: "var(--fg-tertiary)",
          minHeight: "16px",
        }}
      >
        {hint}
      </p>
    </div>
  );
}
