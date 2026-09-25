import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it, mock } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { terminateExomemBillingForDeletion } from "../billing-deletion";
import {
  admitFirstCloudOAuthInviteAtomic,
  expireCloudAwaitingCheckoutTenants,
  redeemCloudInviteAtomic,
} from "../cloud-admission";
import {
  finishCloudAccountDeletion,
  runBoundedCloudDeletionFinish,
  type CloudDeletionFinishDependencies,
  type CloudDeletionFinishOutcome,
} from "../cloud-deletion-finish";
import { reconcileCloudCellDesiredState, runBoundedCloudReconcile } from "../cloud-lifecycle";
import {
  __setExomemSqlForTests,
  __setExomemTransactionForTests,
  consumeDeletionConfirmationAtomic,
  createDeletionConfirmationToken,
  type ExomemSql,
} from "../db";
import { confirmDeletion } from "../deletion";
import { issueOAuthTokensFromCodeAtomic } from "../oauth-store";
import type { PaddleTransport } from "../paddle-billing";
import type { ExomemPaddleConfig } from "../paddle-config";
import { generateExternalToken, tokenDigest } from "../security";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

// Task 3.10: the Cloud deletion finish (design D4 "Cloud deletion finish")
// against real PostgreSQL, from the owner's confirmation to a `deleted`
// tenant. The receipt is proved by enumeration: every row reachable from the
// tenant through a foreign key, plus every row in a table keyed by a
// tenant_id column that has no foreign key, is counted, and anything outside
// D4's receipt fails the test.

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
let pool: Pool | undefined;
let schema: string | undefined;

const CONFIG: ExomemPaddleConfig = {
  environment: "sandbox",
  apiBaseUrl: "https://sandbox-api.paddle.test",
  productKey: "exomem-hosted",
  productId: null,
  priceId: null,
  checkoutUrl: null,
  apiKey: "fake-test-key",
  webhookSecret: null,
  clientToken: null,
  clientEnvironment: null,
  paidCheckoutEnabled: false,
};

const CLOUD_RESOURCE = "https://cloud.example.test/mcp/v1";
const CLOUD_CONFIG_ENV = {
  EXOMEM_CLOUD_MCP_URL: CLOUD_RESOURCE,
  EXOMEM_CLOUD_MCP_PATH: "/api/exomem/cloud/mcp/v1",
  EXOMEM_CLOUD_CELL_TOKEN_KEY: "a".repeat(64),
} as const;
const priorEnv: Record<string, string | undefined> = {};

function taggedSql(client: Pool | PoolClient): ExomemSql {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1) {
      text += `$${index + 1}${strings[index + 1]}`;
    }
    const result = await client.query(text, values);
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount ?? 0 };
  };
}

