"use client";

import { useState } from "react";

const MONO = "var(--font-mono-exo)";
const STD_EASE = "cubic-bezier(0.33,1,0.68,1)";

const TIERS = [
  { value: "", label: "friends cohort preference (optional)" },
  { value: "complimentary", label: "complimentary private alpha" },
  { value: "5", label: "~€5 / month if paid access opens" },
  { value: "10", label: "~€10 / month if paid access opens" },
  { value: "20", label: "€20+ / month if paid access opens" },
];

const isValidEmail = (v: string) => v.indexOf("@") >= 1 && v.indexOf(".") > v.indexOf("@");

/**
 * Friends-cohort access request. It POSTs the email and optional preference to
 * /api/exomem/interest (Brevo-backed) and confirms the request without promising
 * an invite. Validation is intentionally minimal for this private alpha flow.
 */
export default function HostedInterestForm() {
  const [email, setEmail] = useState("");
  const [tier, setTier] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [hint, setHint] = useState("");
  const [pending, setPending] = useState(false);

  const focusAmber = (e: { currentTarget: HTMLElement }) => {
    e.currentTarget.style.borderColor = "var(--exo-amber)";
  };
  const blurBorder = (e: { currentTarget: HTMLElement }) => {
    e.currentTarget.style.borderColor = "var(--exo-border-input)";
  };

  const register = async () => {
    const value = email.trim();
    if (!isValidEmail(value)) {
      setHint("Enter a valid email so we can follow up about private alpha access.");
      return;
    }
    setPending(true);
    setHint("");
    try {
      const response = await fetch("/api/exomem/interest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: value, tier }),
      });
      if (!response.ok) {
        setHint("We couldn’t submit your request. Please try again.");
        return;
      }
      setSubmitted(true);
    } catch {
      setHint("We couldn’t submit your request. Please try again.");
    } finally {
      setPending(false);
    }
  };

  if (submitted) {
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
          <p style={{ margin: 0, color: "var(--fg-primary)" }}>Request received — thank you.</p>
          <p
            style={{
              margin: "6px 0 0",
              fontSize: "12px",
              color: "var(--fg-tertiary)",
              fontFamily: "var(--font-inter), system-ui, sans-serif",
              fontWeight: 300,
            }}
          >
            We&rsquo;ll follow up if there is room in the private alpha friends cohort.
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
            if (e.key === "Enter") void register();
          }}
          onFocus={focusAmber}
          onBlur={blurBorder}
          style={{
            flex: "1 1 220px",
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
        <select
          aria-label="Friends cohort preference. Optional."
          value={tier}
          onChange={(e) => setTier(e.target.value)}
          onFocus={focusAmber}
          onBlur={blurBorder}
          style={{
            flex: "1 1 200px",
            background: "var(--bg-elevated)",
            border: "1px solid var(--exo-border-input)",
            borderRadius: "8px",
            padding: "12px 14px",
            fontFamily: MONO,
            fontSize: "12.5px",
            color: "var(--fg-secondary)",
            cursor: "pointer",
            transition: `border-color 200ms ${STD_EASE}`,
          }}
        >
          {TIERS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void register()}
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
          Request an invite
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
