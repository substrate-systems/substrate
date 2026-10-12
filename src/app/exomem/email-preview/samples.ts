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
        homeUrl: home,
        recipientName: "Maria",
        connected: true,
        billing: { price: "€10", nextPaymentAt: at(30 * DAY), friendInviterName: "Alex" },
        timeZone: ZONE,
      }),
    },
    {
      id: "03-plain",
      number: "03",
      note: "ready, own plan, nothing connected yet, price not stored",
      email: renderExomemReadyEmail({
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
        billingUrl: home,
        readOnlyUntil: at(14 * DAY),
        timeZone: ZONE,
      }),
    },
    {
      id: "04-unknown",
      number: "04",
      note: "payment failed, dunning window not configured",
      email: renderExomemPaymentFailedEmail({ billingUrl: home, readOnlyUntil: null, timeZone: ZONE }),
    },
    {
      id: "05",
      number: "05",
      note: "subscription ended",
      email: renderExomemSubscriptionEndedEmail({
        exportUrl: home,
        resubscribeUrl: home,
        keptUntil: at(30 * DAY),
        now,
        reminderScheduled: true,
        timeZone: ZONE,
      }),
    },
    {
      id: "06",
      number: "06",
      note: "a week before deletion",
      email: renderExomemDeletionReminderEmail({
        exportUrl: home,
        resubscribeUrl: home,
        keptUntil: at(7 * DAY),
        now,
        timeZone: ZONE,
      }),
    },
    {
      id: "07",
      number: "07",
      note: "deleted",
      email: renderExomemDeletedEmail({ deletedAt: now, now, timeZone: ZONE }),
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
