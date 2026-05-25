'use client';

import { useState } from 'react';

const c = {
  bg: '#0c0c0c',
  text: '#e8e8e8',
  textSec: '#999',
  border: '#2a2a2a',
  teal: '#2dd4bf',
};

const MONO_FAMILY =
  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export function ClaimCopyButton({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt('Copy the claim code:', token);
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'stretch',
        flexWrap: 'wrap',
      }}
    >
      <code
        style={{
          flex: '1 1 320px',
          fontFamily: MONO_FAMILY,
          fontSize: '0.95rem',
          fontWeight: 500,
          color: c.text,
          background: 'rgba(0,0,0,0.35)',
          border: `1px solid ${c.border}`,
          borderRadius: 8,
          padding: '18px 20px',
          textAlign: 'left',
          wordBreak: 'break-all',
          lineHeight: 1.5,
          userSelect: 'all',
        }}
      >
        {token}
      </code>
      <button
        type="button"
        onClick={onCopy}
        style={{
          background: copied ? 'rgba(45, 212, 191, 0.15)' : 'transparent',
          color: copied ? c.teal : c.text,
          border: `1px solid ${copied ? 'rgba(45,212,191,0.4)' : c.border}`,
          padding: '14px 22px',
          borderRadius: 8,
          fontSize: '0.9rem',
          fontWeight: 500,
          fontFamily: 'inherit',
          cursor: 'pointer',
          transition:
            'background 160ms ease, color 160ms ease, border-color 160ms ease',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          width={14}
          height={14}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ opacity: 0.7 }}
        >
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        {copied ? 'Copied' : 'Copy code'}
      </button>
    </div>
  );
}

export function OpenInEndstateButton({ token }: { token: string }) {
  const href = `endstate://claim?token=${encodeURIComponent(token)}`;
  return (
    <a
      href={href}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        background: c.text,
        color: c.bg,
        padding: '14px 24px',
        borderRadius: 8,
        fontSize: '0.95rem',
        fontWeight: 600,
        textDecoration: 'none',
      }}
    >
      Open in Endstate
      <span aria-hidden="true" style={{ display: 'inline-block', transform: 'translateY(-1px)' }}>
        →
      </span>
    </a>
  );
}
