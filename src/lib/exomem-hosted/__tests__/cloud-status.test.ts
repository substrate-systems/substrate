import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapCloudCellToLifecycleStatus } from "../cloud-status";

// Item 6 / task 3.7: the pure entitlement+cell -> LifecycleStatus mapping
// that /api/exomem/status's Cloud branch relies on. This is new logic (no
// prior hosted behaviour to regress), so it is asserted directly against the
// table D1/D4 specify rather than red-first against an existing caller --
// the route-level wiring test (status/__tests__/route.test.ts) is the
// red-first check that the route actually reaches this function.
function row(overrides: Partial<Parameters<typeof mapCloudCellToLifecycleStatus>[0]> = {}) {
  return {
    desired_state: "running" as const,
    observed_state: "running" as const,
    ready: true,
    last_error_code: null,
    source_state: "active",
    ...overrides,
  };
}

describe("mapCloudCellToLifecycleStatus", () => {
  it("reports preparing, retryable, when no cell row exists", () => {
    assert.deepEqual(mapCloudCellToLifecycleStatus(undefined), {
      state: "preparing",
      code: "TENANT_PREPARING",
      retryable: true,
    });
  });

  it("reports deleted for a deleted cell regardless of anything else", () => {
    assert.deepEqual(
      mapCloudCellToLifecycleStatus(row({ desired_state: "deleted", source_state: "cancelled" })),
      { state: "deleted", code: "EXOMEM_DELETED", retryable: false }
    );
  });

  it("reports awaiting_payment for an unpaid invite's stopped cell", () => {
    assert.deepEqual(
      mapCloudCellToLifecycleStatus(
        row({ desired_state: "stopped", observed_state: null, ready: false, source_state: "awaiting_checkout" })
      ),
      { state: "awaiting_payment", code: "PAYMENT_REQUIRED", retryable: false }
    );
  });

  it("reports suspended for a stopped cell that is not awaiting checkout", () => {
    assert.deepEqual(
      mapCloudCellToLifecycleStatus(
        row({ desired_state: "stopped", observed_state: "stopped", ready: false, source_state: "paused" })
      ),
      { state: "suspended", code: "EXOMEM_SUSPENDED", retryable: false }
    );
  });

  it("reports ready when observed state matches desired state and the cell is ready", () => {
    assert.deepEqual(mapCloudCellToLifecycleStatus(row()), {
      state: "ready",
      code: "CELL_READY",
      retryable: false,
    });
    assert.deepEqual(
      mapCloudCellToLifecycleStatus(
        row({ desired_state: "read_only", observed_state: "read_only", source_state: "cancelled" })
      ),
      { state: "ready", code: "CELL_READY", retryable: false }
    );
  });

  it("reports preparing while the cell has not yet been observed at all, or is still coming up", () => {
    assert.deepEqual(
      mapCloudCellToLifecycleStatus(row({ observed_state: null, ready: false })),
      { state: "preparing", code: "CELL_PREPARING", retryable: true }
    );
    assert.deepEqual(
      mapCloudCellToLifecycleStatus(row({ observed_state: "provisioning", ready: false })),
      { state: "preparing", code: "CELL_PREPARING", retryable: true }
    );
  });

  it("reports degraded, never leaking the cellctl error code, when the cell has failed", () => {
    assert.deepEqual(
      mapCloudCellToLifecycleStatus(
        row({ observed_state: "failed", ready: false, last_error_code: "CELLCTL_INTERNAL_SENTINEL" })
      ),
      { state: "degraded", code: "CELL_NOT_READY", retryable: true }
    );
  });

  it("reports degraded for any other observed/desired mismatch", () => {
    assert.deepEqual(
      mapCloudCellToLifecycleStatus(row({ observed_state: "stopping", ready: false })),
      { state: "degraded", code: "CELL_NOT_READY", retryable: true }
    );
  });
});
