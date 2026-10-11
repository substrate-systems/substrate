import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { randomCloudCellId } from "../cloud-admission";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
import { digestSecret, generateExternalToken } from "../security";
import { handleCloudImportRequest } from "../cloud-import-http";
import { resolveApprovedCloudOAuthClient } from "../cloud-oauth";
import { redirectUriApproved } from "../oauth-client-admission";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
const resource = "https://cloud.example.test/mcp/v1";
let pool: Pool;
let schema: string;
let scopedUrl: string;
let savedResource: string | undefined;
let savedPath: string | undefined;

type Owner = {
  userId: string;
  tenantId: string;
  cellId: string;
  token: string;
  cookie: string;
  csrf: string;
};

function taggedSql(client: Pool | PoolClient): ExomemSql {
  return async (strings, ...values) => {
    const text = strings.reduce(
      (result, part, index) => result + (index ? `$${index}` : "") + part,
      ""
    );
    const result = await client.query(text, values);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  };
}

async function owner(
  tokenResource = resource,
  scopes = ["exomem.read", "exomem.write"]
): Promise<Owner> {
  const user = await pool.query("INSERT INTO users (email) VALUES ($1) RETURNING id", [
    `import-${randomUUID()}@example.test`,
  ]);
  const userId = user.rows[0].id;
  const tenant = await pool.query(
    "INSERT INTO exomem_tenants (owner_user_id, status, desired_state) VALUES ($1, 'active', 'running') RETURNING id",
    [userId]
  );
  const tenantId = tenant.rows[0].id;
  const cellId = randomCloudCellId();
  await pool.query(
    "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, 'running')",
    [cellId, tenantId]
  );
  const client = await pool.query(
    "SELECT id FROM exomem_oauth_clients WHERE client_id = 'exomem-cloud-cli'"
  );
  const clientId = client.rows[0].id;
  const grant = await pool.query(
    "INSERT INTO exomem_oauth_grants (user_id, tenant_id, client_id, resource, scopes) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [userId, tenantId, clientId, tokenResource, scopes]
  );
  const family = await pool.query(
    "INSERT INTO exomem_oauth_token_families (grant_id, client_id, expires_at) VALUES ($1, $2, now() + interval '1 day') RETURNING id",
    [grant.rows[0].id, clientId]
  );
  const token = generateExternalToken();
  await pool.query(
    "INSERT INTO exomem_oauth_access_tokens (access_digest, grant_id, family_id, client_id, resource, scopes, expires_at) VALUES ($1, $2, $3, $4, $5, $6, now() + interval '1 hour')",
    [digestSecret(token), grant.rows[0].id, family.rows[0].id, clientId, tokenResource, scopes]
  );
  const cookie = generateExternalToken();
  const csrf = generateExternalToken();
  await pool.query(
    "INSERT INTO exomem_sessions (user_id, tenant_id, session_digest, csrf_digest, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 hour')",
    [userId, tenantId, digestSecret(cookie), digestSecret(csrf)]
  );
  return { userId, tenantId, cellId, token, cookie, csrf };
}

