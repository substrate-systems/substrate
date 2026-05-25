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
    eyebrow: 'Still here for you',
    headline: 'Your subscription is waiting.',
    intro:
      'Just a friendly nudge — your Hosted Backup subscription is ready to claim. Tap the button or paste the code into Endstate.',
  });
}

function renderClaimEmailVariant(
  token: string,
  opts: { intro: string; eyebrow?: string; headline?: string },
): RenderedEmail {
  const claimUrl = `${SITE_BASE_URL}/endstate/claim/${encodeURIComponent(token)}`;
  const code = formatCodeFromToken(token);
  const subject = "You're in. Here's your Hosted Backup claim link.";
  const eyebrow = opts.eyebrow ?? 'Welcome';
  const headline = opts.headline ?? "You're in.";

  // Email-safe (works in Gmail, Apple Mail, Outlook desktop): table-based
  // outer frame, inline styles, system fonts only, no flexbox/grid/web
  // fonts. The teal→green top bar + dark code block carry the Endstate
  // brand without depending on any client-side asset loading.
  const htmlContent = `<!doctype html>
<html>
  <body style="margin: 0; padding: 0; background: #f4f4f5;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #f4f4f5;">
      <tr>
        <td align="center" style="padding: 32px 16px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width: 560px; width: 100%; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 2px rgba(0,0,0,0.04);">
            <!-- Top accent bar -->
            <tr>
              <td style="height: 4px; background: linear-gradient(90deg, #2dd4bf 0%, #22c55e 100%); line-height: 4px; font-size: 0;">&nbsp;</td>
            </tr>
            <tr>
              <td style="padding: 40px 40px 32px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #0c0c0c;">
                <!-- Eyebrow -->
                <p style="font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace; font-size: 11px; font-weight: 600; color: #c87941; letter-spacing: 0.18em; text-transform: uppercase; margin: 0 0 14px;">${escapeHtml(eyebrow)}</p>
                <!-- Headline -->
                <h1 style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 30px; font-weight: 700; letter-spacing: -0.025em; line-height: 1.1; margin: 0 0 14px; color: #0c0c0c;">${escapeHtml(headline)}</h1>
                <!-- Intro -->
                <p style="font-size: 16px; line-height: 1.55; color: #444; margin: 0 0 32px;">${escapeHtml(opts.intro)}</p>

                <!-- CTA — centered, auto-width -->
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                  <tr>
                    <td align="center">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                        <tr>
                          <td style="border-radius: 8px; background: #0c0c0c;">
                            <a href="${claimUrl}" style="display: inline-block; background: #0c0c0c; color: #ffffff; text-decoration: none; padding: 16px 28px; border-radius: 8px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-weight: 600; font-size: 15px;">Claim your subscription &rarr;</a>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>

                <!-- Code section -->
                <p style="font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace; font-size: 11px; font-weight: 500; color: #666; letter-spacing: 0.14em; text-transform: uppercase; margin: 36px 0 10px;">Or paste this code into Endstate</p>
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #0c0c0c; border-radius: 8px;">
                  <tr>
                    <td align="center" style="padding: 22px 16px; font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace; font-size: 20px; font-weight: 600; color: #ffffff; letter-spacing: 0.14em;">${escapeHtml(code)}</td>
                  </tr>
                </table>
                <p style="font-size: 13px; line-height: 1.55; color: #666; margin: 12px 0 32px;">On Endstate&rsquo;s sign-in screen, choose &ldquo;I have a claim code&rdquo; and paste it in.</p>

                <!-- Download -->
                <p style="font-size: 14px; line-height: 1.6; color: #444; margin: 0 0 6px;">Don&rsquo;t have Endstate yet?</p>
                <p style="font-size: 14px; line-height: 1.6; margin: 0 0 32px;"><a href="${DOWNLOAD_URL}" style="color: #0c0c0c; text-decoration: none; border-bottom: 1px solid #0c0c0c; padding-bottom: 1px;">Download it free</a> <span style="color: #888;">&mdash; the local product is free, your subscription unlocks Hosted Backup.</span></p>

                <!-- Divider -->
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                  <tr><td style="height: 1px; background: #eee; line-height: 1px; font-size: 0;">&nbsp;</td></tr>
                </table>

                <!-- Footer copy -->
                <p style="font-size: 13px; line-height: 1.55; color: #888; margin: 24px 0 16px;">Your link expires in 30 days. If it expires, just reply to this email and I&rsquo;ll send a fresh one.</p>
                <p style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; line-height: 1.55; color: #0c0c0c; margin: 0;">&mdash; Hugo, founder of Endstate</p>
              </td>
            </tr>
          </table>
          <!-- Brand mark below the card -->
          <p style="font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace; font-size: 11px; color: #aaa; letter-spacing: 0.12em; text-transform: uppercase; margin: 20px 0 0;">Endstate &middot; Substrate Systems</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const textContent = `${opts.intro}

▸ Claim your subscription:
  ${claimUrl}

Or paste this code into Endstate after installing:

  ${code}

On Endstate's sign-in screen, choose "I have a claim code" and paste it in.

Don't have Endstate yet? Download it free: ${DOWNLOAD_URL}
(The local product is free; your subscription unlocks Hosted Backup.)

Your link expires in 30 days. If it expires, just reply to this email and I'll send a fresh one.

— Hugo, Endstate
   Substrate Systems`;

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
  <body style="margin: 0; padding: 0; background: #f4f4f5;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #f4f4f5;">
      <tr>
        <td align="center" style="padding: 32px 16px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width: 560px; width: 100%; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 2px rgba(0,0,0,0.04);">
            <tr>
              <td style="height: 4px; background: linear-gradient(90deg, #2dd4bf 0%, #22c55e 100%); line-height: 4px; font-size: 0;">&nbsp;</td>
            </tr>
            <tr>
              <td style="padding: 40px 40px 32px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #0c0c0c;">
                <p style="font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace; font-size: 11px; font-weight: 600; color: #c87941; letter-spacing: 0.18em; text-transform: uppercase; margin: 0 0 14px;">Subscription added</p>
                <h1 style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 26px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.15; margin: 0 0 14px; color: #0c0c0c;">Hosted Backup is on your account.</h1>
                <p style="font-size: 16px; line-height: 1.55; color: #444; margin: 0 0 20px;">A ${escapeHtml(cadence)} subscription has been linked to your existing Endstate account.${renewalLine ? ' ' + escapeHtml(renewalLine) : ''}</p>
                <p style="font-size: 14px; line-height: 1.6; color: #444; margin: 0 0 24px;">Your credentials are unchanged. Sign in to Endstate the way you always do, and Hosted Backup is now available.</p>
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                  <tr><td style="height: 1px; background: #eee; line-height: 1px; font-size: 0;">&nbsp;</td></tr>
                </table>
                <p style="font-size: 13px; line-height: 1.55; color: #888; margin: 20px 0 16px;">Didn&rsquo;t make this purchase? Just reply &mdash; I&rsquo;ll sort it out.</p>
                <p style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; line-height: 1.55; color: #0c0c0c; margin: 0;">&mdash; Hugo, founder of Endstate</p>
              </td>
            </tr>
          </table>
          <p style="font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace; font-size: 11px; color: #aaa; letter-spacing: 0.12em; text-transform: uppercase; margin: 20px 0 0;">Endstate &middot; Substrate Systems</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const textContent = `A Hosted Backup subscription (${cadence}) has been added to your Endstate account.

${renewalLine ? `${renewalLine}\n\n` : ''}Your existing account credentials are unchanged — sign in to Endstate the same way you always do, and Hosted Backup is now available.

Didn't make this purchase? Reply to this email and I'll sort it out.

— Hugo, Endstate
   Substrate Systems`;

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
