import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { randomCloudCellId } from "../cloud-admission";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
import { drainExomemEmailOutbox } from "../email-outbox";
import { setOperationalEventSinkForTests } from "../observability";
import { pruneExpiredOAuthState } from "../oauth-store";
import { disconnectOwnerApp, listOwnerApps } from "../owner-apps";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

// The app sign-out notice and Home's reachability state against real
// PostgreSQL (notify-owner-of-app-signout): a grant with no live family lists
// signed out, a recently used grant's last ending emails once across sweeps,
// and an owner disconnect emails nobody.

const CLOUD_RESOURCE = "https://cloud.example.test/mcp/v1";
const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
let pool: Pool | undefined;
let schema: string | undefined;

const TEST_ENV = {
  EXOMEM_CLOUD_MCP_URL: CLOUD_RESOURCE,
  EXOMEM_CLOUD_MCP_PATH: "/mcp/v1",
  EXOMEM_CONTROL_PLANE_KEY: Buffer.alloc(32, 9).toString("base64url"),
  EXOMEM_PUBLIC_BASE_URL: "https://cloud.example.test",
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

type Owner = { userId: string; tenantId: string; email: string };

async function newOwner(): Promise<Owner> {
  const email = `owner-${randomUUID()}@example.test`;
  const user = await pool!.query<{ id: string }>(
    "INSERT INTO exomem_users (email) VALUES ($1) RETURNING id",
    [email]
  );
  const userId = user.rows[0]!.id;
  const tenant = await pool!.query<{ id: string }>(
    "INSERT INTO exomem_tenants (owner_user_id, status) VALUES ($1, 'active') RETURNING id",
    [userId]
  );
  const tenantId = tenant.rows[0]!.id;
  await pool!.query(
    `INSERT INTO exomem_entitlements (tenant_id, source, source_state, effective_state)
     VALUES ($1, 'complimentary', 'complimentary_active', 'active')`,
    [tenantId]
  );
  await pool!.query(
    "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, 'running')",
    [randomCloudCellId(), tenantId]
  );
  return { userId, tenantId, email };
}

type Client = { pk: string };

// A self-registered client on an admitted host, as claude.ai and chatgpt.com are.
async function newClient(platform: "claude" | "openai" = "claude"): Promise<Client> {
  const clientId = `https://app-${randomUUID()}.example.test/client.json`;
  const host = new URL(clientId).hostname;
  const redirectUri = `https://${host}/callback`;
  await pool!.query(
    "INSERT INTO exomem_oauth_admitted_cimd_hosts (platform, host) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [platform, host]
  );
  const row = await pool!.query<{ id: string }>(
    `INSERT INTO exomem_oauth_clients (
       client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest,
       metadata_document_digest, metadata_fetched_at, metadata_ttl_seconds, metadata_expires_at,
       cimd_host, client_platform, oauth_client_config_sha256
     ) VALUES (
       $1, 'cimd', true, $2::jsonb, digest(convert_to($2::jsonb::text, 'utf8'), 'sha256'),
       $3, now(), 3600, now() + interval '1 hour', $4, $5, $6
     ) RETURNING id`,
    [
      clientId,
      JSON.stringify([redirectUri]),
      randomBytes(32),
      host,
      platform,
      randomBytes(32).toString("hex"),
    ]
  );
  return { pk: row.rows[0]!.id };
}

async function newGrant(owner: Owner, client: Client): Promise<string> {
  const row = await pool!.query<{ id: string }>(
    `INSERT INTO exomem_oauth_grants (user_id, tenant_id, client_id, resource, scopes, refresh_allowed)
     VALUES ($1, $2, $3, $4, '{exomem.read,exomem.write}'::text[], true) RETURNING id`,
    [owner.userId, owner.tenantId, client.pk, CLOUD_RESOURCE]
  );
  return row.rows[0]!.id;
}

async function newFamily(
  grantId: string,
  client: Client,
  ending: { revokedReason?: string | null; revokedAgo?: string; expiredAgo?: string }
): Promise<string> {
  const revoked = ending.revokedAgo ? `now() - interval '${ending.revokedAgo}'` : "NULL";
  const expires = ending.expiredAgo
    ? `now() - interval '${ending.expiredAgo}'`
    : `now() + interval '30 days'`;
  const created = ending.expiredAgo ? `now() - interval '60 days'` : "now()";
  const row = await pool!.query<{ id: string }>(
    `INSERT INTO exomem_oauth_token_families
       (grant_id, client_id, expires_at, revoked_at, revoked_reason, created_at)
     VALUES ($1, $2, ${expires}, ${revoked}, $3, ${created}) RETURNING id`,
    [grantId, client.pk, ending.revokedReason ?? null]
  );
  return row.rows[0]!.id;
}

async function markUsed(grantId: string, ago = "1 hour"): Promise<void> {
  await pool!.query(
    `INSERT INTO exomem_oauth_grant_usage (grant_id, last_used_at)
     VALUES ($1, now() - interval '${ago}')
     ON CONFLICT (grant_id) DO UPDATE SET last_used_at = EXCLUDED.last_used_at`,
    [grantId]
  );
}

async function appSignoutEmails(familyIds: readonly string[]): Promise<Record<string, unknown>[]> {
  const { rows } = await pool!.query(
    `SELECT dedupe_key, state, recipient::text AS recipient FROM exomem_email_outbox
     WHERE kind = 'app_signout' AND dedupe_key = ANY($1::text[]) ORDER BY created_at`,
    [familyIds.map((id) => `app-signout:${id}`)]
  );
  return rows;
}

describe("Exomem app sign-out notice PostgreSQL integration", { skip: !databaseUrl }, () => {
  before(async () => {
    for (const [key, value] of Object.entries(TEST_ENV)) {
      priorEnv[key] = process.env[key];
      process.env[key] = value;
    }
    setOperationalEventSinkForTests(() => {});
    schema = `app_signout_it_${randomUUID().replaceAll("-", "")}`;
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
    setOperationalEventSinkForTests(null);
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

  it("lists a grant whose families all ended as signed out, and a live one signed in", async () => {
    const owner = await newOwner();
    const deadClient = await newClient();
    const dead = await newGrant(owner, deadClient);
    const endedAt = await pool!.query<{ ended_at: Date }>(
      `UPDATE exomem_oauth_token_families
       SET revoked_at = now() - interval '2 hours', revoked_reason = 'refresh_replayed'
       WHERE id = $1 RETURNING revoked_at AS ended_at`,
      [await newFamily(dead, deadClient, {})]
    );
    const liveClient = await newClient("openai");
    const live = await newGrant(owner, liveClient);
    await newFamily(live, liveClient, {});

    const { apps } = await listOwnerApps(owner);
    const signedOut = apps.find((app) => app.id === dead)!;
    const signedIn = apps.find((app) => app.id === live)!;
    assert.equal(signedOut.session.state, "signed_out");
    assert.equal(signedOut.session.since, endedAt.rows[0]!.ended_at.toISOString());
    assert.equal(signedIn.session.state, "signed_in");
    assert.equal(signedIn.session.since, null);
  });

  it("emails once for a replay-revoked family of a recently used grant, across two sweep runs", async () => {
    const owner = await newOwner();
    const client = await newClient();
    const grant = await newGrant(owner, client);
    await markUsed(grant);
    const family = await newFamily(grant, client, {
      revokedReason: "refresh_replayed",
      revokedAgo: "1 hour",
    });

    const first = await pruneExpiredOAuthState();
    const second = await pruneExpiredOAuthState();

    assert.deepEqual(first.signouts, { candidates: 1, emailed: 1 });
    assert.deepEqual(second.signouts, { candidates: 0, emailed: 0 });
    const emails = await appSignoutEmails([family]);
    assert.equal(emails.length, 1);
    assert.equal(emails[0]!.dedupe_key, `app-signout:${family}`);
    assert.equal(emails[0]!.state, "pending");
    const { rows: markers } = await pool!.query(
      "SELECT ended_reason FROM exomem_oauth_app_signout_notices WHERE family_id = $1",
      [family]
    );
    assert.deepEqual(markers, [{ ended_reason: "refresh_replayed" }]);
  });

  it("emails for an expired family, and for no owner who disconnected or went quiet", async () => {
    const owner = await newOwner();
    const expiredClient = await newClient();
    const expiredGrant = await newGrant(owner, expiredClient);
    await markUsed(expiredGrant, "3 hours");
    const expired = await newFamily(expiredGrant, expiredClient, { expiredAgo: "2 hours" });
    const quietClient = await newClient();
    const quiet = await newGrant(owner, quietClient);
    await markUsed(quiet, "20 days");
    const quietFamily = await newFamily(quiet, quietClient, {
      revokedReason: "refresh_replayed",
      revokedAgo: "1 hour",
    });
    const disconnectedClient = await newClient();
    const disconnected = await newGrant(owner, disconnectedClient);
    await markUsed(disconnected);
    const disconnectedFamily = await newFamily(disconnected, disconnectedClient, {});
    assert.equal(
      await disconnectOwnerApp({ userId: owner.userId, tenantId: owner.tenantId, appId: disconnected }),
      true
    );

    const result = await pruneExpiredOAuthState();

    // The quiet grant (used 20 days ago) and the disconnected grant (revoked,
    // owner_disconnected) never reach candidacy; only the expired family does.
    assert.deepEqual(result.signouts, { candidates: 1, emailed: 1 });
    const emails = await appSignoutEmails([expired, quietFamily, disconnectedFamily]);
    assert.equal(emails.length, 1);
    assert.equal(emails[0]!.dedupe_key, `app-signout:${expired}`);
    const { rows: notices } = await pool!.query(
      "SELECT grant_id FROM exomem_oauth_app_signout_notices WHERE grant_id = ANY($1::uuid[]) ORDER BY grant_id",
      [[expiredGrant, quiet, disconnected]]
    );
    assert.deepEqual(notices, [{ grant_id: expiredGrant }]);
  });

  it("holds a second ending inside the 24-hour cap, and sends it once the cap lifts", async () => {
    const owner = await newOwner();
    const client = await newClient();
    const grant = await newGrant(owner, client);
    await markUsed(grant);
    const first = await newFamily(grant, client, {
      revokedReason: "refresh_replayed",
      revokedAgo: "3 hours",
    });
    await pruneExpiredOAuthState();
    // A newer ending lands while the emailed marker is fresh: it stays a
    // candidate but claims nothing — no email, and no marker of its own.
    const second = await newFamily(grant, client, {
      revokedReason: "refresh_replayed",
      revokedAgo: "1 hour",
    });
    const capped = await pruneExpiredOAuthState();
    assert.deepEqual(capped.signouts, { candidates: 1, emailed: 0 });
    assert.deepEqual(await appSignoutEmails([second]), []);
    // The cap lifts (the emailed marker is a day old): the same suppressed
    // ending now claims and emails once.
    await pool!.query(
      "UPDATE exomem_oauth_app_signout_notices SET emailed_at = now() - interval '25 hours' WHERE family_id = $1",
      [first]
    );
    const lifted = await pruneExpiredOAuthState();
    assert.deepEqual(lifted.signouts, { candidates: 1, emailed: 1 });
    const emails = await appSignoutEmails([first, second]);
    assert.equal(emails.length, 2);
    assert.equal(emails[1]!.dedupe_key, `app-signout:${second}`);
  });

  it("cancels the queued email when the owner disconnects before it sends", async () => {
    const owner = await newOwner();
    const client = await newClient();
    const grant = await newGrant(owner, client);
    await markUsed(grant);
    const family = await newFamily(grant, client, {
      revokedReason: "refresh_replayed",
      revokedAgo: "1 hour",
    });
    await pruneExpiredOAuthState();
    const queued = await appSignoutEmails([family]);
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.state, "pending");
    assert.equal(
      await disconnectOwnerApp({ userId: owner.userId, tenantId: owner.tenantId, appId: grant }),
      true
    );

    // The drain sees every pending row in the shared schema, so assert on
    // this owner's row, not on totals.
    const sent: string[] = [];
    const result = await drainExomemEmailOutbox(
      {},
      {
        sendEmail: async (input) => {
          sent.push(input.to);
          return { success: true };
        },
      }
    );

    assert.ok(!sent.includes(owner.email));
    assert.ok(result.cancelled >= 1);
    const settled = await appSignoutEmails([family]);
    assert.equal(settled.length, 1);
    assert.equal(settled[0]!.state, "cancelled");
  });
});
