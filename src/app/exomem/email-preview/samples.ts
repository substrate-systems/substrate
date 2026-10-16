// Every Exomem email rendered once with sample input, for the dev-only preview. The
// names and addresses are invented; real emails take theirs from stored data at send.

import {
  renderExomemDeletionEmail,
  renderExomemHoldReminderEmail,
  renderExomemInviteEmail,
  renderExomemMagicLinkEmail,
  renderExomemPlaceOpenedEmail,
  renderExomemWaitlistEmail,
  renderExomemWelcomeEmail,
} from "@/lib/email-templates/exomem-access";
import type { RenderedExomemEmail } from "@/lib/email-templates/exomem-email";
import {
  renderExomemCoveredInvitationEmail,
  renderExomemFriendInvitationEmail,
  renderExomemInvitationEndedEmail,
  renderExomemInvitationReminderEmail,
  renderExomemInvitationUsedEmail,
} from "@/lib/email-templates/exomem-invites";
import {
  renderExomemConfirmNewEmailEmail,
  renderExomemDeletedEmail,
  renderExomemDeletionReminderEmail,
  renderExomemEmailChangingEmail,
  renderExomemExportReadyEmail,
  renderExomemPaymentFailedEmail,
  renderExomemReadyEmail,
  renderExomemStorageAddedEmail,
  renderExomemStorageFullEmail,
  renderExomemStorageWarningEmail,
  renderExomemSubscriptionEndedEmail,
  renderExomemVaultImportedEmail,
} from "@/lib/email-templates/exomem-lifecycle";

export type EmailSample = { id: string; number: string; note: string; email: RenderedExomemEmail };

