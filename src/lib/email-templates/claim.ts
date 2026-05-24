/**
 * Email templates for the Hosted Backup anonymous-buyer claim flow.
 *
 * Plaintext-first: every template's `textContent` reads cleanly on its own
 * (no "see HTML version"). The HTML mirrors the text with inline styles to
 * match the existing license-key email convention (no external assets, no
 * stylesheets). Tone matches license-key.ts: direct, founder-voiced, no
 * marketing fluff.
 */

const SITE_BASE_URL =
  process.env.NEXT_PUBLIC_SITE_BASE_URL ?? 'https://substratesystems.io';
const DOWNLOAD_URL = `${SITE_BASE_URL}/download`;

export type RenderedEmail = {
  subject: string;
  htmlContent: string;
  textContent: string;
};

export type ClaimEmailInput = {
  email: string;
  token: string;
};

export type FyiEmailInput = {
  email: string;
  plan: 'monthly' | 'yearly' | string | null;
  currentPeriodEnd: string | null;
};

export type FounderDigestInput = {
  pendingClaims: Array<{
    email: string;
    createdAt: string;
    paddleCustomerId: string | null;
  }>;
};

export function renderClaimEmail({
  token,
}: ClaimEmailInput): RenderedEmail {
  return renderClaimEmailVariant(token, {
    intro:
      'Thanks for buying Endstate Hosted Backup. One short step to finish setting up: claim your account.',
  });
}

export function renderResendClaimEmail({
  token,
}: ClaimEmailInput): RenderedEmail {
  return renderClaimEmailVariant(token, {
    intro:
      'A reminder — your Endstate Hosted Backup subscription is waiting to be claimed. Tap the button below or paste the code into Endstate.',
  });
}

function renderClaimEmailVariant(
  token: string,
  opts: { intro: string },
): RenderedEmail {
  const claimUrl = `${SITE_BASE_URL}/endstate/claim/${encodeURIComponent(token)}`;
  const code = formatCodeFromToken(token);
  const subject = 'Claim your Endstate Hosted Backup subscription';

  const htmlContent = `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #111; max-width: 560px; margin: 0 auto; padding: 32px; background: #ffffff;">
    <p style="font-size: 16px; line-height: 1.6; margin: 0 0 16px;">${escapeHtml(opts.intro)}</p>
    <p style="font-size: 14px; line-height: 1.6; color: #333; margin: 0 0 20px;">
      <a href="${claimUrl}" style="display: inline-block; background: #111; color: #fff; text-decoration: none; padding: 12px 22px; border-radius: 6px; font-weight: 600;">Claim your subscription</a>
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #333; margin: 0 0 8px;">Or paste this code into Endstate after installing:</p>
    <pre style="background: #f4f4f5; border: 1px solid #e4e4e7; border-radius: 6px; padding: 16px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 14px; letter-spacing: 0.05em; margin: 0 0 20px; text-align: center; font-weight: 600;">${escapeHtml(code)}</pre>
    <p style="font-size: 14px; line-height: 1.6; color: #333; margin: 0 0 16px;">Don&rsquo;t have Endstate yet? <a href="${DOWNLOAD_URL}" style="color: #2563eb; text-decoration: underline;">Download it here</a> &mdash; the local product is free, your subscription unlocks Hosted Backup.</p>
    <p style="font-size: 13px; line-height: 1.6; color: #666; margin: 0 0 16px;">Your link expires in 30 days. If it expires, reply to this email and we&rsquo;ll send a fresh one.</p>
    <p style="font-size: 14px; line-height: 1.6; color: #111; margin: 24px 0 0;">&mdash; Hugo, Substrate Systems</p>
  </body>
</html>`;

  const textContent = `${opts.intro}

Claim your subscription: ${claimUrl}

Or paste this code into Endstate after installing:

  ${code}

Don't have Endstate yet? Download it here: ${DOWNLOAD_URL}
The local product is free; your subscription unlocks Hosted Backup.

Your link expires in 30 days. If it expires, reply to this email and we'll send a fresh one.

— Hugo, Substrate Systems`;

  return { subject, htmlContent, textContent };
}

