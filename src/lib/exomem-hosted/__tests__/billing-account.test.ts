import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  billingSummary,
  resumeReturnedOwnerCheckout,
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
  providerEnvironment: null,
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
      load: async () => ({ ...ACCOUNT, transactionRef, providerEnvironment: "sandbox" }),
      checkout: async () => {
        throw new Error("must not create a second transaction");
      },
      resume: async (value) => {
        resumed = value;
        return { state: "open", checkoutUrl: "https://checkout.paddle.test/resumed" };
      },
    });

    assert.deepEqual(resumed, {
      userId: ACCOUNT.userId,
      tenantId: ACCOUNT.tenantId,
      transactionId: transactionRef,
      environment: "sandbox",
    });
    assert.equal(result.checkoutUrl, "https://checkout.paddle.test/resumed");
  });

  it("resumes a returned checkout only when it is bound to the signed-in owner", async () => {
    const transactionRef = `txn_${"a".repeat(26)}`;
    let resumed: unknown;
    const result = await resumeReturnedOwnerCheckout(
      ACCOUNT.userId,
      ACCOUNT.tenantId,
      transactionRef,
      {
        load: async () => ({ ...ACCOUNT, transactionRef, providerEnvironment: "sandbox" }),
        resume: async (value) => {
          resumed = value;
          return {
            state: "open",
            checkoutUrl: `https://substratesystems.io/exomem/home?_ptxn=${transactionRef}`,
          };
        },
      }
    );

    assert.deepEqual(resumed, {
      userId: ACCOUNT.userId,
      tenantId: ACCOUNT.tenantId,
      transactionId: transactionRef,
      environment: "sandbox",
    });
    assert.equal(result.state, "open");
    assert.match(result.checkoutUrl, new RegExp(transactionRef));
  });

  it("settles a canceled returned checkout after compare-clearing its exact binding", async () => {
    const transactionRef = `txn_${"a".repeat(26)}`;
    const calls: Array<{ operation: string; input: unknown }> = [];

    const result = await resumeReturnedOwnerCheckout(
      ACCOUNT.userId,
      ACCOUNT.tenantId,
      transactionRef,
      {
        load: async () => ({ ...ACCOUNT, transactionRef, providerEnvironment: "sandbox" }),
        resume: async (input) => {
          calls.push({ operation: "resume", input });
          return { state: "canceled" };
        },
        clearTransaction: async (input) => {
          calls.push({ operation: "clear", input });
          return true;
        },
      }
    );

    assert.deepEqual(result, { state: "settled" });
    assert.deepEqual(calls, [
      {
        operation: "resume",
        input: {
          userId: ACCOUNT.userId,
          tenantId: ACCOUNT.tenantId,
          transactionId: transactionRef,
          environment: "sandbox",
        },
      },
      {
        operation: "clear",
        input: {
          userId: ACCOUNT.userId,
          tenantId: ACCOUNT.tenantId,
          transactionId: transactionRef,
          environment: "sandbox",
        },
      },
    ]);
  });

  it("settles a completed returned checkout after promoting and reconciling it", async () => {
    const transactionRef = `txn_${"a".repeat(26)}`;
    const subscriptionRef = `sub_${"b".repeat(26)}`;
    const customerRef = `ctm_${"c".repeat(26)}`;
    const calls: Array<{ operation: string; input: unknown }> = [];

    const result = await resumeReturnedOwnerCheckout(
      ACCOUNT.userId,
      ACCOUNT.tenantId,
      transactionRef,
      {
        load: async () => ({ ...ACCOUNT, transactionRef, providerEnvironment: "sandbox" }),
        resume: async (input) => {
          calls.push({ operation: "resume", input });
          return {
            state: "completed",
            customerId: customerRef,
            subscriptionId: subscriptionRef,
          };
        },
        promoteSubscription: async (input) => {
          calls.push({ operation: "promote", input });
          return true;
        },
        reconcileSubscription: async (input) => {
          calls.push({ operation: "reconcile", input });
        },
      }
    );

    assert.deepEqual(result, { state: "settled" });
    assert.deepEqual(calls, [
      {
        operation: "resume",
        input: {
          userId: ACCOUNT.userId,
          tenantId: ACCOUNT.tenantId,
          transactionId: transactionRef,
          environment: "sandbox",
        },
      },
      {
        operation: "promote",
        input: {
          userId: ACCOUNT.userId,
          tenantId: ACCOUNT.tenantId,
          transactionId: transactionRef,
          subscriptionId: subscriptionRef,
          customerId: customerRef,
          environment: "sandbox",
        },
      },
      {
        operation: "reconcile",
        input: {
          userId: ACCOUNT.userId,
          tenantId: ACCOUNT.tenantId,
          subscriptionId: subscriptionRef,
          environment: "sandbox",
        },
      },
    ]);
  });

  it("settles a completed return when immediate reconciliation fails after durable promotion", async () => {
    const transactionRef = `txn_${"a".repeat(26)}`;
    const subscriptionRef = `sub_${"b".repeat(26)}`;
    let promoted = false;

    const result = await resumeReturnedOwnerCheckout(
      ACCOUNT.userId,
      ACCOUNT.tenantId,
      transactionRef,
      {
        load: async () => ({ ...ACCOUNT, transactionRef, providerEnvironment: "sandbox" }),
        resume: async () => ({
          state: "completed",
          customerId: `ctm_${"c".repeat(26)}`,
          subscriptionId: subscriptionRef,
        }),
        promoteSubscription: async () => {
          promoted = true;
          return true;
        },
        reconcileSubscription: async () => {
          throw new Error("transient provider failure with sensitive detail");
        },
      }
    );

    assert.equal(promoted, true);
    assert.deepEqual(result, { state: "settled" });
  });

  it("rejects another owner's returned transaction before contacting Paddle", async () => {
    const ownerTransaction = `txn_${"a".repeat(26)}`;
    const unboundTransaction = `txn_${"b".repeat(26)}`;
    let resumeCalls = 0;

    await assert.rejects(
      resumeReturnedOwnerCheckout(ACCOUNT.userId, ACCOUNT.tenantId, unboundTransaction, {
        load: async () => ({
          ...ACCOUNT,
          transactionRef: ownerTransaction,
          providerEnvironment: "sandbox",
        }),
        resume: async () => {
          resumeCalls += 1;
          return { state: "open", checkoutUrl: "https://example.invalid" };
        },
      }),
      (error) => error instanceof ExomemHostedError && error.code === "EXOMEM_ENTITLEMENT_DENIED"
    );
    assert.equal(resumeCalls, 0);
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
        providerEnvironment: "sandbox",
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
      environment: "sandbox",
    });
    assert.equal(result.portalUrl, "https://portal.paddle.test/session");
  });

  it("denies provider paths for the wrong billing source", async () => {
    await assert.rejects(
      startOwnerCheckout(ACCOUNT.userId, ACCOUNT.tenantId, {
        load: async () => ({ ...ACCOUNT, source: "complimentary" }),
      })
    );
  });

  it("fails closed when a stored transaction has no Paddle environment provenance", async () => {
    let resumeCalls = 0;
    await assert.rejects(
      startOwnerCheckout(ACCOUNT.userId, ACCOUNT.tenantId, {
        load: async () => ({ ...ACCOUNT, transactionRef: `txn_${"a".repeat(26)}` }),
        resume: async () => {
          resumeCalls += 1;
          return { state: "open", checkoutUrl: "https://example.invalid" };
        },
      }),
      (error) => error instanceof ExomemHostedError && error.code === "EXOMEM_ENTITLEMENT_DENIED"
    );
    assert.equal(resumeCalls, 0);
  });

  it("compare-clears a canceled checkout before creating its replacement", async () => {
    const transactionRef = `txn_${"a".repeat(26)}`;
    const calls: Array<{ operation: string; input: unknown }> = [];

    const result = await startOwnerCheckout(ACCOUNT.userId, ACCOUNT.tenantId, {
      load: async () => ({ ...ACCOUNT, transactionRef, providerEnvironment: "sandbox" }),
      resume: async (input) => {
        calls.push({ operation: "resume", input });
        return { state: "canceled" };
      },
      clearTransaction: async (input) => {
        calls.push({ operation: "clear", input });
        return true;
      },
      checkout: async (input) => {
        calls.push({ operation: "checkout", input });
        return { checkoutUrl: "https://checkout.paddle.test/replacement" };
      },
    });

    assert.deepEqual(calls, [
      {
        operation: "resume",
        input: {
          userId: ACCOUNT.userId,
          tenantId: ACCOUNT.tenantId,
          transactionId: transactionRef,
          environment: "sandbox",
        },
      },
      {
        operation: "clear",
        input: {
          userId: ACCOUNT.userId,
          tenantId: ACCOUNT.tenantId,
          transactionId: transactionRef,
          environment: "sandbox",
        },
      },
      {
        operation: "checkout",
        input: { userId: ACCOUNT.userId, tenantId: ACCOUNT.tenantId },
      },
    ]);
    assert.deepEqual(result, {
      checkoutUrl: "https://checkout.paddle.test/replacement",
    });
  });

  it("does not replace a canceled checkout after the compare-clear loses its race", async () => {
    let checkoutCalls = 0;
    await assert.rejects(
      startOwnerCheckout(ACCOUNT.userId, ACCOUNT.tenantId, {
        load: async () => ({
          ...ACCOUNT,
          transactionRef: `txn_${"a".repeat(26)}`,
          providerEnvironment: "sandbox",
        }),
        resume: async () => ({ state: "canceled" }),
        clearTransaction: async () => false,
        checkout: async () => {
          checkoutCalls += 1;
          return { checkoutUrl: "https://example.invalid" };
        },
      }),
      (error) =>
        error instanceof ExomemHostedError && error.code === "EXOMEM_BILLING_STATE_CONFLICT"
    );
    assert.equal(checkoutCalls, 0);
  });

  it("promotes and reconciles a completed checkout without creating another transaction", async () => {
    const transactionRef = `txn_${"a".repeat(26)}`;
    const subscriptionRef = `sub_${"b".repeat(26)}`;
    const customerRef = `ctm_${"c".repeat(26)}`;
    const calls: Array<{ operation: string; input: unknown }> = [];

    await assert.rejects(
      startOwnerCheckout(ACCOUNT.userId, ACCOUNT.tenantId, {
        load: async () => ({ ...ACCOUNT, transactionRef, providerEnvironment: "sandbox" }),
        resume: async (input) => {
          calls.push({ operation: "resume", input });
          return {
            state: "completed",
            customerId: customerRef,
            subscriptionId: subscriptionRef,
          };
        },
        promoteSubscription: async (input) => {
          calls.push({ operation: "promote", input });
          return true;
        },
        reconcileSubscription: async (input) => {
          calls.push({ operation: "reconcile", input });
        },
        checkout: async () => {
          throw new Error("must not create a transaction after Paddle completed checkout");
        },
      }),
      (error) =>
        error instanceof ExomemHostedError && error.code === "EXOMEM_BILLING_STATE_CONFLICT"
    );

    assert.deepEqual(calls, [
      {
        operation: "resume",
        input: {
          userId: ACCOUNT.userId,
          tenantId: ACCOUNT.tenantId,
          transactionId: transactionRef,
          environment: "sandbox",
        },
      },
      {
        operation: "promote",
        input: {
          userId: ACCOUNT.userId,
          tenantId: ACCOUNT.tenantId,
          transactionId: transactionRef,
          environment: "sandbox",
          customerId: customerRef,
          subscriptionId: subscriptionRef,
        },
      },
      {
        operation: "reconcile",
        input: {
          userId: ACCOUNT.userId,
          tenantId: ACCOUNT.tenantId,
          subscriptionId: subscriptionRef,
          environment: "sandbox",
        },
      },
    ]);
  });
});
