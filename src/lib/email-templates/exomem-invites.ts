/**
 * The invitation emails 09 to 13, with the subject and body copy of the
 * design catalogue (R28). Each function takes the facts of one email and
 * nothing about its looks; the shared email template renders them.
 */

import type { ExomemMoney } from "@/lib/exomem-hosted/paddle-billing";

export type RenderedExomemInviteEmail = {
  /** "Exomem", or "<inviter> via Exomem" when a person sent it. */
  senderName: string;
  subject: string;
  htmlContent: string;
  textContent: string;
};

// Temporary local copy of exomem-access.ts's escaping and layout: the shared
// ten-slot email template replaces both when it lands.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "14 October" in the reader's zone; "14 October (UTC)" when their zone is unknown. */
function dateLabel(at: Date, timeZone: string | null): string {
  const date = new Intl.DateTimeFormat("en-GB", {
    timeZone: timeZone ?? "UTC",
    day: "numeric",
    month: "long",
  }).format(at);
  return timeZone ? date : `${date} (UTC)`;
}

/** "€10", or "€10.50" when the amount has cents. Amounts are at most 12 digits, exact as numbers. */
function money(price: ExomemMoney): string {
  const fractionDigits =
    new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: price.currencyCode,
    }).resolvedOptions().maximumFractionDigits ?? 2;
  const scale = 10 ** fractionDigits;
  const minor = Number(price.amount);
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: price.currencyCode,
    minimumFractionDigits: minor % scale === 0 ? 0 : fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(minor / scale);
}

// Small counts in words, as the catalogue writes "three days".
const SMALL_NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven"];

function countWord(count: number): string {
  return SMALL_NUMBERS[count] ?? String(count);
}

type Fact = { label: string; value: string; struck?: string };

function render(input: {
  senderName: string;
  subject: string;
  preheader: string;
  headline: string;
  body: string;
  note: { text: string; by: string } | null;
  facts: Fact[];
  action: { label: string; url: string } | null;
  smallPrint: string;
}): RenderedExomemInviteEmail {
  const note = input.note
    ? `
    <p style="font-size: 15px; line-height: 1.6; margin: 0 0 6px; white-space: pre-line;">“${escapeHtml(input.note.text)}”</p>
    <p style="font-size: 13px; line-height: 1.6; color: #525252; margin: 0 0 18px;">${escapeHtml(input.note.by)}</p>`
    : "";
  const facts = input.facts
    .map(
      (fact) => `
    <p style="font-size: 14px; line-height: 1.6; margin: 0 0 6px;"><span style="color: #525252;">${escapeHtml(fact.label)}</span> ${fact.struck ? `<s>${escapeHtml(fact.struck)}</s> ` : ""}${escapeHtml(fact.value)}</p>`
    )
    .join("");
  const action = input.action
    ? `
    <p style="margin: 18px 0 20px;"><a href="${escapeHtml(input.action.url)}" style="display: inline-block; background: #171717; color: #ffffff; text-decoration: none; padding: 11px 18px; border-radius: 7px; font-weight: 600;">${escapeHtml(input.action.label)}</a></p>`
    : "";
  const htmlContent = `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #171717; max-width: 560px; margin: 0 auto; padding: 32px; background: #ffffff;">
    <div style="display: none; max-height: 0; overflow: hidden;">${escapeHtml(input.preheader)}</div>
    <p style="font-size: 18px; line-height: 1.4; font-weight: 600; margin: 0 0 14px;">${escapeHtml(input.headline)}</p>
    <p style="font-size: 16px; line-height: 1.6; margin: 0 0 18px;">${escapeHtml(input.body)}</p>${note}${facts}${action}
    <p style="font-size: 13px; line-height: 1.6; color: #525252; margin: 0 0 18px;">${escapeHtml(input.smallPrint)}</p>
    <p style="font-size: 14px; line-height: 1.6; margin: 0;">Exomem by Substrate Systems</p>
  </body>
</html>`;
  const textParts = [input.headline, input.body];
  if (input.note) textParts.push(`“${input.note.text}”\n— ${input.note.by}`);
  if (input.facts.length > 0) {
    textParts.push(
      input.facts
        .map((fact) =>
          fact.struck
            ? `${fact.label}: ${fact.value} (instead of ${fact.struck})`
            : `${fact.label}: ${fact.value}`
        )
        .join("\n")
    );
  }
  if (input.action) textParts.push(`${input.action.label}: ${input.action.url}`);
  textParts.push(input.smallPrint, "Exomem by Substrate Systems");
  return {
    senderName: input.senderName,
    subject: input.subject,
    htmlContent,
    textContent: textParts.join("\n\n"),
  };
}

function viaExomem(inviterName: string): string {
  return `${inviterName} via Exomem`;
}

