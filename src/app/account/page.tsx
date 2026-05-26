import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { Nav, EndstateFooter } from '../endstate/_shared';
import { ACCOUNT_SESSION_COOKIE } from '@/lib/hosted-backup/browser-session';
import { resolveAccountSession } from '@/lib/hosted-backup/browser-session';
import {
  findUserById,
  getSubscriptionEntitlement,
} from '@/lib/hosted-backup/db';
import type { SubscriptionStatus } from '@/lib/hosted-backup/types';
import { AccountView } from './AccountView';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Your account · Endstate',
  description: 'Manage your Endstate Hosted Backup subscription.',
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
  copper: '#c87941',
};

const FONT_FAMILY =
  "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const MONO_FAMILY =
  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

type AccountSnapshot = {
  email: string;
  subscriptionStatus: SubscriptionStatus;
  plan: string | null;
  currentPeriodEnd: string | null;
  gracePeriodEndsAt: string | null;
  hasPaddleCustomer: boolean;
};

async function loadSnapshot(): Promise<AccountSnapshot | null> {
  const store = await cookies();
  const cookie = store.get(ACCOUNT_SESSION_COOKIE);
  if (!cookie?.value) return null;
  const resolved = await resolveAccountSession(cookie.value);
  if (!resolved) return null;
  const user = await findUserById(resolved.userId);
  if (!user) return null;
  const ent = await getSubscriptionEntitlement(user.id);
  return {
    email: user.email,
    subscriptionStatus: ent.effectiveStatus,
    plan: ent.plan,
    currentPeriodEnd: ent.currentPeriodEnd,
    gracePeriodEndsAt: ent.gracePeriodEndsAt,
    hasPaddleCustomer: !!ent.paddleCustomerId,
  };
}

type Props = {
  searchParams: Promise<{ error?: string }>;
};

export default async function AccountPage({ searchParams }: Props) {
  const { error } = await searchParams;
  const snapshot = error ? null : await loadSnapshot();

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
        {snapshot ? (
          <AccountView snapshot={snapshot} />
        ) : (
          <SessionErrorState code={error ?? 'NO_SESSION'} />
        )}
        <EndstateFooter />
      </main>
    </>
  );
}

function SessionErrorState({ code }: { code: string }) {
  const friendly = friendlyForCode(code);
  return (
    <section style={{ padding: '120px 24px 96px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <Eyebrow tone="muted">Account portal</Eyebrow>
        <h1
          style={{
            fontSize: 'clamp(1.8rem, 3vw, 2.4rem)',
            fontWeight: 600,
            letterSpacing: '-0.03em',
            lineHeight: 1.1,
            marginBottom: 18,
          }}
        >
          {friendly.heading}
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
          {friendly.body}
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

function friendlyForCode(code: string): { heading: string; body: string } {
  switch (code) {
    case 'BROWSER_SESSION_CONSUMED':
      return {
        heading: 'This account link has already been used.',
        body:
          'Open Endstate and click "Manage subscription" again to get a fresh link. Account portal links are single-use for security.',
      };
    case 'TOKEN_EXPIRED':
    case 'INVALID_TOKEN':
      return {
        heading: 'This account link is no longer valid.',
        body:
          'Account portal links expire after 60 seconds. Open Endstate and click "Manage subscription" again to get a fresh one.',
      };
    case 'ACCOUNT_SESSION_EXPIRED':
      return {
        heading: 'Your account session has expired.',
        body:
          'Sessions last an hour for your security. Open Endstate and click "Manage subscription" again to sign back in.',
      };
    default:
      return {
        heading: "We couldn't open your account portal.",
        body:
          'Open Endstate and click "Manage subscription" to start a fresh session. If this keeps happening, email founder@substratesystems.io.',
      };
  }
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

export type { AccountSnapshot };
