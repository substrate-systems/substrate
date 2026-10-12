import type { CloudCapacityStatus } from "@/lib/exomem-hosted/cloud-capacity";
import {
  inviterEmailAllowed,
  type ExomemInviteKind,
} from "@/lib/exomem-hosted/invitation-contract";

export type OperatorCapacity = CloudCapacityStatus;

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Accepts only a complete capacity read. `freePlaces` is `null` exactly when
 * the server reports why it is unknown.
 */
export function parseOperatorCapacity(value: unknown): OperatorCapacity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !count(record.observedSlots) ||
    !count(record.liveCells) ||
    !count(record.outstandingInvitations) ||
    (record.newestObservationAt !== null && typeof record.newestObservationAt !== "string")
  ) {
    return null;
  }
  const known = count(record.freePlaces) && record.freePlacesUnknownReason === null;
  const unknown =
    record.freePlaces === null && record.freePlacesUnknownReason === "capacity_not_observed";
  if (!known && !unknown) return null;
  return {
    freePlaces: known ? (record.freePlaces as number) : null,
    freePlacesUnknownReason: known ? null : "capacity_not_observed",
    observedSlots: record.observedSlots,
    liveCells: record.liveCells,
    outstandingInvitations: record.outstandingInvitations,
    newestObservationAt: record.newestObservationAt as string | null,
  };
}

/**
 * Every invitation, of any kind, takes a Cloud place, so the page
 * blocks sending while no place is free or capacity is unknown. The server
 * refuses the same request; this only saves a round trip.
 */
export function invitationBlocked(capacity: OperatorCapacity): boolean {
  return capacity.freePlaces === null || capacity.freePlaces === 0;
}

export function requiresComplimentaryConfirmation(
  kind: ExomemInviteKind,
  confirmed: boolean
): boolean {
  return kind === "covered" && !confirmed;
}

export type InvitationDraft = {
  email: string;
  kind: ExomemInviteKind;
  inviterName: string;
  inviterEmail: string;
  inviteeName: string;
  note: string;
};

/** The request body for one invitation: blank optional fields are left out. */
export function invitationRequestBody(draft: InvitationDraft): Record<string, string> {
  const body: Record<string, string> = { email: draft.email.trim(), kind: draft.kind };
  const optional: Array<[string, string]> = [
    ["inviterName", draft.inviterName],
    ["inviteeName", draft.inviteeName],
    ["note", draft.note],
  ];
  if (inviterEmailAllowed(draft.kind)) optional.push(["inviterEmail", draft.inviterEmail]);
  for (const [key, value] of optional) {
    if (value.trim()) body[key] = value.trim();
  }
  return body;
}
