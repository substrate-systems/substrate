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
  applyExomemFriendPriceToSubscription,
  ExomemBillingError,
  previewExomemPrices,
  readExomemSubscription,
  type ExomemPrices,
} from "./paddle-billing";
import type { ExomemMoney } from "@/lib/exomem/money";
import {
  exomemPaddleBasePriceId,
  exomemPaddleFriendDiscountId,
  exomemPaddleFriendPriceId,
} from "./paddle-config";
import { carriesFriendPrice } from "./paddle-friend-price";
import { lockExomemSubscriptionUpdate } from "./subscription-update-lock";
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
    } catch (error) {
      console.error("exomem.friend_price_unavailable", {
        code: error instanceof ExomemBillingError ? (error.providerCode ?? error.code) : null,
        status: error instanceof ExomemBillingError ? (error.providerStatus ?? error.status) : null,
      });
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
      // The invitee's own account values, if any, are read at send (email-outbox.ts).
      recipientEmailScheme: null,
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
          recipientEmailScheme: null,
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
          recipientEmailScheme: null,
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
    recipientEmailScheme: null,
    payload: { version: 1, inviteId: input.inviteId },
  });
}

/**
 * Why an invitation offers no friend price: it is not a friend invitation
 * (or the owner is not on Paddle), or the owner already holds the friend
 * price through another invitation, or the owner's live subscription is on a
 * price other than the base price the discount is restricted to, or its price
 * was never reported.
 */
export type FriendPriceRefusal =
  | "not_offered"
  | "friend_price_taken"
  | "plan_price_differs"
  | "plan_price_unknown";

export type InvitationPrices = {
  usual: ExomemMoney;
  friend: Known<ExomemMoney, FriendPriceRefusal>;
};

export type InvitationPrice = Known<InvitationPrices, "price_unavailable" | "covered">;

/** An existing owner's plan, as stored from Paddle, and the friend price the owner took. */
export type OwnerPlan = {
  source: "complimentary" | "paddle";
  sourceState: string;
  subscriptionRef: string | null;
  environment: "sandbox" | "production" | null;
  priceId: string | null;
  discountId: string | null;
  /** The invitation through which the owner took the friend price, or null. */
  friendPriceTakenThrough: string | null;
};

/** The tenant's friend offer, as the inspection and the decision both read it. */
type StoredFriendOffer = {
  offer_invite_id: string | null;
  offer_consumed: boolean | null;
  offer_consumed_by_user_id: string | null;
  offer_decision: string | null;
};

/**
 * The invitation through which the owner took the friend price: used at
 * signup, or answered with the friend price. An offer recorded from an
 * invitation the owner never used, or answered "kept", does not count.
 */
function friendPriceTakenThrough(offer: StoredFriendOffer, ownerUserId: string): string | null {
  return offer.offer_invite_id &&
    offer.offer_consumed === true &&
    offer.offer_consumed_by_user_id === ownerUserId &&
    offer.offer_decision !== "kept"
    ? offer.offer_invite_id
    : null;
}

function friendPriceTakenElsewhere(inviteId: string, plan: OwnerPlan): boolean {
  return plan.friendPriceTakenThrough !== null && plan.friendPriceTakenThrough !== inviteId;
}

function liveSubscription(plan: OwnerPlan): boolean {
  return (
    plan.subscriptionRef !== null &&
    plan.environment !== null &&
    (LIVE_SUBSCRIPTION_SOURCE_STATES as readonly string[]).includes(plan.sourceState)
  );
}

/**
 * Whether an existing owner may take the friend price; inspect and the
 * decision both ask this. An Exomem has one friend price: an owner who holds
 * it through another invitation, on the subscription or as the offer that the
 * next checkout applies, gains nothing, and Paddle is not asked. The friend
 * discount is restricted to the base price, so a live subscription on another
 * price, or on a price never reported, keeps its plan only. An ended or not
 * yet paid subscription takes the offer to its next checkout, which sells the
 * base price.
 */
function friendPriceOffer(
  invite: { id: string; kind: ExomemInviteKind },
  plan: OwnerPlan,
  basePriceId: string | null
): { offered: true } | { offered: false; reason: FriendPriceRefusal } {
  if (invite.kind !== "friend" || plan.source !== "paddle")
    return { offered: false, reason: "not_offered" };
  // Only another invitation counts: a discount that this invitation's own
  // update put on the subscription, whose answer was lost, is still recorded.
  if (friendPriceTakenElsewhere(invite.id, plan)) {
    return { offered: false, reason: "friend_price_taken" };
  }
  if (!liveSubscription(plan)) return { offered: true };
  if (
    carriesFriendPrice(plan, {
      friendPriceId: exomemPaddleFriendPriceId(),
      friendDiscountId: exomemPaddleFriendDiscountId(),
    })
  )
    return { offered: true };
  if (plan.priceId === null) return { offered: false, reason: "plan_price_unknown" };
  if (plan.priceId !== basePriceId) return { offered: false, reason: "plan_price_differs" };
  return { offered: true };
}

