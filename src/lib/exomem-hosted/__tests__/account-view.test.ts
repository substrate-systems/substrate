import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildExomemAccountView, type ExomemAccountRow } from "../account-view";

const FRIEND_DISCOUNT = "dsc_friend_price_example";

function paidRow(overrides: Partial<ExomemAccountRow> = {}): ExomemAccountRow {
  return {
    email: "owner@example.test",
    timeZone: null,
    supportReference: "7Q4M",
    source: "paddle",
    sourceState: "active",
    effectiveState: "active",
    manuallySuspended: false,
    sourceOccurredAt: new Date("2026-10-01T09:00:00.000Z"),
    sourceRevision: "evt_example",
    subscriptionRef: "sub_example",
    providerEnvironment: "sandbox",
    priceId: "pri_monthly_example",
    priceName: "Monthly",
    nextBilledAt: new Date("2026-11-01T09:00:00.000Z"),
    discountId: null,
    graceStartedAt: null,
    reviewerExpiresAt: null,
    friendOffered: false,
    friendInviterName: null,
    ...overrides,
  };
}

const owner = { reviewer: false, environment: {} };

describe("Exomem account view", () => {
  it("names why a complimentary reviewer account has no payment dates, and shows when access ends", () => {
    const view = buildExomemAccountView(
      paidRow({
        source: "complimentary",
        sourceState: "complimentary_active",
        subscriptionRef: null,
        priceId: null,
        priceName: null,
        nextBilledAt: null,
        reviewerExpiresAt: new Date("2026-11-10T00:00:00.000Z"),
      }),
      { reviewer: true, environment: { EXOMEM_PADDLE_DUNNING_DAYS: "14" } }
    );

    assert.equal(view.kind, "reviewer");
    assert.equal(view.supportReference, "EX-7Q4M");
    assert.equal(view.step, "connect");
    assert.deepEqual(view.plan.name, { value: null, reason: "complimentary" });
    assert.deepEqual(view.nextPaymentAt, { value: null, reason: "complimentary" });
    assert.deepEqual(view.readOnlyUntil, { value: null, reason: "complimentary" });
    assert.deepEqual(view.keptUntil, { value: null, reason: "complimentary" });
    assert.deepEqual(view.reviewerEndsAt, { value: "2026-11-10T00:00:00.000Z", reason: null });
  });

  it("says a paid account has no subscription before its first payment", () => {
    const view = buildExomemAccountView(
      paidRow({
        sourceState: "awaiting_checkout",
        effectiveState: "provisioning",
        subscriptionRef: null,
        priceId: null,
        priceName: null,
        nextBilledAt: null,
      }),
      owner
    );

    assert.equal(view.kind, "owner");
    assert.equal(view.step, "subscribe");
    assert.deepEqual(view.plan.name, { value: null, reason: "no_subscription" });
    assert.deepEqual(view.plan.priceId, { value: null, reason: "no_subscription" });
    assert.deepEqual(view.nextPaymentAt, { value: null, reason: "no_subscription" });
    assert.deepEqual(view.reviewerEndsAt, { value: null, reason: "not_reviewer" });
  });

  it("shows no friend price for another discount, an unconfigured friend discount or an ended subscription", () => {
    const friendEnvironment = {
      reviewer: false,
      environment: { EXOMEM_PADDLE_FRIEND_DISCOUNT_ID: FRIEND_DISCOUNT },
    };
    const other = buildExomemAccountView(
      paidRow({ discountId: "dsc_other_example" }),
      friendEnvironment
    );
    const unconfigured = buildExomemAccountView(paidRow({ discountId: FRIEND_DISCOUNT }), owner);
    const ended = buildExomemAccountView(
      paidRow({
        discountId: FRIEND_DISCOUNT,
        sourceState: "cancelled",
        effectiveState: "cancelled",
      }),
      friendEnvironment
    );

    assert.equal(other.plan.friendPrice.applied, false);
    assert.equal(unconfigured.plan.friendPrice.applied, false);
    assert.equal(ended.plan.friendPrice.applied, false);
  });

  it("says Paddle has not reported the next payment or price instead of inventing them", () => {
    const view = buildExomemAccountView(paidRow({ nextBilledAt: null, priceName: null }), owner);

    assert.deepEqual(view.nextPaymentAt, { value: null, reason: "not_reported" });
    assert.deepEqual(view.plan.name, { value: null, reason: "not_reported" });
  });

  for (const [dunningDays, expected] of [
    ["14", { value: "2026-10-16T10:00:00.000Z", reason: null }],
    [undefined, { value: null, reason: "dunning_window_unconfigured" }],
    ["two weeks", { value: null, reason: "dunning_window_invalid" }],
    ["366", { value: null, reason: "dunning_window_invalid" }],
  ] as const) {
    it(`ends the read-only period of a past_due subscription by the dunning window (${dunningDays ?? "unset"})`, () => {
      const view = buildExomemAccountView(
        paidRow({
          sourceState: "past_due",
          effectiveState: "grace",
          graceStartedAt: new Date("2026-10-02T10:00:00.000Z"),
        }),
        { reviewer: false, environment: { EXOMEM_PADDLE_DUNNING_DAYS: dunningDays } }
      );

      assert.equal(view.step, "connect-read-only");
      assert.deepEqual(view.readOnlyUntil, expected);
    });
  }

  it("says when a past_due period started is unknown rather than guessing it", () => {
    const view = buildExomemAccountView(
      paidRow({ sourceState: "past_due", effectiveState: "grace", graceStartedAt: null }),
      { reviewer: false, environment: { EXOMEM_PADDLE_DUNNING_DAYS: "14" } }
    );

    assert.deepEqual(view.readOnlyUntil, { value: null, reason: "grace_start_unknown" });
  });

  it("keeps an ended subscription for the Cloud retention window from its cancellation", () => {
    const view = buildExomemAccountView(
      paidRow({
        sourceState: "cancelled",
        effectiveState: "cancelled",
        sourceOccurredAt: new Date("2026-10-11T12:00:00.000Z"),
        nextBilledAt: null,
      }),
      owner
    );

    assert.equal(view.step, "ended");
    assert.deepEqual(view.keptUntil, { value: "2026-11-10T12:00:00.000Z", reason: null });
    assert.deepEqual(view.nextPaymentAt, { value: null, reason: "ended" });
  });

  it("shows no kept-until or read-only date while an operator suspension stops the cell", () => {
    const cancelled = buildExomemAccountView(
      paidRow({ sourceState: "cancelled", effectiveState: "suspended", manuallySuspended: true }),
      owner
    );
    const pastDue = buildExomemAccountView(
      paidRow({
        sourceState: "past_due",
        effectiveState: "suspended",
        manuallySuspended: true,
        graceStartedAt: new Date("2026-10-02T10:00:00.000Z"),
      }),
      { reviewer: false, environment: { EXOMEM_PADDLE_DUNNING_DAYS: "14" } }
    );

    assert.deepEqual(cancelled.keptUntil, { value: null, reason: "suspended" });
    assert.deepEqual(pastDue.readOnlyUntil, { value: null, reason: "suspended" });
  });
});
