/**
 * The Exomem account emails after admission, on the one template
 * (exomem-email.ts): 03 to 08 (the lifecycle, R12-Lifecycle and R28-Emails),
 * 14, 15 and 19 (storage), 16 and 16b (email change) and 17 (vault import).
 * Copy is verbatim from the boards; where the board's dark and light cards
 * differ, the dark card is the email and the light card a shortened sample.
 * Every number and time limit is computed here, at send, in the reader's
 * zone, from the caller's typed facts.
 */

import { formatMoney, type ExomemMoney } from "@/lib/exomem/money";
import {
  renderExomemEmail,
  type ExomemEmailFact,
  type ExomemEmailScheme,
  type ExomemEmailSlots,
  type RenderedExomemEmail,
} from "./exomem-email";
import {
  emailClock,
  emailCount,
  emailDate,
  emailDateTime,
  emailDaysLeft,
  emailDuration,
  emailSameDay,
  type EmailTimeZone,
} from "./exomem-email-time";

type RenderedEmail = RenderedExomemEmail;

/** "1,204": a count as the boards write it. */
function count(value: number): string {
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 }).format(value);
}

/** "4", "4.5": a size in GB as the boards write it, at most one decimal. */
function gigabytes(value: number): string {
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 }).format(value);
}

/**
 * Email 03: the first time an admitted Exomem is ready. The board's welcome
 * (R28) names the reader and, for a friend's invitation, the inviter and the
 * friend price. Without a known name it says "Welcome." alone, and it says
 * "connected" only when an app is connected.
 */
export function renderExomemReadyEmail(input: {
  homeUrl: string;
  recipientName: string | null;
  connected: boolean;
  /** The paid plan's facts; `null` for an Exomem someone covers. */
  billing: {
    /** The next payment's amount as Paddle reports it, or `null` when unknown. */
    price: ExomemMoney | null;
    nextPaymentAt: Date | null;
    friendInviterName: string | null;
  } | null;
  timeZone: EmailTimeZone;
  scheme?: ExomemEmailScheme | null;
}): RenderedEmail {
  const friend = input.billing?.friendInviterName ?? null;
  const rows: ExomemEmailFact[] = [];
  if (input.billing?.price) {
    const price = formatMoney(input.billing.price);
    rows.push({
      label: "Your price",
      value: friend ? `${price} a month · from ${friend}’s invitation` : `${price} a month`,
    });
  }
  if (input.billing?.nextPaymentAt) {
    rows.push({
      label: "Next payment",
      value: emailDate(input.billing.nextPaymentAt, input.timeZone),
    });
  }
  const welcome = input.recipientName ? `Welcome, ${input.recipientName}.` : "Welcome.";
  const state = input.connected ? "Exomem is set up and connected." : "Exomem is set up.";
  return renderExomemEmail({
    base: input.scheme,
    subject: "Your Exomem is ready",
    preheader: friend
      ? `${friend}’s friend price is on your plan.`
      : "Your assistant can recall and save from now on.",
    band: "live",
    headline: "Your memory is on",
    body: [
      `${welcome} ${state} Ask your assistant to remember something today, then ask about it tomorrow.`,
    ],
    detail: rows.length > 0 ? { kind: "facts", rows } : null,
    action: { label: "Open Home", url: input.homeUrl },
    smallPrint: !input.billing
      ? ""
      : friend
        ? `You joined from ${friend}’s invitation. Receipts come from Paddle.`
        : "Receipts come from Paddle.",
  });
}

/**
 * Email 04: the move into past due. The read-only end is the grace start plus
 * the configured dunning window; when that is unknown the sentence says what
 * happens without a date.
 */
export function renderExomemPaymentFailedEmail(input: {
  billingUrl: string;
  readOnlyUntil: Date | null;
  timeZone: EmailTimeZone;
  scheme?: ExomemEmailScheme | null;
}): RenderedEmail {
  const ends = input.readOnlyUntil
    ? `If it still hasn’t worked by ${emailDate(input.readOnlyUntil, input.timeZone)}, your subscription ends.`
    : "If it still doesn’t work, your subscription ends.";
  return renderExomemEmail({
    base: input.scheme,
    subject: "Your payment didn’t go through",
    preheader: "Exomem is read-only until billing is fixed. Your memory is safe.",
    band: "readonly",
    headline: "Your payment didn’t go through",
    body: [
      `Exomem is read-only until it’s fixed: your assistants still recall everything, but nothing new is saved. Paddle will try again. ${ends}`,
    ],
    action: { label: "Fix billing", url: input.billingUrl },
    smallPrint: "Your memory is safe either way.",
  });
}

/** Where an ended owner goes from emails 05 and 06. */
type EndedLinks = {
  /** Home's export; null while the export flag is off, and the email names support instead. */
  exportUrl: string | null;
  supportUrl: string;
  resubscribeUrl: string;
};