type InvitationFacts = {
  kind: ExomemInviteKind;
  inviter: { name: string } | null;
  note: string | null;
};

export type InvitationInspection =
  | ({
      status: "invite";
      email: string;
      expiresAt: string;
      price: InvitationPrice;
    } & InvitationFacts)
  | ({ status: "existing"; signedIn: true; price: InvitationPrice } & InvitationFacts)
  // An owner's plan is theirs: whether the friend price fits it is no one else's to read.
  | ({ status: "existing"; signedIn: false } & InvitationFacts);

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
async function findUsableInvitation(digest: Buffer): Promise<{
  id: string;
  kind: ExomemInviteKind;
  email: string;
  expiresAt: Date;
  inviterName: string | null;
  note: string | null;
  owner: { userId: string; plan: OwnerPlan } | null;
} | null> {
  const { rows } = await executeExomemSql`
      /* exomem:inspect-invitation */
      SELECT invite.id, invite.kind, invite.email_normalized::text AS email, invite.expires_at,
             invite.inviter_name, invite.note, owner.user_id AS owner_user_id,
             owner.source, owner.source_state, owner.provider_subscription_ref,
             owner.provider_environment, owner.provider_price_id, owner.provider_discount_id,
             owner.offer_invite_id, owner.offer_consumed, owner.offer_consumed_by_user_id,
             owner.offer_decision
      FROM exomem_invites AS invite
      LEFT JOIN LATERAL (
        SELECT exomem_users.id AS user_id, entitlement.source, entitlement.source_state,
               entitlement.provider_subscription_ref, entitlement.provider_environment,
               entitlement.provider_price_id, entitlement.provider_discount_id,
               offer.id AS offer_invite_id, offer.consumed_at IS NOT NULL AS offer_consumed,
               offer.consumed_by_user_id AS offer_consumed_by_user_id,
               offer.decision AS offer_decision
        FROM exomem_users
        JOIN exomem_tenants AS tenant ON tenant.owner_user_id = exomem_users.id
        JOIN exomem_entitlements AS entitlement ON entitlement.tenant_id = tenant.id
        LEFT JOIN exomem_invites AS offer ON offer.id = tenant.friend_offer_invite_id
        WHERE exomem_users.email = invite.email_normalized
          AND exomem_users.deleted_at IS NULL
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
    | ({
        id: string;
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
        provider_discount_id: string | null;
      } & StoredFriendOffer)
    | undefined;
  return row
    ? {
        id: row.id,
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
                discountId: row.provider_discount_id,
                friendPriceTakenThrough: friendPriceTakenThrough(row, row.owner_user_id),
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
 * as that owner, and only that owner learns the prices. Prices come from
 * Paddle's preview for the caller, or are unknown with a reason; the discount
 * id never leaves the server.
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
  const facts: InvitationFacts = {
    kind: invitation.kind,
    inviter: invitation.inviterName ? { name: invitation.inviterName } : null,
    note: invitation.note,
  };
  if (invitation.owner && input.sessionUserId !== invitation.owner.userId) {
    return { status: "existing", ...facts, signedIn: false };
  }
  // A new person's covered invitation has no checkout, so no price. An
  // owner signed in here always sees the usual price and whether the friend price
  // is theirs to take.
  const offer = invitation.owner
    ? friendPriceOffer(invitation, invitation.owner.plan, deps.basePriceId())
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
  if (invitation.owner) return { status: "existing", ...facts, signedIn: true, price };
  return {
    status: "invite",
    email: invitation.email,
    expiresAt: invitation.expiresAt.toISOString(),
    ...facts,
    price,
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

const FRIEND_PRICE_REFUSALS: Record<FriendPriceRefusal, string> = {
  not_offered: "this invitation can only keep the current plan",
  friend_price_taken: "this Exomem already has a friend price from another invitation",
  plan_price_differs: "the friend price does not apply to the current plan's price",
  plan_price_unknown: "the friend price does not apply to the current plan's price",
};

function friendPriceNotOffered(reason: FriendPriceRefusal): ExomemHostedError {
  return new ExomemHostedError({
    code: "FRIEND_PRICE_NOT_OFFERED",
    status: 409,
    message: FRIEND_PRICE_REFUSALS[reason],
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
  applyFriendPrice: typeof applyExomemFriendPriceToSubscription;
  readSubscription: typeof readExomemSubscription;
  basePriceId: () => string | null;
  friendDiscountId: () => string | null;
  friendPriceId: () => string | null;
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
    applyFriendPrice: applyExomemFriendPriceToSubscription,
    readSubscription: readExomemSubscription,
    basePriceId: () => exomemPaddleBasePriceId(),
    friendDiscountId: () => exomemPaddleFriendDiscountId(),
    friendPriceId: () => exomemPaddleFriendPriceId(),
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
        JOIN exomem_users AS owner ON owner.id = ${input.session.userId}::uuid
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
      // Storage additions and friend conversion replace all items, so they take turns.
      // This lock is separate from webhook, reconciliation and lifecycle projection.
      await lockExomemSubscriptionUpdate(tx, input.session.tenantId);
      const facts = await tx`
        /* exomem:invitation-decision-billing */
        SELECT entitlement.source, entitlement.source_state, entitlement.provider_environment,
               entitlement.provider_subscription_ref, entitlement.provider_next_billed_at,
               entitlement.provider_price_id, entitlement.provider_discount_id,
               offer.id AS offer_invite_id, offer.consumed_at IS NOT NULL AS offer_consumed,
               offer.consumed_by_user_id AS offer_consumed_by_user_id,
               offer.decision AS offer_decision
        FROM exomem_entitlements AS entitlement
        JOIN exomem_tenants AS tenant ON tenant.id = entitlement.tenant_id
        LEFT JOIN exomem_invites AS offer ON offer.id = tenant.friend_offer_invite_id
        WHERE tenant.id = ${input.session.tenantId}::uuid
          AND tenant.owner_user_id = ${input.session.userId}::uuid
      `;
      const billing = facts.rows[0] as
        | ({
            source: "complimentary" | "paddle";
            source_state: string;
            provider_environment: "sandbox" | "production" | null;
            provider_subscription_ref: string | null;
            provider_next_billed_at: Date | string | null;
            provider_price_id: string | null;
            provider_discount_id: string | null;
          } & StoredFriendOffer)
        | undefined;
      if (!billing) throw exomemErrors.sessionInvalid();
      const plan: OwnerPlan = {
        source: billing.source,
        sourceState: billing.source_state,
        subscriptionRef: billing.provider_subscription_ref,
        environment: billing.provider_environment,
        priceId: billing.provider_price_id,
        discountId: billing.provider_discount_id,
        friendPriceTakenThrough: friendPriceTakenThrough(billing, input.session.userId),
      };

      if (invite.consumed) {
        if (invite.decision && invite.consumed_by_user_id === input.session.userId) {
          return storedDecision(invite.decision, billing.provider_next_billed_at);
        }
        throw invitationUnusable();
      }
      if (!invite.live) throw invitationUnusable();

      const offer = friendPriceOffer(invite, plan, deps.basePriceId());
      const subscription = liveSubscription(plan)
        ? {
            subscriptionId: billing.provider_subscription_ref!,
            environment: billing.provider_environment!,
          }
        : null;
      let decision: InvitationDecision;
      // Read before eligibility: a completed update can precede its webhook or lose its response.
      const inForce =
        offer.offered && subscription
          ? await friendPriceInForce(billing, subscription, deps)
          : null;
      if (input.choice === "keep_plan") {
        // An earlier `use_friend_price` may have reached Paddle although its
        // answer was lost, so "kept" is stored only once the subscription is
        // shown not to carry the friend discount now. A friend price the
        // owner took through another invitation explains the discount: this
        // answer stays "kept", and its inviter is told nothing.
        decision = inForce
          ? { status: "applied", nextPaymentAt: nextPayment(inForce.nextBilledAt) }
          : { status: "kept" };
      } else {
        if (inForce) {
          decision = { status: "applied", nextPaymentAt: nextPayment(inForce.nextBilledAt) };
        } else if (!offer.offered) {
          throw friendPriceNotOffered(offer.reason);
        } else if (subscription) {
          const applied = await deps.applyFriendPrice(subscription);
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

/**
 * Whether the subscription carries the friend discount now, and its next
 * payment time. The stored subscription facts, from the newest applied
 * Paddle event, prove it when they show the discount. They cannot prove its
 * absence, because the event of an update whose answer was lost may still be
 * on its way, so Paddle is read then. A friend offer the tenant holds is
 * history, not proof, and is not consulted. Without a configured friend
 * discount nothing can show the discount absent, so the decision waits
 * (503, the invitation unconsumed) rather than store "kept" from a guess.
 */
async function friendPriceInForce(
  billing: {
    provider_price_id: string | null;
    provider_discount_id: string | null;
    provider_next_billed_at: Date | string | null;
  },
  subscription: { subscriptionId: string; environment: "sandbox" | "production" },
  deps: Pick<
    DecideInvitationDependencies,
    "readSubscription" | "friendDiscountId" | "friendPriceId"
  >
): Promise<{ nextBilledAt: Date | string | null } | null> {
  const config = { friendDiscountId: deps.friendDiscountId(), friendPriceId: deps.friendPriceId() };
  if (config.friendDiscountId === null && config.friendPriceId === null)
    throw friendPriceUnavailable();
  if (
    carriesFriendPrice(
      { priceId: billing.provider_price_id, discountId: billing.provider_discount_id },
      config
    )
  ) {
    return { nextBilledAt: billing.provider_next_billed_at };
  }
  const current = await deps.readSubscription(subscription);
  return carriesFriendPrice(current, config) ? { nextBilledAt: current.nextBilledAt } : null;
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
