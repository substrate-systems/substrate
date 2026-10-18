import { normalizeAccessEmail } from "./access";
import { executeExomemSql, withExomemTransaction, type ExomemSql } from "./db";
import { enqueueExomemEmail } from "./email-outbox";
import { exomemErrors } from "./errors";
import { recordPaddleReceiptContactIntent } from "./paddle-receipt-contact";
import { EXTERNAL_TOKEN_BYTES, generateExternalToken, tokenDigest } from "./security";
import type { ExomemSessionRow } from "./db";
import type { ExomemThemeChoice } from "@/lib/exomem/theme";
import type { ExomemEmailScheme } from "@/lib/email-templates/exomem-email";

const EMAIL_CHANGE_TTL_MS = 15 * 60 * 1000;

type ChangeOwner = {
  owner_user_id: string;
  email: string;
  time_zone: string | null;
  email_scheme: ExomemEmailScheme | null;
  theme_choice: ExomemThemeChoice | null;
};

/** All mutations share deletion's tenant-first lock order. */
async function lockChangeOwner(tx: ExomemSql, tenantId: string): Promise<ChangeOwner | null> {
  const { rows } = await tx`
    /* exomem:email-change-lock-owner */
    SELECT owner_user_id, time_zone, email_scheme, theme_choice
    FROM exomem_tenants
    WHERE id = ${tenantId}::uuid AND status IN ('provisioning', 'active', 'suspended')
      AND desired_state <> 'deleted' AND deleted_at IS NULL
      AND marketplace_reviewer_purpose = false
    FOR UPDATE
  `;
  const tenant = rows[0] as Omit<ChangeOwner, "email"> | undefined;
  if (!tenant) return null;
  const identity = await tx`
    SELECT email::text AS email FROM exomem_users
    WHERE id = ${tenant.owner_user_id}::uuid AND deleted_at IS NULL
    FOR UPDATE
  `;
  const email = identity.rows[0]?.email as string | undefined;
  return email ? { ...tenant, email } : null;
}

function capabilityDigest(token: string): Buffer | null {
  const digest = tokenDigest(token);
  return digest &&
    Buffer.from(token, "base64url").length === EXTERNAL_TOKEN_BYTES &&
    Buffer.from(token, "base64url").toString("base64url") === token
    ? digest
    : null;
}

export async function requestExomemEmailChange(
  session: Pick<ExomemSessionRow, "tenantId" | "userId" | "reviewerCredentialId">,
  proposedEmail: string
): Promise<{ state: "pending"; delivery: "queued"; expiresAt: string }> {
  if (session.reviewerCredentialId) throw exomemErrors.entitlementDenied();
  const proposed = normalizeAccessEmail(proposedEmail);
  const confirmationToken = generateExternalToken();
  const cancellationToken = generateExternalToken();
  const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TTL_MS);
  return withExomemTransaction(async (tx) => {
    const owner = await lockChangeOwner(tx, session.tenantId);
    if (!owner || owner.owner_user_id !== session.userId) throw exomemErrors.sessionInvalid();
    if (owner.email.toLowerCase() === proposed) throw exomemErrors.invalidRequest();
    const { rows } = await tx`
      INSERT INTO exomem_email_changes (
        tenant_id, original_email, proposed_email, confirmation_digest, cancellation_digest, expires_at
      ) VALUES (${session.tenantId}::uuid, ${owner.email}, ${proposed},
        ${capabilityDigest(confirmationToken)}, ${capabilityDigest(cancellationToken)}, ${expiresAt})
      ON CONFLICT (tenant_id) DO UPDATE
      SET id = gen_random_uuid(), original_email = EXCLUDED.original_email,
          proposed_email = EXCLUDED.proposed_email, confirmation_digest = EXCLUDED.confirmation_digest,
          cancellation_digest = EXCLUDED.cancellation_digest, expires_at = EXCLUDED.expires_at,
          created_at = now()
      RETURNING id
    `;
    const requestId = rows[0]!.id as string;
    for (const kind of ["email_change_confirmation", "email_change_cancellation"] as const) {
      await enqueueExomemEmail(tx, {
        kind,
        dedupeKey: `${kind}:${requestId}`,
        tenantId: session.tenantId,
        recipient: kind === "email_change_confirmation" ? proposed : owner.email,
        recipientTimeZone: owner.time_zone,
        recipientEmailScheme: owner.email_scheme,
        recipientThemeChoice: owner.theme_choice,
        expiresAt,
        payload: {
          version: 1,
          requestId,
          tenantId: session.tenantId,
          token: kind === "email_change_confirmation" ? confirmationToken : cancellationToken,
        },
      });
    }
    return { state: "pending", delivery: "queued", expiresAt: expiresAt.toISOString() };
  });
}