function endedAction(links: EndedLinks): ExomemEmailSlots["action"] {
  return links.exportUrl
    ? {
        label: "Export your memory",
        url: links.exportUrl,
        link: { label: "Resubscribe", url: links.resubscribeUrl },
      }
    : {
        label: "Resubscribe",
        url: links.resubscribeUrl,
        link: { label: "Contact support", url: links.supportUrl },
      };
}

/** Email 05: the subscription ended (grace ran out, or a cancel took effect). */
export function renderExomemSubscriptionEndedEmail(
  input: EndedLinks & {
    keptUntil: Date;
    now: Date;
    /** Whether email 06 is queued for a week before deletion. */
    reminderScheduled: boolean;
    timeZone: EmailTimeZone;
    scheme?: ExomemEmailScheme | null;
  }
): RenderedEmail {
  const kept = emailCount(emailDaysLeft(input.now, input.keptUntil), "day");
  const deletes = emailDate(input.keptUntil, input.timeZone);
  return renderExomemEmail({
    base: input.scheme,
    subject: "Your Exomem subscription has ended",
    preheader: input.exportUrl
      ? `Kept, read-only, for ${kept}. Export it any time.`
      : `Kept, read-only, for ${kept}.`,
    band: "kept",
    headline: `Your memory is kept for ${kept}`,
    body: [
      input.exportUrl
        ? `It’s read-only until ${deletes}. Export it any time, or resubscribe and everything comes back exactly as it was. After ${deletes} it’s permanently deleted.`
        : `It’s read-only until ${deletes}. Resubscribe and everything comes back exactly as it was. After ${deletes} it’s permanently deleted. For a copy before then, write to support.`,
    ],
    action: endedAction(input),
    smallPrint: input.reminderScheduled ? "We’ll remind you a week before." : "",
  });
}

/** Email 06: a week before an ended Exomem is deleted. */
export function renderExomemDeletionReminderEmail(
  input: EndedLinks & {
    keptUntil: Date;
    now: Date;
    timeZone: EmailTimeZone;
    scheme?: ExomemEmailScheme | null;
  }
): RenderedEmail {
  const left = emailCount(emailDaysLeft(input.now, input.keptUntil), "day");
  const deleted = `On ${emailDate(input.keptUntil, input.timeZone)} your Exomem and everything in it is permanently deleted, backups included.`;
  return renderExomemEmail({
    base: input.scheme,
    subject: `${left} until your Exomem is deleted`,
    preheader: input.exportUrl
      ? "Export it now, or resubscribe to keep it."
      : "Resubscribe to keep it.",
    band: "fading",
    headline: `${left} left`,
    body: [
      input.exportUrl
        ? `${deleted} Export it now, or resubscribe to keep it.`
        : `${deleted} Resubscribe to keep it. For a copy before then, write to support.`,
    ],
    action: endedAction(input),
    smallPrint: input.exportUrl ? "If you’ve already exported it, there’s nothing else to do." : "",
  });
}

/** Email 07: the Exomem is deleted. No action: there is nothing left to open. */
export function renderExomemDeletedEmail(input: {
  deletedAt: Date;
  now: Date;
  timeZone: EmailTimeZone;
  scheme?: ExomemEmailScheme | null;
}): RenderedEmail {
  const when = emailSameDay(input.deletedAt, input.now, input.timeZone)
    ? "today"
    : `on ${emailDate(input.deletedAt, input.timeZone)}`;
  return renderExomemEmail({
    base: input.scheme,
    subject: "Your Exomem has been deleted",
    preheader: "Your vault, backups and keys are gone.",
    band: "gone",
    headline: "Deleted, as promised",
    body: [
      `Your Exomem, its backups and its keys were permanently deleted ${when}. Your Substrate account is still here, and you can start a new Exomem any time.`,
    ],
    smallPrint: "Nothing more will be sent about this Exomem.",
  });
}

/**
 * Email 08: an export finished. The download link lives only in Home (a
 * short-lived link for a signed-in owner), so the button opens Home.
 */
export function renderExomemExportReadyEmail(input: {
  homeUrl: string;
  keptUntil: Date;
  now: Date;
  timeZone: EmailTimeZone;
}): RenderedEmail {
  const kept = emailDuration(input.now, input.keptUntil);
  return renderExomemEmail({
    subject: "Your Exomem export is ready",
    preheader: kept
      ? `Your whole vault, as Markdown. Kept for ${kept}.`
      : "Your whole vault, as Markdown.",
    band: "live",
    headline: "Your export is ready",
    body: [
      "A verified archive of your whole vault: every note as Markdown with its links and sources, the files you attached, and a manifest with checksums. Unzip it and open the folder in Obsidian, or anything that reads Markdown.",
    ],
    action: { label: "Download export", url: input.homeUrl },
    smallPrint: `We keep it until ${emailDateTime(input.keptUntil, input.timeZone)}, then delete it. Download it before then, while you’re signed in. You can export again any time.`,
  });
}

