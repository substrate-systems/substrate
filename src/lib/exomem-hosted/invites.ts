/**
 * Operator invitations: issuing them by kind, inspecting one by its token,
 * and an existing owner's decision on one (design "Friend invitations, the
 * friend price and resubscribe").
 *
 * Kinds: `standard` (paid), `friend` (paid, with the friend price) and
 * `covered` (complimentary). Every email an invitation causes goes through
 * the outbox in the transaction that records its cause.
 */

import { randomBytes as nodeRandomBytes } from "node:crypto";
import { normalizeAccessEmail } from "./access";
import {
  createInviteRecord,
  executeExomemSql,
  withExomemTransaction,
  type CreateInviteRecordInput,
  type ExomemSql,
} from "./db";
import { enqueueExomemEmail, INVITATION_REMINDER_LEAD_DAYS } from "./email-outbox";
import { LIVE_SUBSCRIPTION_SOURCE_STATES } from "./entitlements";
import { ExomemHostedError, exomemErrors } from "./errors";
import {
  EXOMEM_INVITE_KINDS,
  INVITATION_NAME_MAX,
  INVITATION_NOTE_MAX,
  inviteeNameRequired,
  inviterEmailAllowed,
  inviterNameRequired,
  type ExomemInviteKind,
} from "./invitation-contract";
import { known, unknown, type Known } from "./known";
import {
  applyExomemFriendDiscountToSubscription,
  ExomemBillingError,
  previewExomemPrices,
  readExomemSubscription,
  type ExomemMoney,
  type ExomemPrices,
} from "./paddle-billing";
import { exomemPaddleBasePriceId, exomemPaddleFriendDiscountId } from "./paddle-config";
import { EXOMEM_INVITE_CAPABILITIES, EXOMEM_INVITE_LIMITS } from "./self-serve-admission";
import { generateExternalToken, tokenDigest, type RandomBytesSource } from "./security";

const MAX_INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Format checks. A name is shown to the invitee and, for the inviter, used
// as the email sender ("Alex via Exomem"), so it carries no control or
// invisible formatting characters and nothing that reads as an address or
// breaks a quoted header (< > " @ \). A note is shown as text only and may
// keep line breaks.
const UNSAFE_NAME = /[\p{Cc}\p{Cf}<>"@\\]/u;
const UNSAFE_NOTE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;

function invitationFieldsInvalid(): ExomemHostedError {
  return new ExomemHostedError({
    code: "INVITATION_FIELDS_INVALID",
    status: 400,
    message: "the invitation's names or note are not accepted",
  });
}

function optionalText(
  value: string | null | undefined,
  max: number,
  unsafe: RegExp
): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if ([...trimmed].length > max || unsafe.test(trimmed)) throw invitationFieldsInvalid();
  return trimmed;
}

export type OperatorInviteInput = {
  email: string;
  kind: ExomemInviteKind;
  inviterName?: string | null;
  inviterEmail?: string | null;
  inviteeName?: string | null;
  note?: string | null;
  marketplaceReviewerPurpose?: boolean;
  expiresAt: Date;
  operatorPrincipalDigest: Buffer;
};

export type OperatorInviteDependencies = {
  now: () => Date;
  randomBytes: RandomBytesSource;
  createInvite: typeof createInviteRecord;
  previewPrices: typeof previewExomemPrices;
};

function issueDefaults(): OperatorInviteDependencies {
  return {
    now: () => new Date(),
    randomBytes: nodeRandomBytes,
    createInvite: createInviteRecord,
    previewPrices: previewExomemPrices,
  };
}

function friendPriceUnavailable(): ExomemHostedError {
  return new ExomemHostedError({
    code: "FRIEND_PRICE_UNAVAILABLE",
    status: 503,
    message: "the friend price cannot be confirmed right now",
    retryable: true,
  });
}

/**
 * Issues one operator invitation and enqueues its emails in the same
 * transaction: the invitation itself (02 standard, 09 friend, 10 covered),
 * and for a friend invitation the invitee reminder (11) and, when the
 * inviter left an address, the "ended unused" notice (13).
 *
 * A friend invitation is refused while Paddle cannot confirm the friend
 * price: email 09 states the price, and an invitation promising a price
 * that checkout would refuse is worse than none. The operator retries.
 */