/** A token identifies only one request and action; it never creates a browser session. */
export async function completeExomemEmailChange(
  action: "confirm" | "cancel",
  token: string
): Promise<{ state: "confirmed" | "cancelled" }> {
  const digest = capabilityDigest(token);
  if (!digest) throw exomemErrors.accessTokenInvalid();
  try {
    return await withExomemTransaction(async (tx) => {
      // This is discovery only. Tenant and request authority are rechecked under locks below.
      const { rows } = await tx`
        SELECT tenant_id FROM exomem_email_changes
        WHERE (${action} = 'confirm' AND confirmation_digest = ${digest})
           OR (${action} = 'cancel' AND cancellation_digest = ${digest})
      `;
      const tenantId = rows[0]?.tenant_id as string | undefined;
      if (!tenantId) throw exomemErrors.accessTokenInvalid();
      const owner = await lockChangeOwner(tx, tenantId);
      if (!owner) throw exomemErrors.accessTokenInvalid();
      const request = await tx`
        SELECT id, original_email::text AS original_email, proposed_email::text AS proposed_email
        FROM exomem_email_changes
        WHERE tenant_id = ${tenantId}::uuid AND expires_at > now()
          AND ((${action} = 'confirm' AND confirmation_digest = ${digest})
            OR (${action} = 'cancel' AND cancellation_digest = ${digest}))
        FOR UPDATE
      `;
      const pending = request.rows[0] as
        | { id: string; original_email: string; proposed_email: string }
        | undefined;
      if (!pending || pending.original_email.toLowerCase() !== owner.email.toLowerCase())
        throw exomemErrors.accessTokenInvalid();
      if (action === "confirm") {
        await tx`
          UPDATE exomem_users SET email = ${pending.proposed_email}, email_verified_at = now()
          WHERE id = ${owner.owner_user_id}::uuid
        `;
        await tx`
          UPDATE exomem_tenants SET magic_link_generation = magic_link_generation + 1, updated_at = now()
          WHERE id = ${tenantId}::uuid
        `;
        await recordPaddleReceiptContactIntent(tx, tenantId);
      }
      await tx`DELETE FROM exomem_email_changes WHERE tenant_id = ${tenantId}::uuid AND id = ${pending.id}::uuid`;
      return { state: action === "confirm" ? "confirmed" : "cancelled" };
    });
  } catch (error) {
    // Canonical uniqueness rolls back the whole change without merging or revealing another owner.
    if (error && typeof error === "object" && "code" in error && error.code === "23505")
      throw exomemErrors.accessTokenInvalid();
    throw error;
  }
}

export async function loadExomemEmailChange(
  session: Pick<ExomemSessionRow, "tenantId" | "userId">
) {
  const { rows } = await executeExomemSql`
    SELECT change.proposed_email::text AS proposed_email, change.expires_at,
      (SELECT jsonb_object_agg(email.kind, email.state)
       FROM exomem_email_outbox AS email
       WHERE email.dedupe_key IN ('email_change_confirmation:' || change.id, 'email_change_cancellation:' || change.id)) AS delivery
    FROM exomem_email_changes AS change
    JOIN exomem_tenants AS tenant ON tenant.id = change.tenant_id
    WHERE change.tenant_id = ${session.tenantId}::uuid AND tenant.owner_user_id = ${session.userId}::uuid
      AND change.expires_at > now() AND tenant.deleted_at IS NULL
      AND tenant.status NOT IN ('deleted', 'deletion_pending')
  `;
  const row = rows[0] as
    | { proposed_email: string; expires_at: Date | string; delivery: Record<string, string> | null }
    | undefined;
  return row
    ? {
        proposedEmail: row.proposed_email,
        expiresAt: new Date(row.expires_at).toISOString(),
        delivery: row.delivery,
      }
    : null;
}

/** Expired capabilities retain no request history; the existing cron owns bounded cleanup. */
export async function pruneExpiredExomemEmailChanges(limit = 50): Promise<number> {
  const { rows } = await executeExomemSql`
    SELECT tenant_id FROM exomem_email_changes WHERE expires_at <= now()
    ORDER BY expires_at LIMIT ${Math.max(1, Math.min(limit, 500))}
  `;
  let removed = 0;
  for (const row of rows) {
    removed += await withExomemTransaction(async (tx) => {
      const tenant =
        await tx`SELECT id FROM exomem_tenants WHERE id = ${row.tenant_id}::uuid FOR UPDATE SKIP LOCKED`;
      if (!tenant.rows.length) return 0;
      const deleted =
        await tx`DELETE FROM exomem_email_changes WHERE tenant_id = ${row.tenant_id}::uuid AND expires_at <= now() RETURNING id`;
      return deleted.rows.length;
    });
  }
  return removed;
}
