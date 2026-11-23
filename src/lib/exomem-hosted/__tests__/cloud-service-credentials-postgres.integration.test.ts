import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { randomCloudCellId } from "../cloud-admission";
import { findCloudOAuthAccessToken } from "../cloud-oauth";
import {
  findCloudServiceCredential,
  generateCloudServiceCredentialSecret,
  issueCloudServiceCredentialAtomic,
  listCloudServiceCredentials,
  revokeCloudServiceCredentialAtomic,
} from "../cloud-service-credentials";
import {
  __setExomemSqlForTests,
  __setExomemTransactionForTests,
  type ExomemSql,
} from "../db";
import { digestSecret } from "../security";
import { SERVICE_CREDENTIAL_PREFIX } from "../service-credential-format";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

// add-cloud-service-credentials (D1-D5): the service credential store and the
// gateway's digest lookup against real PostgreSQL — the digest-only storage,
// the two-live-credential limit under the tenant lock, and migration 0088's
// shared tenant-access predicate both credential kinds run (review B1).

const CLOUD_RESOURCE = "https://cloud.example.test/mcp/v1";
const OPERATOR_DIGEST = digestSecret("operator-test-principal");
const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
let pool: Pool | undefined;
let schema: string | undefined;

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

async function transaction<T>(callback: (tx: ExomemSql) => Promise<T>): Promise<T> {
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

async function newTenantWithCell(input: {
  status?: string;
  cellDesiredState?: string;
  marketplaceReviewer?: boolean;
} = {}): Promise<{ tenantId: string; ownerUserId: string; cellId: string }> {
  const user = await pool!.query<{ id: string }>(
    "INSERT INTO exomem_users (email) VALUES ($1) RETURNING id",
    [`svc-cred-${randomUUID()}@example.test`]
  );
  const tenant = await pool!.query<{ id: string }>(
    "INSERT INTO exomem_tenants (owner_user_id, status, marketplace_reviewer_purpose) VALUES ($1, $2, $3) RETURNING id",
    [user.rows[0]!.id, input.status ?? "active", input.marketplaceReviewer ?? false]
  );
  const cellId = randomCloudCellId();
  await pool!.query(
    "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, $3)",
    [cellId, tenant.rows[0]!.id, input.cellDesiredState ?? "running"]
  );
  return { tenantId: tenant.rows[0]!.id, ownerUserId: user.rows[0]!.id, cellId };
}

function issue(tenantId: string, principal = "service:creator-platform") {
  return issueCloudServiceCredentialAtomic({
    tenantId,
    principal,
    operatorPrincipalDigest: OPERATOR_DIGEST,
  });
}

describe("Exomem Cloud service credentials PostgreSQL integration", { skip: !databaseUrl }, () => {
  before(async () => {
    schema = `cloud_svc_cred_it_${randomUUID().replaceAll("-", "")}`;
    await ensureExomemPostgresTestExtensions(databaseUrl!);
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);
    await applyMigrations({ databaseUrl: scoped.toString() });
    await admin.end();
    pool = new Pool({ connectionString: scoped.toString() });
    __setExomemSqlForTests(taggedSql(pool));
    __setExomemTransactionForTests(transaction);
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
  });

  it("stores only the secret's SHA-256 digest and resolves the D3 access shape", async () => {
    const { tenantId, ownerUserId, cellId } = await newTenantWithCell();
    const issued = await issue(tenantId);

    assert.ok(issued.secret.startsWith(SERVICE_CREDENTIAL_PREFIX));
    assert.equal(issued.tenantId, tenantId);
    assert.equal(issued.cellId, cellId);
    const rows = await pool!.query<{
      secret_digest: Buffer;
      principal: string;
      revoked_at: Date | null;
    }>("SELECT secret_digest, principal, revoked_at FROM exomem_cloud_service_credentials WHERE id = $1", [
      issued.credentialId,
    ]);
    assert.equal(rows.rows.length, 1);
    // Digest-only storage: the row matches sha256(secret), and the plaintext
    // appears in no column — the table has nothing else that could hold it.
    assert.equal(rows.rows[0]!.secret_digest.equals(digestSecret(issued.secret)), true);
    assert.equal(rows.rows[0]!.principal, "service:creator-platform");
    assert.equal(rows.rows[0]!.revoked_at, null);

    const access = await findCloudServiceCredential(digestSecret(issued.secret), CLOUD_RESOURCE);
    assert.ok(access);
    assert.equal(access.serviceCredential, true);
    assert.equal(access.tenantId, tenantId);
    assert.equal(access.userId, ownerUserId);
    assert.equal(access.cellId, cellId);
    assert.equal(access.cellDesiredState, "running");
    assert.equal(access.clientId, "service:creator-platform");
    assert.equal(access.grantId, issued.credentialId);
    assert.equal(access.familyId, issued.credentialId);
    assert.equal(access.resource, CLOUD_RESOURCE);
    assert.deepEqual(access.scopes, ["exomem.read", "exomem.write"]);
    assert.equal(access.firstParty, false);
  });

  it("refuses a malformed principal before any row exists", async () => {
    const { tenantId } = await newTenantWithCell();
    for (const principal of ["creator-platform", "service:", "service:Upper", "service:a_b"]) {
      await assert.rejects(issue(tenantId, principal), { code: "INVALID_REQUEST" });
    }
    const count = await pool!.query(
      "SELECT count(*)::integer AS count FROM exomem_cloud_service_credentials WHERE tenant_id = $1",
      [tenantId]
    );
    assert.equal(count.rows[0]!.count, 0);
  });

  it("admits exactly two live credentials and refuses the third with SERVICE_CREDENTIAL_LIMIT", async () => {
    const { tenantId } = await newTenantWithCell();
    await issue(tenantId);
    await issue(tenantId);
    await assert.rejects(issue(tenantId), { code: "SERVICE_CREDENTIAL_LIMIT" });
    const live = await pool!.query(
      `SELECT count(*)::integer AS count FROM exomem_cloud_service_credentials
       WHERE tenant_id = $1 AND revoked_at IS NULL`,
      [tenantId]
    );
    assert.equal(live.rows[0]!.count, 2);
  });

  it("lets at most one of two concurrent issues create the second credential", async () => {
    const { tenantId } = await newTenantWithCell();
    await issue(tenantId);
    const settled = await Promise.allSettled([issue(tenantId), issue(tenantId)]);
    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const refused = settled.filter(
      (result) =>
        result.status === "rejected" &&
        (result.reason as { code?: string }).code === "SERVICE_CREDENTIAL_LIMIT"
    );
    // The tenant lock serializes the count: one attempt sees one live
    // credential and succeeds, the other sees two and is refused — never both.
    assert.equal(fulfilled.length, 1, JSON.stringify(settled));
    assert.equal(refused.length, 1, JSON.stringify(settled));
    const live = await pool!.query(
      `SELECT count(*)::integer AS count FROM exomem_cloud_service_credentials
       WHERE tenant_id = $1 AND revoked_at IS NULL`,
      [tenantId]
    );
    assert.equal(live.rows[0]!.count, 2);
  });

  it("takes a revocation on the next lookup and lists no secret or digest", async () => {
    const { tenantId } = await newTenantWithCell();
    const first = await issue(tenantId);
    const second = await issue(tenantId, "service:other-product");

    const listed = await listCloudServiceCredentials({ tenantId });
    assert.ok(listed);
    assert.equal(listed.length, 2);
    for (const row of listed) {
      assert.deepEqual(Object.keys(row).sort(), [
        "createdAt",
        "credentialId",
        "principal",
        "revokedAt",
      ]);
      assert.equal(typeof row.createdAt, "string");
      assert.equal(row.revokedAt, null);
    }
    // Neither the plaintext nor its digest can appear in a list payload.
    const serialized = JSON.stringify(listed);
    for (const secret of [first.secret, second.secret]) {
      assert.equal(serialized.includes(secret), false);
      assert.equal(serialized.includes(digestSecret(secret).toString("hex")), false);
    }

    assert.equal(
      await revokeCloudServiceCredentialAtomic({
        credentialId: first.credentialId,
        operatorPrincipalDigest: OPERATOR_DIGEST,
      }),
      true
    );
    // A repeat revoke is a successful no-op — idempotent by contract.
    assert.equal(
      await revokeCloudServiceCredentialAtomic({
        credentialId: first.credentialId,
        operatorPrincipalDigest: OPERATOR_DIGEST,
      }),
      false
    );
    assert.equal(
      await findCloudServiceCredential(digestSecret(first.secret), CLOUD_RESOURCE),
      null
    );
    assert.ok(await findCloudServiceCredential(digestSecret(second.secret), CLOUD_RESOURCE));
  });

  it("refuses a credential whose tenant is deletion_pending or deleted, whose owner is blocked, or whose cell is deleted", async () => {
    // Tenant status. The deleted state carries its deleted_at marker —
    // migration 0017's CHECK couples the two.
    for (const status of ["deletion_pending", "deleted"]) {
      const { tenantId } = await newTenantWithCell();
      const issued = await issue(tenantId);
      await pool!.query(
        "UPDATE exomem_tenants SET status = $1, deleted_at = CASE WHEN $1 = 'deleted' THEN now() ELSE NULL END WHERE id = $2",
        [status, tenantId]
      );
      assert.equal(
        await findCloudServiceCredential(digestSecret(issued.secret), CLOUD_RESOURCE),
        null,
        `tenant status ${status}`
      );
    }

    // Owner account block.
    {
      const { tenantId, ownerUserId } = await newTenantWithCell();
      const issued = await issue(tenantId);
      await pool!.query(
        "INSERT INTO exomem_oauth_account_blocks (tenant_id, owner_user_id, blocked_reason) VALUES ($1, $2, 'operator_revoked')",
        [tenantId, ownerUserId]
      );
      assert.equal(
        await findCloudServiceCredential(digestSecret(issued.secret), CLOUD_RESOURCE),
        null
      );
    }

    // Deleted cell.
    {
      const { tenantId, cellId } = await newTenantWithCell();
      const issued = await issue(tenantId);
      await pool!.query(
        "UPDATE exomem_cloud_cells SET desired_state = 'deleted' WHERE cell_id = $1",
        [cellId]
      );
      assert.equal(
        await findCloudServiceCredential(digestSecret(issued.secret), CLOUD_RESOURCE),
        null
      );
    }
  });

  it("issues by owner email, and an ineligible tenant gets no credential", async () => {
    const email = `svc-owner-${randomUUID()}@example.test`;
    const user = await pool!.query<{ id: string }>(
      "INSERT INTO exomem_users (email) VALUES ($1) RETURNING id",
      [email]
    );
    const tenant = await pool!.query<{ id: string }>(
      "INSERT INTO exomem_tenants (owner_user_id, status) VALUES ($1, 'active') RETURNING id",
      [user.rows[0]!.id]
    );
    await pool!.query(
      "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, 'running')",
      [randomCloudCellId(), tenant.rows[0]!.id]
    );
    const issued = await issueCloudServiceCredentialAtomic({
      ownerEmail: email,
      principal: "service:creator-platform",
      operatorPrincipalDigest: OPERATOR_DIGEST,
    });
    assert.equal(issued.tenantId, tenant.rows[0]!.id);

    // A tenant already leaving is refused at issue time, not only at lookup —
    // with the ineligible code, not a bare INVALID_REQUEST (review R2).
    const leaving = await newTenantWithCell({ status: "deletion_pending" });
    await assert.rejects(issue(leaving.tenantId), {
      code: "SERVICE_CREDENTIAL_TENANT_INELIGIBLE",
    });
    const blocked = await newTenantWithCell();
    await pool!.query(
      "INSERT INTO exomem_oauth_account_blocks (tenant_id, owner_user_id, blocked_reason) VALUES ($1, $2, 'operator_revoked')",
      [blocked.tenantId, blocked.ownerUserId]
    );
    await assert.rejects(issue(blocked.tenantId), {
      code: "SERVICE_CREDENTIAL_TENANT_INELIGIBLE",
    });
  });

  it("refuses issuance for a marketplace-reviewer tenant (review R2)", async () => {
    // Reviewer credentials carry their own expiry contract; a long-lived
    // service credential would sidestep it, so issuance is refused outright.
    const reviewer = await newTenantWithCell({ marketplaceReviewer: true });
    await assert.rejects(issue(reviewer.tenantId), {
      code: "SERVICE_CREDENTIAL_TENANT_INELIGIBLE",
    });
    const { rows } = await pool!.query(
      "SELECT count(*)::integer AS count FROM exomem_cloud_service_credentials WHERE tenant_id = $1",
      [reviewer.tenantId]
    );
    assert.equal(rows[0]!.count, 0);
  });

  it("separates the credential kinds: a digest in one table is invisible to the other's lookup", async () => {
    const { tenantId } = await newTenantWithCell();
    const issued = await issue(tenantId);
    // The generated secret's own prefix is its kind's mark; what is stored is
    // its digest. Sanity: a lookup with a wrong digest finds nothing.
    assert.equal(
      await findCloudServiceCredential(digestSecret(`wrong-${issued.secret}`), CLOUD_RESOURCE),
      null
    );
    // And the unprefixed random suffix is not a credential of any kind.
    const bare = generateCloudServiceCredentialSecret().slice(SERVICE_CREDENTIAL_PREFIX.length);
    assert.equal(await findCloudServiceCredential(digestSecret(bare), CLOUD_RESOURCE), null);
    // Review R6: the OAuth lookup must refuse a service secret's digest
    // outright — the credential kind is enforced by which table the dispatch
    // lets each lookup see, and the OAuth table never holds the digest.
    assert.equal(
      await findCloudOAuthAccessToken(digestSecret(issued.secret), CLOUD_RESOURCE),
      null
    );
  });
});