export async function issueOperatorInvite(
  input: OperatorInviteInput,
  dependencies?: Partial<OperatorInviteDependencies>
): Promise<{ inviteId: string; delivery: "queued" }> {
  const deps = { ...issueDefaults(), ...dependencies };
  const emailNormalized = normalizeAccessEmail(input.email);
  const now = deps.now();
  if (
    !Number.isFinite(input.expiresAt.getTime()) ||
    input.expiresAt <= now ||
    input.expiresAt.getTime() - now.getTime() > MAX_INVITE_TTL_MS
  ) {
    throw exomemErrors.invalidExpiry();
  }
  if (!(EXOMEM_INVITE_KINDS as readonly string[]).includes(input.kind)) {
    throw exomemErrors.invalidEntitlementSource();
  }
  const inviterName = optionalText(input.inviterName, INVITATION_NAME_MAX, UNSAFE_NAME);
  const inviteeName = optionalText(input.inviteeName, INVITATION_NAME_MAX, UNSAFE_NAME);
  const note = optionalText(input.note, INVITATION_NOTE_MAX, UNSAFE_NOTE);
  const inviterEmail =
    input.inviterEmail === null ||
    input.inviterEmail === undefined ||
    input.inviterEmail.trim() === ""
      ? null
      : normalizeAccessEmail(input.inviterEmail);
  if (
    (inviterNameRequired(input.kind) && inviterName === null) ||
    (inviterEmail !== null && !inviterEmailAllowed(input.kind)) ||
    (inviteeNameRequired(input.kind, inviterEmail !== null) && inviteeName === null)
  ) {
    throw invitationFieldsInvalid();
  }

  let prices: ExomemPrices | null = null;
  if (input.kind === "friend") {
    try {
      prices = await deps.previewPrices({ country: null, customerIp: null, friend: true });
    } catch {
      throw friendPriceUnavailable();
    }
    if (!prices.friend) throw friendPriceUnavailable();
  }

  const token = generateExternalToken(deps.randomBytes);
  const digest = tokenDigest(token);
  if (!digest) throw exomemErrors.accessTokenInvalid();
  const expiresAt = input.expiresAt;
  const enqueueEmails: CreateInviteRecordInput["afterCreate"] = async (tx, { inviteId }) => {
    const link = { version: 1 as const, inviteId, token, expiresAt: expiresAt.toISOString() };
    const invitation = {
      dedupeKey: `invite:${inviteId}`,
      recipient: emailNormalized,
      recipientTimeZone: null,
      expiresAt,
    };
    if (input.kind === "friend" && prices?.friend) {
      await enqueueExomemEmail(tx, {
        ...invitation,
        kind: "friend_invitation",
        payload: {
          ...link,
          usualAmount: prices.usual.amount,
          usualCurrency: prices.usual.currencyCode,
          friendAmount: prices.friend.amount,
          friendCurrency: prices.friend.currencyCode,
        },
      });
      const remindAt = new Date(expiresAt.getTime() - INVITATION_REMINDER_LEAD_DAYS * DAY_MS);
      // A reminder due at once would arrive with the invitation itself.
      if (remindAt > now) {
        await enqueueExomemEmail(tx, {
          kind: "invitation_reminder",
          dedupeKey: `invite-reminder:${inviteId}`,
          recipient: emailNormalized,
          recipientTimeZone: null,
          payload: link,
          notBefore: remindAt,
          expiresAt,
        });
      }
      if (inviterEmail) {
        await enqueueExomemEmail(tx, {
          kind: "invitation_ended",
          dedupeKey: `invite-ended:${inviteId}`,
          recipient: inviterEmail,
          recipientTimeZone: null,
          payload: { version: 1, inviteId },
          notBefore: expiresAt,
        });
      }
      return;
    }
    await enqueueExomemEmail(tx, {
      ...invitation,
      kind: input.kind === "covered" ? "covered_invitation" : "invitation",
      payload: link,
    });
  };

  const { inviteId } = await deps.createInvite({
    tokenDigest: digest,
    emailNormalized,
    entitlementSource: input.kind === "covered" ? "complimentary" : "paddle",
    capabilities: EXOMEM_INVITE_CAPABILITIES,
    resourceLimits: EXOMEM_INVITE_LIMITS,
    marketplaceReviewerPurpose: input.marketplaceReviewerPurpose === true,
    operatorPrincipalDigest: input.operatorPrincipalDigest,
    expiresAt,
    kind: input.kind,
    inviterName,
    inviterEmail,
    inviteeName,
    note,
    afterCreate: enqueueEmails,
  });
  return { inviteId, delivery: "queued" };
}

