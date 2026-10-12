/**
 * The invitation contract that the server and the operator page share.
 * It imports nothing, so a client component can import it too.
 * Migration 0065's checks hold the same kinds and limits in the database.
 */

/** Standard is paid; friend is paid with the friend price; covered is complimentary. */
export const EXOMEM_INVITE_KINDS = ["standard", "friend", "covered"] as const;

export type ExomemInviteKind = (typeof EXOMEM_INVITE_KINDS)[number];

/** The most characters an inviter's or invitee's name may have. */
export const INVITATION_NAME_MAX = 60;

/** The most characters an inviter's note may have. */
export const INVITATION_NOTE_MAX = 280;

/** Emails 09 and 10 name who invites or covers, so those kinds need the inviter's name. */
export function inviterNameRequired(kind: ExomemInviteKind): boolean {
  return kind !== "standard";
}

/** Only a friend invitation tells its inviter anything (emails 12 and 13). */
export function inviterEmailAllowed(kind: ExomemInviteKind): boolean {
  return kind === "friend";
}

/** Emails 12 and 13 name the invitee to the inviter, so an inviter's email needs the invitee's name. */
export function inviteeNameRequired(kind: ExomemInviteKind, hasInviterEmail: boolean): boolean {
  return inviterEmailAllowed(kind) && hasInviterEmail;
}
