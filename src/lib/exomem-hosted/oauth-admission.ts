export const EXOMEM_ALPHA_CAPACITY = {
  storageBytes: 5 * 1024 * 1024 * 1024,
  runtimeSlots: 1,
  provisionReservationSlots: 1,
} as const;

/**
 * A deterministic transactional seam for admission tests. Production storage
 * performs the same compare-and-increment transition in one SQL statement.
 */
export class CapacityAdmissionLedger {
  readonly #reservations = new Set<string>();
  readonly #claims = new Set<string>();
  #storageBytes = 0;
  #runtimeSlots = 0;

  constructor(
    private readonly capacity: {
      storageCapacityBytes: number;
      runtimeCapacitySlots: number;
      provisionReservationCapacity: number;
      provisionClaimCapacity: number;
      configured: boolean;
    }
  ) {}

  reserve(identity: string): boolean {
    if (this.#reservations.has(identity)) return true;
    if (
      !this.capacity.configured ||
      this.#storageBytes + EXOMEM_ALPHA_CAPACITY.storageBytes >
        this.capacity.storageCapacityBytes ||
      this.#runtimeSlots + EXOMEM_ALPHA_CAPACITY.runtimeSlots >
        this.capacity.runtimeCapacitySlots ||
      this.#reservations.size + EXOMEM_ALPHA_CAPACITY.provisionReservationSlots >
        this.capacity.provisionReservationCapacity
    ) {
      return false;
    }
    this.#reservations.add(identity);
    this.#storageBytes += EXOMEM_ALPHA_CAPACITY.storageBytes;
    this.#runtimeSlots += EXOMEM_ALPHA_CAPACITY.runtimeSlots;
    return true;
  }

  isReserved(identity: string): boolean {
    return this.#reservations.has(identity);
  }

  claim(identity: string): boolean {
    if (
      !this.#reservations.has(identity) ||
      this.#claims.has(identity) ||
      this.#claims.size >= this.capacity.provisionClaimCapacity
    ) {
      return false;
    }
    this.#claims.add(identity);
    return true;
  }

  releaseClaim(identity: string): void {
    this.#claims.delete(identity);
  }
}