export function renderFyiEmail({
  plan,
  currentPeriodEnd,
}: FyiEmailInput): RenderedEmail {
  const subject = 'Hosted Backup added to your Endstate account';
  const cadence = cadenceLabel(plan);
  const renewalLine = currentPeriodEnd
    ? `It renews on ${formatDate(currentPeriodEnd)}.`
    : '';

  const htmlContent = `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #111; max-width: 560px; margin: 0 auto; padding: 32px; background: #ffffff;">
    <p style="font-size: 16px; line-height: 1.6; margin: 0 0 16px;">A Hosted Backup subscription (${escapeHtml(cadence)}) has been added to your Endstate account.</p>
    ${renewalLine ? `<p style="font-size: 14px; line-height: 1.6; color: #333; margin: 0 0 16px;">${escapeHtml(renewalLine)}</p>` : ''}
    <p style="font-size: 14px; line-height: 1.6; color: #333; margin: 0 0 16px;">Your existing account credentials are unchanged — sign in to Endstate the same way you always do, and Hosted Backup is now available.</p>
    <p style="font-size: 13px; line-height: 1.6; color: #666; margin: 0 0 16px;">Didn&rsquo;t make this purchase? Reply to this email and we&rsquo;ll sort it out.</p>
    <p style="font-size: 14px; line-height: 1.6; color: #111; margin: 24px 0 0;">&mdash; Hugo, Substrate Systems</p>
  </body>
</html>`;

  const textContent = `A Hosted Backup subscription (${cadence}) has been added to your Endstate account.

${renewalLine ? `${renewalLine}\n\n` : ''}Your existing account credentials are unchanged — sign in to Endstate the same way you always do, and Hosted Backup is now available.

Didn't make this purchase? Reply to this email and we'll sort it out.

— Hugo, Substrate Systems`;

  return { subject, htmlContent, textContent };
}

export function renderFounderDigest({
  pendingClaims,
}: FounderDigestInput): RenderedEmail {
  const subject = `[Endstate] ${pendingClaims.length} unclaimed Hosted Backup ${pendingClaims.length === 1 ? 'subscription' : 'subscriptions'} (14d+)`;
  const rows = pendingClaims
    .map(
      (c) =>
        `  - ${c.email} | created ${c.createdAt} | paddle_customer_id ${c.paddleCustomerId ?? '(none)'}`,
    )
    .join('\n');

  const htmlRows = pendingClaims
    .map(
      (c) =>
        `<tr><td style="padding: 4px 12px 4px 0; font-family: ui-monospace, monospace; font-size: 12px;">${escapeHtml(c.email)}</td><td style="padding: 4px 12px 4px 0; font-family: ui-monospace, monospace; font-size: 12px; color: #666;">${escapeHtml(c.createdAt)}</td><td style="padding: 4px 0; font-family: ui-monospace, monospace; font-size: 12px; color: #666;">${escapeHtml(c.paddleCustomerId ?? '(none)')}</td></tr>`,
    )
    .join('');

  const htmlContent = `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #111; max-width: 720px; margin: 0 auto; padding: 24px;">
    <p style="font-size: 14px; line-height: 1.5; margin: 0 0 12px;">These Hosted Backup subscriptions have been unclaimed for 14+ days. Reach out, refund, or extend the grace as appropriate.</p>
    <table cellspacing="0" cellpadding="0" style="border-collapse: collapse;">${htmlRows}</table>
  </body>
</html>`;

  const textContent = `These Hosted Backup subscriptions have been unclaimed for 14+ days. Reach out, refund, or extend the grace as appropriate.

${rows}`;

  return { subject, htmlContent, textContent };
}

// Format a 43-char URL-safe base64 token as a copy-friendly grouped code.
// We expose the first ~16 chars in 4-char groups so it's easy to type if
// someone is bridging from a different device. The full token is in the
// URL; the code is a convenience fallback.
function formatCodeFromToken(token: string): string {
  const cleaned = token.replace(/[^A-Za-z0-9_-]/g, '');
  const head = cleaned.slice(0, 16).toUpperCase();
  return head.match(/.{1,4}/g)?.join('-') ?? head;
}

function cadenceLabel(plan: string | null | undefined): string {
  if (plan === 'monthly' || plan === 'yearly') return plan;
  // Fall back to a generic noun when the plan ID is a Paddle pri_ value.
  return 'subscription';
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
