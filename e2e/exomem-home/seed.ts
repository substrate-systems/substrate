// Rows for Home's end-to-end tests, written straight into the test database as the
// real flows write them: an owner with a Paddle entitlement and a Cloud cell, a
// signed-in session, connected apps, the disk reading cellctl reports, and the
// export rows cellctl moves along. Nothing here touches the web server's code.

import { randomBytes, randomUUID } from "node:crypto";
import type { BrowserContext } from "@playwright/test";
import { Pool } from "pg";
import { randomCloudCellId } from "../../src/lib/exomem-hosted/cloud-admission";
import { digestSecret, generateExternalToken } from "../../src/lib/exomem-hosted/security";
import { homeE2eEnvironment } from "./environment";
import type { SentEmail } from "./fake-brevo";

const environment = homeE2eEnvironment();
export const pool = new Pool({ connectionString: environment.databaseUrl, max: 4 });

export type Owner = {
  userId: string;
  tenantId: string;
  cellId: string;
  email: string;
  session: string;
  csrf: string;
};

type Plan =
  /** Paying, Paddle subscription active. */
  | "active"
  /** A payment failed; Paddle retries (grace). */
  | "past_due"
  /** The subscription ended; the memory is kept read-only. */
  | "cancelled"
  /** Complimentary: no Paddle subscription at all. */
  | "complimentary";

const PLAN_STATES: Record<Plan, { source: string; effective: string; cell: string }> = {
  active: { source: "active", effective: "active", cell: "running" },
  past_due: { source: "past_due", effective: "grace", cell: "read_only" },
  cancelled: { source: "cancelled", effective: "cancelled", cell: "read_only" },
  complimentary: { source: "complimentary_active", effective: "active", cell: "running" },
};

