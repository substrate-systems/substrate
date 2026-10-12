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
 * Always labelled. A time is shown in the recipient's own time zone when the
 * product knows it, and in UTC otherwise, because an unlabelled timestamp
 * invites the reader to misread it as their own local time.
 */
function absoluteTime(at: Date, timeZone: string | null | undefined): string {
  const zone = timeZone ?? "UTC";
  const date = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(at);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
  return zone === "UTC" ? `${date} at ${time} UTC` : `${date} at ${time} (${zone})`;
}

function expiryLabel(
  subject: string,
  expiresAt: Date,
  now: Date,
  timeZone?: string | null
): string {
  const relative = relativeExpiry(expiresAt, now);
  const absolute = absoluteTime(expiresAt, timeZone);
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
  timeZone?: string | null;
}): RenderedExomemAccessEmail {
  return renderAccessEmail({
    subject: "Your Exomem invitation",
    introduction:
      "You have been invited to Exomem Cloud. Accept the invitation to create your private memory space.",
    actionLabel: "Accept invitation",
    accessUrl: input.accessUrl,
    expiryLabel: expiryLabel(
      "This invitation",
      input.expiresAt,
      input.now ?? new Date(),
      input.timeZone
    ),
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
  timeZone?: string | null;
}): RenderedExomemAccessEmail {
  return renderAccessEmail({
    subject: "Set up your Exomem",
    introduction:
      "Your place on Exomem Cloud is ready. Set it up to create your private memory space, then connect it to Claude or ChatGPT.",
    actionLabel: "Set up Exomem",
    accessUrl: input.accessUrl,
    expiryLabel: expiryLabel(
      "This setup link",
      input.expiresAt,
      input.now ?? new Date(),
      input.timeZone
    ),
  });
}

/**
 * A time limit as the design catalogue writes it ("14 Sep, 15:05"), in the
 * reader's zone, or in UTC with the label when the zone is unknown.
 */
function catalogueTime(
  at: Date,
  timeZone: string | null | undefined
): {
  time: string;
  known: boolean;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone ?? "UTC",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return {
    time: `${part("day")} ${part("month")}, ${part("hour")}:${part("minute")}`,
    known: Boolean(timeZone),
  };
}

/**
 * The catalogue layout: a hidden preheader, a headline, the body, at most one
 * action, the small print and the footer.
 */
function renderCatalogueEmail(input: {
  subject: string;
  preheader: string;
  headline: string;
  body: string;
  action: { label: string; url: string } | null;
  smallPrint: string;
}): RenderedExomemAccessEmail {
  const action = input.action
    ? `
    <p style="margin: 0 0 20px;"><a href="${escapeHtml(input.action.url)}" style="display: inline-block; background: #171717; color: #ffffff; text-decoration: none; padding: 11px 18px; border-radius: 7px; font-weight: 600;">${escapeHtml(input.action.label)}</a></p>`
    : "";
  const htmlContent = `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #171717; max-width: 560px; margin: 0 auto; padding: 32px; background: #ffffff;">
    <div style="display: none; max-height: 0; overflow: hidden;">${escapeHtml(input.preheader)}</div>
    <p style="font-size: 18px; line-height: 1.4; font-weight: 600; margin: 0 0 14px;">${escapeHtml(input.headline)}</p>
    <p style="font-size: 16px; line-height: 1.6; margin: 0 0 18px;">${escapeHtml(input.body)}</p>${action}
    <p style="font-size: 13px; line-height: 1.6; color: #525252; margin: 0 0 18px;">${escapeHtml(input.smallPrint)}</p>
    <p style="font-size: 14px; line-height: 1.6; margin: 0;">Exomem by Substrate Systems</p>
  </body>
</html>`;
  const actionText = input.action ? `\n\n${input.action.label}: ${input.action.url}` : "";
  const textContent = `${input.headline}

${input.body}${actionText}

${input.smallPrint}

Exomem by Substrate Systems`;
  return { subject: input.subject, htmlContent, textContent };
}

/**
 * Email 18: a person who accepted but has not paid, two days before their
 * unpaid hold ends, in the design catalogue's copy. That copy names the
 * inviter. A self-serve start, or an operator invitation without a name, has
 * none, and uses the product owner's approved sentence without one.
 */
export function renderExomemHoldReminderEmail(input: {
  setupUrl: string;
  holdEndsAt: Date;
  inviterName: string | null;
  timeZone?: string | null;
}): RenderedExomemAccessEmail {
  const deadline = absoluteTime(input.holdEndsAt, input.timeZone);
  const body = input.inviterName
    ? `You accepted ${input.inviterName}’s invitation but haven’t subscribed yet. Finish by ${deadline} and everything is as you left it. After that we release the setup; the invitation stays used.`
    : `You started setting up Exomem but haven’t subscribed yet. Finish by ${deadline} and everything is as you left it. After that we release the setup.`;
  return renderCatalogueEmail({
    subject: "Finish setting up your Exomem",
    preheader: `Finish by ${deadline}.`,
    headline: "Your Exomem is waiting",
    body,
    action: { label: "Finish setting up", url: input.setupUrl },
    smallPrint: "We send this once. If you’ve changed your mind, ignore it.",
  });
}

/** The waitlist email, in the product owner's approved copy (2026-10-12). */
export function renderExomemWaitlistEmail(): RenderedExomemAccessEmail {
  return renderCatalogueEmail({
    subject: "You're on the Exomem waitlist",
    preheader: "We'll email you when a place opens.",
    headline: "You're on the list",
    body: "Exomem is full for now. We add room as we grow. When a place opens for you, we'll send a link to start.",
    action: null,
    smallPrint:
      "You don't need to do anything. If you didn't ask for this, ignore this email. We write again only when a place opens.",
  });
}

/**
 * A waiting person's place opened, in the product owner's approved copy
 * (2026-10-12). The copy reads "(your time)"; when the reader's zone is
 * unknown the time is shown in UTC and labelled so.
 */
export function renderExomemPlaceOpenedEmail(input: {
  accessUrl: string;
  expiresAt: Date;
  timeZone?: string | null;
}): RenderedExomemAccessEmail {
  const expiry = catalogueTime(input.expiresAt, input.timeZone);
  const zoneLabel = expiry.known ? "(your time)" : "UTC";
  return renderCatalogueEmail({
    subject: "Your place in Exomem is ready",
    preheader: expiry.known
      ? `Start before ${expiry.time} to keep it.`
      : `Start before ${expiry.time} UTC to keep it.`,
    headline: "Your place is ready",
    body: "A place opened up for you. Start your Exomem, then add it to your assistant.",
    action: { label: "Start Exomem", url: input.accessUrl },
    smallPrint: `The link works once, until ${expiry.time} ${zoneLabel}. If you don't use it, the place goes to the next person on the list.`,
  });
}

export function renderExomemMagicLinkEmail(input: {
  accessUrl: string;
  expiresAt: Date;
  now?: Date;
  timeZone?: string | null;
}): RenderedExomemAccessEmail {
  return renderAccessEmail({
    subject: "Sign in to Exomem",
    introduction: "Use this private link to sign in to your Exomem workspace.",
    actionLabel: "Sign in to Exomem",
    accessUrl: input.accessUrl,
    expiryLabel: expiryLabel(
      "This sign-in link",
      input.expiresAt,
      input.now ?? new Date(),
      input.timeZone
    ),
  });
}

/**
 * Item 5 / task 3.7 (design D4), Cloud-only. Sent once, when a Cloud
 * tenant's Paddle subscription becomes cancelled. No call to action, like
 * `renderExomemWaitlistEmail` -- there is nothing to click; the cell has
 * already switched to read-only, and resubscribing (through the product's
 * ordinary billing flow, not this email) is what reverses it.
 */
export function renderExomemCloudCancellationEmail(input: {
  deletionDate: Date;
  retentionDays: number;
}): RenderedExomemAccessEmail {
  const deletionDateLabel = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(input.deletionDate);
  const introduction =
    `Your Exomem subscription has been cancelled. Your memories stay in place and readable for ` +
    `${input.retentionDays} days, but Exomem can no longer accept new memories during that window.`;
  const windowLine =
    `If you resubscribe before ${deletionDateLabel}, Exomem returns to normal automatically. ` +
    `Otherwise, your Exomem and everything in it is permanently deleted on ${deletionDateLabel}.`;
  const htmlContent = `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #171717; max-width: 560px; margin: 0 auto; padding: 32px; background: #ffffff;">
    <p style="font-size: 16px; line-height: 1.6; margin: 0 0 18px;">${escapeHtml(introduction)}</p>
    <p style="font-size: 13px; line-height: 1.6; color: #525252; margin: 0 0 18px;">${escapeHtml(windowLine)}</p>
    <p style="font-size: 14px; line-height: 1.6; margin: 0;">— Exomem by Substrate Systems</p>
  </body>
</html>`;
  const textContent = `${introduction}

${windowLine}

— Exomem by Substrate Systems`;
  return { subject: "Your Exomem subscription was cancelled", htmlContent, textContent };
}

export function renderExomemDeletionEmail(input: {
  accessUrl: string;
  expiresAt: Date;
  now?: Date;
  timeZone?: string | null;
}): RenderedExomemAccessEmail {
  return renderAccessEmail({
    subject: "Confirm deletion of your Exomem",
    introduction:
      "You asked to permanently delete your Exomem Cloud account. This removes the Exomem vault, its backups and exports, and its encryption keys. It does not delete your shared Substrate identity or other products.",
    actionLabel: "Review and confirm deletion",
    accessUrl: input.accessUrl,
    expiryLabel: expiryLabel(
      "This confirmation",
      input.expiresAt,
      input.now ?? new Date(),
      input.timeZone
    ),
  });
}
