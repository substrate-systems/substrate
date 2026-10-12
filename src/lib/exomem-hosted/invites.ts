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
  type ExomemInviteKind,
  type ExomemSql,
} from "./db";
import { enqueueExomemEmail, INVITATION_REMINDER_LEAD_DAYS } from "./email-outbox";
import { LIVE_SUBSCRIPTION_SOURCE_STATES } from "./entitlements";
import { ExomemHostedError, exomemErrors } from "./errors";
import { known, unknown, type Known } from "./known";
import {
  applyExomemFriendDiscountToSubscription,
  ExomemBillingError,
  previewExomemPrices,
  type ExomemPrices,
} from "./paddle-billing";
import { EXOMEM_INVITE_CAPABILITIES, EXOMEM_INVITE_LIMITS } from "./self-serve-admission";
import { generateExternalToken, tokenDigest, type RandomBytesSource } from "./security";

export type { ExomemInviteKind };

const MAX_INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const NAME_MAX = 60;
const NOTE_MAX = 280;

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
  if (input.kind !== "standard" && input.kind !== "friend" && input.kind !== "covered") {
    throw exomemErrors.invalidEntitlementSource();
  }
  const inviterName = optionalText(input.inviterName, NAME_MAX, UNSAFE_NAME);
  const inviteeName = optionalText(input.inviteeName, NAME_MAX, UNSAFE_NAME);
  const note = optionalText(input.note, NOTE_MAX, UNSAFE_NOTE);
  const inviterEmail =
    input.inviterEmail === null ||
    input.inviterEmail === undefined ||
    input.inviterEmail.trim() === ""
      ? null
      : normalizeAccessEmail(input.inviterEmail);
  // Emails 09 and 10 name who invites or covers; 12 and 13 name the invitee
  // to an inviter, and only a friend invitation tells its inviter anything.
  if (
    (input.kind !== "standard" && inviterName === null) ||
    (inviterEmail !== null && (input.kind !== "friend" || inviteeName === null))
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

export type InvitationPrice = Known<ExomemPrices, "price_unavailable" | "covered">;

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
  ownerUserId: string | null;
} | null> {
  const { rows } = await executeExomemSql`
      /* exomem:inspect-invitation */
      SELECT invite.kind, invite.email_normalized::text AS email, invite.expires_at,
             invite.inviter_name, invite.note, owner.user_id AS owner_user_id
      FROM exomem_invites AS invite
      LEFT JOIN LATERAL (
        SELECT users.id AS user_id
        FROM users
        JOIN exomem_tenants AS tenant ON tenant.owner_user_id = users.id
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
      }
    | undefined;
  return row
    ? {
        kind: row.kind,
        email: row.email,
        expiresAt: new Date(row.expires_at),
        inviterName: row.inviter_name,
        note: row.note,
        ownerUserId: row.owner_user_id,
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
    ...dependencies,
  };
  const digest = tokenDigest(input.token);
  if (!digest) return null;
  const invitation = await deps.findUsable(digest);
  if (!invitation) return null;
  let price: InvitationPrice;
  if (invitation.kind === "covered") {
    price = unknown("covered");
  } else {
    try {
      price = known(
        await deps.previewPrices({
          country: input.country,
          customerIp: input.customerIp,
          friend: invitation.kind === "friend",
        })
      );
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
  if (invitation.ownerUserId) {
    return {
      status: "existing",
      ...facts,
      signedIn: input.sessionUserId === invitation.ownerUserId,
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

function friendPriceNotOffered(): ExomemHostedError {
  return new ExomemHostedError({
    code: "FRIEND_PRICE_NOT_OFFERED",
    status: 409,
    message: "this invitation can only keep the current plan",
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
};

/**
 * An existing owner's answer to an invitation for their address. The
 * invitation is locked first; for the friend price on a live subscription
 * Paddle is updated while that lock is held, and the invitation is consumed
 * only after Paddle has answered. So a Paddle failure rolls back and leaves
 * the invitation usable (503), and two answers at once cannot leave the
 * discount applied under a stored "kept". A repeat returns the stored answer
 * without calling Paddle again.
 */
export async function decideInvitation(
  input: {
    token: string;
    choice: InvitationChoice;
    session: { id: string; userId: string; tenantId: string };
  },
  dependencies?: Partial<DecideInvitationDependencies>
): Promise<InvitationDecision> {
  const deps = { applyFriendDiscount: applyExomemFriendDiscountToSubscription, ...dependencies };
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
               entitlement.provider_subscription_ref, entitlement.provider_next_billed_at
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
          }
        | undefined;
      if (!billing) throw exomemErrors.sessionInvalid();

      if (invite.consumed) {
        if (invite.decision && invite.consumed_by_user_id === input.session.userId) {
          return storedDecision(invite.decision, billing.provider_next_billed_at);
        }
        throw invitationUnusable();
      }
      if (!invite.live) throw invitationUnusable();

      let decision: InvitationDecision;
      if (input.choice === "keep_plan") {
        decision = { status: "kept" };
      } else {
        if (invite.kind !== "friend" || billing.source !== "paddle") throw friendPriceNotOffered();
        const live =
          billing.provider_subscription_ref !== null &&
          billing.provider_environment !== null &&
          (LIVE_SUBSCRIPTION_SOURCE_STATES as readonly string[]).includes(billing.source_state);
        if (live) {
          const applied = await deps.applyFriendDiscount({
            subscriptionId: billing.provider_subscription_ref!,
            environment: billing.provider_environment!,
          });
          decision = {
            status: "applied",
            nextPaymentAt: applied.nextBilledAt
              ? known(applied.nextBilledAt)
              : unknown("not_reported"),
          };
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

function storedDecision(
  status: StoredDecision,
  nextBilledAt: Date | string | null
): InvitationDecision {
  if (status === "applied") {
    return {
      status,
      nextPaymentAt: nextBilledAt
        ? known(new Date(nextBilledAt).toISOString())
        : unknown("not_reported"),
    };
  }
  return { status };
}
