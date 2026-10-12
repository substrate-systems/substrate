// Test data for the journey specs, written straight to the same PostgreSQL the server
// under test reads (EXOMEM_E2E_DATABASE_URL). Each call makes its own people, apps and
// requests, so specs run in parallel without sharing a row.
//
// Only providers outside Exomem are substituted: Turnstile by Cloudflare's documented
// test keys (configuration, not code), Paddle not at all (no spec completes a payment),
// and mail by reading the outbox rows the server wrote instead of a mailbox.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  decryptSecret,
  digestSecret,
  generateExternalToken,
  tokenDigest,
} from "../../src/lib/exomem-hosted/security";
import {
  generateMarketplaceReviewerCredential,
  hashMarketplaceReviewerPassword,
} from "../../src/lib/exomem-hosted/reviewer-access";

const databaseUrl = process.env.EXOMEM_E2E_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "EXOMEM_E2E_DATABASE_URL is not set: the journey specs need the server's database"
  );
}
export const pool = new Pool({ connectionString: databaseUrl, max: 4 });

const baseUrl = process.env.EXOMEM_E2E_BASE_URL;
if (!baseUrl) {
  throw new Error(
    "EXOMEM_E2E_BASE_URL is not set: the server's public address (EXOMEM_PUBLIC_BASE_URL)"
  );
}
export const BASE_URL = baseUrl;
export const CLOUD_MCP_URL = process.env.EXOMEM_CLOUD_MCP_URL ?? "";

export function uniqueEmail(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}@example.test`;
}

/**
 * Room in Cloud for new people: one fresh observation with plenty of slots, and nobody
 * on the waitlist (a new person joins the queue behind anyone already waiting).
 */
export async function seedCapacity(): Promise<void> {
  await pool.query(
    `INSERT INTO exomem_cloud_capacity (node, cell_slots, observed_at)
     VALUES ('journey-e2e', 10000, now())
     ON CONFLICT (node) DO UPDATE SET cell_slots = 10000, observed_at = now()`
  );
  await pool.query("DELETE FROM exomem_waitlist_entries WHERE admitted_at IS NULL");
}

export type OwnerState =
  | "unpaid"
  | "preparing"
  | "ready"
  | "readonly"
  | "ended"
  | "paused"
  | "suspended";

type EntitlementRow = {
  source: "paddle" | "complimentary";
  sourceState: string;
  effectiveState: string;
  graceStarted?: boolean;
  occurredDaysAgo?: number;
  manuallySuspended?: boolean;
};

// The states the Paddle projection and admission write (entitlements.ts lists them).
const ENTITLEMENTS: Record<OwnerState, EntitlementRow> = {
  unpaid: { source: "paddle", sourceState: "awaiting_checkout", effectiveState: "provisioning" },
  preparing: { source: "paddle", sourceState: "active", effectiveState: "active" },
  ready: { source: "paddle", sourceState: "active", effectiveState: "active" },
  readonly: {
    source: "paddle",
    sourceState: "past_due",
    effectiveState: "grace",
    graceStarted: true,
  },
  ended: {
    source: "paddle",
    sourceState: "cancelled",
    effectiveState: "cancelled",
    occurredDaysAgo: 2,
  },
  paused: { source: "paddle", sourceState: "paused", effectiveState: "suspended" },
  suspended: {
    source: "paddle",
    sourceState: "active",
    effectiveState: "suspended",
    manuallySuspended: true,
  },
};

const CELLS: Record<OwnerState, { desired: string; observed: string | null; ready: boolean }> = {
  unpaid: { desired: "stopped", observed: "stopped", ready: false },
  preparing: { desired: "running", observed: "provisioning", ready: false },
  ready: { desired: "running", observed: "running", ready: true },
  readonly: { desired: "read_only", observed: "read_only", ready: true },
  ended: { desired: "read_only", observed: "read_only", ready: true },
  paused: { desired: "stopped", observed: "stopped", ready: false },
  suspended: { desired: "stopped", observed: "stopped", ready: false },
};

function cellId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return Array.from(randomBytes(16), (byte) => alphabet[byte % 32]).join("");
}

export type Owner = {
  email: string;
  userId: string;
  tenantId: string;
  supportReference: string;
  /** The browser cookies a signed-in owner carries. */
  cookies: { name: string; value: string; url: string }[];
};

/** An owner with an Exomem in `state` and a signed-in browser session. */
export async function seedOwner(state: OwnerState, email = uniqueEmail(state)): Promise<Owner> {
  const entitlement = ENTITLEMENTS[state];
  const cell = CELLS[state];
  const user = await pool.query<{ id: string }>(
    "INSERT INTO users (email) VALUES ($1) RETURNING id",
    [email]
  );
  const userId = user.rows[0]!.id;
  const tenant = await pool.query<{ id: string; support_reference: string }>(
    `INSERT INTO exomem_tenants (owner_user_id, status) VALUES ($1, 'active')
     RETURNING id, support_reference`,
    [userId]
  );
  const tenantId = tenant.rows[0]!.id;
  await pool.query(
    `INSERT INTO exomem_entitlements (
       tenant_id, source, source_state, effective_state, grace_started_at,
       source_occurred_at, manual_suspended_at
     ) VALUES ($1, $2, $3, $4,
       CASE WHEN $5::boolean THEN now() - interval '2 days' END,
       now() - make_interval(days => $6::int),
       CASE WHEN $7::boolean THEN now() END)`,
    [
      tenantId,
      entitlement.source,
      entitlement.sourceState,
      entitlement.effectiveState,
      entitlement.graceStarted ?? false,
      entitlement.occurredDaysAgo ?? 0,
      entitlement.manuallySuspended ?? false,
    ]
  );
  await pool.query(
    `INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state, observed_state, ready)
     VALUES ($1, $2, $3, $4, $5)`,
    [cellId(), tenantId, cell.desired, cell.observed, cell.ready]
  );
  const session = generateExternalToken();
  const csrf = generateExternalToken();
  await pool.query(
    `INSERT INTO exomem_sessions (user_id, tenant_id, session_digest, csrf_digest, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
    [userId, tenantId, tokenDigest(session), digestSecret(csrf)]
  );
  return {
    email,
    userId,
    tenantId,
    supportReference: `EX-${tenant.rows[0]!.support_reference}`,
    cookies: [
      { name: "exomem_session", value: session, url: BASE_URL },
      { name: "exomem_csrf", value: csrf, url: BASE_URL },
    ],
  };
}