async function call(
  who: Owner,
  action: "create" | "status" | "prepare-upload" | "complete" | "cancel" | "discard",
  body?: unknown,
  id?: string,
  headers?: Record<string, string>
) {
  return handleCloudImportRequest(
    new Request(`https://app.example.test/api/exomem/cloud/imports${id ? `/${id}` : ""}`, {
      method: action === "status" ? "GET" : "POST",
      headers: headers ?? {
        authorization: `Bearer ${who.token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    action,
    id
  );
}

async function create(who: Owner) {
  const response = await call(who, "create", {
    kind: "adopt",
    declared_bytes: 123,
    declared_files: 2,
  });
  assert.equal(response.status, 201);
  return (await response.json()).import;
}

async function transport(who: Owner) {
  const row = await create(who);
  await pool.query(
    "UPDATE exomem_cloud_imports SET recipient = 'age1test', observed_state = 'key_ready' WHERE import_id = $1",
    [row.import_id]
  );
  const report = { ciphertext_sha256: "a".repeat(64), ciphertext_bytes: 256 };
  assert.equal((await call(who, "prepare-upload", report, row.import_id)).status, 200);
  const parts = [{ part_number: 1, url: "https://upload.example.test/part", part_size_bytes: 256 }];
  await pool.query(
    "UPDATE exomem_cloud_imports SET upload_id = 'multipart-test', part_urls = $2::jsonb, urls_expire_at = now() + interval '1 hour' WHERE import_id = $1",
    [row.import_id, JSON.stringify(parts)]
  );
  return {
    id: row.import_id as string,
    report,
    completion: { ...report, part_etags: [{ part_number: 1, etag: '"accepted"' }] },
  };
}

describe("Cloud import API PostgreSQL boundary", { skip: !databaseUrl }, () => {
  before(async () => {
    savedResource = process.env.EXOMEM_CLOUD_MCP_URL;
    savedPath = process.env.EXOMEM_CLOUD_MCP_PATH;
    process.env.EXOMEM_CLOUD_MCP_URL = resource;
    process.env.EXOMEM_CLOUD_MCP_PATH = "/mcp/v1";
    await ensureExomemPostgresTestExtensions(databaseUrl!);
    schema = `cloud_import_it_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);
    scopedUrl = scoped.toString();
    await applyMigrations({ databaseUrl: scopedUrl });
    pool = new Pool({ connectionString: scopedUrl });
    __setExomemSqlForTests(taggedSql(pool));
    __setExomemTransactionForTests(async (work) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(taggedSql(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    });
  });

  after(async () => {
    __setExomemSqlForTests(null);
    __setExomemTransactionForTests(null);
    if (savedResource === undefined) delete process.env.EXOMEM_CLOUD_MCP_URL;
    else process.env.EXOMEM_CLOUD_MCP_URL = savedResource;
    if (savedPath === undefined) delete process.env.EXOMEM_CLOUD_MCP_PATH;
    else process.env.EXOMEM_CLOUD_MCP_PATH = savedPath;
    await pool?.end();
    if (schema) {
      const admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it("reports pending, protects another tenant's transport, and rejects caller-selected authority", async () => {
    const alice = await owner();
    const bob = await owner();
    assert.deepEqual(await (await call(alice, "status")).json(), { import: null });
    const pending = await create(alice);
    assert.equal(pending.observed_state, "pending");
    assert.equal(pending.part_urls, null);
    await pool.query(
      'UPDATE exomem_cloud_imports SET recipient = \'age1private\', part_urls = \'[{"part_number":1,"url":"https://upload.example.test/private","part_size_bytes":256}]\' WHERE import_id = $1',
      [pending.import_id]
    );
    for (const action of ["status", "prepare-upload", "complete", "cancel", "discard"] as const) {
      const response = await call(
        bob,
        action,
        action === "prepare-upload"
          ? { ciphertext_sha256: "a".repeat(64), ciphertext_bytes: 256 }
          : action === "complete"
            ? {
                ciphertext_sha256: "a".repeat(64),
                ciphertext_bytes: 256,
                part_etags: [{ part_number: 1, etag: "other" }],
              }
            : undefined,
        pending.import_id
      );
      assert.equal(response.status, 404, action);
      assert.doesNotMatch(await response.text(), /age1private|upload\.example/);
    }
    assert.equal(
      (
        await call(bob, "create", {
          kind: "adopt",
          declared_bytes: 1,
          declared_files: 1,
          cell_id: alice.cellId,
        })
      ).status,
      400
    );
    assert.equal(
      (await call(bob, "create", { kind: "restore", declared_bytes: 1, declared_files: 1 })).status,
      400
    );
    assert.equal((await call(alice, "status", undefined, pending.import_id)).status, 200);
  });

  it("keeps browser CSRF and never borrows valid cookies after bearer failure", async () => {
    const alice = await owner();
    const browser = {
      cookie: `exomem_session=${alice.cookie}; exomem_csrf=${alice.csrf}`,
      origin: "https://app.example.test",
      host: "app.example.test",
      "content-type": "application/json",
    };
    const body = { kind: "adopt", declared_bytes: 1, declared_files: 1 };
    assert.equal((await call(alice, "create", body, undefined, browser)).status, 403);
    assert.equal(
      (
        await call(alice, "create", body, undefined, {
          ...browser,
          "x-exomem-csrf": alice.csrf,
          origin: "https://other.example.test",
        })
      ).status,
      403
    );
    for (const authorization of ["", "Basic bad", "Bearer invalid"]) {
      const denied = await call(alice, "create", body, undefined, {
        ...browser,
        "x-exomem-csrf": alice.csrf,
        authorization,
      });
      assert.equal(denied.status, 401);
      assert.match(
        denied.headers.get("www-authenticate")!,
        /https:\/\/cloud.example.test\/\.well-known\/oauth-protected-resource\/mcp\/v1/
      );
    }
    assert.equal(
      (await call(alice, "create", body, undefined, { ...browser, "x-exomem-csrf": alice.csrf }))
        .status,
      201
    );
  });

  it("rejects wrong-resource, revoked, expired, and insufficient-scope OAuth credentials", async () => {
    const wrongResource = await owner("https://other.example.test/mcp");
    assert.equal((await call(wrongResource, "status")).status, 401);
    const revoked = await owner();
    await pool.query(
      "UPDATE exomem_oauth_access_tokens SET revoked_at = now() WHERE access_digest = $1",
      [digestSecret(revoked.token)]
    );
    assert.equal((await call(revoked, "status")).status, 401);
    const expired = await owner();
    await pool.query(
      "UPDATE exomem_oauth_access_tokens SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE access_digest = $1",
      [digestSecret(expired.token)]
    );
    assert.equal((await call(expired, "status")).status, 401);
    for (const scopes of [["exomem.read"], ["exomem.write"]]) {
      assert.equal((await call(await owner(resource, scopes), "status")).status, 403);
    }
  });

  it("serializes create retries and keeps cancellation open until a controller terminal observation", async () => {
    const alice = await owner();
    const importId = randomUUID();
    const body = {
      import_id: importId,
      kind: "archive_members",
      declared_bytes: 2,
      declared_files: 1,
    };
    const retries = await Promise.all([call(alice, "create", body), call(alice, "create", body)]);
    assert.deepEqual(retries.map((response) => response.status).sort(), [200, 201]);
    assert.equal((await call(alice, "create", { ...body, declared_bytes: 3 })).status, 409);
    assert.equal((await call(alice, "cancel", undefined, importId)).status, 200);
    assert.equal((await call(alice, "create", { ...body, import_id: randomUUID() })).status, 409);
    await pool.query(
      "UPDATE exomem_cloud_imports SET observed_state = 'discarded' WHERE import_id = $1",
      [importId]
    );
    const racing = await Promise.all([
      call(alice, "create", { ...body, import_id: randomUUID() }),
      call(alice, "create", { ...body, import_id: randomUUID() }),
    ]);
    assert.deepEqual(racing.map((response) => response.status).sort(), [201, 409]);
  });

  it("freezes the prepared digest and accepted ETags across concurrent completions and terminal cleanup", async () => {
    const alice = await owner();
    const ready = await transport(alice);
    assert.equal((await call(alice, "prepare-upload", ready.report, ready.id)).status, 200);
    assert.equal(
      (await call(alice, "prepare-upload", { ...ready.report, ciphertext_bytes: 257 }, ready.id))
        .status,
      409
    );
    assert.equal(
      (
        await call(
          alice,
          "complete",
          { ...ready.completion, part_etags: [{ part_number: 2, etag: "wrong" }] },
          ready.id
        )
      ).status,
      409
    );
    const different = {
      ...ready.completion,
      part_etags: [{ part_number: 1, etag: '"replacement"' }],
    };
    const results = await Promise.all([
      call(alice, "complete", ready.completion, ready.id),
      call(alice, "complete", different, ready.id),
    ]);
    assert.deepEqual(results.map((response) => response.status).sort(), [200, 409]);
    const accepted = (
      await pool.query("SELECT part_etags FROM exomem_cloud_imports WHERE import_id = $1", [
        ready.id,
      ])
    ).rows[0].part_etags;
    await pool.query(
      "UPDATE exomem_cloud_imports SET observed_state = 'done', part_urls = NULL WHERE import_id = $1",
      [ready.id]
    );
    const retried = await call(
      alice,
      "complete",
      { ...ready.report, part_etags: accepted },
      ready.id
    );
    assert.equal(retried.status, 200);
    assert.equal((await retried.json()).import.observed_state, "done");
    await assert.rejects(
      pool.query("UPDATE exomem_cloud_imports SET ciphertext_bytes = 257 WHERE import_id = $1", [
        ready.id,
      ]),
      /immutable/
    );
    await assert.rejects(
      pool.query("UPDATE exomem_cloud_imports SET part_etags = '[]' WHERE import_id = $1", [
        ready.id,
      ]),
      /immutable/
    );
  });

  it("refuses unready and expired transport and malformed metadata before accepting completion", async () => {
    const alice = await owner();
    const row = await create(alice);
    const report = { ciphertext_sha256: "a".repeat(64), ciphertext_bytes: 256 };
    assert.equal((await call(alice, "prepare-upload", report, row.import_id)).status, 409);
    await pool.query(
      "UPDATE exomem_cloud_imports SET recipient = 'age1test', observed_state = 'key_ready' WHERE import_id = $1",
      [row.import_id]
    );
    for (const bad of [
      { ...report, ciphertext_bytes: -1 },
      { ...report, ciphertext_sha256: "bad" },
      { ...report, member_names: ["private"] },
    ]) {
      assert.equal((await call(alice, "prepare-upload", bad, row.import_id)).status, 400);
    }
    assert.equal((await call(alice, "prepare-upload", report, row.import_id)).status, 200);
    const completion = { ...report, part_etags: [{ part_number: 1, etag: "ok" }] };
    assert.equal((await call(alice, "complete", completion, row.import_id)).status, 409);
    await pool.query(
      'UPDATE exomem_cloud_imports SET upload_id = \'expired\', part_urls = \'[{"part_number":1,"url":"https://upload.example.test/expired","part_size_bytes":256}]\', urls_expire_at = now() - interval \'1 second\' WHERE import_id = $1',
      [row.import_id]
    );
    assert.equal((await call(alice, "complete", completion, row.import_id)).status, 409);
    assert.equal(
      (
        await call(
          alice,
          "complete",
          { ...completion, part_etags: [...completion.part_etags, ...completion.part_etags] },
          row.import_id
        )
      ).status,
      400
    );
  });

  it("permits status, cancel, and discard during suspension while refusing write starts and completion", async () => {
    const alice = await owner();
    const ready = await transport(alice);
    await pool.query("UPDATE exomem_cloud_cells SET desired_state = 'stopped' WHERE cell_id = $1", [
      alice.cellId,
    ]);
    await pool.query(
      "UPDATE exomem_tenants SET status = 'suspended', desired_state = 'suspended' WHERE id = $1",
      [alice.tenantId]
    );
    assert.equal((await call(alice, "status", undefined, ready.id)).status, 200);
    assert.equal(
      (await call(alice, "create", { kind: "adopt", declared_bytes: 1, declared_files: 1 })).status,
      403
    );
    assert.equal((await call(alice, "prepare-upload", ready.report, ready.id)).status, 403);
    assert.equal((await call(alice, "complete", ready.completion, ready.id)).status, 403);
    const cancelled = await call(alice, "cancel", undefined, ready.id);
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).import.observed_state, "key_ready");
    const discarded = await call(alice, "discard", undefined, ready.id);
    assert.equal(discarded.status, 200);
    assert.equal((await discarded.json()).import.requested_state, "discard_requested");
  });

  it("reserves the cell for an older discard and reports deferred cleanup without claiming completion", async () => {
    const alice = await owner();
    const older = await create(alice);
    await pool.query(
      "UPDATE exomem_cloud_imports SET observed_state = 'done' WHERE import_id = $1",
      [older.import_id]
    );
    const newer = await create(alice);
    assert.equal((await call(alice, "discard", undefined, older.import_id)).status, 409);
    assert.equal(
      (await (await call(alice, "status", undefined, older.import_id)).json()).import
        .requested_state,
      "requested"
    );
    await pool.query(
      "UPDATE exomem_cloud_imports SET observed_state = 'discarded' WHERE import_id = $1",
      [newer.import_id]
    );
    assert.equal((await call(alice, "discard", undefined, older.import_id)).status, 200);
    assert.equal(
      (await call(alice, "create", { kind: "adopt", declared_bytes: 1, declared_files: 1 })).status,
      409
    );
    await pool.query(
      "UPDATE exomem_cloud_imports SET observed_state = 'cleanup_pending' WHERE import_id = $1",
      [older.import_id]
    );
    const pending = await (await call(alice, "status", undefined, older.import_id)).json();
    assert.equal(pending.import.observed_state, "cleanup_pending");
    assert.equal(pending.import.error_code, null);
    assert.equal(
      (await call(alice, "create", { kind: "adopt", declared_bytes: 1, declared_files: 1 })).status,
      409
    );
    await pool.query(
      "UPDATE exomem_cloud_imports SET observed_state = 'discarded' WHERE import_id = $1",
      [older.import_id]
    );
    assert.equal(
      (await call(alice, "create", { kind: "adopt", declared_bytes: 1, declared_files: 1 })).status,
      201
    );
  });

  it("admits loopback CLI redirects without marketplace identity and preserves disabled admission on replay", async () => {
    const client = await resolveApprovedCloudOAuthClient("exomem-cloud-cli");
    assert.ok(client);
    assert.equal(redirectUriApproved(client.redirectUris, "http://127.0.0.1:49152/callback"), true);
    const row = (
      await pool.query(
        "SELECT client_platform, oauth_client_config_sha256 FROM exomem_oauth_clients WHERE client_id = 'exomem-cloud-cli'"
      )
    ).rows[0];
    assert.deepEqual(row, { client_platform: null, oauth_client_config_sha256: null });
    await pool.query(
      "UPDATE exomem_oauth_clients SET enabled = false WHERE client_id = 'exomem-cloud-cli'"
    );
    await applyMigrations({ databaseUrl: scopedUrl });
    assert.equal(await resolveApprovedCloudOAuthClient("exomem-cloud-cli"), null);
  });
  it("upgrades C5 cleanup authority without re-enabling an operator-disabled CLI client", async () => {
    const migrationRoot = await mkdtemp(join(tmpdir(), "cloud-import-upgrade-"));
    const upgradeSchema = `cloud_import_upgrade_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: databaseUrl });
    let upgrade: Pool | undefined;
    try {
      for (const file of await readdir("migrations")) {
        if (file.endsWith(".sql") && file < "0060")
          await cp(join("migrations", file), join(migrationRoot, file));
      }
      await admin.query(`CREATE SCHEMA "${upgradeSchema}"`);
      const url = new URL(databaseUrl!);
      url.searchParams.set("options", `-c search_path=${upgradeSchema},public`);
      await applyMigrations({ databaseUrl: url.toString(), migrationsDir: migrationRoot });
      upgrade = new Pool({ connectionString: url.toString() });
      assert.equal(
        (await upgrade.query("SELECT to_regclass('exomem_cloud_imports') AS table_name")).rows[0]
          .table_name,
        null
      );
      await upgrade.query(`INSERT INTO exomem_oauth_clients (client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest)
        VALUES ('exomem-cloud-cli', 'pinned', false, '["http://127.0.0.1/callback"]',
          digest(convert_to('["http://127.0.0.1/callback"]'::jsonb::text, 'utf8'), 'sha256'))`);
      await cp(
        "migrations/0060_exomem_cloud_imports.sql",
        join(migrationRoot, "0060_exomem_cloud_imports.sql")
      );
      await applyMigrations({ databaseUrl: url.toString(), migrationsDir: migrationRoot });
      const cellId = randomCloudCellId();
      const created = await upgrade.query(
        `WITH owner AS (
        INSERT INTO users (email) VALUES ($1) RETURNING id
      ), tenant AS (
        INSERT INTO exomem_tenants (owner_user_id) SELECT id FROM owner RETURNING id
      ), cell AS (
        INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state)
        SELECT $2, id, 'running' FROM tenant RETURNING cell_id
      ) INSERT INTO exomem_cloud_imports (cell_id, kind, declared_bytes, declared_files)
        SELECT cell_id, 'adopt', 1, 1 FROM cell RETURNING import_id`,
        [`upgrade-${randomUUID()}@example.test`, cellId]
      );
      const importId = created.rows[0].import_id;
      await assert.rejects(
        upgrade.query(
          "UPDATE exomem_cloud_imports SET observed_state = 'cleanup_pending' WHERE import_id = $1",
          [importId]
        ),
        { code: "23514" }
      );
      await applyMigrations({ databaseUrl: url.toString() });
      await upgrade.query(
        "UPDATE exomem_cloud_imports SET observed_state = 'cleanup_pending' WHERE import_id = $1",
        [importId]
      );
      await assert.rejects(
        upgrade.query(
          "INSERT INTO exomem_cloud_imports (cell_id, kind, declared_bytes, declared_files) VALUES ($1, 'adopt', 1, 1)",
          [cellId]
        ),
        { code: "23505" }
      );
      assert.equal(
        (
          await upgrade.query(
            "SELECT enabled FROM exomem_oauth_clients WHERE client_id = 'exomem-cloud-cli'"
          )
        ).rows[0].enabled,
        false
      );
      assert.equal(
        (await upgrade.query("SELECT count(*)::int AS count FROM exomem_cloud_imports")).rows[0]
          .count,
        1
      );
    } finally {
      await upgrade?.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${upgradeSchema}" CASCADE`);
      await admin.end();
      await rm(migrationRoot, { recursive: true, force: true });
    }
  });
});
