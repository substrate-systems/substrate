'use client';

import { useState } from 'react';

const c = {
  text: '#e8e8e8',
  textSec: '#999',
  border: '#2a2a2a',
  teal: '#2dd4bf',
};

export function ClaimCopyButton({
  code,
  token,
}: {
  code: string;
  token: string;
}) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      // Copy the full token (what the GUI needs), not the truncated display
      // code. The display code is just a friendlier preview.
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Fallback for browsers that block clipboard access: select-and-prompt.
      window.prompt('Copy the claim code:', token);
    }
  }

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <code
        style={{
          flex: '1 1 240px',
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: '1.1rem',
          fontWeight: 600,
          letterSpacing: '0.08em',
          background: 'rgba(255,255,255,0.04)',
          border: `1px solid ${c.border}`,
          borderRadius: 6,
          padding: '12px 16px',
          textAlign: 'center',
          color: c.text,
          userSelect: 'all',
        }}
      >
        {code}
      </code>
      <button
        type="button"
        onClick={onCopy}
        style={{
          background: copied ? 'rgba(45, 212, 191, 0.15)' : 'transparent',
          color: copied ? c.teal : c.text,
          border: `1px solid ${copied ? 'rgba(45,212,191,0.4)' : c.border}`,
          padding: '10px 16px',
          borderRadius: 6,
          fontSize: '0.9rem',
          fontWeight: 500,
          cursor: 'pointer',
          transition: 'background 120ms ease, color 120ms ease, border-color 120ms ease',
        }}
      >
        {copied ? 'Copied' : 'Copy code'}
      </button>
    </div>
  );
}

export function OpenInEndstateButton({ token }: { token: string }) {
  // endstate://claim?token=... is the URL scheme the GUI registers via Tauri
  // deep-links. If Endstate isn't installed nothing happens (the browser
  // silently no-ops on unknown schemes); the user falls back to the paste-code
  // path below.
  const href = `endstate://claim?token=${encodeURIComponent(token)}`;
  return (
    <a
      href={href}
      style={{
        display: 'inline-block',
        background: c.text,
        color: '#0c0c0c',
        padding: '12px 22px',
        borderRadius: 6,
        fontSize: '0.95rem',
        fontWeight: 600,
        textDecoration: 'none',
      }}
    >
      Open in Endstate
    </a>
  );
}
