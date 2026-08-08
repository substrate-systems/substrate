export type RenderedExomemAccessEmail = {
  subject: string;
  htmlContent: string;
  textContent: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderAccessEmail(input: {
  subject: string;
  introduction: string;
  actionLabel: string;
  accessUrl: string;
  expiryLabel: string;
}): RenderedExomemAccessEmail {
  const safeUrl = escapeHtml(input.accessUrl);
  const htmlContent = `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #171717; max-width: 560px; margin: 0 auto; padding: 32px; background: #ffffff;">
    <p style="font-size: 16px; line-height: 1.6; margin: 0 0 18px;">${escapeHtml(input.introduction)}</p>
    <p style="margin: 0 0 20px;"><a href="${safeUrl}" style="display: inline-block; background: #171717; color: #ffffff; text-decoration: none; padding: 11px 18px; border-radius: 7px; font-weight: 600;">${escapeHtml(input.actionLabel)}</a></p>
    <p style="font-size: 13px; line-height: 1.6; color: #525252; margin: 0 0 18px;">${escapeHtml(input.expiryLabel)} This link works once. If you did not request it, you can ignore this email.</p>
    <p style="font-size: 14px; line-height: 1.6; margin: 0;">— Exomem by Substrate Systems</p>
  </body>
</html>`;
  const textContent = `${input.introduction}

${input.actionLabel}: ${input.accessUrl}

${input.expiryLabel} This link works once. If you did not request it, you can ignore this email.

— Exomem by Substrate Systems`;
  return { subject: input.subject, htmlContent, textContent };
}

export function renderExomemInviteEmail(input: {
  accessUrl: string;
  expiresAt: Date;
}): RenderedExomemAccessEmail {
  return renderAccessEmail({
    subject: "Your Exomem invitation",
    introduction:
      "You have been invited to Exomem Hosted. Accept the invitation to create your private memory space.",
    actionLabel: "Accept invitation",
    accessUrl: input.accessUrl,
    expiryLabel: `This invitation expires ${input.expiresAt.toISOString()}.`,
  });
}

/**
 * Self-serve admission. Distinct from the operator invitation because nobody
 * invited them — they asked, capacity was free, and the next step is theirs.
 */
export function renderExomemWelcomeEmail(input: {
  accessUrl: string;
  expiresAt: Date;
}): RenderedExomemAccessEmail {
  return renderAccessEmail({
    subject: "Set up your Exomem",
    introduction:
      "Your place on Exomem Hosted is ready. Set it up to create your private memory space, then connect it to Claude or ChatGPT.",
    actionLabel: "Set up Exomem",
    accessUrl: input.accessUrl,
    expiryLabel: `This setup link expires ${input.expiresAt.toISOString()}.`,
  });
}

/**
 * No call to action on purpose: there is nothing for them to do, and a button
 * here would imply otherwise. Capacity is stated as the reason so the wait does
 * not read as a silent rejection.
 */
export function renderExomemWaitlistEmail(input: { position: number }): RenderedExomemAccessEmail {
  const introduction =
    input.position === 1
      ? "Thanks for asking about Exomem Hosted. Every place is currently taken, so you are first in line — we will email you as soon as one frees up. You have not been charged."
      : `Thanks for asking about Exomem Hosted. Every place is currently taken, so you are number ${input.position} in line — we will email you as soon as one frees up. You have not been charged.`;
  const htmlContent = `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #171717; max-width: 560px; margin: 0 auto; padding: 32px; background: #ffffff;">
    <p style="font-size: 16px; line-height: 1.6; margin: 0 0 18px;">${escapeHtml(introduction)}</p>
    <p style="font-size: 13px; line-height: 1.6; color: #525252; margin: 0 0 18px;">Exomem is also free and open source if you would rather run it yourself — there is no waiting for that.</p>
    <p style="font-size: 14px; line-height: 1.6; margin: 0;">— Exomem by Substrate Systems</p>
  </body>
</html>`;
  const textContent = `${introduction}

Exomem is also free and open source if you would rather run it yourself — there is no waiting for that.

— Exomem by Substrate Systems`;
  return { subject: "You are on the Exomem waitlist", htmlContent, textContent };
}

export function renderExomemMagicLinkEmail(input: {
  accessUrl: string;
  expiresAt: Date;
}): RenderedExomemAccessEmail {
  return renderAccessEmail({
    subject: "Sign in to Exomem",
    introduction: "Use this private link to sign in to your Exomem workspace.",
    actionLabel: "Sign in to Exomem",
    accessUrl: input.accessUrl,
    expiryLabel: `This sign-in link expires ${input.expiresAt.toISOString()}.`,
  });
}

export function renderExomemDeletionEmail(input: {
  accessUrl: string;
  expiresAt: Date;
}): RenderedExomemAccessEmail {
  return renderAccessEmail({
    subject: "Confirm deletion of your Exomem",
    introduction:
      "You asked to permanently delete your hosted Exomem. This removes the Exomem vault, hosted exports, and its encryption keys. It does not delete your shared Substrate identity or other products.",
    actionLabel: "Review and confirm deletion",
    accessUrl: input.accessUrl,
    expiryLabel: `This confirmation expires ${input.expiresAt.toISOString()}.`,
  });
}
