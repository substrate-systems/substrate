'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { AccountSnapshot } from './page';

const c = {
  bg: '#0c0c0c',
  card: '#1a1a1a',
  border: '#2a2a2a',
  text: '#e8e8e8',
  textSec: '#999',
  textMuted: '#666',
  teal: '#2dd4bf',
  green: '#22c55e',
  copper: '#c87941',
  amber: '#f59e0b',
  red: '#ef4444',
};

const MONO_FAMILY =
  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

type Tone = 'positive' | 'warning' | 'danger' | 'neutral';

function statusVisual(status: AccountSnapshot['subscriptionStatus']): {
  tone: Tone;
  label: string;
} {
  switch (status) {
    case 'active':
      return { tone: 'positive', label: 'Active' };
    case 'grace':
      return { tone: 'warning', label: 'Renewal failed' };
    case 'paused':
      return { tone: 'warning', label: 'Paused' };
    case 'cancelled':
      return { tone: 'danger', label: 'Cancelled' };
    case 'none':
    default:
      return { tone: 'neutral', label: 'No subscription' };
  }
}

function toneColor(tone: Tone): string {
  switch (tone) {
    case 'positive':
      return c.green;
    case 'warning':
      return c.amber;
    case 'danger':
      return c.red;
    case 'neutral':
    default:
      return c.textSec;
  }
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return null;
  }
}