/** Email 09: a friend invitation, with the usual and the friend price from Paddle. */
export function renderExomemFriendInvitationEmail(input: {
  acceptUrl: string;
  inviterName: string;
  note: string | null;
  inviteeEmail: string;
  expiresAt: Date;
  timeZone: string | null;
  usualPrice: ExomemMoney;
  friendPrice: ExomemMoney;
}): RenderedExomemInviteEmail {
  const usual = money(input.usualPrice);
  const friend = money(input.friendPrice);
  return render({
    senderName: viaExomem(input.inviterName),
    subject: `${input.inviterName} invited you to Exomem`,
    preheader: `Your friend price: ${friend} a month instead of ${usual}.`,
    headline: `${input.inviterName} invited you`,
    body: "Exomem is a knowledge base that every assistant you use shares. It keeps where each thing came from, and what changed.",
    note: input.note ? { text: input.note, by: input.inviterName } : null,
    facts: [
      { label: "Your price", struck: usual, value: `${friend} a month` },
      { label: "For", value: "as long as you stay subscribed" },
    ],
    action: { label: "Accept invitation", url: input.acceptUrl },
    smallPrint: `This invitation is for ${input.inviteeEmail}. It works once, until ${dateLabel(input.expiresAt, input.timeZone)}. If you don’t know ${input.inviterName}, ignore it.`,
  });
}

/** Email 10: a covered (complimentary) invitation. */
export function renderExomemCoveredInvitationEmail(input: {
  acceptUrl: string;
  inviterName: string;
  note: string | null;
  inviteeEmail: string;
  expiresAt: Date;
  timeZone: string | null;
}): RenderedExomemInviteEmail {
  return render({
    senderName: viaExomem(input.inviterName),
    subject: `${input.inviterName} is covering your Exomem`,
    preheader: `No checkout. ${input.inviterName} covers it.`,
    headline: `${input.inviterName} invited you`,
    body: `Exomem is a knowledge base that every assistant you use shares. ${input.inviterName} pays for it, so there is no checkout.`,
    note: input.note ? { text: input.note, by: input.inviterName } : null,
    facts: [
      { label: "Your price", value: `covered by ${input.inviterName}` },
      { label: "Billing", value: "none while it’s covered" },
    ],
    action: { label: "Accept invitation", url: input.acceptUrl },
    smallPrint: `This invitation is for ${input.inviteeEmail}. It works once, until ${dateLabel(input.expiresAt, input.timeZone)}. If anything about the cover changes, we email you first.`,
  });
}

/** Email 11: one reminder before an unused friend invitation ends. */
export function renderExomemInvitationReminderEmail(input: {
  acceptUrl: string;
  inviterName: string;
  expiresAt: Date;
  /** How many days before the end this reminder is sent. */
  leadDays: number;
  timeZone: string | null;
}): RenderedExomemInviteEmail {
  const ends = dateLabel(input.expiresAt, input.timeZone);
  return render({
    senderName: viaExomem(input.inviterName),
    subject: `${input.inviterName}’s invitation ends on ${ends}`,
    preheader: "Your friend price is still waiting.",
    headline: "Your invitation ends soon",
    body: `${input.inviterName}’s invitation is still waiting for you, with the friend price. It ends on ${ends}. After that, ask ${input.inviterName} for a new one.`,
    note: null,
    facts: [],
    action: { label: "Accept invitation", url: input.acceptUrl },
    smallPrint: `We send this once, ${countWord(input.leadDays)} days before it ends. Nothing happens if you ignore it.`,
  });
}

/**
 * Email 12, to the inviter: their friend invitation was used. The friend
 * price row shows only when the price is known. The catalogue's "Her" and
 * "hers" read as "Their" and "theirs", because the invitee is any person.
 */
export function renderExomemInvitationUsedEmail(input: {
  inviteeName: string;
  usedAt: Date;
  friendPrice: ExomemMoney | null;
  timeZone: string | null;
}): RenderedExomemInviteEmail {
  const facts: Fact[] = [
    { label: "Invitation", value: `used ${dateLabel(input.usedAt, input.timeZone)}` },
  ];
  if (input.friendPrice) {
    facts.push({ label: "Their price", value: `${money(input.friendPrice)} a month` });
  }
  return render({
    senderName: "Exomem",
    subject: `${input.inviteeName} accepted your invitation`,
    preheader: `${input.inviteeName} joined with your friend price.`,
    headline: "Your invitation worked",
    body: `${input.inviteeName} joined Exomem with your friend price. You don’t need to do anything.`,
    note: null,
    facts,
    action: null,
    smallPrint: `We tell you only that the invitation was used. ${input.inviteeName}’s notes are theirs; you never see them.`,
  });
}

/**
 * Email 13, to the inviter: their friend invitation ended unused. The
 * catalogue's "send her" reads "send them", as in email 12.
 */
export function renderExomemInvitationEndedEmail(input: {
  inviteeName: string;
  issuedAt: Date;
  expiredAt: Date;
}): RenderedExomemInviteEmail {
  const days = Math.max(
    1,
    Math.round((input.expiredAt.getTime() - input.issuedAt.getTime()) / 86_400_000)
  );
  return render({
    senderName: "Exomem",
    subject: `Your invitation to ${input.inviteeName} ended`,
    preheader: `${input.inviteeName} didn’t open it in time.`,
    headline: "Your invitation ended",
    body: `${input.inviteeName} didn’t open your invitation within ${days} ${days === 1 ? "day" : "days"}, so it no longer works. You can send them a new one any time.`,
    note: null,
    facts: [],
    action: null,
    smallPrint: `We send this once. We don’t tell ${input.inviteeName} anything more.`,
  });
}
