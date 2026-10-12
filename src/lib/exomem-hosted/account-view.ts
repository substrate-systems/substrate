/**
 * The account facts Home and the web journey show: plan, dates, support
 * reference, reviewer access end. Every value comes from stored data, or is
 * explicitly unknown with a reason the page can name. No value is invented.
 */

import { cloudCancelledKeptUntil } from "./cloud-lifecycle";
import { consentStep, type ConsentStep } from "./consent-state";
import { executeExomemSql, type ExomemSessionRow } from "./db";
import { exomemErrors } from "./errors";
import { known, unknown, type Known } from "./known";

export type ExomemAccountView = {
  kind: "owner" | "reviewer";
  email: string;
  timeZone: Known<string, "not_recorded">;
  /** Shown to the owner and quoted to support, as `EX-` and 4 to 8 characters. */
  supportReference: string;
  step: ConsentStep;
  plan: {
    source: "complimentary" | "paddle";
    name: Known<string, "complimentary" | "no_subscription" | "not_reported">;
    priceId: Known<string, "complimentary" | "no_subscription" | "not_reported">;
    friendPrice: { applied: boolean; inviterName: string | null };
  };
  nextPaymentAt: Known<
    string,
    "complimentary" | "no_subscription" | "not_reported" | "ended" | "paused"
  >;
  readOnlyUntil: Known<
    string,
    | "complimentary"
    | "suspended"
    | "not_past_due"
    | "grace_start_unknown"
    | "dunning_window_unconfigured"
    | "dunning_window_invalid"
  >;
  keptUntil: Known<string, "complimentary" | "suspended" | "not_ended" | "not_reported">;
  reviewerEndsAt: Known<string, "not_reviewer" | "not_reported">;
};

export type ExomemAccountRow = {
  email: string;
  timeZone: string | null;
  supportReference: string;
  source: "complimentary" | "paddle";
  sourceState: string;
  effectiveState: string;
  manuallySuspended: boolean;
  sourceOccurredAt: Date | null;
  subscriptionRef: string | null;
  priceId: string | null;
  priceName: string | null;
  nextBilledAt: Date | null;
  discountId: string | null;
  graceStartedAt: Date | null;
  reviewerExpiresAt: Date | null;
};

type Environment = Record<string, string | undefined>;

/**
 * Days that Paddle keeps retrying a failed payment before it cancels, as set
 * in Paddle's payment recovery settings. There is no default: an unset value
 * makes the read-only end date unknown rather than a guess. A value outside
 * 1 to 365 days is a typo, not a dunning window, so it is unknown too.
 */
export function exomemPaddleDunningDays(
  environment: Environment = process.env
): Known<number, "dunning_window_unconfigured" | "dunning_window_invalid"> {
  const value = environment.EXOMEM_PADDLE_DUNNING_DAYS?.trim();
  if (!value) return unknown("dunning_window_unconfigured");
  const days = Number(value);
  return /^\d+$/.test(value) && days >= 1 && days <= 365
    ? known(days)
    : unknown("dunning_window_invalid");
}

/**
 * The one recurring Paddle discount that carries the friend price, if configured.
 * Temporary home: this reader moves to paddle-config.ts with friend-price checkout.
 */
function exomemPaddleFriendDiscountId(
  environment: Environment = process.env
): string | null {
  return environment.EXOMEM_PADDLE_FRIEND_DISCOUNT_ID?.trim() || null;
}

function planFact(
  row: ExomemAccountRow,
  value: string | null
): Known<string, "complimentary" | "no_subscription" | "not_reported"> {
  if (row.source === "complimentary") return unknown("complimentary");
  if (!row.subscriptionRef) return unknown("no_subscription");
  return value ? known(value) : unknown("not_reported");
}

// The friend price shows on the same subscription the plan facts describe,
// and only while that subscription has not ended.
function friendPriceApplied(row: ExomemAccountRow, friendDiscountId: string | null): boolean {
  return (
    planFact(row, row.discountId).value !== null &&
    row.sourceState !== "cancelled" &&
    row.discountId === friendDiscountId
  );
}

function nextPaymentAt(row: ExomemAccountRow): ExomemAccountView["nextPaymentAt"] {
  if (row.source === "complimentary") return unknown("complimentary");
  if (row.sourceState === "cancelled") return unknown("ended");
  if (row.sourceState === "paused") return unknown("paused");
  if (!row.subscriptionRef) return unknown("no_subscription");
  return row.nextBilledAt ? known(row.nextBilledAt.toISOString()) : unknown("not_reported");
}