async function interactiveTransaction<T>(callback: (tx: ExomemSql) => Promise<T>): Promise<T> {
  const client = await pool!.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const result = await callback(taggedSql(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// One schema is shared by the whole file, so every table a test can touch is
// cleared child-first before the next test.
async function resetFleet(): Promise<void> {
  for (const table of [
    "exomem_paddle_events",
    "exomem_waitlist_entries",
    "exomem_oauth_authorization_codes",
    "exomem_oauth_grants",
    "exomem_oauth_authorization_transactions",
    "exomem_oauth_clients",
    "exomem_invites",
    "exomem_access_tokens",
    "exomem_sessions",
    "exomem_lifecycle_operations",
    "exomem_exports",
    "exomem_entitlements",
    "exomem_cloud_cells",
    "exomem_oauth_account_blocks",
    "exomem_tenants",
    "users",
    "exomem_cloud_capacity",
  ]) {
    await pool!.query(`DELETE FROM ${table}`);
  }
  await pool!.query("INSERT INTO exomem_cloud_capacity (node, cell_slots) VALUES ($1, 20)", [
    `node-${randomUUID()}`,
  ]);
}

const PADDLE_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
function paddleId(prefix: "sub" | "ctm" | "txn" | "evt"): string {
  const bytes = randomBytes(26);
  let id = "";
  for (const byte of bytes) id += PADDLE_ID_ALPHABET[byte % PADDLE_ID_ALPHABET.length];
  return `${prefix}_${id}`;
}

type AdmittedTenant = {
  tenantId: string;
  userId: string;
  cellId: string;
  email: string;
  inviteId: string;
};

/**
 * A real Cloud OAuth admission (invite, grant, code, session, cell) followed by
 * a real token exchange, so the tenant holds a grant, a token family, an
 * access token and, with offline access, a refresh token.
 */
async function admitCloudTenant(input: {
  source: "complimentary" | "paddle";
  offlineAccess?: boolean;
  email?: string;
}): Promise<AdmittedTenant> {
  const email = input.email ?? `cloud-deletion-${randomUUID()}@example.test`;
  const clientId = `https://cloud-deletion-${randomUUID()}.example.test/client.json`;
  const host = new URL(clientId).hostname;
  await pool!.query(
    "INSERT INTO exomem_oauth_admitted_cimd_hosts (platform, host) VALUES ('claude', $1) ON CONFLICT DO NOTHING",
    [host]
  );
  const redirectUri = `https://${host}/callback`;
  const client = await pool!.query<{ id: string }>(
    `INSERT INTO exomem_oauth_clients (
       client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest,
       metadata_document_digest, metadata_fetched_at, metadata_ttl_seconds, metadata_expires_at,
       cimd_host, client_platform, oauth_client_config_sha256
     ) VALUES (
       $1, 'cimd', true, $2::jsonb, digest(convert_to($2::jsonb::text, 'utf8'), 'sha256'),
       $3, now(), 3600, now() + interval '1 hour', $4, 'claude', $5
     ) RETURNING id`,
    [
      clientId,
      JSON.stringify([redirectUri]),
      randomBytes(32),
      host,
      randomBytes(32).toString("hex"),
    ]
  );
  const inviteDigest = randomBytes(32);
  await pool!.query(
    `INSERT INTO exomem_invites (
       token_digest, email_normalized, entitlement_source, entitlement_capabilities,
       entitlement_limits, created_by_principal_digest, expires_at
     ) VALUES ($1, $2, $3, '["capture","recall"]'::jsonb, '{}'::jsonb, $4, now() + interval '1 day')`,
    [inviteDigest, email, input.source, randomBytes(32)]
  );
  const transactionDigest = randomBytes(32);
  const scopes = input.offlineAccess ? ["exomem.read", "offline_access"] : ["exomem.read"];
  await pool!.query(
    `INSERT INTO exomem_oauth_authorization_transactions (
       transaction_digest, client_id, redirect_uri, resource, requested_scopes,
       state_digest, state_envelope, form_nonce_digest, continuation_binding, pkce_challenge, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, $7, $8, 'challenge', now() + interval '1 hour')`,
    [
      transactionDigest,
      client.rows[0]!.id,
      redirectUri,
      CLOUD_RESOURCE,
      scopes,
      randomBytes(32),
      randomBytes(32),
      randomBytes(32),
    ]
  );
  const codeDigest = randomBytes(32);
  const admission = await admitFirstCloudOAuthInviteAtomic({
    inviteDigest,
    transactionDigest,
    sessionDigest: randomBytes(32),
    csrfDigest: randomBytes(32),
    sessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    codeDigest,
    codeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  assert.ok(admission, "sanity: the Cloud OAuth admission succeeds");
  const issued = await issueOAuthTokensFromCodeAtomic({
    codeDigest,
    clientId,
    redirectUri,
    resource: CLOUD_RESOURCE,
    pkceChallenge: "challenge",
    refreshDigest: randomBytes(32),
    refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    accessDigest: randomBytes(32),
    accessExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  assert.ok(issued, "sanity: the admitted tenant holds live Cloud tokens");
  const owner = await pool!.query<{ owner_user_id: string }>(
    "SELECT owner_user_id FROM exomem_tenants WHERE id = $1",
    [admission!.tenantId]
  );
  const invite = await pool!.query<{ id: string }>(
    "SELECT id FROM exomem_invites WHERE token_digest = $1",
    [inviteDigest]
  );
  return {
    tenantId: admission!.tenantId,
    userId: owner.rows[0]!.owner_user_id,
    cellId: admission!.cellId,
    email,
    inviteId: invite.rows[0]!.id,
  };
}

type Subscription = { subscriptionRef: string; customerRef: string; transactionRef: string };

/**
 * What the Paddle checkout webhook leaves behind for a paid tenant: an active
 * subscription with every provider reference, and the event's dedupe row.
 * The invite is the self-serve kind, admitted off the waitlist.
 */
async function activateSubscription(tenant: AdmittedTenant): Promise<Subscription> {
  const subscription = {
    subscriptionRef: paddleId("sub"),
    customerRef: paddleId("ctm"),
    transactionRef: paddleId("txn"),
  };
  const eventId = paddleId("evt");
  await pool!.query(
    `UPDATE exomem_entitlements
     SET source = 'paddle', source_state = 'active', effective_state = 'active',
         provider_environment = 'sandbox', provider_customer_ref = $2,
         provider_subscription_ref = $3, provider_transaction_ref = $4,
         source_revision = $5, source_occurred_at = now()
     WHERE tenant_id = $1`,
    [
      tenant.tenantId,
      subscription.customerRef,
      subscription.subscriptionRef,
      subscription.transactionRef,
      eventId,
    ]
  );
  await pool!.query(
    `INSERT INTO exomem_paddle_events (
       paddle_event_id, environment, event_type, tenant_id, source_revision,
       occurred_at, applied_at, disposition
     ) VALUES ($1, 'sandbox', 'subscription.activated', $2, $1, now(), now(), 'applied')`,
    [eventId, tenant.tenantId]
  );
  await pool!.query("UPDATE exomem_invites SET self_serve = true WHERE id = $1", [tenant.inviteId]);
  await pool!.query(
    `INSERT INTO exomem_waitlist_entries (email_normalized, admitted_at, admitted_invite_id)
     VALUES ($1, now(), $2)`,
    [tenant.email, tenant.inviteId]
  );
  assert.equal(await reconcileCloudCellDesiredState(tenant.tenantId), "running");
  return subscription;
}

type FakePaddle = {
  transport: PaddleTransport;
  calls: string[];
  mode: "ok" | "throw" | "not_found";
};

/** Paddle, answering an immediate cancellation or an already-cancelled checkout. */
function fakePaddle(owner?: AdmittedTenant): FakePaddle {
  const fake: FakePaddle = {
    calls: [],
    mode: "ok",
    transport: async (path, init) => {
      fake.calls.push(`${init?.method ?? "GET"} ${path}`);
      if (fake.mode === "throw") throw new Error("simulated provider outage");
      if (fake.mode === "not_found") return new Response(null, { status: 404 });
      const cancel = /^\/subscriptions\/(sub_[a-z0-9]{26})\/cancel$/.exec(path);
      if (cancel) return Response.json({ data: { id: cancel[1], status: "canceled" } });
      const transaction = /^\/transactions\/(txn_[a-z0-9]{26})$/.exec(path);
      if (transaction && owner) {
        return Response.json({
          data: {
            id: transaction[1],
            status: "canceled",
            custom_data: {
              product_key: CONFIG.productKey,
              user_id: owner.userId,
              tenant_id: owner.tenantId,
            },
          },
        });
      }
      return new Response(null, { status: 500 });
    },
  };
  return fake;
}

type RealisticFakePaddle = { transport: PaddleTransport; calls: string[] };

/**
 * M1/L4: Paddle as documented, not as the simpler `fakePaddle` above pretends
 * -- a second cancel of an already-canceled subscription answers
 * `400 subscription_is_canceled_action_invalid`, not a repeat 200. A GET
 * against the bare subscription path is not modeled here (a 500, like any
 * other unhandled route on this fake), so the billing-deletion fix's GET
 * fallback (`subscriptionIsCanceled`) cannot heal a losing 400 through this
 * fake -- the loser's `terminateBilling` genuinely returns null.
 */
function realisticFakePaddle(options: { supportsGet?: boolean } = {}): RealisticFakePaddle {
  const canceled = new Set<string>();
  const calls: string[] = [];
  const transport: PaddleTransport = async (path, init) => {
    calls.push(`${init?.method ?? "GET"} ${path}`);
    const cancel = /^\/subscriptions\/(sub_[a-z0-9]{26})\/cancel$/.exec(path);
    if (cancel) {
      if (canceled.has(cancel[1])) {
        return Response.json(
          {
            error: {
              type: "request_error",
              code: "subscription_is_canceled_action_invalid",
              detail: "action can't be performed on canceled subscription",
            },
          },
          { status: 400 }
        );
      }
      canceled.add(cancel[1]);
      return Response.json({ data: { id: cancel[1], status: "canceled" } });
    }
    if (options.supportsGet) {
      const get = /^\/subscriptions\/(sub_[a-z0-9]{26})$/.exec(path);
      if (get) {
        return canceled.has(get[1])
          ? Response.json({ data: { id: get[1], status: "canceled" } })
          : Response.json({ data: { id: get[1], status: "active" } });
      }
    }
    return new Response(null, { status: 500 });
  };
  return { transport, calls };
}

/** The finish's billing step, the real one, over the fake Paddle. */
function withPaddle(fake: FakePaddle): Partial<CloudDeletionFinishDependencies> {
  return {
    terminateBilling: (tenantId) =>
      terminateExomemBillingForDeletion(tenantId, { config: CONFIG, transport: fake.transport }),
  };
}

/**
 * The owner confirms deletion through the real confirmDeletion under Cloud:
 * the real consume and the real Cloud reconcile run, and `finishCloud` is the
 * best-effort finish confirmDeletion calls afterwards.
 */
async function confirmCloudDeletion(
  tenant: AdmittedTenant,
  finishCloud: (tenantId: string) => Promise<unknown>
): Promise<Awaited<ReturnType<typeof confirmDeletion>>> {
  const token = generateExternalToken();
  const created = await createDeletionConfirmationToken({
    userId: tenant.userId,
    tenantId: tenant.tenantId,
    tokenDigest: tokenDigest(token)!,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });
  assert.ok(created, "sanity: the owner can request a deletion confirmation");
  const prior = process.env.EXOMEM_CLOUD_ENABLED;
  process.env.EXOMEM_CLOUD_ENABLED = "1";
  try {
    return await confirmDeletion(
      token,
      { userId: tenant.userId, tenantId: tenant.tenantId },
      {
        reconcile: async () => ({ attempted: false, code: "RECONCILE_IDLE" }),
        finishCloud,
      }
    );
  } finally {
    if (prior === undefined) delete process.env.EXOMEM_CLOUD_ENABLED;
    else process.env.EXOMEM_CLOUD_ENABLED = prior;
  }
}

type ForeignKeyEdge = {
  child: string;
  parent: string;
  childColumns: string[];
  parentColumns: string[];
};

async function foreignKeyEdges(): Promise<ForeignKeyEdge[]> {
  const { rows } = await pool!.query(`
    SELECT constraint_row.conrelid::regclass::text AS child,
           constraint_row.confrelid::regclass::text AS parent,
           array_agg(child_column.attname::text ORDER BY key.ordinality) AS child_columns,
           array_agg(parent_column.attname::text ORDER BY key.ordinality) AS parent_columns
    FROM pg_constraint AS constraint_row
    CROSS JOIN LATERAL unnest(constraint_row.conkey, constraint_row.confkey)
      WITH ORDINALITY AS key(child_attnum, parent_attnum, ordinality)
    JOIN pg_attribute AS child_column
      ON child_column.attrelid = constraint_row.conrelid AND child_column.attnum = key.child_attnum
    JOIN pg_attribute AS parent_column
      ON parent_column.attrelid = constraint_row.confrelid AND parent_column.attnum = key.parent_attnum
    WHERE constraint_row.contype = 'f'
      AND constraint_row.connamespace = current_schema()::regnamespace
    GROUP BY constraint_row.oid, constraint_row.conrelid, constraint_row.confrelid
  `);
  return rows.map((row) => ({
    child: String(row.child),
    parent: String(row.parent),
    childColumns: row.child_columns as string[],
    parentColumns: row.parent_columns as string[],
  }));
}

/**
 * Every row the tenant owns, counted per table, found from the catalog rather
 * than a hand-picked list: the tenant row, every row in a table keyed by a
 * tenant_id column without a foreign key, and then, transitively, every row
 * whose foreign key points at a row already found. Only non-empty tables are
 * returned.
 */
async function tenantFootprint(tenantId: string): Promise<Record<string, number>> {
  const edges = await foreignKeyEdges();
  assert.ok(
    edges.some((edge) => edge.parent === "exomem_tenants" && edge.child === "exomem_cloud_cells"),
    "sanity: the catalog walk sees the schema's foreign keys"
  );
  const found = new Map<string, Map<string, Record<string, unknown>>>();
  const add = (table: string, rows: Array<Record<string, unknown>>): boolean => {
    let byLocation = found.get(table);
    if (!byLocation) {
      byLocation = new Map();
      found.set(table, byLocation);
    }
    let added = false;
    for (const row of rows) {
      const location = String(row.location);
      if (!byLocation.has(location)) {
        byLocation.set(location, row.data as Record<string, unknown>);
        added = true;
      }
    }
    return added;
  };

  const tenant = await pool!.query(
    "SELECT ctid::text AS location, to_jsonb(t.*) AS data FROM exomem_tenants AS t WHERE id = $1",
    [tenantId]
  );
  add("exomem_tenants", tenant.rows);

  // Tables keyed by a tenant_id column that no foreign key covers (migration
  // 0017's exomem_audit_events is the only one today).
  const covered = new Set(
    edges
      .filter((edge) => edge.parent === "exomem_tenants" && edge.childColumns.length === 1)
      .map((edge) => `${edge.child}.${edge.childColumns[0]}`)
  );
  const tenantColumns = await pool!.query(
    `SELECT table_name::text, column_name::text
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND column_name LIKE '%tenant_id'
       AND data_type = 'uuid'
       AND table_name <> 'exomem_tenants'`
  );
  for (const column of tenantColumns.rows) {
    if (covered.has(`${column.table_name}.${column.column_name}`)) continue;
    const { rows } = await pool!.query(
      `SELECT t.ctid::text AS location, to_jsonb(t.*) AS data
       FROM "${column.table_name}" AS t WHERE t."${column.column_name}" = $1`,
      [tenantId]
    );
    add(String(column.table_name), rows);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      const parents = found.get(edge.parent);
      if (!parents || parents.size === 0) continue;
      const keys = [...parents.values()]
        .map((row) =>
          edge.parentColumns.map((column) => (row[column] == null ? null : String(row[column])))
        )
        .filter((key) => key.every((value) => value !== null));
      if (keys.length === 0) continue;
      const predicate = edge.childColumns
        .map((column, index) => `t."${column}"::text = key.value->>${index}`)
        .join(" AND ");
      const { rows } = await pool!.query(
        `SELECT t.ctid::text AS location, to_jsonb(t.*) AS data
         FROM "${edge.child}" AS t
         WHERE EXISTS (
           SELECT 1 FROM jsonb_array_elements($1::jsonb) AS key(value) WHERE ${predicate}
         )`,
        [JSON.stringify(keys)]
      );
      if (add(edge.child, rows)) changed = true;
    }
  }

  return Object.fromEntries(
    [...found.entries()]
      .filter(([, rows]) => rows.size > 0)
      .map(([table, rows]) => [table, rows.size] as const)
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

/** D4's receipt, exactly: nothing else may remain for the tenant. */
function d4Receipt(input: { cells?: number; refreshTokens?: number } = {}): Record<string, number> {
  return {
    exomem_cloud_cells: input.cells ?? 1,
    exomem_entitlements: 1,
    exomem_oauth_access_tokens: 1,
    exomem_oauth_grants: 1,
    ...(input.refreshTokens ? { exomem_oauth_refresh_tokens: input.refreshTokens } : {}),
    exomem_oauth_token_families: 1,
    exomem_tenants: 1,
  };
}

async function assertFinishedReceipt(
  tenant: AdmittedTenant,
  expected: { sourceState: string; cells?: number; refreshTokens?: number }
): Promise<void> {
  assert.deepEqual(await tenantFootprint(tenant.tenantId), d4Receipt(expected));

  const tenantRow = await pool!.query(
    "SELECT status, desired_state, deleted_at, bound_cell_id FROM exomem_tenants WHERE id = $1",
    [tenant.tenantId]
  );
  assert.equal(tenantRow.rows[0]!.status, "deleted");
  assert.equal(tenantRow.rows[0]!.desired_state, "deleted");
  assert.notEqual(tenantRow.rows[0]!.deleted_at, null);
  assert.equal(tenantRow.rows[0]!.bound_cell_id, null);

  const entitlement = await pool!.query(
    `SELECT source_state, effective_state, capabilities, provider_environment,
            provider_customer_ref, provider_subscription_ref, provider_transaction_ref,
            provider_provenance_unresolved_fingerprint
     FROM exomem_entitlements WHERE tenant_id = $1`,
    [tenant.tenantId]
  );
  assert.deepEqual(entitlement.rows[0], {
    source_state: expected.sourceState,
    effective_state: "deleted",
    capabilities: [],
    provider_environment: null,
    provider_customer_ref: null,
    provider_subscription_ref: null,
    provider_transaction_ref: null,
    provider_provenance_unresolved_fingerprint: null,
  });

  const cells = await pool!.query(
    "SELECT desired_state FROM exomem_cloud_cells WHERE tenant_id = $1",
    [tenant.tenantId]
  );
  assert.ok(cells.rows.every((row) => row.desired_state === "deleted"));

  const consent = await pool!.query(
    `SELECT
       (SELECT count(*)::int FROM exomem_oauth_grants WHERE tenant_id = $1 AND revoked_at IS NULL) AS grants,
       (SELECT count(*)::int FROM exomem_oauth_token_families AS family
         JOIN exomem_oauth_grants AS g ON g.id = family.grant_id
         WHERE g.tenant_id = $1 AND family.revoked_at IS NULL) AS families,
       (SELECT count(*)::int FROM exomem_oauth_access_tokens AS token
         JOIN exomem_oauth_grants AS g ON g.id = token.grant_id
         WHERE g.tenant_id = $1 AND token.revoked_at IS NULL) AS tokens`,
    [tenant.tenantId]
  );
  assert.deepEqual(consent.rows[0], { grants: 0, families: 0, tokens: 0 });

  // The shared Substrate account and its email stay.
  const user = await pool!.query("SELECT email, deleted_at FROM users WHERE id = $1", [
    tenant.userId,
  ]);
  assert.equal(user.rows[0]!.email, tenant.email);
  assert.equal(user.rows[0]!.deleted_at, null);
}

async function tenantStatus(tenantId: string): Promise<string> {
  const { rows } = await pool!.query("SELECT status FROM exomem_tenants WHERE id = $1", [tenantId]);
  return String(rows[0]!.status);
}

async function lifecycleOperations(tenantId: string): Promise<number> {
  const { rows } = await pool!.query(
    "SELECT count(*)::int AS n FROM exomem_lifecycle_operations WHERE tenant_id = $1",
    [tenantId]
  );
  return rows[0]!.n as number;
}

async function subscriptionRef(tenantId: string): Promise<string | null> {
  const { rows } = await pool!.query(
    "SELECT provider_subscription_ref FROM exomem_entitlements WHERE tenant_id = $1",
    [tenantId]
  );
  return (rows[0]!.provider_subscription_ref as string | null) ?? null;
}

describe("Exomem Cloud deletion finish PostgreSQL integration", { skip: !databaseUrl }, () => {
  before(async () => {
    for (const key of [...Object.keys(CLOUD_CONFIG_ENV), "EXOMEM_CLOUD_ENABLED"]) {
      priorEnv[key] = process.env[key];
    }
    Object.assign(process.env, CLOUD_CONFIG_ENV);
    delete process.env.EXOMEM_CLOUD_ENABLED;
    schema = `cloud_deletion_it_${randomUUID().replaceAll("-", "")}`;
    await ensureExomemPostgresTestExtensions(databaseUrl!);
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);
    await applyMigrations({ databaseUrl: scoped.toString() });
    await admin.end();
    pool = new Pool({ connectionString: scoped.toString() });
    __setExomemSqlForTests(taggedSql(pool));
    __setExomemTransactionForTests(interactiveTransaction);
  });

  after(async () => {
    __setExomemSqlForTests(null);
    __setExomemTransactionForTests(null);
    if (pool) await pool.end();
    if (schema) {
      const admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("finishes a paid Cloud tenant from confirmation to exactly the D4 receipt", async () => {
    await resetFleet();
    const tenant = await admitCloudTenant({ source: "paddle", offlineAccess: true });
    const subscription = await activateSubscription(tenant);

    const fake = fakePaddle();
    const outcomes: CloudDeletionFinishOutcome[] = [];
    let beforeFinish: Record<string, number> = {};
    const result = await confirmCloudDeletion(tenant, async (tenantId) => {
      beforeFinish = await tenantFootprint(tenantId);
      outcomes.push(await finishCloudAccountDeletion(tenantId, withPaddle(fake)));
    });

    // Non-vacuous: just before the finish, the enumeration sees every row
    // class the scrub must remove.
    for (const table of [
      "exomem_access_tokens",
      "exomem_invites",
      "exomem_oauth_authorization_codes",
      "exomem_paddle_events",
      "exomem_sessions",
      "exomem_waitlist_entries",
    ]) {
      assert.ok((beforeFinish[table] ?? 0) > 0, `the tenant owns ${table} rows before the finish`);
    }
    assert.deepEqual(
      result,
      { state: "deletion_pending" },
      "no v1 operation id for a Cloud tenant"
    );
    assert.deepEqual(outcomes, ["finished"]);
    assert.deepEqual(fake.calls, [`POST /subscriptions/${subscription.subscriptionRef}/cancel`]);
    assert.equal(await lifecycleOperations(tenant.tenantId), 0);
    await assertFinishedReceipt(tenant, { sourceState: "deletion_cancelled", refreshTokens: 1 });

    // The webhook ledger keeps its dedupe row, no longer linked to the tenant.
    const ledger = await pool!.query("SELECT tenant_id FROM exomem_paddle_events");
    assert.deepEqual(ledger.rows, [{ tenant_id: null }]);
  });

  it("L2: purges an unconsumed invite and an unadmitted waitlist entry for the owner's email", async () => {
    await resetFleet();
    const tenant = await admitCloudTenant({ source: "complimentary" });
    // A second, never-redeemed operator invite to the same email, plus a
    // self-serve waitlist entry that was never admitted.
    await pool!.query(
      `INSERT INTO exomem_invites (
         token_digest, email_normalized, entitlement_source, entitlement_capabilities,
         entitlement_limits, created_by_principal_digest, expires_at
       ) VALUES ($1, $2, 'complimentary', '["capture"]'::jsonb, '{}'::jsonb, $3, now() + interval '7 days')`,
      [randomBytes(32), tenant.email, randomBytes(32)]
    );
    await pool!.query("INSERT INTO exomem_waitlist_entries (email_normalized) VALUES ($1)", [
      tenant.email,
    ]);
    const before = await pool!.query<{ invites: number; waitlist: number }>(
      `SELECT
         (SELECT count(*)::int FROM exomem_invites
           WHERE email_normalized = $1 AND consumed_at IS NULL) AS invites,
         (SELECT count(*)::int FROM exomem_waitlist_entries
           WHERE email_normalized = $1 AND admitted_at IS NULL) AS waitlist`,
      [tenant.email]
    );
    assert.deepEqual(before.rows[0], { invites: 1, waitlist: 1 }, "sanity: both rows exist first");

    await confirmCloudDeletion(tenant, (tenantId) =>
      finishCloudAccountDeletion(tenantId, withPaddle(fakePaddle()))
    );
    assert.equal(await tenantStatus(tenant.tenantId), "deleted");

    const after = await pool!.query<{ invites: number; waitlist: number }>(
      `SELECT
         (SELECT count(*)::int FROM exomem_invites WHERE email_normalized = $1) AS invites,
         (SELECT count(*)::int FROM exomem_waitlist_entries WHERE email_normalized = $1) AS waitlist`,
      [tenant.email]
    );
    assert.deepEqual(after.rows[0], { invites: 0, waitlist: 0 });
    await assertFinishedReceipt(tenant, { sourceState: "complimentary_active" });
  });

  it("finishes a tenant whose unpaid invite expired before the owner confirmed deletion", async () => {
    await resetFleet();
    const tenant = await admitCloudTenant({ source: "paddle" });
    const transactionRef = paddleId("txn");
    await pool!.query(
      `UPDATE exomem_entitlements
       SET provider_transaction_ref = $2, provider_environment = 'sandbox'
       WHERE tenant_id = $1`,
      [tenant.tenantId, transactionRef]
    );
    await pool!.query(
      "UPDATE exomem_tenants SET created_at = now() - interval '8 days' WHERE id = $1",
      [tenant.tenantId]
    );
    const expired = await expireCloudAwaitingCheckoutTenants({
      config: CONFIG,
      cancelTransaction: async () => ({ state: "canceled" }),
    });
    assert.deepEqual(
      expired.map((outcome) => outcome.outcome),
      ["expired"]
    );

    // The best-effort finish inside the confirmation fails; the sweep is the
    // backstop that finishes the tenant.
    const result = await confirmCloudDeletion(tenant, async () => {
      throw new Error("simulated transient failure");
    });
    assert.deepEqual(result, { state: "deletion_pending" });
    assert.equal(
      await lifecycleOperations(tenant.tenantId),
      0,
      "no v1 operation for a deleted cell row"
    );
    assert.equal(await tenantStatus(tenant.tenantId), "deletion_pending");

    const fake = fakePaddle(tenant);
    await runBoundedCloudReconcile();
    const sweep = await runBoundedCloudDeletionFinish({
      finishTenant: (tenantId) => finishCloudAccountDeletion(tenantId, withPaddle(fake)),
    });
    assert.deepEqual(sweep, { finished: 1, pending: 0, failed: 0 });
    assert.deepEqual(fake.calls, [`GET /transactions/${transactionRef}`]);
    await assertFinishedReceipt(tenant, { sourceState: "deletion_cancelled" });
  });

  it("keeps a tenant pending while billing cannot be terminated, and the next sweep finishes it", async () => {
    await resetFleet();
    const tenant = await admitCloudTenant({ source: "paddle" });
    const subscription = await activateSubscription(tenant);
    const fake = fakePaddle();
    fake.mode = "throw";
    const outcomes: CloudDeletionFinishOutcome[] = [];
    await confirmCloudDeletion(tenant, async (tenantId) => {
      outcomes.push(await finishCloudAccountDeletion(tenantId, withPaddle(fake)));
    });
    assert.deepEqual(outcomes, ["billing_pending"]);

    fake.mode = "not_found";
    const refused = await runBoundedCloudDeletionFinish({
      finishTenant: (tenantId) => finishCloudAccountDeletion(tenantId, withPaddle(fake)),
    });
    assert.deepEqual(refused, { finished: 0, pending: 1, failed: 0 });
    assert.equal(fake.calls.length, 2, "both attempts reached Paddle");
    assert.equal(await tenantStatus(tenant.tenantId), "deletion_pending");
    assert.equal(await subscriptionRef(tenant.tenantId), subscription.subscriptionRef);
    const pending = await tenantFootprint(tenant.tenantId);
    assert.ok((pending.exomem_sessions ?? 0) > 0, "no scrub ran");
    assert.ok((pending.exomem_invites ?? 0) > 0, "no scrub ran");

    fake.mode = "ok";
    const finished = await runBoundedCloudDeletionFinish({
      finishTenant: (tenantId) => finishCloudAccountDeletion(tenantId, withPaddle(fake)),
    });
    assert.deepEqual(finished, { finished: 1, pending: 0, failed: 0 });
    assert.equal(fake.calls.length, 3);
    await assertFinishedReceipt(tenant, { sourceState: "deletion_cancelled" });
  });

  it("scrubs nothing when the entitlement changes between the cancellation and the scrub", async () => {
    await resetFleet();
    const tenant = await admitCloudTenant({ source: "paddle" });
    const subscription = await activateSubscription(tenant);
    const fake = fakePaddle();
    const webhookEvent = paddleId("evt");
    const outcomes: CloudDeletionFinishOutcome[] = [];
    await confirmCloudDeletion(tenant, async (tenantId) => {
      outcomes.push(
        await finishCloudAccountDeletion(tenantId, {
          terminateBilling: async (id) => {
            const proof = await withPaddle(fake).terminateBilling!(id);
            // Paddle's subscription.canceled webhook lands before the scrub.
            await pool!.query(
              `UPDATE exomem_entitlements
               SET source_state = 'cancelled', source_revision = $2, source_occurred_at = now()
               WHERE tenant_id = $1`,
              [id, webhookEvent]
            );
            return proof;
          },
        })
      );
    });
    assert.deepEqual(outcomes, ["proof_mismatch"]);
    assert.equal(await tenantStatus(tenant.tenantId), "deletion_pending");
    assert.equal(await subscriptionRef(tenant.tenantId), subscription.subscriptionRef);
    assert.ok(((await tenantFootprint(tenant.tenantId)).exomem_sessions ?? 0) > 0, "no scrub ran");

    // The next sweep reads the cancelled subscription as terminated billing
    // without calling Paddle again, and finishes.
    const sweep = await runBoundedCloudDeletionFinish({
      finishTenant: (tenantId) => finishCloudAccountDeletion(tenantId, withPaddle(fake)),
    });
    assert.deepEqual(sweep, { finished: 1, pending: 0, failed: 0 });
    assert.equal(fake.calls.length, 1);
    await assertFinishedReceipt(tenant, { sourceState: "deletion_cancelled" });
  });

  it("isolates one tenant's failure in the sweep and logs it content-free", async () => {
    await resetFleet();
    const broken = await admitCloudTenant({ source: "complimentary" });
    const healthy = await admitCloudTenant({ source: "complimentary" });
    for (const tenant of [broken, healthy]) {
      await confirmCloudDeletion(tenant, async () => undefined);
    }
    const logged: string[] = [];
    const capture = (...args: unknown[]) => {
      logged.push(
        args
          .map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg)))
          .join(" ")
      );
    };
    const errorLog = mock.method(console, "error", capture);
    const warnLog = mock.method(console, "warn", capture);
    const infoLog = mock.method(console, "log", capture);
    let sweep;
    try {
      sweep = await runBoundedCloudDeletionFinish({
        finishTenant: async (tenantId) => {
          if (tenantId === broken.tenantId) {
            throw new Error(`simulated failure for ${broken.email} ${broken.tenantId}`);
          }
          return finishCloudAccountDeletion(tenantId, withPaddle(fakePaddle()));
        },
      });
    } finally {
      errorLog.mock.restore();
      warnLog.mock.restore();
      infoLog.mock.restore();
    }
    assert.deepEqual(sweep, { finished: 1, pending: 0, failed: 1 });
    assert.equal(await tenantStatus(broken.tenantId), "deletion_pending");
    await assertFinishedReceipt(healthy, { sourceState: "complimentary_active" });

    assert.ok(logged.length > 0, "the failure is logged");
    for (const line of logged) {
      for (const secret of [
        broken.email,
        broken.tenantId,
        broken.userId,
        healthy.tenantId,
        "simulated",
      ]) {
        assert.equal(line.includes(secret), false, "logs carry no email, identifier or cause");
      }
    }
  });

  it("changes nothing when the finish runs again on a deleted tenant", async () => {
    await resetFleet();
    const tenant = await admitCloudTenant({ source: "paddle" });
    await activateSubscription(tenant);
    const fake = fakePaddle();
    await confirmCloudDeletion(tenant, (tenantId) =>
      finishCloudAccountDeletion(tenantId, withPaddle(fake))
    );
    assert.equal(await tenantStatus(tenant.tenantId), "deleted");

    const snapshot = async () =>
      (
        await pool!.query(
          `SELECT
             (SELECT to_jsonb(t.*) FROM exomem_tenants AS t WHERE id = $1) AS tenant,
             (SELECT to_jsonb(e.*) FROM exomem_entitlements AS e WHERE tenant_id = $1) AS entitlement,
             (SELECT jsonb_agg(to_jsonb(c.*) ORDER BY cell_id) FROM exomem_cloud_cells AS c WHERE tenant_id = $1) AS cells,
             (SELECT jsonb_agg(to_jsonb(g.*) ORDER BY id) FROM exomem_oauth_grants AS g WHERE tenant_id = $1) AS grants`,
          [tenant.tenantId]
        )
      ).rows[0];
    const before_ = await snapshot();
    const calls = fake.calls.length;
    assert.equal(
      await finishCloudAccountDeletion(tenant.tenantId, withPaddle(fake)),
      "already_deleted"
    );
    assert.deepEqual(await runBoundedCloudDeletionFinish(), { finished: 0, pending: 0, failed: 0 });
    assert.deepEqual(await snapshot(), before_);
    assert.equal(fake.calls.length, calls, "no second Paddle call");
  });

  it("re-admits the same owner to Cloud after a finished deletion, with fresh consent", async () => {
    await resetFleet();
    const tenant = await admitCloudTenant({ source: "complimentary" });
    await confirmCloudDeletion(tenant, (tenantId) =>
      finishCloudAccountDeletion(tenantId, withPaddle(fakePaddle()))
    );
    assert.equal(await tenantStatus(tenant.tenantId), "deleted");

    // Browser re-admission, the same flow the admission suite covers.
    const inviteDigest = randomBytes(32);
    await pool!.query(
      `INSERT INTO exomem_invites (
         token_digest, email_normalized, entitlement_source, entitlement_capabilities,
         entitlement_limits, created_by_principal_digest, expires_at
       ) VALUES ($1, $2, 'complimentary', '["capture","recall"]'::jsonb, '{}'::jsonb, $3, now() + interval '1 day')`,
      [inviteDigest, tenant.email, randomBytes(32)]
    );
    const readmitted = await redeemCloudInviteAtomic({
      tokenDigest: inviteDigest,
      sessionDigest: randomBytes(32),
      csrfDigest: randomBytes(32),
      sessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    assert.ok(readmitted);
    assert.equal(readmitted!.tenantId, tenant.tenantId);
    assert.notEqual(readmitted!.cellId, tenant.cellId);
    const cell = await pool!.query(
      "SELECT desired_state FROM exomem_cloud_cells WHERE cell_id = $1",
      [readmitted!.cellId]
    );
    assert.equal(cell.rows[0]!.desired_state, "running");
    assert.equal(await tenantStatus(tenant.tenantId), "provisioning");
  });

  it("re-admits the same owner through Cloud OAuth after a finished deletion, and issues tokens", async () => {
    await resetFleet();
    const tenant = await admitCloudTenant({ source: "complimentary" });
    await confirmCloudDeletion(tenant, (tenantId) =>
      finishCloudAccountDeletion(tenantId, withPaddle(fakePaddle()))
    );
    assert.equal(await tenantStatus(tenant.tenantId), "deleted");
    // A second OAuth admission and token exchange for the same email: no
    // account block refuses either step.
    const readmitted = await admitCloudTenant({ source: "complimentary", email: tenant.email });
    assert.equal(readmitted.tenantId, tenant.tenantId);
  });

  it("refuses to finish while an older Cloud cell row is still live", async () => {
    await resetFleet();
    const tenant = await admitCloudTenant({ source: "complimentary" });
    // A second, newer row already deleted; the older admission row is live.
    await pool!.query(
      "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, 'deleted')",
      ["abcdefghijklmnop", tenant.tenantId]
    );
    const token = generateExternalToken();
    await createDeletionConfirmationToken({
      userId: tenant.userId,
      tenantId: tenant.tenantId,
      tokenDigest: tokenDigest(token)!,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });
    // Confirmed, before the Cloud reconcile has reached the live row.
    assert.ok(
      await consumeDeletionConfirmationAtomic({
        userId: tenant.userId,
        tenantId: tenant.tenantId,
        tokenDigest: tokenDigest(token)!,
      })
    );
    let billingCalls = 0;
    const outcome = await finishCloudAccountDeletion(tenant.tenantId, {
      terminateBilling: async (id) => {
        billingCalls += 1;
        return withPaddle(fakePaddle()).terminateBilling!(id);
      },
    });
    assert.equal(outcome, "cell_live");
    assert.equal(billingCalls, 0, "billing is not touched while a cell is live");
    assert.equal(await tenantStatus(tenant.tenantId), "deletion_pending");
    assert.deepEqual(
      await runBoundedCloudDeletionFinish({
        finishTenant: (tenantId) => finishCloudAccountDeletion(tenantId, withPaddle(fakePaddle())),
      }),
      { finished: 0, pending: 1, failed: 0 },
      "the sweep sees the tenant and leaves it pending"
    );

    await runBoundedCloudReconcile();
    assert.equal(
      await finishCloudAccountDeletion(tenant.tenantId, withPaddle(fakePaddle())),
      "finished"
    );
    await assertFinishedReceipt(tenant, { sourceState: "complimentary_active", cells: 2 });
  });

  it("finishes a complimentary tenant without any Paddle call", async () => {
    await resetFleet();
    const tenant = await admitCloudTenant({ source: "complimentary" });
    const fake = fakePaddle();
    let billingCalls = 0;
    await confirmCloudDeletion(tenant, (tenantId) =>
      finishCloudAccountDeletion(tenantId, {
        terminateBilling: async (id) => {
          billingCalls += 1;
          return withPaddle(fake).terminateBilling!(id);
        },
      })
    );
    assert.equal(billingCalls, 1);
    assert.deepEqual(fake.calls, []);
    await assertFinishedReceipt(tenant, { sourceState: "complimentary_active" });
  });

  it("finishes a never-paid awaiting_checkout tenant, with no references, without any Paddle call", async () => {
    await resetFleet();
    const tenant = await admitCloudTenant({ source: "paddle" });
    const fake = fakePaddle();
    let billingCalls = 0;
    await confirmCloudDeletion(tenant, (tenantId) =>
      finishCloudAccountDeletion(tenantId, {
        terminateBilling: async (id) => {
          billingCalls += 1;
          return withPaddle(fake).terminateBilling!(id);
        },
      })
    );
    assert.equal(billingCalls, 1);
    assert.deepEqual(fake.calls, []);
    await assertFinishedReceipt(tenant, { sourceState: "deletion_cancelled" });
  });

  it("does not scrub a cancelled subscription recorded in another Paddle environment", async () => {
    await resetFleet();
    const tenant = await admitCloudTenant({ source: "paddle" });
    const subscription = await activateSubscription(tenant);
    await pool!.query(
      `UPDATE exomem_entitlements
       SET source_state = 'cancelled', provider_environment = 'production'
       WHERE tenant_id = $1`,
      [tenant.tenantId]
    );
    const fake = fakePaddle();
    let billingCalls = 0;
    const outcomes: CloudDeletionFinishOutcome[] = [];
    await confirmCloudDeletion(tenant, async (tenantId) => {
      outcomes.push(
        await finishCloudAccountDeletion(tenantId, {
          terminateBilling: async (id) => {
            billingCalls += 1;
            return withPaddle(fake).terminateBilling!(id);
          },
        })
      );
    });
    assert.deepEqual(outcomes, ["billing_pending"]);
    assert.equal(billingCalls, 1);
    assert.deepEqual(fake.calls, []);
    assert.equal(await tenantStatus(tenant.tenantId), "deletion_pending");
    assert.equal(await subscriptionRef(tenant.tenantId), subscription.subscriptionRef);
  });

  it("keeps the v1 delete operation for a tenant without a Cloud cell, and the finish never touches it", async () => {
    await resetFleet();
    const user = await pool!.query<{ id: string }>(
      "INSERT INTO users (email, email_verified_at) VALUES ($1, now()) RETURNING id",
      [`v1-deletion-${randomUUID()}@example.test`]
    );
    const v1Tenant = await pool!.query<{ id: string }>(
      "INSERT INTO exomem_tenants (owner_user_id, status) VALUES ($1, 'active') RETURNING id",
      [user.rows[0]!.id]
    );
    const v1TenantId = v1Tenant.rows[0]!.id;
    await pool!.query(
      `INSERT INTO exomem_entitlements (tenant_id, source, source_state, effective_state)
       VALUES ($1, 'complimentary', 'complimentary_active', 'active')`,
      [v1TenantId]
    );
    const digest = tokenDigest(generateExternalToken())!;
    const created = await createDeletionConfirmationToken({
      userId: user.rows[0]!.id,
      tenantId: v1TenantId,
      tokenDigest: digest,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });
    assert.ok(created);
    const consumed = await consumeDeletionConfirmationAtomic({
      userId: user.rows[0]!.id,
      tenantId: v1TenantId,
      tokenDigest: digest,
    });
    assert.ok(consumed);
    assert.equal(typeof consumed.operationId, "string");
    const operation = await pool!.query(
      "SELECT id, request_id, operation_type, idempotency_key FROM exomem_lifecycle_operations WHERE tenant_id = $1",
      [v1TenantId]
    );
    assert.deepEqual(operation.rows, [
      {
        id: consumed.operationId,
        request_id: consumed.requestId,
        operation_type: "delete",
        idempotency_key: `confirmed-deletion-${created.tokenId}`,
      },
    ]);

    // A Cloud tenant in the same sweep proves the sweep ran.
    const cloudTenant = await admitCloudTenant({ source: "complimentary" });
    await confirmCloudDeletion(cloudTenant, async () => undefined);
    const v1Before = await pool!.query(
      `SELECT to_jsonb(t.*) AS tenant, to_jsonb(e.*) AS entitlement
       FROM exomem_tenants AS t JOIN exomem_entitlements AS e ON e.tenant_id = t.id WHERE t.id = $1`,
      [v1TenantId]
    );
    assert.equal(
      await finishCloudAccountDeletion(v1TenantId, withPaddle(fakePaddle())),
      "not_eligible"
    );
    assert.deepEqual(
      await runBoundedCloudDeletionFinish({
        finishTenant: (tenantId) => finishCloudAccountDeletion(tenantId, withPaddle(fakePaddle())),
      }),
      { finished: 1, pending: 0, failed: 0 }
    );
    const v1After = await pool!.query(
      `SELECT to_jsonb(t.*) AS tenant, to_jsonb(e.*) AS entitlement
       FROM exomem_tenants AS t JOIN exomem_entitlements AS e ON e.tenant_id = t.id WHERE t.id = $1`,
      [v1TenantId]
    );
    assert.deepEqual(v1After.rows, v1Before.rows);
    assert.equal(await lifecycleOperations(v1TenantId), 1);
  });

  it("L4: applies at most one scrub when two finishes race on the same tenant, against realistic Paddle", async () => {
    await resetFleet();
    const tenant = await admitCloudTenant({ source: "paddle" });
    await activateSubscription(tenant);
    const confirmation = await confirmCloudDeletion(tenant, async () => undefined);
    assert.deepEqual(confirmation, { state: "deletion_pending" });

    // Both finishes pass billing before either scrubs: the worst interleaving.
    // The fake answers a second cancel of the same subscription with the
    // documented 400, as Paddle does (M1) -- exactly one racer's cancel
    // succeeds, so the other's `terminateBilling` returns null and it never
    // attempts a scrub of its own.
    const fake = realisticFakePaddle();
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const racing: Partial<CloudDeletionFinishDependencies> = {
      terminateBilling: async (id) => {
        const proof = await terminateExomemBillingForDeletion(id, {
          config: CONFIG,
          transport: fake.transport,
        });
        arrived += 1;
        if (arrived === 2) release();
        await barrier;
        return proof;
      },
    };
    const outcomes = await Promise.all([
      finishCloudAccountDeletion(tenant.tenantId, racing),
      finishCloudAccountDeletion(tenant.tenantId, racing),
    ]);

    // The billing-cancel winner always finishes, uncontested (the loser never
    // reaches scrubCloudTenant with a proof). The loser's own outcome is a
    // genuine race between its `scrubbedMeanwhile` read and the winner's
    // transactional scrub: either can commit first.
    assert.equal(outcomes.filter((outcome) => outcome === "finished").length, 1);
    const loser = outcomes.find((outcome) => outcome !== "finished");
    assert.ok(
      loser === "billing_pending" || loser === "already_deleted",
      `unexpected loser outcome: ${loser}`
    );
    assert.equal(
      fake.calls.filter((call) => call.endsWith("/cancel")).length,
      2,
      "both racers reach the cancel endpoint"
    );
    assert.equal(
      fake.calls.filter((call) => call.startsWith("GET")).length,
      1,
      "exactly the 400-losing racer reads the subscription back"
    );
    await assertFinishedReceipt(tenant, { sourceState: "deletion_cancelled" });
  });

  it("M1: heals via the subscription GET after the finish dies between a successful cancel and the scrub, with no webhook ever applied", async () => {
    await resetFleet();
    const tenant = await admitCloudTenant({ source: "paddle" });
    const subscription = await activateSubscription(tenant);
    const fake = realisticFakePaddle({ supportsGet: true });
    const billing = (id: string) =>
      terminateExomemBillingForDeletion(id, { config: CONFIG, transport: fake.transport });

    // The cancel succeeds; the finish dies before it ever reaches the scrub.
    await confirmCloudDeletion(tenant, (tenantId) =>
      finishCloudAccountDeletion(tenantId, {
        terminateBilling: async (id) => {
          await billing(id);
          throw new Error("simulated crash after the cancel, before the scrub");
        },
      })
    );
    assert.equal(await tenantStatus(tenant.tenantId), "deletion_pending");
    assert.deepEqual(fake.calls, [`POST /subscriptions/${subscription.subscriptionRef}/cancel`]);

    // Every later sweep's cancel now 400s -- Paddle already canceled it, and
    // no webhook ever arrives to heal the entitlement's own state instead.
    // Only the GET fallback (M1) can prove termination and let the sweep
    // finish the tenant.
    const sweep = await runBoundedCloudDeletionFinish({
      finishTenant: (id) => finishCloudAccountDeletion(id, { terminateBilling: billing }),
    });
    assert.deepEqual(sweep, { finished: 1, pending: 0, failed: 0 });
    assert.deepEqual(fake.calls, [
      `POST /subscriptions/${subscription.subscriptionRef}/cancel`,
      `POST /subscriptions/${subscription.subscriptionRef}/cancel`,
      `GET /subscriptions/${subscription.subscriptionRef}`,
    ]);
    await assertFinishedReceipt(tenant, { sourceState: "deletion_cancelled" });
  });

  it("reports the loser of a race as already deleted when the winner scrubbed before its billing step", async () => {
    await resetFleet();
    const tenant = await admitCloudTenant({ source: "paddle" });
    await activateSubscription(tenant);
    await confirmCloudDeletion(tenant, async () => undefined);

    // The loser passes eligibility, then reaches billing only after the
    // winner has scrubbed the tenant.
    const fake = fakePaddle();
    let winnerDone!: () => void;
    const winnerFinished = new Promise<void>((resolve) => {
      winnerDone = resolve;
    });
    const loser = finishCloudAccountDeletion(tenant.tenantId, {
      terminateBilling: async (id) => {
        await winnerFinished;
        return withPaddle(fake).terminateBilling!(id);
      },
    });
    const winner = await finishCloudAccountDeletion(tenant.tenantId, withPaddle(fake));
    winnerDone();
    assert.equal(winner, "finished");
    assert.equal(await loser, "already_deleted");
    assert.equal(fake.calls.length, 1, "the loser never reaches Paddle");
    await assertFinishedReceipt(tenant, { sourceState: "deletion_cancelled" });
  });
});
