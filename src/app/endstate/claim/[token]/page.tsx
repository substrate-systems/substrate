import type { Metadata } from 'next';
import Link from 'next/link';
import { verifyClaimToken } from '@/lib/hosted-backup/claim-tokens';
import { Nav, EndstateFooter } from '../../_shared';
import { ClaimCopyButton, OpenInEndstateButton } from './ClaimClient';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Claim your Hosted Backup · Endstate',
  description: 'Finish setting up your Endstate Hosted Backup subscription.',
  robots: { index: false, follow: false },
};

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
};

const FONT_FAMILY =
  "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const MONO_FAMILY =
  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

type VerifyResult = Awaited<ReturnType<typeof verifyClaimToken>>;

// In development, tokens starting with `preview-` render a synthetic valid
// result so the design can be iterated against without seeding the DB. This
// branch is dead in production (NODE_ENV check ensures it).
function devPreviewResult(token: string): VerifyResult | null {
  if (process.env.NODE_ENV !== 'development') return null;
  if (!token.startsWith('preview-')) return null;
  const kind = token.slice('preview-'.length);
  const baseRow = {
    token_hash: new Uint8Array(32),
    user_id: 'preview-user',
    email: 'buyer@example.com',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    consumed_at: null,
    resend_count: 0,
    last_sent_at: new Date().toISOString(),
    founder_alerted_at: null,
  };
  if (kind === 'success') return { kind: 'valid', row: baseRow };
  if (kind === 'expired') return { kind: 'expired', row: baseRow };
  if (kind === 'consumed') return { kind: 'consumed', row: baseRow };
  if (kind === 'invalid') return { kind: 'invalid' };
  return null;
}

type Props = {
  params: Promise<{ token: string }>;
};

export default async function ClaimPage({ params }: Props) {
  const { token } = await params;
  const result = devPreviewResult(token) ?? (await verifyClaimToken(token));

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link
        href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=JetBrains+Mono:wght@400;500&display=swap"
        rel="stylesheet"
      />
      <main
        style={{
          background: c.bg,
          minHeight: '100vh',
          color: c.text,
          fontFamily: FONT_FAMILY,
          WebkitFontSmoothing: 'antialiased',
        }}
      >
        <Nav />
        {result.kind === 'valid' ? (
          <SuccessState token={token} email={result.row.email} />
        ) : result.kind === 'expired' ? (
          <ErrorState
            heading="Claim link has expired"
            body={
              <>
                Claim links expire 30 days after the purchase. Reply to the
                email we sent you, or{' '}
                <MailLink subject="Hosted Backup claim link expired" /> and
                we&rsquo;ll mint a fresh one.
              </>
            }
          />
        ) : result.kind === 'consumed' ? (
          <ErrorState
            heading="This link has already been used"
            body={
              <>
                If you successfully signed in to Endstate, you&rsquo;re all set
                — your Hosted Backup is active. If you can&rsquo;t sign in,{' '}
                <MailLink subject="Hosted Backup claim already used" />.
              </>
            }
          />
        ) : (
          <ErrorState
            heading="Claim link not recognized"
            body={
              <>
                This link doesn&rsquo;t match any claim on file. It may have
                been mistyped or already used. If you just paid and didn&rsquo;t
                get an email,{' '}
                <MailLink subject="Hosted Backup claim link" /> and we&rsquo;ll
                sort it out.
              </>
            }
          />
        )}
        <EndstateFooter />
      </main>
    </>
  );
}

