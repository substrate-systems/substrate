import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { EXOMEM_HOSTED_RESOURCE } from "../agent-contract-store";
import { randomCloudCellId } from "../cloud-admission";
import {
  assertGrantOwnsCloudCell,
  assertPrincipalOwnsCloudCell,
  CloudPrincipalHasNoCellError,
  findCloudOAuthAccessToken,
  resolveApprovedCloudOAuthClient,
} from "../cloud-oauth";
import { __setExomemSqlForTests, type ExomemSql } from "../db";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

// Task 3.5: Cloud OAuth client admission and exact-resource token binding
// (design D2) against real PostgreSQL.

const CLOUD_RESOURCE = "https://cloud.example.test/mcp/v1";
const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
let pool: Pool | undefined;
let schema: string | undefined;

function taggedSql(client: Pool): ExomemSql {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1) {
      text += `$${index + 1}${strings[index + 1]}`;
    }
    const result = await client.query(text, values);
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount ?? 0 };
  };
}

async function admitCimdHost(platform: "claude" | "openai", host: string): Promise<void> {
  await pool!.query(
    "INSERT INTO exomem_oauth_admitted_cimd_hosts (platform, host) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [platform, host]
  );
}

async function createCimdClient(input: {
  clientId: string;
  host: string;
  enabled?: boolean;
  freshMetadata?: boolean;
}): Promise<void> {
  const redirectUris = [`https://${input.host}/callback`];
  await pool!.query(
    `INSERT INTO exomem_oauth_clients (
       client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest,
       metadata_document_digest, metadata_fetched_at, metadata_ttl_seconds, metadata_expires_at,
       cimd_host, client_platform, oauth_client_config_sha256
     ) VALUES (
       $1, 'cimd', $2, $3::jsonb, digest(convert_to($3::jsonb::text, 'utf8'), 'sha256'),
       $4, now(), 3600, $5, $6, 'claude', $7
     )`,
    [
      input.clientId,
      input.enabled ?? true,
      JSON.stringify(redirectUris),
      randomBytes(32),
      input.freshMetadata === false ? new Date(Date.now() - 1000) : new Date(Date.now() + 3600_000),
      input.host,
      randomBytes(32).toString("hex"),
    ]
  );
}

async function newTenantWithCell(desiredState: string | null): Promise<string> {
  const email = `cloud-oauth-${randomUUID()}@example.test`;
  const user = await pool!.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [
    email,
  ]);
  const tenant = await pool!.query<{ id: string }>(
    "INSERT INTO exomem_tenants (owner_user_id) VALUES ($1) RETURNING id",
    [user.rows[0]!.id]
  );
  const tenantId = tenant.rows[0]!.id;
  if (desiredState) {
    const cellId = randomCloudCellId();
    await pool!.query(
      "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, $3)",
      [cellId, tenantId, desiredState]
    );
  }
  return tenantId;
}

async function mintAccessToken(input: {
  clientDbId: string;
  tenantId: string;
  userId: string;
  resource: string;
}): Promise<Buffer> {
  const grant = await pool!.query<{ id: string }>(
    `INSERT INTO exomem_oauth_grants (user_id, tenant_id, client_id, resource, scopes)
     VALUES ($1, $2, $3, $4, '{}')
     RETURNING id`,
    [input.userId, input.tenantId, input.clientDbId, input.resource]
  );
  const family = await pool!.query<{ id: string }>(
    `INSERT INTO exomem_oauth_token_families (grant_id, client_id, expires_at)
     VALUES ($1, $2, now() + interval '1 day')
     RETURNING id`,
    [grant.rows[0]!.id, input.clientDbId]
  );
  const accessDigest = randomBytes(32);
  await pool!.query(
    `INSERT INTO exomem_oauth_access_tokens (
       access_digest, grant_id, family_id, client_id, resource, scopes, expires_at
     ) VALUES ($1, $2, $3, $4, $5, '{}', now() + interval '1 hour')`,
    [accessDigest, grant.rows[0]!.id, family.rows[0]!.id, input.clientDbId, input.resource]
  );
  return accessDigest;
}