export async function createOwner(
  options: {
    plan?: Plan;
    priceName?: string;
    nextBilledAt?: string;
    /** Disk use as cellctl reports it; omitted means never measured. */
    storage?: { usedBytes: number; filesystemBytes: number; observedAt: string };
    /** The cell has served before, so it holds data to export. */
    hasRun?: boolean;
    /** A complimentary tenant made for app-directory review (fixed when the tenant is made). */
    reviewerPurpose?: boolean;
  } = {}
): Promise<Owner> {
  const plan = PLAN_STATES[options.plan ?? "active"];
  const email = `home-${randomUUID().slice(0, 8)}@example.test`;
  const user = await pool.query("INSERT INTO users (email) VALUES ($1) RETURNING id", [email]);
  const userId = String(user.rows[0].id);
  const tenant = await pool.query(
    `INSERT INTO exomem_tenants (owner_user_id, status, desired_state, marketplace_reviewer_purpose)
     VALUES ($1, 'active', 'running', $2) RETURNING id`,
    [userId, options.reviewerPurpose === true]
  );
  const tenantId = String(tenant.rows[0].id);
  if (options.reviewerPurpose || options.plan === "complimentary") {
    await pool.query(
      `INSERT INTO exomem_entitlements (tenant_id, source, source_state, effective_state)
       VALUES ($1, 'complimentary', 'complimentary_active', 'active')`,
      [tenantId]
    );
  } else
    await pool.query(
      `INSERT INTO exomem_entitlements (
       tenant_id, source, source_state, effective_state, provider_environment,
       provider_customer_ref, provider_subscription_ref, source_occurred_at,
       provider_price_name, provider_next_billed_at
     ) VALUES ($1, 'paddle', $2, $3, 'sandbox', $4, $5, now() - interval '1 day', $6, $7)`,
      [
        tenantId,
        plan.source,
        plan.effective,
        `ctm_${randomBytes(12).toString("hex")}`,
        `sub_${randomBytes(12).toString("hex")}`,
        options.priceName ?? "Exomem · monthly",
        options.nextBilledAt ?? null,
      ]
    );
  const cellId = randomCloudCellId();
  await pool.query(
    "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, $3)",
    [cellId, tenantId, plan.cell]
  );
  await pool.query(
    `UPDATE exomem_cloud_cells
        SET ready = true, observed_state = desired_state, observed_image = $2,
            used_bytes = $3, filesystem_bytes = $4, usage_observed_at = $5
      WHERE cell_id = $1`,
    [
      cellId,
      options.hasRun === false ? null : `registry.example.test/exomem@sha256:${"a".repeat(64)}`,
      options.storage?.usedBytes ?? null,
      options.storage?.filesystemBytes ?? null,
      options.storage?.observedAt ?? null,
    ]
  );
  const session = generateExternalToken();
  const csrf = generateExternalToken();
  await pool.query(
    `INSERT INTO exomem_sessions (user_id, tenant_id, session_digest, csrf_digest, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
    [userId, tenantId, digestSecret(session), digestSecret(csrf)]
  );
  return { userId, tenantId, cellId, email, session, csrf };
}

/**
 * A reviewer's sample account: a complimentary tenant made for review, signed in
 * with a reviewer credential. Only one credential per provider may be active, so
 * this retires any earlier test reviewer for the same provider first.
 */
export async function createReviewer(provider: "anthropic" | "openai"): Promise<Owner> {
  const owner = await createOwner({ reviewerPurpose: true });
  await pool.query(
    `UPDATE exomem_marketplace_reviewer_credentials SET revoked_at = now()
      WHERE provider = $1 AND credential_kind = 'cloud_provider_review' AND revoked_at IS NULL`,
    [provider]
  );
  const credential = await pool.query(
    `INSERT INTO exomem_marketplace_reviewer_credentials (
       provider, username_digest, password_hash, owner_user_id, tenant_id, fixture_version,
       fixture_payload_digest, created_by_principal_digest, expires_at, credential_kind
     ) VALUES ($1, $2, '$argon2id$test', $3, $4, 'sample-v1', $5, $6,
               now() + interval '20 days', 'cloud_provider_review') RETURNING id`,
    [provider, randomBytes(32), owner.userId, owner.tenantId, "a".repeat(64), randomBytes(32)]
  );
  await pool.query("UPDATE exomem_sessions SET reviewer_credential_id = $2 WHERE user_id = $1", [
    owner.userId,
    credential.rows[0].id,
  ]);
  return owner;
}

/** Signs the browser in as the owner: the session and CSRF cookies the redeem route sets. */
export async function signIn(context: BrowserContext, owner: Owner) {
  const url = environment.baseUrl;
  await context.addCookies([
    { name: "exomem_session", value: owner.session, url },
    { name: "exomem_csrf", value: owner.csrf, url },
  ]);
}

/** An app the owner connected: an operator-registered client and its live grant. */
export async function connectApp(
  owner: Owner,
  app: { platform: "claude" | "openai" | null; name?: string; redirect?: string }
): Promise<string> {
  const redirect = app.redirect ?? `https://app-${randomUUID().slice(0, 8)}.example.test/callback`;
  const client = await pool.query(
    `INSERT INTO exomem_oauth_clients (
       client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest,
       client_name, client_platform, oauth_client_config_sha256
     ) VALUES ($1, 'pinned', true, $2::jsonb, digest(convert_to($2::jsonb::text, 'utf8'), 'sha256'), $3, $4, $5)
     RETURNING id`,
    [
      `pinned-${randomUUID()}`,
      JSON.stringify([redirect]),
      app.name ?? null,
      app.platform,
      // A platform client carries the checksum of its reviewed configuration.
      app.platform ? randomBytes(32).toString("hex") : null,
    ]
  );
  const grant = await pool.query(
    `INSERT INTO exomem_oauth_grants (user_id, tenant_id, client_id, resource, scopes)
     VALUES ($1, $2, $3, $4, ARRAY['exomem.read', 'exomem.write']) RETURNING id`,
    [owner.userId, owner.tenantId, client.rows[0].id, environment.mcpUrl]
  );
  return String(grant.rows[0].id);
}

export async function grantRevoked(grantId: string): Promise<boolean> {
  const { rows } = await pool.query(
    "SELECT revoked_at IS NOT NULL AS revoked FROM exomem_oauth_grants WHERE id = $1",
    [grantId]
  );
  return rows[0].revoked === true;
}

/** The owner's newest export row, as Home's request left it. */
export async function newestExport(owner: Owner) {
  const { rows } = await pool.query(
    `SELECT export_id, observed_state, link_requested_at
       FROM exomem_cloud_exports WHERE cell_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [owner.cellId]
  );
  return rows[0] as
    | { export_id: string; observed_state: string | null; link_requested_at: Date | null }
    | undefined;
}

/** What cellctl does when the archive is packed and uploaded. */
export async function markExportReady(exportId: string, ttlHours = 24) {
  await pool.query(
    `UPDATE exomem_cloud_exports
        SET observed_state = 'ready', archive_bytes = 1048576, archive_sha256 = $2,
            ready_at = now(), expires_at = now() + make_interval(hours => $3)
      WHERE export_id = $1`,
    [exportId, "b".repeat(64), ttlHours]
  );
}

/** What cellctl does on a link request: a short-lived link issued after the request. */
export async function issueExportLink(exportId: string, url: string) {
  await pool.query(
    `UPDATE exomem_cloud_exports
        SET download_url = $2, download_url_expires_at = now() + interval '5 minutes',
            link_issued_at = now()
      WHERE export_id = $1`,
    [exportId, url]
  );
}

/** Patches the stand-in cell for one tenant (levels, activity, note count). */
export async function setCell(owner: Owner, patch: Record<string, unknown>) {
  const response = await fetch(`${environment.controlUrl}/__control/${owner.tenantId}`, {
    method: "POST",
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(`fake cell control failed: ${response.status}`);
  return response.json();
}

export async function cellState(owner: Owner) {
  const response = await fetch(`${environment.controlUrl}/__control/${owner.tenantId}`);
  return response.json();
}

/** The emails the Brevo stand-in accepted for this owner, oldest first. */
export async function emailsTo(owner: Owner): Promise<SentEmail[]> {
  const response = await fetch(
    `${environment.mailUrl}/__mail?to=${encodeURIComponent(owner.email)}`
  );
  return response.json();
}

/** Every later email to this owner fails at the provider, as in an outage. */
export async function refuseEmailTo(owner: Owner) {
  const response = await fetch(`${environment.mailUrl}/__mail/refuse`, {
    method: "POST",
    body: JSON.stringify({ to: owner.email }),
  });
  if (!response.ok) throw new Error(`fake Brevo control failed: ${response.status}`);
}

/** A deletion link as the confirmation email carries it; the raw token goes in the fragment. */
export async function createDeletionLink(owner: Owner): Promise<string> {
  const token = generateExternalToken();
  await pool.query(
    `INSERT INTO exomem_access_tokens (purpose, token_digest, user_id, tenant_id, expires_at)
     VALUES ('deletion_confirmation', $1, $2, $3, now() + interval '15 minutes')`,
    [digestSecret(token), owner.userId, owner.tenantId]
  );
  return token;
}

export async function tenantStatus(owner: Owner): Promise<string> {
  const { rows } = await pool.query("SELECT status FROM exomem_tenants WHERE id = $1", [
    owner.tenantId,
  ]);
  return String(rows[0].status);
}