const ZONE = "Europe/Berlin";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function exomemEmailSamples(now: Date, publicBaseUrl: string): EmailSample[] {
  const at = (ms: number) => new Date(now.getTime() + ms);
  const url = (path: string) => new URL(path, `${publicBaseUrl}/`).toString();
  const link = (path: string) => `${url(path)}#sample-token`;
  const home = url("/exomem/home");
  const support = url("/exomem/support");
  return [
    {
      id: "01",
      number: "01",
      note: "sign-in link",
      email: renderExomemMagicLinkEmail({
        accessUrl: link("/exomem/sign-in"),
        expiresAt: at(15 * MINUTE),
        now,
        timeZone: ZONE,
      }),
    },
    {
      id: "01w",
      number: "01w",
      note: "start with your email",
      email: renderExomemWelcomeEmail({
        accessUrl: link("/exomem/invite"),
        expiresAt: at(48 * HOUR),
        now,
        timeZone: ZONE,
      }),
    },
    {
      id: "02",
      number: "02",
      note: "operator invitation, zone unknown (UTC)",
      email: renderExomemInviteEmail({
        accessUrl: link("/exomem/invite"),
        expiresAt: at(30 * DAY),
        email: "maria@example.com",
        now,
      }),
    },
    {
      id: "waitlist",
      number: "—",
      note: "waitlist",
      email: renderExomemWaitlistEmail(),
    },
    {
      id: "place-opened",
      number: "—",
      note: "place opened",
      email: renderExomemPlaceOpenedEmail({
        accessUrl: link("/exomem/invite"),
        expiresAt: at(48 * HOUR),
        timeZone: ZONE,
      }),
    },
    {
      id: "03",
      number: "03",
      note: "ready, friend's invitation",
      email: renderExomemReadyEmail({
        scheme: null,
        homeUrl: home,
        recipientName: "Reader",
        connected: true,
        billing: {
          price: { amount: "1000", currencyCode: "EUR" },
          nextPaymentAt: at(30 * DAY),
          friendInviterName: "Alex",
        },
        timeZone: ZONE,
      }),
    },
    {
      id: "03-plain",
      number: "03",
      note: "ready, own plan, nothing connected yet, price unknown",
      email: renderExomemReadyEmail({
        scheme: null,
        homeUrl: home,
        recipientName: null,
        connected: false,
        billing: { price: null, nextPaymentAt: at(30 * DAY), friendInviterName: null },
        timeZone: ZONE,
      }),
    },
    {
      id: "04",
      number: "04",
      note: "payment failed",
      email: renderExomemPaymentFailedEmail({
        scheme: null,
        billingUrl: home,
        readOnlyUntil: at(14 * DAY),
        timeZone: ZONE,
      }),
    },
    {
      id: "04-unknown",
      number: "04",
      note: "payment failed, dunning window not configured",
      email: renderExomemPaymentFailedEmail({
        scheme: null,
        billingUrl: home,
        readOnlyUntil: null,
        timeZone: ZONE,
      }),
    },
    // 05 and 06 name support for a copy while Home offers no export (deviation (s)).
    ...[home, null].map((exportUrl) => ({
      id: exportUrl ? "05" : "05-no-export",
      number: "05",
      note: exportUrl ? "subscription ended" : "subscription ended, export off",
      email: renderExomemSubscriptionEndedEmail({
        scheme: null,
        exportUrl,
        supportUrl: support,
        resubscribeUrl: home,
        keptUntil: at(30 * DAY),
        now,
        reminderScheduled: true,
        timeZone: ZONE,
      }),
    })),
    ...[home, null].map((exportUrl) => ({
      id: exportUrl ? "06" : "06-no-export",
      number: "06",
      note: exportUrl ? "a week before deletion" : "a week before deletion, export off",
      email: renderExomemDeletionReminderEmail({
        scheme: null,
        exportUrl,
        supportUrl: support,
        resubscribeUrl: home,
        keptUntil: at(7 * DAY),
        now,
        timeZone: ZONE,
      }),
    })),
    {
      id: "07",
      number: "07",
      note: "deleted",
      email: renderExomemDeletedEmail({ deletedAt: now, now, timeZone: ZONE, scheme: null }),
    },
    {
      id: "08",
      number: "08",
      note: "export ready",
      email: renderExomemExportReadyEmail({
        homeUrl: home,
        keptUntil: at(24 * HOUR),
        now,
        timeZone: ZONE,
      }),
    },
    {
      id: "09",
      number: "09",
      note: "friend invitation, with a note",
      email: renderExomemFriendInvitationEmail({
        scheme: null,
        acceptUrl: link("/exomem/invite"),
        inviterName: "Alex",
        note: "This is the thing I told you about. It remembers where every note came from.",
        inviteeEmail: "maria@example.com",
        expiresAt: at(14 * DAY),
        timeZone: ZONE,
        usualPrice: { amount: "1500", currencyCode: "EUR" },
        friendPrice: { amount: "1000", currencyCode: "EUR" },
      }),
    },
    {
      id: "09-long",
      number: "09",
      note: "friend invitation, long name, address and unbroken note",
      email: renderExomemFriendInvitationEmail({
        scheme: null,
        acceptUrl: link("/exomem/invite"),
        inviterName: "Alexandria".repeat(6),
        note: `A note with a long reference: ${"reference".repeat(16)}.`,
        inviteeEmail: `${"m".repeat(63)}@${"example".repeat(8)}.test`,
        expiresAt: at(14 * DAY),
        timeZone: ZONE,
        usualPrice: { amount: "1500", currencyCode: "EUR" },
        friendPrice: { amount: "1000", currencyCode: "EUR" },
      }),
    },
    {
      id: "10",
      number: "10",
      note: "covered invitation, no note",
      email: renderExomemCoveredInvitationEmail({
        scheme: null,
        acceptUrl: link("/exomem/invite"),
        inviterName: "Alex",
        note: null,
        inviteeEmail: "maria@example.com",
        expiresAt: at(14 * DAY),
        timeZone: ZONE,
      }),
    },
    {
      id: "11",
      number: "11",
      note: "invitation ends soon",
      email: renderExomemInvitationReminderEmail({
        scheme: null,
        acceptUrl: link("/exomem/invite"),
        inviterName: "Alex",
        expiresAt: at(3 * DAY),
        leadDays: 3,
        timeZone: ZONE,
      }),
    },
    {
      id: "12",
      number: "12",
      note: "invitation used, to the inviter",
      email: renderExomemInvitationUsedEmail({
        scheme: null,
        inviteeName: "Reader",
        usedAt: now,
        friendPrice: { amount: "1000", currencyCode: "EUR" },
        timeZone: ZONE,
      }),
    },
    {
      id: "13",
      number: "13",
      note: "invitation ended unused, to the inviter",
      email: renderExomemInvitationEndedEmail({
        scheme: null,
        inviteeName: "Reader",
        issuedAt: at(-14 * DAY),
        expiredAt: now,
      }),
    },
    {
      id: "14",
      number: "14",
      note: "storage warning",
      email: renderExomemStorageWarningEmail({
        homeUrl: home,
        usedGb: 8,
        limitGb: 10,
        thresholdPercent: 80,
      }),
    },
    {
      id: "15",
      number: "15",
      note: "storage full",
      email: renderExomemStorageFullEmail({ homeUrl: home }),
    },
    {
      id: "19",
      number: "19",
      note: "storage added",
      email: renderExomemStorageAddedEmail({ homeUrl: home, newLimitGb: 20, growStepGb: 10 }),
    },
    {
      id: "16",
      number: "16",
      note: "confirm new email",
      email: renderExomemConfirmNewEmailEmail({
        confirmUrl: link("/exomem/home"),
        newEmail: "maria.l@example.com",
        expiresAt: at(15 * MINUTE),
        now,
        timeZone: ZONE,
      }),
    },
    {
      id: "16b",
      number: "16b",
      note: "email changing, to the old address",
      email: renderExomemEmailChangingEmail({ homeUrl: home, newEmail: "maria.l@example.com" }),
    },
    {
      id: "17",
      number: "17",
      note: "vault imported",
      email: renderExomemVaultImportedEmail({ homeUrl: home, notes: 1204, files: 312 }),
    },
    {
      id: "18",
      number: "18",
      note: "unpaid hold reminder",
      email: renderExomemHoldReminderEmail({
        setupUrl: url("/exomem/setup"),
        holdEndsAt: at(2 * DAY),
        inviterName: "Alex",
        timeZone: ZONE,
      }),
    },
    {
      id: "deletion",
      number: "—",
      note: "deletion confirmation (not drawn)",
      email: renderExomemDeletionEmail({
        accessUrl: link("/exomem/delete"),
        expiresAt: at(15 * MINUTE),
        now,
        timeZone: ZONE,
      }),
    },
  ];
}
