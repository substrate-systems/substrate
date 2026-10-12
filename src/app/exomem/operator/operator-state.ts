import type { CloudCapacityStatus } from "@/lib/exomem-hosted/cloud-capacity";

export type OperatorCapacity = CloudCapacityStatus;

export type InviteSource = "paid" | "complimentary";

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
 * Every invitation, paid or complimentary, takes a Cloud place, so the page
 * blocks sending while no place is free or capacity is unknown. The server
 * refuses the same request; this only saves a round trip.
 */
export function invitationBlocked(capacity: OperatorCapacity): boolean {
  return capacity.freePlaces === null || capacity.freePlaces === 0;
}

export function requiresComplimentaryConfirmation(
  source: InviteSource,
  confirmed: boolean
): boolean {
  return source === "complimentary" && !confirmed;
}