/**
 * Called in the transaction that consumes an invitation with the friend
 * price taken (a redemption, or an owner's `use_friend_price`). A friend
 * invitation becomes the tenant's friend offer, which checkout reads, and
 * its inviter, if they left an address, is told once (email 12).
 */
export async function recordInvitationUse(
  tx: ExomemSql,
  input: { inviteId: string; tenantId: string }
): Promise<void> {
  const { rows } = await tx`
    /* exomem:record-invitation-use */
    UPDATE exomem_tenants AS tenant
    SET friend_offer_invite_id = invite.id,
        updated_at = now()
    FROM exomem_invites AS invite
    WHERE invite.id = ${input.inviteId}::uuid
      AND invite.kind = 'friend'
      AND tenant.id = ${input.tenantId}::uuid
    RETURNING invite.inviter_email::text AS inviter_email
  `;
  const inviterEmail = (rows[0] as { inviter_email: string | null } | undefined)?.inviter_email;
  if (!inviterEmail) return;
  await enqueueExomemEmail(tx, {
    kind: "invitation_used",
    dedupeKey: `invite-used:${input.inviteId}`,
    recipient: inviterEmail,
    recipientTimeZone: null,
    payload: { version: 1, inviteId: input.inviteId },
  });
}

/**
 * Why an invitation offers no friend price: it is not a friend invitation
 * (or the owner is not on Paddle), or the owner's live subscription is on
 * a price other than the base price the discount is restricted to, or its
 * price was never reported.
 */
export type FriendPriceRefusal = "not_offered" | "plan_price_differs" | "plan_price_unknown";

export type InvitationPrices = {
  usual: ExomemMoney;
  friend: Known<ExomemMoney, FriendPriceRefusal>;
};

export type InvitationPrice = Known<InvitationPrices, "price_unavailable" | "covered">;

/** An existing owner's plan, as stored from Paddle. */
export type OwnerPlan = {
  source: "complimentary" | "paddle";
  sourceState: string;
  subscriptionRef: string | null;
  environment: "sandbox" | "production" | null;
  priceId: string | null;
};

function liveSubscription(plan: OwnerPlan): boolean {
  return (
    plan.subscriptionRef !== null &&
    plan.environment !== null &&
    (LIVE_SUBSCRIPTION_SOURCE_STATES as readonly string[]).includes(plan.sourceState)
  );
}

/**
 * Whether an existing owner may take the friend price; inspect and the
 * decision both ask this. The friend discount is restricted to the base
 * price, so a live subscription on another price, or on a price never
 * reported, keeps its plan only and Paddle is not asked. An ended or not yet
 * paid subscription takes the offer to its next checkout, which sells the
 * base price.
 */
export function friendPriceOffer(
  kind: ExomemInviteKind,
  plan: OwnerPlan,
  basePriceId: string | null
): { offered: true } | { offered: false; reason: FriendPriceRefusal } {
  if (kind !== "friend" || plan.source !== "paddle")
    return { offered: false, reason: "not_offered" };
  if (!liveSubscription(plan)) return { offered: true };
  if (plan.priceId === null) return { offered: false, reason: "plan_price_unknown" };
  if (plan.priceId !== basePriceId) return { offered: false, reason: "plan_price_differs" };
  return { offered: true };
}

type InvitationFacts = {
  kind: ExomemInviteKind;
  inviter: { name: string } | null;
  note: string | null;
  price: InvitationPrice;
};

export type InvitationInspection =
  | ({ status: "invite"; email: string; expiresAt: string } & InvitationFacts)
  | ({ status: "existing"; signedIn: boolean } & InvitationFacts);

export type InspectInvitationDependencies = {
  previewPrices: typeof previewExomemPrices;
  findUsable: typeof findUsableInvitation;
  basePriceId: () => string | null;
};

/**
 * A usable invitation and, when its address already owns a live Exomem,
 * that owner. One query for every token, so an unusable token of any kind
 * (unknown, expired, used, revoked) costs the same.
 */
