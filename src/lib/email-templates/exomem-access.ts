/**
 * The Exomem access emails, on the one template (exomem-email.ts): sign-in
 * (01), start (01w), invitation (02), waitlist, place opened, the unpaid-hold
 * reminder (18) and the deletion confirmation. Copy is verbatim from the
 * boards (R12-Lifecycle for 01 and 02, the landing board's inbox for 01w,
 * R28-Emails for 18) and the product owner's approved copy (2026-10-12) for
 * the waitlist and place-opened emails. Every time limit is computed here, at
 * send, in the reader's zone.
 */

import { renderExomemEmail, type RenderedExomemEmail } from "./exomem-email";
import {
  emailClock,
  emailDate,
  emailDateTime,
  emailDuration,
  emailShortDateTime,
  type EmailTimeZone,
} from "./exomem-email-time";

export type RenderedExomemAccessEmail = RenderedExomemEmail;

/** "until 09:20 (15 minutes)": the link's end and what is left of it. */
function linkLimit(expiresAt: Date, now: Date, until: string): string {
  const left = emailDuration(now, expiresAt);
  return left ? `${until} (${left})` : until;
}

/** Email 01: a sign-in link for the owner of an Exomem. */
export function renderExomemMagicLinkEmail(input: {
  accessUrl: string;
  expiresAt: Date;
  now?: Date;
  timeZone?: string | null;
}): RenderedExomemAccessEmail {
  const now = input.now ?? new Date();
  const left = emailDuration(now, input.expiresAt);
  return renderExomemEmail({
    subject: "Sign in to Exomem",
    preheader: left ? `Your link works once, for ${left}.` : "Your link works once.",
    band: "arrive",
    headline: "Your sign-in link",
    body: [
      "Open it on the device where you asked for it. It brings you straight back to where you were.",
    ],
    action: { label: "Sign in to Exomem", url: input.accessUrl },
    smallPrint: `Works once, until ${linkLimit(input.expiresAt, now, emailClock(input.expiresAt, input.timeZone))}. If you didn’t ask for this, ignore it: nothing happens.`,
  });
}

/**
 * Email 01w: a start link from "Start with your email". The board's inbox
 * shows a 15-minute link; a start link lasts 48 hours (owner decision 8), so
 * its end carries a date.
 */
export function renderExomemWelcomeEmail(input: {
  accessUrl: string;
  expiresAt: Date;
  now?: Date;
  timeZone?: string | null;
}): RenderedExomemAccessEmail {
  const now = input.now ?? new Date();
  const left = emailDuration(now, input.expiresAt);
  return renderExomemEmail({
    subject: "Start your Exomem",
    preheader: left ? `Your link works once, for ${left}.` : "Your link works once.",
    band: "arrive",
    headline: "Let’s start your Exomem.",
    body: ["One tap and you’re in. Next: choose your plan, then add Exomem to your assistant."],
    action: { label: "Start Exomem", url: input.accessUrl },
    smallPrint: `The link works once, until ${linkLimit(input.expiresAt, now, emailDateTime(input.expiresAt, input.timeZone))}. If you didn’t ask for it, ignore this email.`,
  });
}

/**
 * Email 02: an operator's invitation. The board's body named four
 * assistants; the product never names a fixed number of them, so the first
 * sentence is the positioning line instead. The small print names the
 * invited address when the caller passes it.
 */
export function renderExomemInviteEmail(input: {
  accessUrl: string;
  expiresAt: Date;
  email?: string | null;
  now?: Date;
  timeZone?: string | null;
}): RenderedExomemAccessEmail {
  const until = emailDate(input.expiresAt, input.timeZone);
  return renderExomemEmail({
    subject: "You’re invited to Exomem",
    preheader: "One memory for every assistant you use.",
    band: "arrive",
    headline: "Start your Exomem",
    body: [
      "One memory for every assistant and every session you connect. Everything you keep stays yours, with its source.",
    ],
    action: { label: "Accept invitation", url: input.accessUrl },
    smallPrint: input.email
      ? `This invitation is for ${input.email} and works until ${until}.`
      : `This invitation works until ${until}.`,
  });
}

/**
 * Email 18: a person who accepted but has not paid, two days before their
 * unpaid hold ends. The board's copy names the inviter. A self-serve start, or
 * an operator invitation without a name, has none, and uses the product
 * owner's approved sentence without one.
 */
export function renderExomemHoldReminderEmail(input: {
  setupUrl: string;
  holdEndsAt: Date;
  inviterName: string | null;
  timeZone?: string | null;
}): RenderedExomemAccessEmail {
  const deadline = emailDate(input.holdEndsAt, input.timeZone);
  const body = input.inviterName
    ? `You accepted ${input.inviterName}’s invitation but haven’t subscribed yet. Finish by ${deadline} and everything is as you left it. After that we release the setup; the invitation stays used.`
    : `You started setting up Exomem but haven’t subscribed yet. Finish by ${deadline} and everything is as you left it. After that we release the setup.`;
  return renderExomemEmail({
    subject: "Finish setting up your Exomem",
    preheader: `Finish by ${deadline}.`,
    band: "arrive",
    headline: "Your Exomem is waiting",
    body: [body],
    action: { label: "Finish setting up", url: input.setupUrl },
    smallPrint: "We send this once. If you’ve changed your mind, ignore it.",
  });
}

/** The waitlist email, in the product owner's approved copy (2026-10-12). */
export function renderExomemWaitlistEmail(): RenderedExomemAccessEmail {
  return renderExomemEmail({
    subject: "You're on the Exomem waitlist",
    preheader: "We'll email you when a place opens.",
    band: "arrive",
    headline: "You're on the list",
    body: [
      "Exomem is full for now. We add room as we grow. When a place opens for you, we'll send a link to start.",
    ],
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
  const zone: EmailTimeZone = input.timeZone;
  const time = emailShortDateTime(input.expiresAt, zone);
  return renderExomemEmail({
    subject: "Your place in Exomem is ready",
    preheader: zone ? `Start before ${time} to keep it.` : `Start before ${time} UTC to keep it.`,
    band: "arrive",
    headline: "Your place is ready",
    body: ["A place opened up for you. Start your Exomem, then add it to your assistant."],
    action: { label: "Start Exomem", url: input.accessUrl },
    smallPrint: `The link works once, until ${time} ${zone ? "(your time)" : "UTC"}. If you don't use it, the place goes to the next person on the list.`,
  });
}

/**
 * The deletion confirmation link. No board draws this email (design.md
 * deviation (t)): the preheader and the last sentence are the Home board's
 * delete dialog, the headline is that dialog's title, and the body says what
 * the deletion removes in the dialog's words.
 */
export function renderExomemDeletionEmail(input: {
  accessUrl: string;
  expiresAt: Date;
  now?: Date;
  timeZone?: string | null;
}): RenderedExomemAccessEmail {
  const now = input.now ?? new Date();
  return renderExomemEmail({
    subject: "Confirm deletion of your Exomem",
    preheader: "Nothing is deleted until you open the link.",
    band: "fading",
    headline: "Delete your Exomem?",
    body: [
      "You asked to delete your Exomem. This removes your notes, files, backups, exports and encryption keys for good.",
    ],
    action: { label: "Review and confirm deletion", url: input.accessUrl },
    smallPrint: `Works once, until ${linkLimit(input.expiresAt, now, emailClock(input.expiresAt, input.timeZone))}. Ignore it and your Exomem stays.`,
  });
}
