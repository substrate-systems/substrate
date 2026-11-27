/**
 * The owner's "Monthly update email" setting and Home's invitation to it
 * (`send-monthly-whats-new-digest`, D5; migration 0098). Home's toggle, the
 * unsubscribe link and the operator's action all change the one column
 * `exomem_tenants.whats_new_digest`.
 */

import { executeExomemSql } from "../db";

/** Home's invitation, a closed set that migration 0098's CHECK and this module spell the same way. */
export type MonthlyUpdateInvitation = "none" | "open" | "dismissed" | "accepted";

export type MonthlyUpdateEmailView = {
  /** The setting. */
  enabled: boolean;
  /** Home asks the owner to turn the setting on. */
  invited: boolean;
};

/**
 * Home invites an owner who existed before the digest while the invitation is
 * open and the setting is off. A dismissal, a turn-on (also by the operator)
 * and a signup after the digest shipped all close it for good, and an owner
 * who turned the setting on and later unsubscribed is not asked again.
 */
export function invitationShows(invitation: MonthlyUpdateInvitation, enabled: boolean): boolean {
  return invitation === "open" && !enabled;
}

/** The view of a tenant row's two columns, as a statement returns them. */
export function monthlyUpdateEmailView(row: Record<string, unknown>): MonthlyUpdateEmailView {
  const enabled = row.whats_new_digest === true;
  return {
    enabled,
    invited: invitationShows(row.whats_new_digest_invitation as MonthlyUpdateInvitation, enabled),
  };
}

type Principal = { userId: string; tenantId: string };

/**
 * The one write that sets the setting. Turning it on also answers the
 * invitation, so it can never open again. `ownerUserId` null is the operator,
 * who names the tenant and leaves `operatorDigest` as the record of who acted.
 * A reviewer account has no such setting and a deleted account none to
 * change: no row, `null`. `offSinceBefore` is when the owner had turned the
 * setting off before this write, `null` when they had not; `dismissedBefore` is
 * whether they had dismissed Home's invitation.
 */
async function writeSetting(input: {
  tenantId: string;
  ownerUserId: string | null;
  enabled: boolean;
  operatorDigest: Buffer | null;
}): Promise<{
  view: MonthlyUpdateEmailView;
  offSinceBefore: Date | null;
  dismissedBefore: boolean;
} | null> {
  const { rows } = await executeExomemSql`
    /* exomem:whats-new-digest-set-setting */
    UPDATE exomem_tenants AS tenant
    SET whats_new_digest = ${input.enabled},
        whats_new_digest_off_since = CASE
          WHEN ${input.enabled}::boolean THEN NULL
          WHEN tenant.whats_new_digest THEN now()
          ELSE tenant.whats_new_digest_off_since END,
        whats_new_digest_invitation = CASE
          WHEN ${input.enabled}::boolean AND tenant.whats_new_digest_invitation IN ('open', 'dismissed') THEN 'accepted'
          ELSE tenant.whats_new_digest_invitation END,
        whats_new_digest_operator_on_at = CASE
          WHEN ${input.operatorDigest}::bytea IS NOT NULL THEN now() ELSE tenant.whats_new_digest_operator_on_at END,
        whats_new_digest_operator_on_by = COALESCE(${input.operatorDigest}::bytea, tenant.whats_new_digest_operator_on_by)
    FROM (SELECT id, whats_new_digest_off_since, whats_new_digest_invitation FROM exomem_tenants WHERE id = ${input.tenantId}::uuid FOR UPDATE) AS before
    WHERE tenant.id = before.id
      AND (${input.ownerUserId}::uuid IS NULL OR tenant.owner_user_id = ${input.ownerUserId}::uuid)
      AND tenant.status NOT IN ('deletion_pending', 'deleted')
      AND NOT tenant.marketplace_reviewer_purpose
    RETURNING tenant.whats_new_digest, tenant.whats_new_digest_invitation,
              before.whats_new_digest_off_since AS off_since_before,
              before.whats_new_digest_invitation AS invitation_before
  `;
  return rows[0]
    ? {
        view: monthlyUpdateEmailView(rows[0]),
        offSinceBefore: rows[0].off_since_before
          ? new Date(rows[0].off_since_before as string | Date)
          : null,
        dismissedBefore: rows[0].invitation_before === "dismissed",
      }
    : null;
}

/** The owner turns the setting on or off from Home. */
export async function setMonthlyUpdateEmail(
  principal: Principal,
  enabled: boolean
): Promise<MonthlyUpdateEmailView | null> {
  const written = await writeSetting({
    tenantId: principal.tenantId,
    ownerUserId: principal.userId,
    enabled,
    operatorDigest: null,
  });
  return written?.view ?? null;
}

/** The owner dismisses Home's invitation. The setting stays as it is. */
export async function dismissMonthlyUpdateInvitation(
  principal: Principal
): Promise<MonthlyUpdateEmailView | null> {
  const { rows } = await executeExomemSql`
    /* exomem:whats-new-digest-dismiss-invitation */
    UPDATE exomem_tenants
    SET whats_new_digest_invitation = CASE
          WHEN whats_new_digest_invitation = 'open' THEN 'dismissed'
          ELSE whats_new_digest_invitation END
    WHERE id = ${principal.tenantId}::uuid
      AND owner_user_id = ${principal.userId}::uuid
      AND status NOT IN ('deletion_pending', 'deleted')
      AND NOT marketplace_reviewer_purpose
    RETURNING whats_new_digest, whats_new_digest_invitation
  `;
  return rows[0] ? monthlyUpdateEmailView(rows[0]) : null;
}

/** The unsubscribe link's POST: the setting goes off. It is a repeat-safe write, and an unknown tenant changes nothing. */
export async function unsubscribeMonthlyUpdateEmail(tenantId: string): Promise<void> {
  await executeExomemSql`
    /* exomem:whats-new-digest-unsubscribe */
    UPDATE exomem_tenants
    SET whats_new_digest = false, whats_new_digest_off_since = now()
    WHERE id = ${tenantId}::uuid AND whats_new_digest
  `;
}

/**
 * The operator's audited action (`send-monthly-whats-new-digest`, Decided):
 * turns the setting on for one existing owner who asked, and records when and
 * under which operator principal on the owner's own row. It refuses no owner who
 * said no before: it reports when they unsubscribed, and whether they dismissed
 * Home's invitation, so the operator knows. A signup that left the switch off is
 * not reported: the row cannot tell it from a signup that never showed the switch
 * (`monthlyUpdateEmail` absent writes off too). `null` when no live owner account
 * has that tenant id.
 */
export async function operatorTurnOnMonthlyUpdateEmail(
  tenantId: string,
  principalDigest: Buffer
): Promise<{ earlierUnsubscribedAt: Date | null; earlierDismissedInvitation: boolean } | null> {
  const written = await writeSetting({
    tenantId,
    ownerUserId: null,
    enabled: true,
    operatorDigest: principalDigest,
  });
  return written
    ? {
        earlierUnsubscribedAt: written.offSinceBefore,
        earlierDismissedInvitation: written.dismissedBefore,
      }
    : null;
}
