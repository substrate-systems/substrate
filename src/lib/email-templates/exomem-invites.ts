/**
 * The invitation emails 09 to 13, with the copy of the design catalogue
 * (R28), each rendered through renderExomemEmail (exomem-email.ts).
 */

import type { ExomemMoney } from "@/lib/exomem-hosted/paddle-billing";
import {
  renderExomemEmail,
  type ExomemEmailFact,
  type ExomemEmailSlots,
  type RenderedExomemEmail,
} from "./exomem-email";
import { emailMoney } from "./exomem-email-money";
import { emailDate, type EmailTimeZone } from "./exomem-email-time";

// Small counts in words, as the catalogue writes "three days".
const SMALL_NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven"];

function countWord(count: number): string {
  return SMALL_NUMBERS[count] ?? String(count);
}

/** The inviter's note, with the facts under it, or the facts alone. */
function noteWithFacts(
  note: string | null,
  author: string,
  rows: readonly ExomemEmailFact[]
): ExomemEmailSlots["detail"] {
  return note ? { kind: "note", text: note, author, rows } : { kind: "facts", rows };
}

/** Email 09: a friend invitation, with the usual and the friend price from Paddle. */
export function renderExomemFriendInvitationEmail(input: {
  acceptUrl: string;
  inviterName: string;
  note: string | null;
  inviteeEmail: string;
  expiresAt: Date;
  timeZone: EmailTimeZone;
  usualPrice: ExomemMoney;
  friendPrice: ExomemMoney;
}): RenderedExomemEmail {
  const usual = emailMoney(input.usualPrice);
  const friend = emailMoney(input.friendPrice);
  return renderExomemEmail({
    sentBy: { personName: input.inviterName },
    subject: `${input.inviterName} invited you to Exomem`,
    preheader: `Your friend price: ${friend} a month instead of ${usual}.`,
    band: "arrive",
    headline: `${input.inviterName} invited you`,
    body: [
      "Exomem is a knowledge base that every assistant you use shares. It keeps where each thing came from, and what changed.",
    ],
    detail: noteWithFacts(input.note, input.inviterName, [
      { label: "Your price", struck: usual, value: `${friend} a month` },
      { label: "For", value: "as long as you stay subscribed" },
    ]),
    action: { label: "Accept invitation", url: input.acceptUrl },
    smallPrint: `This invitation is for ${input.inviteeEmail}. It works once, until ${emailDate(input.expiresAt, input.timeZone)}. If you don’t know ${input.inviterName}, ignore it.`,
  });
}

/** Email 10: a covered (complimentary) invitation. */
export function renderExomemCoveredInvitationEmail(input: {
  acceptUrl: string;
  inviterName: string;
  note: string | null;
  inviteeEmail: string;
  expiresAt: Date;
  timeZone: EmailTimeZone;
}): RenderedExomemEmail {
  return renderExomemEmail({
    sentBy: { personName: input.inviterName },
    subject: `${input.inviterName} is covering your Exomem`,
    preheader: `No checkout. ${input.inviterName} covers it.`,
    band: "arrive",
    headline: `${input.inviterName} invited you`,
    body: [
      `Exomem is a knowledge base that every assistant you use shares. ${input.inviterName} pays for it, so there is no checkout.`,
    ],
    detail: noteWithFacts(input.note, input.inviterName, [
      { label: "Your price", value: `covered by ${input.inviterName}` },
      { label: "Billing", value: "none while it’s covered" },
    ]),
    action: { label: "Accept invitation", url: input.acceptUrl },
    smallPrint: `This invitation is for ${input.inviteeEmail}. It works once, until ${emailDate(input.expiresAt, input.timeZone)}. If anything about the cover changes, we email you first.`,
  });
}

/** Email 11: one reminder before an unused friend invitation ends. */
export function renderExomemInvitationReminderEmail(input: {
  acceptUrl: string;
  inviterName: string;
  expiresAt: Date;
  /** How many days before the end this reminder is sent. */
  leadDays: number;
  timeZone: EmailTimeZone;
}): RenderedExomemEmail {
  const ends = emailDate(input.expiresAt, input.timeZone);
  return renderExomemEmail({
    sentBy: { personName: input.inviterName },
    subject: `${input.inviterName}’s invitation ends on ${ends}`,
    preheader: "Your friend price is still waiting.",
    band: "fading",
    headline: "Your invitation ends soon",
    body: [
      `${input.inviterName}’s invitation is still waiting for you, with the friend price. It ends on ${ends}. After that, ask ${input.inviterName} for a new one.`,
    ],
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
  timeZone: EmailTimeZone;
}): RenderedExomemEmail {
  const rows: ExomemEmailFact[] = [
    { label: "Invitation", value: `used ${emailDate(input.usedAt, input.timeZone)}` },
  ];
  if (input.friendPrice) {
    rows.push({ label: "Their price", value: `${emailMoney(input.friendPrice)} a month` });
  }
  return renderExomemEmail({
    subject: `${input.inviteeName} accepted your invitation`,
    preheader: `${input.inviteeName} joined with your friend price.`,
    band: "live",
    headline: "Your invitation worked",
    body: [
      `${input.inviteeName} joined Exomem with your friend price. You don’t need to do anything.`,
    ],
    detail: { kind: "facts", rows },
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
}): RenderedExomemEmail {
  const days = Math.max(
    1,
    Math.round((input.expiredAt.getTime() - input.issuedAt.getTime()) / 86_400_000)
  );
  return renderExomemEmail({
    subject: `Your invitation to ${input.inviteeName} ended`,
    preheader: `${input.inviteeName} didn’t open it in time.`,
    band: "kept",
    headline: "Your invitation ended",
    body: [
      `${input.inviteeName} didn’t open your invitation within ${days} ${days === 1 ? "day" : "days"}, so it no longer works. You can send them a new one any time.`,
    ],
    smallPrint: `We send this once. We don’t tell ${input.inviteeName} anything more.`,
  });
}