function readOnlyUntil(
  row: ExomemAccountRow,
  environment: Environment
): ExomemAccountView["readOnlyUntil"] {
  if (row.source === "complimentary") return unknown("complimentary");
  if (row.manuallySuspended) return unknown("suspended");
  if (row.sourceState !== "past_due") return unknown("not_past_due");
  if (!row.graceStartedAt) return unknown("grace_start_unknown");
  const days = exomemPaddleDunningDays(environment);
  if (days.reason !== null) return unknown(days.reason);
  return known(new Date(row.graceStartedAt.getTime() + days.value * 86_400_000).toISOString());
}

// The same conditions under which desiredCloudCellState runs the cancelled
// window: a Paddle cancellation that no manual suspension overrides.
function keptUntil(row: ExomemAccountRow): ExomemAccountView["keptUntil"] {
  if (row.source === "complimentary") return unknown("complimentary");
  if (row.manuallySuspended) return unknown("suspended");
  if (row.sourceState !== "cancelled") return unknown("not_ended");
  if (!row.sourceOccurredAt) return unknown("not_reported");
  return known(cloudCancelledKeptUntil(row.sourceOccurredAt).toISOString());
}

export function buildExomemAccountView(
  row: ExomemAccountRow,
  options: { reviewer: boolean; environment?: Environment }
): ExomemAccountView {
  const environment = options.environment ?? process.env;
  const friendDiscountId = exomemPaddleFriendDiscountId(environment);
  return {
    kind: options.reviewer ? "reviewer" : "owner",
    email: row.email,
    timeZone: row.timeZone ? known(row.timeZone) : unknown("not_recorded"),
    supportReference: `EX-${row.supportReference}`,
    step: consentStep({ effectiveState: row.effectiveState, sourceState: row.sourceState }),
    plan: {
      source: row.source,
      name: planFact(row, row.priceName),
      priceId: planFact(row, row.priceId),
      friendPrice: {
        applied: friendPriceApplied(row, friendDiscountId),
        // Friend invitations do not store an inviter name yet.
        inviterName: null,
      },
    },
    nextPaymentAt: nextPaymentAt(row),
    readOnlyUntil: readOnlyUntil(row, environment),
    keptUntil: keptUntil(row),
    reviewerEndsAt: !options.reviewer
      ? unknown("not_reviewer")
      : row.reviewerExpiresAt
        ? known(row.reviewerExpiresAt.toISOString())
        : unknown("not_reported"),
  };
}

function dateOrNull(value: unknown): Date | null {
  return value === null || value === undefined ? null : new Date(value as string | Date);
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export async function loadExomemAccountView(
  session: Pick<ExomemSessionRow, "userId" | "tenantId" | "reviewerCredentialId">,
  options: { environment?: Environment } = {}
): Promise<ExomemAccountView> {
  const { rows } = await executeExomemSql`
    /* exomem:account-view */
    SELECT users.email,
           tenant.time_zone,
           tenant.support_reference,
           entitlement.source,
           entitlement.source_state,
           entitlement.effective_state,
           entitlement.manual_suspended_at IS NOT NULL AS manually_suspended,
           entitlement.source_occurred_at,
           entitlement.provider_subscription_ref,
           entitlement.provider_price_id,
           entitlement.provider_price_name,
           entitlement.provider_next_billed_at,
           entitlement.provider_discount_id,
           entitlement.grace_started_at,
           credential.expires_at AS reviewer_expires_at
    FROM exomem_tenants AS tenant
    JOIN users ON users.id = tenant.owner_user_id
    JOIN exomem_entitlements AS entitlement ON entitlement.tenant_id = tenant.id
    LEFT JOIN exomem_marketplace_reviewer_credentials AS credential
      ON credential.id = ${session.reviewerCredentialId ?? null}::uuid
     AND credential.tenant_id = tenant.id
    WHERE tenant.id = ${session.tenantId}::uuid
      AND tenant.owner_user_id = ${session.userId}::uuid
      AND tenant.status <> 'deleted'
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw exomemErrors.sessionInvalid();
  return buildExomemAccountView(
    {
      email: String(row.email),
      timeZone: textOrNull(row.time_zone),
      supportReference: String(row.support_reference),
      source: row.source === "complimentary" ? "complimentary" : "paddle",
      sourceState: String(row.source_state),
      effectiveState: String(row.effective_state),
      manuallySuspended: row.manually_suspended === true,
      sourceOccurredAt: dateOrNull(row.source_occurred_at),
      subscriptionRef: textOrNull(row.provider_subscription_ref),
      priceId: textOrNull(row.provider_price_id),
      priceName: textOrNull(row.provider_price_name),
      nextBilledAt: dateOrNull(row.provider_next_billed_at),
      discountId: textOrNull(row.provider_discount_id),
      graceStartedAt: dateOrNull(row.grace_started_at),
      reviewerExpiresAt: dateOrNull(row.reviewer_expires_at),
    },
    { reviewer: Boolean(session.reviewerCredentialId), environment: options.environment }
  );
}