/**
 * The app-directory reviewer account and its credential, the way the operator issues
 * them: a complimentary, running Exomem kept for review. One live credential per
 * directory, so this retires any earlier one first.
 */
export async function seedReviewer(): Promise<{ username: string; password: string }> {
  const { username, password, usernameDigest } = generateMarketplaceReviewerCredential();
  const user = await pool.query<{ id: string }>(
    "INSERT INTO users (email) VALUES ($1) RETURNING id",
    [uniqueEmail("reviewer")]
  );
  const userId = user.rows[0]!.id;
  const tenant = await pool.query<{ id: string }>(
    `INSERT INTO exomem_tenants (owner_user_id, status, desired_state, marketplace_reviewer_purpose)
     VALUES ($1, 'active', 'running', true) RETURNING id`,
    [userId]
  );
  const tenantId = tenant.rows[0]!.id;
  await pool.query(
    `INSERT INTO exomem_entitlements (tenant_id, source, source_state, effective_state)
     VALUES ($1, 'complimentary', 'complimentary_active', 'active')`,
    [tenantId]
  );
  await pool.query(
    `INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state, observed_state, ready)
     VALUES ($1, $2, 'running', 'running', true)`,
    [cellId(), tenantId]
  );
  const operator = createHash("sha256").update("journey-e2e operator").digest();
  await pool.query(
    `UPDATE exomem_marketplace_reviewer_credentials
     SET revoked_at = now(), revoked_by_principal_digest = $1
     WHERE provider = 'anthropic' AND credential_kind = 'cloud_provider_review' AND revoked_at IS NULL`,
    [operator]
  );
  await pool.query(
    `INSERT INTO exomem_marketplace_reviewer_credentials (
       provider, username_digest, password_hash, owner_user_id, tenant_id, fixture_version,
       fixture_payload_digest, expires_at, created_by_principal_digest, credential_kind
     ) VALUES ('anthropic', $1, $2, $3, $4, 'journey-e2e', $5, now() + interval '1 day', $6,
               'cloud_provider_review')`,
    [
      usernameDigest,
      await hashMarketplaceReviewerPassword(password),
      userId,
      tenantId,
      createHash("sha256").update("journey-e2e fixture").digest("hex"),
      operator,
    ]
  );
  return { username, password };
}

export type SeededClient = {
  clientId: string;
  redirectUri: string;
  /** The name the consent page shows: the operator's, for a pinned client. */
  name: string;
};

/**
 * An app on a web host or on this computer. The operator registers and names it (pinned),
 * or it registers itself with a name of its own choosing (generic, RFC 7591), which
 * Exomem cannot vouch for. `platform` is the client_platform CHECK value, or null.
 */
