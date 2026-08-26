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

/**
 * How long the reader has, in words. This leads the expiry line because that is
 * the question they are actually asking; the instant only matters if they plan
 * to come back later.
 */
function relativeExpiry(expiresAt: Date, now: Date): string | null {
  const minutes = Math.round((expiresAt.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return null;
  if (minutes === 1) return "in 1 minute";
  if (minutes < 60) return `in ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours === 1) return "in 1 hour";
  if (hours < 48) return `in ${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? "in 1 day" : `in ${days} days`;
}

/**
 * Always UTC, always labelled. No recipient locale or time zone is collected
 * anywhere in the product, so an unlabelled timestamp would be inviting the
 * reader to misread it as their own local time.
 */
function absoluteExpiry(expiresAt: Date): string {
  const date = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(expiresAt);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(expiresAt);
  return `${date} at ${time} UTC`;
}

function expiryLabel(subject: string, expiresAt: Date, now: Date): string {
  const relative = relativeExpiry(expiresAt, now);
  const absolute = absoluteExpiry(expiresAt);
  return relative === null
    ? `${subject} expired on ${absolute}.`
    : `${subject} expires ${relative}, on ${absolute}.`;
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
  now?: Date;
}): RenderedExomemAccessEmail {
  return renderAccessEmail({
    subject: "Your Exomem invitation",
    introduction:
      "You have been invited to Exomem Hosted. Accept the invitation to create your private memory space.",
    actionLabel: "Accept invitation",
    accessUrl: input.accessUrl,
    expiryLabel: expiryLabel("This invitation", input.expiresAt, input.now ?? new Date()),
  });
}

/**
 * Self-serve admission. Distinct from the operator invitation because nobody
 * invited them — they asked, capacity was free, and the next step is theirs.
 */
export function renderExomemWelcomeEmail(input: {
  accessUrl: string;
  expiresAt: Date;
  now?: Date;
}): RenderedExomemAccessEmail {
  return renderAccessEmail({
    subject: "Set up your Exomem",
    introduction:
      "Your place on Exomem Hosted is ready. Set it up to create your private memory space, then connect it to Claude or ChatGPT.",
    actionLabel: "Set up Exomem",
    accessUrl: input.accessUrl,
    expiryLabel: expiryLabel("This setup link", input.expiresAt, input.now ?? new Date()),
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
  now?: Date;
}): RenderedExomemAccessEmail {
  return renderAccessEmail({
    subject: "Sign in to Exomem",
    introduction: "Use this private link to sign in to your Exomem workspace.",
    actionLabel: "Sign in to Exomem",
    accessUrl: input.accessUrl,
    expiryLabel: expiryLabel("This sign-in link", input.expiresAt, input.now ?? new Date()),
  });
}

export function renderExomemDeletionEmail(input: {
  accessUrl: string;
  expiresAt: Date;
  now?: Date;
}): RenderedExomemAccessEmail {
  return renderAccessEmail({
    subject: "Confirm deletion of your Exomem",
    introduction:
      "You asked to permanently delete your hosted Exomem. This removes the Exomem vault, hosted exports, and its encryption keys. It does not delete your shared Substrate identity or other products.",
    actionLabel: "Review and confirm deletion",
    accessUrl: input.accessUrl,
    expiryLabel: expiryLabel("This confirmation", input.expiresAt, input.now ?? new Date()),
  });
}

export function renderExomemDeletionCompleteEmail(): RenderedExomemAccessEmail {
  const introduction =
    "Your hosted Exomem has been permanently deleted. Its vault, files, exports, and encryption keys have been removed. Your shared Substrate identity and any other products remain untouched.";
  const htmlContent = `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #171717; max-width: 560px; margin: 0 auto; padding: 32px; background: #ffffff;">
    <p style="font-size: 16px; line-height: 1.6; margin: 0 0 18px;">${escapeHtml(introduction)}</p>
    <p style="font-size: 14px; line-height: 1.6; margin: 0;">— Exomem by Substrate Systems</p>
  </body>
</html>`;
  const textContent = `${introduction}

— Exomem by Substrate Systems`;
  return {
    subject: "Your Exomem has been deleted",
    htmlContent,
    textContent,
  };
}