export async function findUsableInvitation(digest: Buffer): Promise<{
  kind: ExomemInviteKind;
  email: string;
  expiresAt: Date;
  inviterName: string | null;
  note: string | null;
  owner: { userId: string; plan: OwnerPlan } | null;
} | null> {
  const { rows } = await executeExomemSql`
      /* exomem:inspect-invitation */
      SELECT invite.kind, invite.email_normalized::text AS email, invite.expires_at,
             invite.inviter_name, invite.note, owner.user_id AS owner_user_id,
             owner.source, owner.source_state, owner.provider_subscription_ref,
             owner.provider_environment, owner.provider_price_id
      FROM exomem_invites AS invite
      LEFT JOIN LATERAL (
        SELECT users.id AS user_id, entitlement.source, entitlement.source_state,
               entitlement.provider_subscription_ref, entitlement.provider_environment,
               entitlement.provider_price_id
        FROM users
        JOIN exomem_tenants AS tenant ON tenant.owner_user_id = users.id
        JOIN exomem_entitlements AS entitlement ON entitlement.tenant_id = tenant.id
        WHERE users.email = invite.email_normalized
          AND users.deleted_at IS NULL
          AND tenant.status IN ('provisioning', 'active', 'suspended')
          AND tenant.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM exomem_cloud_cells AS cell
            WHERE cell.tenant_id = tenant.id AND cell.desired_state <> 'deleted'
          )
        LIMIT 1
      ) AS owner ON true
      WHERE invite.token_digest = ${digest}
        AND invite.consumed_at IS NULL
        AND invite.revoked_at IS NULL
        AND invite.expires_at > now()
    `;
  const row = rows[0] as
    | {
        kind: ExomemInviteKind;
        email: string;
        expires_at: Date | string;
        inviter_name: string | null;
        note: string | null;
        owner_user_id: string | null;
        source: OwnerPlan["source"] | null;
        source_state: string | null;
        provider_subscription_ref: string | null;
        provider_environment: OwnerPlan["environment"];
        provider_price_id: string | null;
      }
    | undefined;
  return row
    ? {
        kind: row.kind,
        email: row.email,
        expiresAt: new Date(row.expires_at),
        inviterName: row.inviter_name,
        note: row.note,
        owner: row.owner_user_id
          ? {
              userId: row.owner_user_id,
              plan: {
                source: row.source === "complimentary" ? "complimentary" : "paddle",
                sourceState: String(row.source_state),
                subscriptionRef: row.provider_subscription_ref,
                environment: row.provider_environment,
                priceId: row.provider_price_id,
              },
            }
          : null,
      }
    : null;
}

/**
 * What the holder of an invitation token sees. `null` for every unusable
 * token alike. A token never signs anybody in here; for an address that
 * already owns an Exomem it says so, and whether the caller is signed in
 * as that owner. Prices come from Paddle's preview for the caller, or are
 * unknown with a reason; the discount id never leaves the server.
 */
export async function inspectInvitation(
  input: {
    token: string;
    country: string | null;
    customerIp: string | null;
    sessionUserId: string | null;
  },
  dependencies?: Partial<InspectInvitationDependencies>
): Promise<InvitationInspection | null> {
  const deps = {
    previewPrices: previewExomemPrices,
    findUsable: findUsableInvitation,
    basePriceId: () => exomemPaddleBasePriceId(),
    ...dependencies,
  };
  const digest = tokenDigest(input.token);
  if (!digest) return null;
  const invitation = await deps.findUsable(digest);
  if (!invitation) return null;
  // A new person's covered invitation has no checkout, so no price. An
  // existing owner always sees the usual price and whether the friend price
  // is theirs to take.
  const offer = invitation.owner
    ? friendPriceOffer(invitation.kind, invitation.owner.plan, deps.basePriceId())
    : invitation.kind === "friend"
      ? ({ offered: true } as const)
      : ({ offered: false, reason: "not_offered" } as const);
  let price: InvitationPrice;
  if (invitation.kind === "covered" && !invitation.owner) {
    price = unknown("covered");
  } else {
    try {
      const previewed = await deps.previewPrices({
        country: input.country,
        customerIp: input.customerIp,
        friend: offer.offered,
      });
      price = known({
        usual: previewed.usual,
        friend: offer.offered
          ? previewed.friend
            ? known(previewed.friend)
            : unknown("not_offered")
          : unknown(offer.reason),
      });
    } catch {
      price = unknown("price_unavailable");
    }
  }
  const facts: InvitationFacts = {
    kind: invitation.kind,
    inviter: invitation.inviterName ? { name: invitation.inviterName } : null,
    note: invitation.note,
    price,
  };
  if (invitation.owner) {
    return {
      status: "existing",
      ...facts,
      signedIn: input.sessionUserId === invitation.owner.userId,
    };
  }
  return {
    status: "invite",
    email: invitation.email,
    expiresAt: invitation.expiresAt.toISOString(),
    ...facts,
  };
}