export async function seedClient(input: {
  name: string;
  redirectUri: string;
  platform: "claude" | "openai" | null;
  namedBy?: "operator" | "itself";
}): Promise<SeededClient> {
  const clientId = `journey-e2e-${randomUUID()}`;
  const redirectUris = JSON.stringify([input.redirectUri]);
  const selfNamed = input.namedBy === "itself";
  // Self-registered apps are admitted only while the operator keeps their lane open.
  if (selfNamed) await pool.query("UPDATE exomem_oauth_generic_client_lane SET enabled = true");
  await pool.query(
    `INSERT INTO exomem_oauth_clients (
       client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest,
       client_platform, client_name, oauth_client_config_sha256
     ) VALUES ($1, $6, true, $2::jsonb, digest(convert_to($2::jsonb::text, 'utf8'), 'sha256'),
               $3, $4, $5)`,
    [
      clientId,
      redirectUris,
      selfNamed ? null : input.platform,
      input.name,
      // A platform client carries the digest of its operator configuration; any other has none.
      input.platform && !selfNamed ? randomBytes(32).toString("hex") : null,
      selfNamed ? "generic" : "pinned",
    ]
  );
  return { clientId, redirectUri: input.redirectUri, name: input.name };
}

/** An authorization request the way an app opens it: the URL the browser goes to first. */
export function authorizeRequest(client: SeededClient): { url: string; state: string } {
  const state = `state-${randomUUID()}`;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL("/api/exomem/oauth/authorize", BASE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "exomem.read exomem.write",
    resource: CLOUD_MCP_URL,
  }).toString();
  return { url: url.toString(), state };
}

/** How many live grants this app holds. */
export async function grantCount(client: SeededClient): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM exomem_oauth_grants AS oauth_grant
     JOIN exomem_oauth_clients AS c ON c.id = oauth_grant.client_id
     WHERE c.client_id = $1 AND oauth_grant.revoked_at IS NULL`,
    [client.clientId]
  );
  return rows[0]!.count;
}

/**
 * The sign-in link the server queued for an owner (email 01), as the email carries it.
 * This stands in for Brevo: it marks the email sent the way the delivery worker does once
 * Brevo accepts it (markMagicLinkDeliverySent), because a link works only after it went out.
 */
export async function signInLinkFor(email: string): Promise<string> {
  const { rows } = await pool.query<{ secret: unknown }>(
    `WITH queued AS (
       SELECT outbox.id, outbox.token_id, outbox.secret_ciphertext
       FROM exomem_access_delivery_outbox AS outbox
       JOIN exomem_access_tokens AS token ON token.id = outbox.token_id
       JOIN users ON users.id = token.user_id
       WHERE users.email = $1 AND outbox.state = 'pending'
       ORDER BY outbox.created_at DESC LIMIT 1
     ), sent AS (
       UPDATE exomem_access_delivery_outbox AS outbox
       SET state = 'sent', secret_ciphertext = NULL, sent_at = now(), updated_at = now()
       FROM queued WHERE outbox.id = queued.id
     ), delivered AS (
       UPDATE exomem_access_tokens AS token
       SET delivery_state = 'sent', delivered_at = now()
       FROM queued WHERE token.id = queued.token_id
     )
     SELECT secret_ciphertext AS secret FROM queued`,
    [email]
  );
  if (!rows[0]) throw new Error(`no sign-in link queued for ${email}`);
  const payload = JSON.parse(
    decryptSecret(rows[0].secret as Parameters<typeof decryptSecret>[0]).reveal()
  ) as { token: string };
  return `${BASE_URL}/exomem/sign-in#${payload.token}`;
}

/** The start link a new person's "Start with your email" queued (email 01w). */
export async function startLinkFor(email: string): Promise<string> {
  const { rows } = await pool.query<{ payload: unknown }>(
    `SELECT payload_ciphertext AS payload FROM exomem_email_outbox
     WHERE recipient = $1 AND kind = 'start'
     ORDER BY created_at DESC LIMIT 1`,
    [email]
  );
  if (!rows[0]) throw new Error(`no start link queued for ${email}`);
  const payload = JSON.parse(
    decryptSecret(rows[0].payload as Parameters<typeof decryptSecret>[0]).reveal()
  ) as { token: string };
  return `${BASE_URL}/exomem/invite#${payload.token}`;
}

/** How many emails of a kind the outbox holds for an address. */
export async function queuedEmails(email: string): Promise<string[]> {
  const { rows } = await pool.query<{ kind: string }>(
    "SELECT kind FROM exomem_email_outbox WHERE recipient = $1 ORDER BY created_at",
    [email]
  );
  return rows.map((row) => row.kind);
}
