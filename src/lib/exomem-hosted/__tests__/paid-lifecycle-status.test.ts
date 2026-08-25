import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { __setExomemSqlForTests } from "../db";
import { SqlLifecycleStore } from "../lifecycle-store";

afterEach(() => {
  __setExomemSqlForTests(null);
});

describe("paid owner lifecycle status", () => {
  it("derives awaiting payment from Paddle state, a reservation, and no operation", async () => {
    __setExomemSqlForTests(async () => ({
      rows: [
        {
          tenant_status: "provisioning",
          bound_cell_id: null,
          lifecycle_state: null,
          readiness_code: null,
          operation_state: null,
          operation_type: null,
          error_code: null,
          request_id: null,
          entitlement_source: "paddle",
          entitlement_source_state: "awaiting_checkout",
          allocation_state: "reserved",
          allocation_operation_id: null,
        },
      ],
      rowCount: 1,
    }));

    assert.deepEqual(await new SqlLifecycleStore().statusForTenant("tenant-paid"), {
      state: "awaiting_payment",
      code: "PAYMENT_REQUIRED",
      retryable: false,
    });
  });
});