export function AccountView({ snapshot }: { snapshot: AccountSnapshot }) {
  const { tone, label } = statusVisual(snapshot.subscriptionStatus);
  const accent = toneColor(tone);
  const periodEnd = formatDate(snapshot.currentPeriodEnd);
  const graceEnd = formatDate(snapshot.gracePeriodEndsAt);

  return (
    <section style={{ padding: '120px 24px 96px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <Eyebrow>Account portal</Eyebrow>
        <h1
          style={{
            fontSize: 'clamp(2.2rem, 4vw, 3rem)',
            fontWeight: 600,
            letterSpacing: '-0.035em',
            lineHeight: 1.05,
            marginBottom: 14,
          }}
        >
          Your Hosted Backup subscription.
        </h1>
        <p
          style={{
            fontSize: '1.05rem',
            color: c.textSec,
            lineHeight: 1.55,
            marginBottom: 40,
          }}
        >
          Signed in as{' '}
          <span
            style={{
              color: c.text,
              fontWeight: 500,
              borderBottom: '1px dashed rgba(232,232,232,0.25)',
              paddingBottom: 1,
            }}
          >
            {snapshot.email}
          </span>
          .
        </p>

        <StatusCard
          tone={tone}
          accent={accent}
          label={label}
          plan={snapshot.plan ?? 'Hosted Backup'}
          status={snapshot.subscriptionStatus}
          periodEnd={periodEnd}
          graceEnd={graceEnd}
          hasPaddleCustomer={snapshot.hasPaddleCustomer}
        />

        <RecoveryKeyReminder />

        <DangerZone />
      </div>
    </section>
  );
}

function StatusCard(props: {
  tone: Tone;
  accent: string;
  label: string;
  plan: string;
  status: AccountSnapshot['subscriptionStatus'];
  periodEnd: string | null;
  graceEnd: string | null;
  hasPaddleCustomer: boolean;
}) {
  // Tonal background + border + top stripe, scaled to the state's accent.
  // Mirrors the `StepCard` pattern from /endstate/claim/[token] (featured
  // variant) so /account inherits the same visual vocabulary.
  const rgb = hexToRgbTriplet(props.accent);
  const tinted = rgb
    ? `linear-gradient(180deg, rgba(${rgb},0.04), rgba(${rgb},0.015))`
    : c.card;
  const tintedBorder = rgb ? `1px solid rgba(${rgb},0.25)` : `1px solid ${c.border}`;

  return (
    <section
      style={{
        background: tinted,
        border: tintedBorder,
        borderRadius: 10,
        padding: '28px 32px',
        position: 'relative',
        overflow: 'hidden',
        marginBottom: 24,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          background: props.accent,
        }}
      />
      <div
        style={{
          fontFamily: MONO_FAMILY,
          fontSize: '0.72rem',
          fontWeight: 500,
          color: props.accent,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          marginBottom: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <span
          style={{
            display: 'inline-block',
            width: 6,
            height: 6,
            borderRadius: 999,
            background: props.accent,
            flexShrink: 0,
          }}
        />
        {props.label}
      </div>
      <h3
        style={{
          fontSize: '1.35rem',
          fontWeight: 600,
          letterSpacing: '-0.015em',
          marginBottom: 8,
          color: c.text,
        }}
      >
        {props.plan}
      </h3>

      <DateLine status={props.status} periodEnd={props.periodEnd} graceEnd={props.graceEnd} />

      <PrimaryAction status={props.status} hasPaddleCustomer={props.hasPaddleCustomer} />
    </section>
  );
}

// Hex `#rrggbb` → `r,g,b` (CSS rgba() body). Returns null on unsupported
// shapes so callers can fall back gracefully.
function hexToRgbTriplet(hex: string): string | null {
  const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return null;
  return `${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)}`;
}

function DateLine({
  status,
  periodEnd,
  graceEnd,
}: {
  status: AccountSnapshot['subscriptionStatus'];
  periodEnd: string | null;
  graceEnd: string | null;
}) {
  let text: string | null = null;
  if (status === 'active' && periodEnd) {
    text = `Renews ${periodEnd}.`;
  } else if (status === 'grace' && graceEnd) {
    text = `Backups remain readable through ${graceEnd}. Update your card to keep pushing new versions.`;
  } else if (status === 'cancelled' && periodEnd) {
    text = `Cancelled. Existing backups remain accessible through ${periodEnd}.`;
  } else if (status === 'paused') {
    text = 'Subscription paused. Resume in Paddle to push new versions.';
  } else if (status === 'none') {
    text = 'No active subscription. Start one to back up to the cloud.';
  }
  if (!text) return null;
  return (
    <p
      style={{
        fontSize: '0.95rem',
        color: c.textSec,
        lineHeight: 1.55,
        marginBottom: 20,
      }}
    >
      {text}
    </p>
  );
}

function PrimaryAction({
  status,
  hasPaddleCustomer,
}: {
  status: AccountSnapshot['subscriptionStatus'];
  hasPaddleCustomer: boolean;
}) {
  const needsPortal = status === 'active' || status === 'grace' || status === 'paused';
  const needsCheckout = status === 'cancelled' || status === 'none';

  if (needsPortal) {
    return <ManageInPaddleButton disabled={!hasPaddleCustomer} />;
  }
  if (needsCheckout) {
    const label = status === 'cancelled' ? 'Resubscribe' : 'Subscribe';
    return <ResubscribeButton label={label} />;
  }
  return null;
}

function ManageInPaddleButton({ disabled }: { disabled: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<React.ReactNode | null>(null);
  async function go() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/billing/portal', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const code = body?.error?.code ?? `HTTP_${res.status}`;
        setError(
          code === 'PADDLE_PORTAL_UNAVAILABLE' ? (
            <>
              We don&rsquo;t have a payment record on file yet —{' '}
              <FounderMailLink subject="Hosted Backup billing update" /> if you
              need to update billing.
            </>
          ) : (
            "We couldn't open Paddle's billing portal. Try again in a moment."
          ),
        );
        return;
      }
      const body = (await res.json()) as { portalUrl?: string };
      if (!body.portalUrl) {
        setError('Paddle returned an unexpected response.');
        return;
      }
      window.location.href = body.portalUrl;
    } catch {
      setError("We couldn't reach Paddle. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div>
      <PrimaryButton onClick={go} disabled={disabled || pending} label={pending ? 'Opening…' : 'Manage in Paddle'} />
      {disabled && (
        <p style={{ fontSize: '0.85rem', color: c.textMuted, marginTop: 10 }}>
          Paddle doesn&rsquo;t have a customer record for this account yet. This usually means your first
          payment is still processing — try again in a few minutes.
        </p>
      )}
      {error && (
        <p style={{ fontSize: '0.85rem', color: c.amber, marginTop: 10 }}>{error}</p>
      )}
    </div>
  );
}

function ResubscribeButton({ label }: { label: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setPending(true);
    setError(null);
    try {
      // Cookie-authenticated sibling of /api/billing/checkout. The
      // bearer-auth route stays for the engine path; the web page uses
      // /web-checkout so the session cookie is honored. See route handler
      // for the auth-surface rationale.
      const res = await fetch('/api/billing/web-checkout', { method: 'POST' });
      if (!res.ok) {
        setError("We couldn't open checkout. Try again in a moment.");
        return;
      }
      const body = (await res.json()) as { checkoutUrl?: string };
      if (!body.checkoutUrl) {
        setError('Checkout returned an unexpected response.');
        return;
      }
      window.location.href = body.checkoutUrl;
    } catch {
      setError("We couldn't reach checkout. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div>
      <PrimaryButton onClick={go} disabled={pending} label={pending ? 'Opening…' : label} />
      {error && (
        <p style={{ fontSize: '0.85rem', color: c.amber, marginTop: 10 }}>{error}</p>
      )}
    </div>
  );
}

function PrimaryButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  // Light-on-dark primary CTA, matching the `OpenInEndstateButton` style on
  // /endstate/claim. Keeps the page's accent palette restrained — the status
  // card already carries the state colour; the button itself is identity-neutral.
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        appearance: 'none',
        border: 'none',
        background: disabled ? c.border : c.text,
        color: disabled ? c.textMuted : c.bg,
        fontFamily: 'inherit',
        fontSize: '0.95rem',
        fontWeight: 600,
        padding: '14px 24px',
        borderRadius: 8,
        cursor: disabled ? 'not-allowed' : 'pointer',
        letterSpacing: '-0.005em',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      {label}
    </button>
  );
}

function RecoveryKeyReminder() {
  return (
    <aside
      style={{
        background: 'rgba(200,121,65,0.05)',
        border: '1px solid rgba(200,121,65,0.2)',
        borderRadius: 10,
        padding: '20px 24px',
        marginBottom: 32,
      }}
    >
      <div
        style={{
          fontFamily: MONO_FAMILY,
          fontSize: '0.7rem',
          fontWeight: 500,
          color: c.copper,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          marginBottom: 8,
        }}
      >
        Recovery key
      </div>
      <p style={{ fontSize: '0.95rem', color: c.textSec, lineHeight: 1.55, margin: 0 }}>
        Your 24-word recovery key is the only way to recover your backups if you forget your
        passphrase. Endstate cannot recover it for you — keep your saved file or printout
        somewhere safe.
      </p>
    </aside>
  );
}

function DangerZone() {
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<React.ReactNode | null>(null);

  async function signOut() {
    setPending(true);
    setError(null);
    try {
      await fetch('/api/account/session/logout', { method: 'POST' });
      window.location.href = '/endstate';
    } catch {
      setError("We couldn't sign you out cleanly. Close this tab to end the session.");
    } finally {
      setPending(false);
    }
  }

  async function deleteAccount() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/account/web-delete', { method: 'POST' });
      if (!res.ok) {
        setError(
          <>
            We couldn&rsquo;t delete your account right now.{' '}
            <FounderMailLink subject="Hosted Backup account deletion" /> for help.
          </>,
        );
        return;
      }
      window.location.href = '/endstate?deleted=1';
    } catch {
      setError("We couldn't reach the server. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      style={{
        borderTop: `1px solid ${c.border}`,
        paddingTop: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <button
        type="button"
        onClick={signOut}
        disabled={pending}
        style={{
          alignSelf: 'flex-start',
          appearance: 'none',
          background: 'transparent',
          border: `1px solid ${c.border}`,
          color: c.textSec,
          fontFamily: 'inherit',
          fontSize: '0.9rem',
          padding: '10px 16px',
          borderRadius: 8,
          cursor: pending ? 'not-allowed' : 'pointer',
        }}
      >
        Sign out
      </button>

      {confirming ? (
        <div
          style={{
            background: 'rgba(239,68,68,0.04)',
            border: '1px solid rgba(239,68,68,0.25)',
            borderRadius: 8,
            padding: '14px 16px',
            marginTop: 6,
          }}
        >
          <p style={{ fontSize: '0.9rem', color: c.text, marginBottom: 12, lineHeight: 1.5 }}>
            Delete your account? Your subscription will be cancelled and all backed-up data will
            be purged within 24 hours. This cannot be undone.
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              type="button"
              onClick={deleteAccount}
              disabled={pending}
              style={{
                appearance: 'none',
                background: 'rgba(239,68,68,0.12)',
                border: '1px solid rgba(239,68,68,0.35)',
                color: c.red,
                fontFamily: 'inherit',
                fontSize: '0.9rem',
                padding: '8px 14px',
                borderRadius: 6,
                cursor: pending ? 'not-allowed' : 'pointer',
              }}
            >
              {pending ? 'Deleting…' : 'Yes, delete account'}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={pending}
              style={{
                appearance: 'none',
                background: 'transparent',
                border: `1px solid ${c.border}`,
                color: c.textSec,
                fontFamily: 'inherit',
                fontSize: '0.9rem',
                padding: '8px 14px',
                borderRadius: 6,
                cursor: pending ? 'not-allowed' : 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={pending}
          style={{
            alignSelf: 'flex-start',
            appearance: 'none',
            background: 'transparent',
            border: `1px solid rgba(239,68,68,0.35)`,
            color: c.red,
            fontFamily: 'inherit',
            fontSize: '0.9rem',
            padding: '10px 16px',
            borderRadius: 8,
            cursor: pending ? 'not-allowed' : 'pointer',
          }}
        >
          Delete account…
        </button>
      )}

      {error && (
        <p style={{ fontSize: '0.85rem', color: c.amber, marginTop: 4 }}>{error}</p>
      )}

      <p style={{ fontSize: '0.8rem', color: c.textMuted, marginTop: 4 }}>
        Trouble?{' '}
        <Link
          href="mailto:founder@substratesystems.io"
          style={{
            color: c.textSec,
            borderBottom: '1px solid rgba(153,153,153,0.3)',
            textDecoration: 'none',
          }}
        >
          Email founder@substratesystems.io
        </Link>
        .
      </p>
    </section>
  );
}

function FounderMailLink({ subject }: { subject: string }) {
  return (
    <a
      href={`mailto:founder@substratesystems.io?subject=${encodeURIComponent(subject)}`}
      style={{
        color: c.textSec,
        borderBottom: '1px solid rgba(153,153,153,0.3)',
        textDecoration: 'none',
      }}
    >
      email founder@substratesystems.io
    </a>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: 'inline-block',
        fontFamily: MONO_FAMILY,
        fontSize: '0.7rem',
        fontWeight: 500,
        color: c.copper,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        padding: '6px 12px',
        border: '1px solid rgba(200,121,65,0.3)',
        background: 'rgba(200,121,65,0.06)',
        borderRadius: 4,
        marginBottom: 24,
      }}
    >
      {children}
    </span>
  );
}