export type InvitationChoice = "use_friend_price" | "keep_plan";

export type InvitationDecision =
  | { status: "applied"; nextPaymentAt: Known<string, "not_reported"> }
  | { status: "applied_on_resubscribe" }
  | { status: "kept" };

type StoredDecision = InvitationDecision["status"];

function invitationUnusable(): ExomemHostedError {
  return new ExomemHostedError({
    code: "INVITATION_UNUSABLE",
    status: 404,
    message: "this invitation cannot be used",
  });
}

function invitationForAnotherAddress(): ExomemHostedError {
  return new ExomemHostedError({
    code: "INVITATION_EMAIL_MISMATCH",
    status: 403,
    message: "this invitation belongs to another email address",
  });
}

function friendPriceNotOffered(reason: FriendPriceRefusal): ExomemHostedError {
  return new ExomemHostedError({
    code: "FRIEND_PRICE_NOT_OFFERED",
    status: 409,
    message:
      reason === "not_offered"
        ? "this invitation can only keep the current plan"
        : "the friend price does not apply to the current plan's price",
  });
}

function providerUnavailable(error: ExomemBillingError): ExomemHostedError {
  return new ExomemHostedError({
    code: error.code,
    status: 503,
    message: "Exomem billing is temporarily unavailable",
    retryable: true,
  });
}

export type DecideInvitationDependencies = {
  applyFriendDiscount: typeof applyExomemFriendDiscountToSubscription;
  readSubscription: typeof readExomemSubscription;
  basePriceId: () => string | null;
  friendDiscountId: () => string | null;
};

/**
 * An existing owner's answer to an invitation for their address. The
 * invitation is locked first; for the friend price on a live subscription
 * Paddle is updated while that lock is held, and the invitation is consumed
 * only after Paddle has answered. So a Paddle failure rolls back and leaves
 * the invitation usable (503), and two answers at once cannot leave the
 * discount applied under a stored "kept". A failure can still hide an
 * update that reached Paddle, so "kept" is stored only after Paddle reports
 * the subscription without the friend discount. A repeat returns the stored
 * answer without calling Paddle again.
 */
