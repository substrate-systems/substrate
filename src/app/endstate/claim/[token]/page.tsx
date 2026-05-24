import type { Metadata } from 'next';
import Link from 'next/link';
import { verifyClaimToken } from '@/lib/hosted-backup/claim-tokens';
import { ClaimCopyButton, OpenInEndstateButton } from './ClaimClient';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Claim your Hosted Backup · Endstate',
  description: 'Finish setting up your Endstate Hosted Backup subscription.',
  robots: { index: false, follow: false },
};

// Palette is inlined here so this page doesn't pull in `_shared.tsx`'s
// 'use client' boundary. The /endstate landing's dynamic theme isn't
// appropriate for what is essentially a transactional confirmation page.
const c = {
  bg: '#0c0c0c',
  card: '#141414',
  border: '#2a2a2a',
  text: '#e8e8e8',
  textSec: '#999',
  textMuted: '#666',
  teal: '#2dd4bf',
  copper: '#c87941',
};

function formatCode(token: string): string {
  const cleaned = token.replace(/[^A-Za-z0-9_-]/g, '');
  const head = cleaned.slice(0, 16).toUpperCase();
  return head.match(/.{1,4}/g)?.join('-') ?? head;
}

type Props = {
  params: Promise<{ token: string }>;
};

export default async function ClaimPage({ params }: Props) {
  const { token } = await params;
  const result = await verifyClaimToken(token);

  const wrapperStyle: React.CSSProperties = {
    background: c.bg,
    minHeight: '100vh',
    color: c.text,
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  };
  const containerStyle: React.CSSProperties = {
    maxWidth: 560,
    margin: '0 auto',
    padding: '80px 24px 64px',
  };

  if (result.kind === 'invalid') {
    return (
      <main style={wrapperStyle}>
        <div style={containerStyle}>
          <h1
            style={{
              fontSize: '1.6rem',
              fontWeight: 600,
              letterSpacing: '-0.02em',
              marginBottom: 16,
            }}
          >
            Claim link not recognized
          </h1>
          <p
            style={{
              fontSize: '0.95rem',
              lineHeight: 1.6,
              color: c.textSec,
              marginBottom: 20,
            }}
          >
            This link doesn&rsquo;t match any claim on file. It may have been
            mistyped or already used. If you just paid and didn&rsquo;t get an
            email,{' '}
            <a
              href="mailto:founder@substratesystems.io?subject=Hosted%20Backup%20claim%20link"
              style={{ color: c.teal, textDecoration: 'underline' }}
            >
              email founder@substratesystems.io
            </a>{' '}
            and we&rsquo;ll sort it out.
          </p>
          <BackLink />
        </div>
      </main>
    );
  }

  if (result.kind === 'expired') {
    return (
      <main style={wrapperStyle}>
        <div style={containerStyle}>
          <h1
            style={{
              fontSize: '1.6rem',
              fontWeight: 600,
              letterSpacing: '-0.02em',
              marginBottom: 16,
            }}
          >
            Claim link has expired
          </h1>
          <p
            style={{
              fontSize: '0.95rem',
              lineHeight: 1.6,
              color: c.textSec,
              marginBottom: 20,
            }}
          >
            Claim links expire 30 days after the purchase. Reply to the email
            we sent you, or{' '}
            <a
              href="mailto:founder@substratesystems.io?subject=Hosted%20Backup%20claim%20link%20expired"
              style={{ color: c.teal, textDecoration: 'underline' }}
            >
              email founder@substratesystems.io
            </a>{' '}
            and we&rsquo;ll mint a fresh one.
          </p>
          <BackLink />
        </div>
      </main>
    );
  }

  if (result.kind === 'consumed') {
    return (
      <main style={wrapperStyle}>
        <div style={containerStyle}>
          <h1
            style={{
              fontSize: '1.6rem',
              fontWeight: 600,
              letterSpacing: '-0.02em',
              marginBottom: 16,
            }}
          >
            This link has already been used
          </h1>
          <p
            style={{
              fontSize: '0.95rem',
              lineHeight: 1.6,
              color: c.textSec,
              marginBottom: 20,
            }}
          >
            If you successfully signed in to Endstate, you&rsquo;re all set —
            your Hosted Backup is active. If you can&rsquo;t sign in,{' '}
            <a
              href="mailto:founder@substratesystems.io?subject=Hosted%20Backup%20claim%20already%20used"
              style={{ color: c.teal, textDecoration: 'underline' }}
            >
              email founder@substratesystems.io
            </a>
            .
          </p>
          <BackLink />
        </div>
      </main>
    );
  }

  const code = formatCode(token);

  return (
    <main style={wrapperStyle}>
      <div style={containerStyle}>
        <p
          style={{
            display: 'inline-block',
            fontSize: '0.7rem',
            fontWeight: 500,
            color: c.copper,
            fontFamily: "'JetBrains Mono', monospace",
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            padding: '0.25rem 0.6rem',
            border: '1px solid rgba(200,121,65,0.3)',
            background: 'rgba(200,121,65,0.05)',
            borderRadius: 4,
            marginBottom: 16,
          }}
        >
          Claim verified
        </p>
        <h1
          style={{
            fontSize: '1.8rem',
            fontWeight: 600,
            letterSpacing: '-0.02em',
            marginBottom: 12,
          }}
        >
          Welcome to Hosted Backup
        </h1>
        <p
          style={{
            fontSize: '1rem',
            lineHeight: 1.6,
            color: c.textSec,
            marginBottom: 28,
          }}
        >
          Your subscription for{' '}
          <span style={{ color: c.text, fontWeight: 500 }}>
            {result.row.email}
          </span>{' '}
          is ready. Open Endstate to finish setup.
        </p>

        <section
          style={{
            background: c.card,
            border: `1px solid ${c.border}`,
            borderRadius: 8,
            padding: 24,
            marginBottom: 20,
          }}
        >
          <p
            style={{
              fontSize: '0.85rem',
              color: c.textMuted,
              marginBottom: 16,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            One-tap (if Endstate is installed)
          </p>
          <OpenInEndstateButton token={token} />
        </section>

        <section
          style={{
            background: c.card,
            border: `1px solid ${c.border}`,
            borderRadius: 8,
            padding: 24,
            marginBottom: 20,
          }}
        >
          <p
            style={{
              fontSize: '0.85rem',
              color: c.textMuted,
              marginBottom: 12,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            Or paste this claim code into Endstate
          </p>
          <ClaimCopyButton code={code} token={token} />
          <p
            style={{
              fontSize: '0.8rem',
              color: c.textMuted,
              marginTop: 16,
              lineHeight: 1.5,
            }}
          >
            On Endstate&rsquo;s sign-in screen, choose{' '}
            <span style={{ color: c.textSec, fontWeight: 500 }}>
              I have a claim code
            </span>{' '}
            and paste this in. The code is short enough to type if you&rsquo;re
            bridging from another device.
          </p>
        </section>

        <section
          style={{
            background: c.card,
            border: `1px solid ${c.border}`,
            borderRadius: 8,
            padding: 24,
            marginBottom: 20,
          }}
        >
          <p
            style={{
              fontSize: '0.85rem',
              color: c.textMuted,
              marginBottom: 12,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            Don&rsquo;t have Endstate yet?
          </p>
          <Link
            href="/download"
            style={{
              display: 'inline-block',
              background: c.text,
              color: c.bg,
              padding: '10px 20px',
              borderRadius: 6,
              fontSize: '0.95rem',
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Download Endstate
          </Link>
          <p
            style={{
              fontSize: '0.8rem',
              color: c.textMuted,
              marginTop: 12,
              lineHeight: 1.5,
            }}
          >
            The local product is free. Your subscription unlocks Hosted Backup.
          </p>
        </section>

        <p
          style={{
            fontSize: '0.78rem',
            color: c.textMuted,
            textAlign: 'center',
            lineHeight: 1.6,
            marginTop: 32,
          }}
        >
          Trouble signing in?{' '}
          <a
            href="mailto:founder@substratesystems.io?subject=Hosted%20Backup%20claim%20help"
            style={{ color: c.textSec, textDecoration: 'underline' }}
          >
            Email founder@substratesystems.io
          </a>
        </p>
      </div>
    </main>
  );
}

function BackLink() {
  return (
    <Link
      href="/endstate"
      style={{
        display: 'inline-block',
        color: '#999',
        fontSize: '0.9rem',
        textDecoration: 'underline',
        textDecorationColor: 'rgba(153,153,153,0.3)',
      }}
    >
      ← Back to Endstate
    </Link>
  );
}