/** Email 14: storage crossed its warning threshold, once. */
export function renderExomemStorageWarningEmail(input: {
  homeUrl: string;
  usedGb: number;
  limitGb: number;
  thresholdPercent: number;
}): RenderedEmail {
  const percent = Math.floor((input.usedGb / input.limitGb) * 100);
  const free = gigabytes(Math.max(0, input.limitGb - input.usedGb));
  const limit = gigabytes(input.limitGb);
  return renderExomemEmail({
    subject: `Your Exomem is ${percent}% full`,
    preheader: `Everything works. ${free} GB left.`,
    band: "readonly",
    headline: `${percent}% full`,
    body: [
      `Everything works. You have ${free} GB left of ${limit} GB. Add storage in one step, or let it grow automatically when it fills.`,
    ],
    detail: {
      kind: "facts",
      rows: [{ label: "Used", value: `${gigabytes(input.usedGb)} of ${limit} GB` }],
    },
    action: { label: "Add storage", url: input.homeUrl },
    smallPrint: `We send this once at ${input.thresholdPercent}%. Nothing is ever deleted to make space.`,
  });
}

/** Email 15: storage is full; recall works and saving waits. */
export function renderExomemStorageFullEmail(input: { homeUrl: string }): RenderedEmail {
  return renderExomemEmail({
    subject: "Your Exomem is full",
    preheader: "Recall works. Saving waits for room.",
    band: "readonly",
    headline: "Saving is paused",
    body: [
      "Your Exomem is full. Recall still works; new saves wait until there is room. Add storage and they carry on where they stopped.",
    ],
    action: { label: "Add storage", url: input.homeUrl },
    smallPrint: "Nothing is ever deleted to make space. Paddle shows the price before you pay.",
  });
}

/** Email 19: storage was added, by hand or by Grow automatically. */
export function renderExomemStorageAddedEmail(input: {
  homeUrl: string;
  newLimitGb: number;
  /** What Grow automatically adds each time it fills. */
  growStepGb: number;
}): RenderedEmail {
  const limit = gigabytes(input.newLimitGb);
  return renderExomemEmail({
    subject: "More storage added",
    preheader: `${limit} GB, and saving carries on.`,
    band: "live",
    headline: "More storage added",
    body: [
      `Your Exomem now has ${limit} GB. Saving carries on. If you turned on Grow automatically, it adds ${gigabytes(input.growStepGb)} GB when it fills, at most once a month, and tells you each time.`,
    ],
    action: { label: "Open Home", url: input.homeUrl },
    smallPrint: "Paddle sends the receipt. You can remove the extra storage from Home.",
  });
}

/** Email 16: an email change, to the new address. */
export function renderExomemConfirmNewEmailEmail(input: {
  confirmUrl: string;
  newEmail: string;
  expiresAt: Date;
  now: Date;
  timeZone: EmailTimeZone;
}): RenderedEmail {
  const left = emailDuration(input.now, input.expiresAt);
  const until = emailClock(input.expiresAt, input.timeZone);
  return renderExomemEmail({
    subject: "Confirm your new email",
    preheader: "Nothing changes until you open it.",
    band: "arrive",
    headline: "Confirm your new email",
    body: [
      `Open this to make ${input.newEmail} the address for your Exomem: sign-in links and receipts go here after that.`,
    ],
    action: { label: "Confirm this address", url: input.confirmUrl },
    smallPrint: `Works once, until ${left ? `${until} (${left})` : until}. If you didn’t ask for this, ignore it: nothing changes.`,
  });
}

/**
 * "m•••@example.com": the board's mask for the new address in 16b. Only the
 * first character of the local part shows.
 */
function maskEmailAddress(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 1) return "•••";
  return `${[...address.slice(0, at)][0]}•••${address.slice(at)}`;
}

/** Email 16b: an email change, to the old address at the same time. */
export function renderExomemEmailChangingEmail(input: {
  homeUrl: string;
  newEmail: string;
}): RenderedEmail {
  return renderExomemEmail({
    subject: "Your Exomem email is changing",
    preheader: "If this wasn’t you, stop it here.",
    band: "kept",
    headline: "Your email is changing",
    body: [
      `Someone asked to move your Exomem to ${maskEmailAddress(input.newEmail)}. If that was you, there is nothing to do. If not, open Home and stop it; your notes are untouched either way.`,
    ],
    action: { label: "Stop the change", url: input.homeUrl },
    smallPrint: "The change only happens once the new address confirms.",
  });
}

/** Email 17: a vault import finished. The board draws no preheader for it. */
export function renderExomemVaultImportedEmail(input: {
  homeUrl: string;
  notes: number;
  files: number;
}): RenderedEmail {
  return renderExomemEmail({
    subject: "Your vault is in Exomem",
    preheader: "",
    band: "live",
    headline: "Your vault is here",
    body: [
      "Your notes are now in Exomem, with their folders and links. Your connected apps see them already. The originals are unchanged.",
    ],
    detail: {
      kind: "facts",
      rows: [
        { label: "Notes", value: count(input.notes) },
        { label: "Sources and files", value: count(input.files) },
      ],
    },
    action: { label: "Open Home", url: input.homeUrl },
    smallPrint: "Checked against its manifest before anything changed.",
  });
}