export async function decideInvitation(
  input: {
    token: string;
    choice: InvitationChoice;
    session: { id: string; userId: string; tenantId: string };
  },
  dependencies?: Partial<DecideInvitationDependencies>
): Promise<InvitationDecision> {
  const deps = {
    applyFriendDiscount: applyExomemFriendDiscountToSubscription,
    readSubscription: readExomemSubscription,
    basePriceId: () => exomemPaddleBasePriceId(),
    friendDiscountId: () => exomemPaddleFriendDiscountId(),
    ...dependencies,
  };
  const digest = tokenDigest(input.token);
  if (!digest) throw invitationUnusable();
  try {
    return await withExomemTransaction(async (tx) => {
      const { rows } = await tx`
        /* exomem:lock-invitation-decision */
        SELECT invite.id, invite.kind, invite.decision,
               invite.consumed_at IS NOT NULL AS consumed,
               invite.consumed_by_user_id,
               (invite.revoked_at IS NULL AND invite.expires_at > now()) AS live,
               owner.email = invite.email_normalized AS same_address
        FROM exomem_invites AS invite
        JOIN users AS owner ON owner.id = ${input.session.userId}::uuid
        WHERE invite.token_digest = ${digest}
        FOR UPDATE OF invite
      `;
      const invite = rows[0] as
        | {
            id: string;
            kind: ExomemInviteKind;
            decision: StoredDecision | null;
            consumed: boolean;
            consumed_by_user_id: string | null;
            live: boolean;
            same_address: boolean;
          }
        | undefined;
      if (!invite) throw invitationUnusable();
      if (!invite.same_address) throw invitationForAnotherAddress();
      const facts = await tx`
        /* exomem:invitation-decision-billing */
        SELECT entitlement.source, entitlement.source_state, entitlement.provider_environment,
               entitlement.provider_subscription_ref, entitlement.provider_next_billed_at,
               entitlement.provider_price_id, tenant.friend_offer_invite_id
        FROM exomem_entitlements AS entitlement
        JOIN exomem_tenants AS tenant ON tenant.id = entitlement.tenant_id
        WHERE tenant.id = ${input.session.tenantId}::uuid
          AND tenant.owner_user_id = ${input.session.userId}::uuid
      `;
      const billing = facts.rows[0] as
        | {
            source: "complimentary" | "paddle";
            source_state: string;
            provider_environment: "sandbox" | "production" | null;
            provider_subscription_ref: string | null;
            provider_next_billed_at: Date | string | null;
            provider_price_id: string | null;
            friend_offer_invite_id: string | null;
          }
        | undefined;
      if (!billing) throw exomemErrors.sessionInvalid();
      const plan: OwnerPlan = {
        source: billing.source,
        sourceState: billing.source_state,
        subscriptionRef: billing.provider_subscription_ref,
        environment: billing.provider_environment,
        priceId: billing.provider_price_id,
      };

      if (invite.consumed) {
        if (invite.decision && invite.consumed_by_user_id === input.session.userId) {
          return storedDecision(invite.decision, billing.provider_next_billed_at);
        }
        throw invitationUnusable();
      }
      if (!invite.live) throw invitationUnusable();

      const offer = friendPriceOffer(invite.kind, plan, deps.basePriceId());
      const subscription = liveSubscription(plan)
        ? {
            subscriptionId: billing.provider_subscription_ref!,
            environment: billing.provider_environment!,
          }
        : null;
      let decision: InvitationDecision;
      if (input.choice === "keep_plan") {
        decision = { status: "kept" };
        // An earlier `use_friend_price` for this invitation may have reached
        // Paddle although its answer was lost. Paddle's subscription decides.
        // A friend offer the tenant already holds explains the discount.
        if (offer.offered && subscription && billing.friend_offer_invite_id === null) {
          const current = await deps.readSubscription(subscription);
          const friendDiscountId = deps.friendDiscountId();
          if (friendDiscountId !== null && current.discountId === friendDiscountId) {
            decision = { status: "applied", nextPaymentAt: nextPayment(current.nextBilledAt) };
          }
        }
      } else {
        if (!offer.offered) throw friendPriceNotOffered(offer.reason);
        if (subscription) {
          const applied = await deps.applyFriendDiscount(subscription);
          decision = { status: "applied", nextPaymentAt: nextPayment(applied.nextBilledAt) };
        } else {
          // Ended, or not yet paid for the first time: the offer is kept on
          // the tenant and the next checkout carries the discount.
          decision = { status: "applied_on_resubscribe" };
        }
      }

      const consumed = await tx`
        /* exomem:consume-invitation-decision */
        UPDATE exomem_invites
        SET consumed_at = now(),
            consumed_by_user_id = ${input.session.userId}::uuid,
            redeemed_tenant_id = ${input.session.tenantId}::uuid,
            redeemed_session_id = ${input.session.id}::uuid,
            decision = ${decision.status},
            decided_at = now()
        WHERE id = ${invite.id}::uuid AND consumed_at IS NULL AND revoked_at IS NULL
        RETURNING id
      `;
      if (!consumed.rows[0]) throw invitationUnusable();
      if (decision.status !== "kept") {
        await recordInvitationUse(tx, { inviteId: invite.id, tenantId: input.session.tenantId });
      }
      return decision;
    });
  } catch (error) {
    if (error instanceof ExomemBillingError) throw providerUnavailable(error);
    throw error;
  }
}

function nextPayment(nextBilledAt: Date | string | null): Known<string, "not_reported"> {
  return nextBilledAt ? known(new Date(nextBilledAt).toISOString()) : unknown("not_reported");
}

function storedDecision(
  status: StoredDecision,
  nextBilledAt: Date | string | null
): InvitationDecision {
  return status === "applied" ? { status, nextPaymentAt: nextPayment(nextBilledAt) } : { status };
}
