import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  billingSummary,
  startOwnerCheckout,
  startOwnerPortal,
  type OwnerBillingAccount,
} from "../billing-account";
import { ExomemHostedError } from "../errors";

const ACCOUNT: OwnerBillingAccount = {
  userId: "018f2d91-7c42-7000-8000-0000000000a1",
  tenantId: "018f2d91-7c42-7000-8000-0000000000a2",
  source: "paddle",
  sourceState: "awaiting_checkout",
  effectiveState: "provisioning",
  customerRef: null,
  subscriptionRef: null,
  transactionRef: null,
};

describe("owner Exomem billing account", () => {
  it("keeps complimentary alpha out of Paddle request paths", () => {
    assert.deepEqual(
      billingSummary({
        ...ACCOUNT,
        source: "complimentary",
        sourceState: "complimentary_active",
        effectiveState: "active",
      }),
      {
        source: "complimentary",
        state: "active",
        checkoutAvailable: false,
        portalAvailable: false,
      }
    );
  });

  it("creates checkout with only session-derived owner and tenant", async () => {
    let input: unknown;
    const result = await startOwnerCheckout(ACCOUNT.userId, ACCOUNT.tenantId, {
      load: async () => ACCOUNT,
      checkout: async (value) => {
        input = value;
        return { checkoutUrl: "https://checkout.paddle.test/exomem" };
      },
    });
    assert.deepEqual(input, { userId: ACCOUNT.userId, tenantId: ACCOUNT.tenantId });
    assert.equal(result.checkoutUrl, "https://checkout.paddle.test/exomem");
  });

  it("reuses the authoritative Paddle transaction instead of creating an orphan retry", async () => {
    const transactionRef = `txn_${"a".repeat(26)}`;
    let resumed: unknown;
    const result = await startOwnerCheckout(ACCOUNT.userId, ACCOUNT.tenantId, {
      load: async () => ({ ...ACCOUNT, transactionRef }),
      checkout: async () => {
        throw new Error("must not create a second transaction");
      },
      resume: async (value) => {
        resumed = value;
        return { checkoutUrl: "https://checkout.paddle.test/resumed" };
      },
    });

    assert.deepEqual(resumed, {
      userId: ACCOUNT.userId,
      tenantId: ACCOUNT.tenantId,
      transactionId: transactionRef,
    });
    assert.equal(result.checkoutUrl, "https://checkout.paddle.test/resumed");
  });

  it("uses internal provider references only for portal creation", async () => {
    let input: unknown;
    const result = await startOwnerPortal(ACCOUNT.userId, ACCOUNT.tenantId, {
      load: async () => ({
        ...ACCOUNT,
        sourceState: "active",
        effectiveState: "active",
        customerRef: "ctm_internal",
        subscriptionRef: "sub_internal",
      }),
      portal: async (value) => {
        input = value;
        return { portalUrl: "https://portal.paddle.test/session" };
      },
    });
    assert.deepEqual(input, {
      userId: ACCOUNT.userId,
      tenantId: ACCOUNT.tenantId,
      customerId: "ctm_internal",
      subscriptionId: "sub_internal",
    });
    assert.equal(result.portalUrl, "https://portal.paddle.test/session");
  });

  it("denies provider paths for the wrong billing source", async () => {
    await assert.rejects(
      startOwnerCheckout(ACCOUNT.userId, ACCOUNT.tenantId, {
        load: async () => ({ ...ACCOUNT, source: "complimentary" }),
      }),
      (error) => error instanceof ExomemHostedError && error.code === "EXOMEM_ENTITLEMENT_DENIED"
    );
  });
});
