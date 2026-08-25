import { EXOMEM_ALPHA_CAPACITY } from "@/lib/exomem-hosted/oauth-admission";

export type OperatorCapacity = {
  storageCapacityBytes: number;
  reservedStorageBytes: number;
  runtimeCapacitySlots: number;
  reservedRuntimeSlots: number;
  provisionReservationCapacity: number;
  reservedProvisionSlots: number;
  provisionClaimCapacity: number;
  activeProvisionClaims: number;
  outstandingPaidInvites: number;
};

export type InviteSource = "paid" | "complimentary";

const capacityKeys = [
  "storageCapacityBytes",
  "reservedStorageBytes",
  "runtimeCapacitySlots",
  "reservedRuntimeSlots",
  "provisionReservationCapacity",
  "reservedProvisionSlots",
  "provisionClaimCapacity",
  "activeProvisionClaims",
  "outstandingPaidInvites",
] as const;

export function parseOperatorCapacity(value: unknown): OperatorCapacity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    capacityKeys.some(
      (key) =>
        typeof record[key] !== "number" ||
        !Number.isSafeInteger(record[key]) ||
        Number(record[key]) < 0
    )
  ) {
    return null;
  }
  return Object.fromEntries(capacityKeys.map((key) => [key, record[key]])) as OperatorCapacity;
}

export function paidInviteHeadroom(capacity: OperatorCapacity): number {
  const storageSlots = Math.floor(
    (capacity.storageCapacityBytes - capacity.reservedStorageBytes) /
      EXOMEM_ALPHA_CAPACITY.storageBytes
  );
  const runtimeSlots = Math.floor(
    (capacity.runtimeCapacitySlots - capacity.reservedRuntimeSlots) /
      EXOMEM_ALPHA_CAPACITY.runtimeSlots
  );
  const provisionSlots = Math.floor(
    (capacity.provisionReservationCapacity - capacity.reservedProvisionSlots) /
      EXOMEM_ALPHA_CAPACITY.provisionReservationSlots
  );
  return Math.max(
    0,
    Math.min(storageSlots, runtimeSlots, provisionSlots) - capacity.outstandingPaidInvites
  );
}

export function requiresComplimentaryConfirmation(
  source: InviteSource,
  confirmed: boolean
): boolean {
  return source === "complimentary" && !confirmed;
}
