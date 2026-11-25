/**
 * The Exomem account emails after admission, on the one template
 * (exomem-email.ts): 03 to 08 (the lifecycle, R12-Lifecycle and R28-Emails),
 * 14, 15 and 19 (storage), 16 and 16b (email change), 17 (vault import) and
 * the app sign-out notice (notify-owner-of-app-signout).
 * Copy is verbatim from the boards; where the board's dark and light cards
 * differ, the dark card is the email and the light card a shortened sample.
 * Every number and time limit is computed here, at send, in the reader's
 * zone, from the caller's typed facts.
 */

import type { ExomemThemeChoice } from "@/lib/exomem/theme";

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
  emailTimeSpan,
  type EmailTimeZone,
} from "./exomem-email-time";

type RenderedEmail = RenderedExomemEmail;

/** Slot 1 of the email design contract: a subject holds 45 characters or fewer. */
const SUBJECT_SLOT_LENGTH = 45;
/** What the sign-out subject says after the app's name. */
const SIGNED_OUT_SUBJECT_SUFFIX = " can’t reach your Evermatter";

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
  scheme: ExomemEmailScheme | null;
  themeChoice?: ExomemThemeChoice | null;
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
  const state = input.connected ? "Evermatter is set up and connected." : "Evermatter is set up.";
  return renderExomemEmail({
    base: input.scheme,
    themeChoice: input.themeChoice,
    subject: "Your Evermatter is ready",
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
  scheme: ExomemEmailScheme | null;
  themeChoice?: ExomemThemeChoice | null;
}): RenderedEmail {
  const ends = input.readOnlyUntil
    ? `If it still hasn’t worked by ${emailDate(input.readOnlyUntil, input.timeZone)}, your subscription ends.`
    : "If it still doesn’t work, your subscription ends.";
  return renderExomemEmail({
    base: input.scheme,
    themeChoice: input.themeChoice,
    subject: "Your payment didn’t go through",
    preheader: "Evermatter is read-only until billing is fixed. Your memory is safe.",
    band: "readonly",
    headline: "Your payment didn’t go through",
    body: [
      `Evermatter is read-only until it’s fixed: your assistants still recall everything, but nothing new is saved. Paddle will try again. ${ends}`,
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
    scheme: ExomemEmailScheme | null;
    themeChoice?: ExomemThemeChoice | null;
  }
): RenderedEmail {
  const kept = emailCount(emailDaysLeft(input.now, input.keptUntil), "day");
  const deletes = emailDate(input.keptUntil, input.timeZone);
  return renderExomemEmail({
    base: input.scheme,
    themeChoice: input.themeChoice,
    subject: "Your Evermatter subscription has ended",
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
    scheme: ExomemEmailScheme | null;
    themeChoice?: ExomemThemeChoice | null;
  }
): RenderedEmail {
  const left = emailCount(emailDaysLeft(input.now, input.keptUntil), "day");
  const deleted = `On ${emailDate(input.keptUntil, input.timeZone)} your Evermatter and everything in it is permanently deleted, backups included.`;
  return renderExomemEmail({
    base: input.scheme,
    themeChoice: input.themeChoice,
    subject: `${left} until your Evermatter is deleted`,
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
  scheme: ExomemEmailScheme | null;
  themeChoice?: ExomemThemeChoice | null;
}): RenderedEmail {
  const when = emailSameDay(input.deletedAt, input.now, input.timeZone)
    ? "today"
    : `on ${emailDate(input.deletedAt, input.timeZone)}`;
  return renderExomemEmail({
    base: input.scheme,
    themeChoice: input.themeChoice,
    subject: "Your Evermatter has been deleted",
    preheader: "Your vault, backups and keys are gone.",
    band: "gone",
    headline: "Deleted, as promised",
    body: [
      `Your Evermatter, its backups and its keys were permanently deleted ${when}. Your Substrate account is still here, and you can start a new Evermatter any time.`,
    ],
    smallPrint: "Nothing more will be sent about this Evermatter.",
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
    base: null, // Nothing sends this email yet; its sender passes the scheme.
    subject: "Your Evermatter export is ready",
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
    base: null, // Nothing sends this email yet; its sender passes the scheme.
    subject: `Your Evermatter is ${percent}% full`,
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
    base: null, // Nothing sends this email yet; its sender passes the scheme.
    subject: "Your Evermatter is full",
    preheader: "Recall works. Saving waits for room.",
    band: "readonly",
    headline: "Saving is paused",
    body: [
      "Your Evermatter is full. Recall still works; new saves wait until there is room. Add storage and they carry on where they stopped.",
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
    base: null, // Nothing sends this email yet; its sender passes the scheme.
    subject: "More storage added",
    preheader: `${limit} GB, and saving carries on.`,
    band: "live",
    headline: "More storage added",
    body: [
      `Your Evermatter now has ${limit} GB. Saving carries on. If you turned on Grow automatically, it adds ${gigabytes(input.growStepGb)} GB when it fills, at most once a month, and tells you each time.`,
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
  scheme?: ExomemEmailScheme | null;
  themeChoice?: ExomemThemeChoice | null;
}): RenderedEmail {
  const left = emailDuration(input.now, input.expiresAt);
  const until = emailClock(input.expiresAt, input.timeZone);
  return renderExomemEmail({
    base: input.scheme ?? null,
    themeChoice: input.themeChoice,
    subject: "Confirm your new email",
    preheader: "Nothing changes until you open it.",
    band: "arrive",
    headline: "Confirm your new email",
    body: [
      `Confirm this to send Evermatter sign-in links to ${input.newEmail}. We’ll also request an update to your receipt address. Check Home for the verified result.`,
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
  scheme?: ExomemEmailScheme | null;
  themeChoice?: ExomemThemeChoice | null;
}): RenderedEmail {
  return renderExomemEmail({
    base: input.scheme ?? null,
    themeChoice: input.themeChoice,
    subject: "Your Evermatter email is changing",
    preheader: "If this wasn’t you, stop it here.",
    band: "kept",
    headline: "Your email is changing",
    body: [
      `Someone asked to move your Evermatter to ${maskEmailAddress(input.newEmail)}. If that was you, there is nothing to do. If not, open Home and stop it; your notes are untouched either way.`,
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
    base: null, // Nothing sends this email yet; its sender passes the scheme.
    subject: "Your vault is in Evermatter",
    preheader: "",
    band: "live",
    headline: "Your vault is here",
    body: [
      "Your notes are now in Evermatter, with their folders and links. Your connected apps see them already. The originals are unchanged.",
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

/**
 * The app sign-out notice (notify-owner-of-app-signout): an app's last live
 * token family ended without the owner's action, so it can no longer reach
 * the Exomem. Plain, short, no blame: which app, when, that nothing it saves
 * gets there until it reconnects, and how. A name the app declared itself is
 * marked as its own claim, as Home marks it.
 */
export function renderExomemAppSignoutEmail(input: {
  homeUrl: string;
  /** The same display name Home shows: oauthClientDisplayName's answer. */
  appName: string;
  /** True when the name is the app's own claim (client_metadata). */
  appNameClaimed: boolean;
  signedOutAt: Date;
  timeZone: EmailTimeZone;
  scheme: ExomemEmailScheme | null;
  themeChoice?: ExomemThemeChoice | null;
}): RenderedEmail {
  const day = emailDate(input.signedOutAt, input.timeZone);
  // The subject stays within its slot; a longer self-declared name still names
  // the app in the headline, body and facts. The name gets what the fixed
  // suffix leaves. Truncate by code points so an astral character never leaves
  // a lone surrogate.
  const nameBudget = SUBJECT_SLOT_LENGTH - [...SIGNED_OUT_SUBJECT_SUFFIX].length;
  const namePoints = [...input.appName];
  const subjectName =
    namePoints.length <= nameBudget
      ? input.appName
      : `${namePoints.slice(0, nameBudget - 1).join("")}…`;
  const claim = input.appNameClaimed ? ` “${input.appName}” is what the app calls itself.` : "";
  return renderExomemEmail({
    base: input.scheme,
    themeChoice: input.themeChoice,
    subject: `${subjectName}${SIGNED_OUT_SUBJECT_SUFFIX}`,
    preheader: `Since ${day}, nothing it saves gets there. Reconnect to fix it.`,
    band: "readonly",
    headline: `${input.appName} is signed out`,
    body: [
      `On ${day}, ${input.appName}’s connection to your Evermatter ended. Until it is connected again, nothing ${input.appName} saves reaches your Evermatter.`,
      `Open ${input.appName} and connect again to pick up where it left off.`,
    ],
    detail: {
      kind: "facts",
      rows: [
        { label: "App", value: input.appName },
        { label: "Signed out", value: day },
      ],
    },
    action: { label: "Open Home", url: input.homeUrl },
    smallPrint: `One email per app a day, and only for apps you used lately.${claim} Home lists every connected app.`,
  });
}

/**
 * Service notices, declared by the operator. Both emails say only what the
 * operator declared: the times, the operator's own summary and where to read
 * more. They claim nothing about data or availability that the summary does not.
 */
type ServiceNoticeEmailInput = {
  /** The operator's summary, quoted as written. */
  summary: string;
  statusUrl: string;
  timeZone: EmailTimeZone;
  scheme: ExomemEmailScheme | null;
  themeChoice?: ExomemThemeChoice | null;
};

const SERVICE_NOTICE_REASON = "You’re getting this because you have an Evermatter.";

/** The email before planned maintenance: when it starts and ends, in the reader's zone. */
export function renderExomemMaintenanceScheduledEmail(
  input: ServiceNoticeEmailInput & { startsAt: Date; endsAt: Date }
): RenderedEmail {
  return renderExomemEmail({
    base: input.scheme,
    themeChoice: input.themeChoice,
    subject: `Evermatter maintenance on ${emailDate(input.startsAt, input.timeZone)}`,
    preheader: `Planned for ${emailTimeSpan(input.startsAt, input.endsAt, input.timeZone)}.`,
    band: "live",
    headline: "Planned maintenance",
    body: ["We have planned maintenance on Evermatter.", input.summary],
    detail: {
      kind: "facts",
      rows: [
        { label: "Starts", value: emailDateTime(input.startsAt, input.timeZone) },
        { label: "Ends", value: emailDateTime(input.endsAt, input.timeZone) },
      ],
    },
    action: { label: "See the status page", url: input.statusUrl },
    smallPrint: SERVICE_NOTICE_REASON,
  });
}

/** The email after an incident the operator resolved: when it started and ended. */
export function renderExomemIncidentResolvedEmail(
  input: ServiceNoticeEmailInput & { startedAt: Date; resolvedAt: Date }
): RenderedEmail {
  return renderExomemEmail({
    base: input.scheme,
    themeChoice: input.themeChoice,
    subject: "The Evermatter problem is resolved",
    preheader: `It ran from ${emailTimeSpan(input.startedAt, input.resolvedAt, input.timeZone)}.`,
    band: "live",
    headline: "The problem is resolved",
    body: ["The Evermatter problem we reported is resolved.", `We reported: ${input.summary}`],
    detail: {
      kind: "facts",
      rows: [
        { label: "Started", value: emailDateTime(input.startedAt, input.timeZone) },
        { label: "Ended", value: emailDateTime(input.resolvedAt, input.timeZone) },
      ],
    },
    action: { label: "See the status page", url: input.statusUrl },
    smallPrint: SERVICE_NOTICE_REASON,
  });
}