function SuccessState({ token, email }: { token: string; email: string }) {
  return (
    <section style={{ padding: '120px 24px 96px' }}>
      <div style={{ maxWidth: 880, margin: '0 auto' }}>
        <Eyebrow>Claim verified</Eyebrow>
        <h1
          style={{
            fontSize: 'clamp(2.2rem, 4vw, 3rem)',
            fontWeight: 600,
            letterSpacing: '-0.035em',
            lineHeight: 1.05,
            marginBottom: 18,
          }}
        >
          Welcome to Hosted Backup.
        </h1>
        <p
          style={{
            fontSize: '1.125rem',
            color: c.textSec,
            lineHeight: 1.55,
            maxWidth: 560,
            marginBottom: 56,
          }}
        >
          Your subscription for{' '}
          <span
            style={{
              color: c.text,
              fontWeight: 500,
              borderBottom: '1px dashed rgba(232,232,232,0.25)',
              paddingBottom: 1,
            }}
          >
            {email}
          </span>{' '}
          is ready. Two short steps and you&rsquo;re backing up.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <StepCard featured number="01 — YOUR CLAIM CODE" heading="Copy this, paste it into Endstate.">
            <p
              style={{
                fontSize: '0.95rem',
                color: c.textSec,
                lineHeight: 1.6,
                maxWidth: 580,
                marginBottom: 20,
              }}
            >
              Endstate uses this code once to attach your subscription to a
              fresh local account. It expires in 30 days. You won&rsquo;t need
              it again after setup.
            </p>
            <ClaimCopyButton token={token} />
          </StepCard>

          <StepCard number="02 — OPEN ENDSTATE" heading="If you already have it installed.">
            <p
              style={{
                fontSize: '0.95rem',
                color: c.textSec,
                lineHeight: 1.6,
                maxWidth: 580,
                marginBottom: 20,
              }}
            >
              One tap opens Endstate with your code pre-filled. On the
              sign-in screen, finish the recovery key setup and you&rsquo;re
              in.
            </p>
            <div
              style={{
                display: 'flex',
                gap: 12,
                flexWrap: 'wrap',
                alignItems: 'center',
              }}
            >
              <OpenInEndstateButton token={token} />
              <Link
                href="/download"
                style={{
                  color: c.textSec,
                  fontSize: '0.9rem',
                  borderBottom: '1px solid rgba(153,153,153,0.25)',
                  paddingBottom: 1,
                  textDecoration: 'none',
                }}
              >
                or download Endstate first
              </Link>
            </div>
          </StepCard>
        </div>

        <p
          style={{
            marginTop: 48,
            textAlign: 'center',
            fontSize: '0.85rem',
            color: c.textMuted,
          }}
        >
          Trouble signing in?{' '}
          <a
            href="mailto:founder@substratesystems.io?subject=Hosted%20Backup%20claim%20help"
            style={{
              color: c.textSec,
              borderBottom: `1px solid rgba(153,153,153,0.3)`,
              textDecoration: 'none',
            }}
          >
            Email founder@substratesystems.io
          </a>
        </p>
      </div>
    </section>
  );
}

function ErrorState({
  heading,
  body,
}: {
  heading: string;
  body: React.ReactNode;
}) {
  return (
    <section style={{ padding: '120px 24px 96px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <Eyebrow tone="muted">Claim status</Eyebrow>
        <h1
          style={{
            fontSize: 'clamp(1.8rem, 3vw, 2.4rem)',
            fontWeight: 600,
            letterSpacing: '-0.03em',
            lineHeight: 1.1,
            marginBottom: 18,
          }}
        >
          {heading}
        </h1>
        <p
          style={{
            fontSize: '1rem',
            color: c.textSec,
            lineHeight: 1.6,
            maxWidth: 560,
            marginBottom: 28,
          }}
        >
          {body}
        </p>
        <Link
          href="/endstate"
          style={{
            color: c.textSec,
            fontSize: '0.9rem',
            borderBottom: '1px solid rgba(153,153,153,0.3)',
            paddingBottom: 1,
            textDecoration: 'none',
          }}
        >
          ← Back to Endstate
        </Link>
      </div>
    </section>
  );
}

function Eyebrow({
  children,
  tone = 'accent',
}: {
  children: React.ReactNode;
  tone?: 'accent' | 'muted';
}) {
  const accent = tone === 'accent';
  return (
    <span
      style={{
        display: 'inline-block',
        fontFamily: MONO_FAMILY,
        fontSize: '0.7rem',
        fontWeight: 500,
        color: accent ? c.copper : c.textSec,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        padding: '6px 12px',
        border: `1px solid ${accent ? 'rgba(200,121,65,0.3)' : c.border}`,
        background: accent ? 'rgba(200,121,65,0.06)' : 'transparent',
        borderRadius: 4,
        marginBottom: 24,
      }}
    >
      {children}
    </span>
  );
}

function StepCard({
  number,
  heading,
  children,
  featured = false,
}: {
  number: string;
  heading: string;
  children: React.ReactNode;
  featured?: boolean;
}) {
  return (
    <section
      style={{
        background: featured
          ? 'linear-gradient(180deg, rgba(45,212,191,0.04), rgba(34,197,94,0.015))'
          : c.card,
        border: featured
          ? '1px solid rgba(45,212,191,0.25)'
          : `1px solid ${c.border}`,
        borderRadius: 10,
        padding: '28px 32px',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {featured && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            background: `linear-gradient(90deg, ${c.teal}, ${c.green})`,
          }}
        />
      )}
      <div
        style={{
          fontFamily: MONO_FAMILY,
          fontSize: '0.72rem',
          fontWeight: 500,
          color: c.copper,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          marginBottom: 12,
        }}
      >
        {number}
      </div>
      <h3
        style={{
          fontSize: '1.35rem',
          fontWeight: 600,
          letterSpacing: '-0.015em',
          marginBottom: 8,
        }}
      >
        {heading}
      </h3>
      {children}
    </section>
  );
}

function MailLink({ subject }: { subject: string }) {
  return (
    <a
      href={`mailto:founder@substratesystems.io?subject=${encodeURIComponent(subject)}`}
      style={{
        color: c.teal,
        borderBottom: '1px solid rgba(45,212,191,0.3)',
        textDecoration: 'none',
      }}
    >
      email founder@substratesystems.io
    </a>
  );
}
