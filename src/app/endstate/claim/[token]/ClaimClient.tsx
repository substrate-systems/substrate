"use client";

import { Check, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { AnalyticsEvent, capture } from "@/lib/analytics";

const c = {
  bg: "#0c0c0c",
  text: "#e8e8e8",
  textSec: "#999",
  border: "#2a2a2a",
  teal: "#2dd4bf",
};

const MONO_FAMILY =
  "var(--font-jetbrains-mono), ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export function openClaimInEndstate(
  token: string,
  copy: (value: string) => Promise<void>,
  launch: (url: string) => void
) {
  try {
    void copy(token).catch(() => {});
  } catch {
    // Clipboard access is optional; the deep link remains the primary path.
  }

  // A website event about the website's own control. The local product carries
  // no telemetry, so observation ends at this boundary — nothing is threaded
  // into the deep link, and the token never becomes an event property.
  capture(AnalyticsEvent.ClaimHandoffOpened);

  launch(`endstate://claim?token=${encodeURIComponent(token)}`);
}

export function ClaimCopyButton({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    // Captured web-side only, and without the code itself — what is copied is
    // unchanged by this.
    capture(AnalyticsEvent.ClaimCodeCopied);
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt("Copy the claim code:", token);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        alignItems: "stretch",
        flexWrap: "wrap",
      }}
    >
      <code
        style={{
          flex: "1 1 320px",
          fontFamily: MONO_FAMILY,
          fontSize: "0.95rem",
          fontWeight: 500,
          color: c.text,
          background: "rgba(0,0,0,0.35)",
          border: `1px solid ${c.border}`,
          borderRadius: 8,
          padding: "18px 20px",
          textAlign: "left",
          wordBreak: "break-all",
          lineHeight: 1.5,
          userSelect: "all",
        }}
      >
        {token}
      </code>
      <button
        type="button"
        onClick={onCopy}
        style={{
          background: copied ? "rgba(45, 212, 191, 0.15)" : "transparent",
          color: copied ? c.teal : c.text,
          border: `1px solid ${copied ? "rgba(45,212,191,0.4)" : c.border}`,
          padding: "14px 22px",
          borderRadius: 8,
          fontSize: "0.9rem",
          fontWeight: 500,
          fontFamily: "inherit",
          cursor: "pointer",
          transition: "background 160ms ease, color 160ms ease, border-color 160ms ease",
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        {copied ? <Check aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />}
        {copied ? "Copied" : "Copy code"}
      </button>
    </div>
  );
}

export function OpenInEndstateButton({ token }: { token: string }) {
  function onOpen() {
    openClaimInEndstate(
      token,
      (value) => navigator.clipboard.writeText(value),
      (url) => {
        window.location.href = url;
      }
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        background: c.text,
        color: c.bg,
        padding: "14px 24px",
        borderRadius: 8,
        fontSize: "0.95rem",
        fontWeight: 600,
        fontFamily: "inherit",
        border: 0,
        cursor: "pointer",
      }}
    >
      <ExternalLink aria-hidden="true" size={16} />
      Open in Endstate
    </button>
  );
}
