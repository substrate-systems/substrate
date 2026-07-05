"use client";

import { useEffect, useRef, useState } from "react";

const INSTALL_CMD = "pip install exomem";
const MONO = "var(--font-mono-exo)";
const STD_EASE = "cubic-bezier(0.33,1,0.68,1)";

/**
 * Copies `pip install exomem` to the clipboard and shows a transient " · copied"
 * for 1.6s. Two visual forms:
 *  - "cta": the hero's secondary call-to-action, a full pill showing the command.
 *  - "terminal": the small "copy" affordance in the install card header.
 */
export default function CopyButton({
  variant,
}: {
  variant: "cta" | "terminal";
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = () => {
    try {
      void navigator.clipboard?.writeText(INSTALL_CMD);
    } catch {
      /* clipboard may be unavailable (insecure context) — the command is visible */
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  };

  if (variant === "terminal") {
    return (
      <button
        type="button"
        onClick={copy}
        aria-label="Copy install command"
        style={{
          background: "none",
          border: "none",
          padding: "4px 6px",
          cursor: "pointer",
          fontFamily: MONO,
          fontSize: "11px",
          color: "var(--fg-tertiary)",
          transition: `color 200ms ${STD_EASE}`,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--fg-primary)")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--fg-tertiary)")}
      >
        copy{copied ? " · copied" : ""}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label="Copy install command"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "10px",
        background: "var(--bg-elevated)",
        color: "var(--fg-secondary)",
        border: "1px solid var(--exo-border-input)",
        fontFamily: MONO,
        fontSize: "13px",
        fontWeight: 400,
        padding: "12px 18px",
        borderRadius: "8px",
        cursor: "pointer",
        transition: `border-color 200ms ${STD_EASE}, color 200ms ${STD_EASE}`,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "rgba(236,233,226,0.28)";
        e.currentTarget.style.color = "var(--fg-primary)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--exo-border-input)";
        e.currentTarget.style.color = "var(--fg-secondary)";
      }}
    >
      <span style={{ color: "var(--fg-tertiary)" }}>$</span> pip install exomem
      <span style={{ fontSize: "11px", color: "var(--fg-tertiary)" }}>
        {copied ? " · copied" : ""}
      </span>
    </button>
  );
}