describe("Exomem Cloud OAuth admission PostgreSQL integration", { skip: !databaseUrl }, () => {
  before(async () => {
    schema = `cloud_oauth_it_${randomUUID().replaceAll("-", "")}`;
    await ensureExomemPostgresTestExtensions(databaseUrl!);
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);
    await applyMigrations({ databaseUrl: scoped.toString() });
    await admin.end();
    pool = new Pool({ connectionString: scoped.toString() });
    __setExomemSqlForTests(taggedSql(pool));
  });

  after(async () => {
    __setExomemSqlForTests(null);
    if (pool) await pool.end();
    if (schema) {
      const admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it("admits a CIMD client on an empty cohort once its host is approved", async () => {
    const clientId = `https://approved-${randomUUID()}.example.test/client.json`;
    const host = new URL(clientId).hostname;
    await admitCimdHost("claude", host);
    await createCimdClient({ clientId, host });

    const approved = await resolveApprovedCloudOAuthClient(clientId);
    assert.ok(approved);
    assert.equal(approved!.clientId, clientId);
    assert.equal(approved!.admissionMode, "cimd");
  });

  it("refuses a client whose host is not on the admitted list", async () => {
    const clientId = `https://unapproved-${randomUUID()}.example.test/client.json`;
    const host = new URL(clientId).hostname;
    // Deliberately not admitting this host.
    await createCimdClient({ clientId, host });
    assert.equal(await resolveApprovedCloudOAuthClient(clientId), null);
  });

  it("refuses a disabled client and one with stale metadata, even on an admitted host", async () => {
    const disabledClientId = `https://disabled-${randomUUID()}.example.test/client.json`;
    const disabledHost = new URL(disabledClientId).hostname;
    await admitCimdHost("claude", disabledHost);
    await createCimdClient({ clientId: disabledClientId, host: disabledHost, enabled: false });
    assert.equal(await resolveApprovedCloudOAuthClient(disabledClientId), null);

    const staleClientId = `https://stale-${randomUUID()}.example.test/client.json`;
    const staleHost = new URL(staleClientId).hostname;
    await admitCimdHost("claude", staleHost);
    await createCimdClient({ clientId: staleClientId, host: staleHost, freshMetadata: false });
    assert.equal(await resolveApprovedCloudOAuthClient(staleClientId), null);
  });

  it("refuses cross-resource tokens in both directions", async () => {
    const clientId = `https://cross-resource-${randomUUID()}.example.test/client.json`;
    const host = new URL(clientId).hostname;
    await admitCimdHost("claude", host);
    await createCimdClient({ clientId, host });
    const clientRow = await pool!.query<{ id: string }>(
      "SELECT id FROM exomem_oauth_clients WHERE client_id = $1",
      [clientId]
    );
    const clientDbId = clientRow.rows[0]!.id;
    const tenantId = await newTenantWithCell("running");
    const tenant = await pool!.query<{ owner_user_id: string }>(
      "SELECT owner_user_id FROM exomem_tenants WHERE id = $1",
      [tenantId]
    );
    const userId = tenant.rows[0]!.owner_user_id;

    // A hosted-resource token must never be accepted on the Cloud path.
    const hostedToken = await mintAccessToken({
      clientDbId,
      tenantId,
      userId,
      resource: EXOMEM_HOSTED_RESOURCE,
    });
    assert.equal(await findCloudOAuthAccessToken(hostedToken, CLOUD_RESOURCE), null);

    // A Cloud-resource token must never be accepted on the hosted path.
    // findActiveOAuthAccessToken/findMcpOAuthAccessToken (oauth-store.ts)
    // do not themselves filter on the resource literal — mcp.ts's inline
    // `access.resource !== EXOMEM_HOSTED_RESOURCE` check is what refuses it
    // — so the fact this suite proves is the one that check depends on: a
    // Cloud-resource token's stored resource is never the hosted one.
    const cloudToken = await mintAccessToken({
      clientDbId,
      tenantId,
      userId,
      resource: CLOUD_RESOURCE,
    });
    const found = await findCloudOAuthAccessToken(cloudToken, CLOUD_RESOURCE);
    assert.ok(found);
    assert.notEqual(found!.resource, EXOMEM_HOSTED_RESOURCE);
    assert.equal(found!.resource, CLOUD_RESOURCE);
  });

  it("finds a Cloud token's cell and desired_state without gating on it", async () => {
    const clientId = `https://routing-${randomUUID()}.example.test/client.json`;
    const host = new URL(clientId).hostname;
    await admitCimdHost("claude", host);
    await createCimdClient({ clientId, host });
    const clientRow = await pool!.query<{ id: string }>(
      "SELECT id FROM exomem_oauth_clients WHERE client_id = $1",
      [clientId]
    );
    const clientDbId = clientRow.rows[0]!.id;
    const tenantId = await newTenantWithCell("stopped");
    const tenant = await pool!.query<{ owner_user_id: string }>(
      "SELECT owner_user_id FROM exomem_tenants WHERE id = $1",
      [tenantId]
    );
    const accessDigest = await mintAccessToken({
      clientDbId,
      tenantId,
      userId: tenant.rows[0]!.owner_user_id,
      resource: CLOUD_RESOURCE,
    });
    const found = await findCloudOAuthAccessToken(accessDigest, CLOUD_RESOURCE);
    assert.ok(found);
    assert.equal(found!.cellDesiredState, "stopped");
  });

  it("refuses a token whose tenant's only cell row is deleted", async () => {
    const clientId = `https://deleted-cell-${randomUUID()}.example.test/client.json`;
    const host = new URL(clientId).hostname;
    await admitCimdHost("claude", host);
    await createCimdClient({ clientId, host });
    const clientRow = await pool!.query<{ id: string }>(
      "SELECT id FROM exomem_oauth_clients WHERE client_id = $1",
      [clientId]
    );
    const clientDbId = clientRow.rows[0]!.id;
    const tenantId = await newTenantWithCell("deleted");
    const tenant = await pool!.query<{ owner_user_id: string }>(
      "SELECT owner_user_id FROM exomem_tenants WHERE id = $1",
      [tenantId]
    );
    const accessDigest = await mintAccessToken({
      clientDbId,
      tenantId,
      userId: tenant.rows[0]!.owner_user_id,
      resource: CLOUD_RESOURCE,
    });
    assert.equal(await findCloudOAuthAccessToken(accessDigest, CLOUD_RESOURCE), null);
  });

  it("issues Cloud tokens only to a principal owning a non-deleted cell row", async () => {
    const withCell = await newTenantWithCell("running");
    await assertPrincipalOwnsCloudCell(withCell);

    const withoutCell = await newTenantWithCell(null);
    await assert.rejects(assertPrincipalOwnsCloudCell(withoutCell), CloudPrincipalHasNoCellError);

    const deletedOnly = await newTenantWithCell("deleted");
    await assert.rejects(assertPrincipalOwnsCloudCell(deletedOnly), CloudPrincipalHasNoCellError);
  });

  // Security review finding 7: the hosted-shared minting queries
  // (issueOAuthTokensFromCodeAtomic, rotateOAuthRefreshTokenAtomic) know
  // nothing about Cloud cells -- this is the post-condition the token route
  // applies to their result, keyed on the grant id they already return.
  it("refuses grant-keyed Cloud token issuance for a tenant without a live cell row", async () => {
    const clientId = `https://grant-owns-cell-${randomUUID()}.example.test/client.json`;
    const host = new URL(clientId).hostname;
    await admitCimdHost("claude", host);
    await createCimdClient({ clientId, host });
    const clientRow = await pool!.query<{ id: string }>(
      "SELECT id FROM exomem_oauth_clients WHERE client_id = $1",
      [clientId]
    );
    const clientDbId = clientRow.rows[0]!.id;

    async function grantFor(tenantId: string): Promise<string> {
      const tenant = await pool!.query<{ owner_user_id: string }>(
        "SELECT owner_user_id FROM exomem_tenants WHERE id = $1",
        [tenantId]
      );
      const grant = await pool!.query<{ id: string }>(
        `INSERT INTO exomem_oauth_grants (user_id, tenant_id, client_id, resource, scopes)
         VALUES ($1, $2, $3, $4, '{exomem.read,exomem.write}')
         RETURNING id`,
        [tenant.rows[0]!.owner_user_id, tenantId, clientDbId, CLOUD_RESOURCE]
      );
      return grant.rows[0]!.id;
    }

    const withCell = await grantFor(await newTenantWithCell("running"));
    await assertGrantOwnsCloudCell(withCell);

    const withoutCell = await grantFor(await newTenantWithCell(null));
    await assert.rejects(assertGrantOwnsCloudCell(withoutCell), CloudPrincipalHasNoCellError);

    const deletedOnly = await grantFor(await newTenantWithCell("deleted"));
    await assert.rejects(assertGrantOwnsCloudCell(deletedOnly), CloudPrincipalHasNoCellError);
  });
});
