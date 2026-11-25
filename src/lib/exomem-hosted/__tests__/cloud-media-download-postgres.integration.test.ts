import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { handleCloudDownloadRequest } from "../../../exomem-gateway/cloud-handler";
import { testUpstream } from "../../../exomem-gateway/__tests__/upstream-fixture";
import { deriveCloudCellBearer } from "../cloud-cell-bearer";
import { randomCloudCellId } from "../cloud-admission";
import type { ExomemCloudConfig } from "../cloud-config";
import { handleCloudMediaDownloadRequest } from "../cloud-media-download";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
import { digestSecret, generateExternalToken } from "../security";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

// add-cloud-media-access: the signed-in download link against real PostgreSQL. The browser
// session, the ticket and the gateway's login lookup all run for real; only the cell's
// bytes are substituted, at the gateway's `fetchCell` boundary.

process.env.EXOMEM_CONTROL_PLANE_KEY ??= randomBytes(32).toString("base64url");

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
const RESOURCE = "https://cloud.example.test/mcp/v1";
const ENV = { EXOMEM_CLOUD_MCP_URL: RESOURCE, EXOMEM_CLOUD_MCP_PATH: "/mcp/v1" };
const CELL_TOKEN_KEY = Buffer.alloc(32, 5);
const { privateKey } = generateKeyPairSync("ed25519");
const PATH = "Recordings/standup.mp4";
const BYTES = Buffer.from("0123456789");
let pool: Pool;
let schema: string;

type Owner = { userId: string; tenantId: string; cellId: string; cookie: string };

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

async function owner(desired = "running"): Promise<Owner> {
  const user = await pool.query("INSERT INTO exomem_users (email) VALUES ($1) RETURNING id", [
    `media-${randomUUID()}@example.test`,
  ]);
  const userId = user.rows[0].id;
  const tenant = await pool.query(
    "INSERT INTO exomem_tenants (owner_user_id, status, desired_state) VALUES ($1, 'active', 'running') RETURNING id",
    [userId]
  );
  const tenantId = tenant.rows[0].id;
  const cellId = randomCloudCellId();
  await pool.query(
    "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, $3)",
    [cellId, tenantId, desired]
  );
  await pool.query(
    "UPDATE exomem_cloud_cells SET ready = true, observed_state = $2, observed_image = $3 WHERE cell_id = $1",
    [cellId, desired, "registry.example.test/exomem@sha256:" + "a".repeat(64)]
  );
  const cookie = generateExternalToken();
  await pool.query(
    "INSERT INTO exomem_sessions (user_id, tenant_id, session_digest, csrf_digest, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 hour')",
    [userId, tenantId, digestSecret(cookie), digestSecret(generateExternalToken())]
  );
  return { userId, tenantId, cellId, cookie };
}

/** What a browser sends for a link inside Home: the session cookie and its own fetch metadata. */
function homeLink(who: Owner | null, query: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://app.example.test/api/exomem/cloud/download?${query}`, {
    headers: {
      host: "app.example.test",
      "sec-fetch-site": "same-origin",
      ...(who ? { cookie: `exomem_session=${who.cookie}` } : {}),
      ...headers,
    },
  });
}

function link(who: Owner | null, path = PATH, headers: Record<string, string> = {}) {
  return handleCloudMediaDownloadRequest(
    homeLink(who, new URLSearchParams({ path }).toString(), headers),
    { env: ENV }
  );
}

/** The claims a ticket carries; its payload is signed, not secret. */
function claimsOf(location: string): { family_id: string; iat: number; exp: number } {
  const ticket = new URL(location).searchParams.get("ticket")!;
  return JSON.parse(Buffer.from(ticket.split(".")[0], "base64url").toString("utf8"));
}

/** The gateway and the cell behind it: the real handler and lookup, a stand-in for the cell's bytes. */
function gateway(cells: Owner[]) {
  const reached: Array<{ cellUrl: string; bearer: string | null; range: string | null }> = [];
  const config: ExomemCloudConfig = {
    mcpUrl: RESOURCE,
    acceptedResources: [RESOURCE],
    mcpPath: "/mcp/v1",
    cellTokenKey: CELL_TOKEN_KEY,
    artifactSigningKey: privateKey,
    uploadCells: new Set(cells.map((cell) => cell.cellId)),
  };
  const fetchCell = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    reached.push({
      cellUrl: url,
      bearer: headers.get("authorization"),
      range: headers.get("range"),
    });
    const match = /^bytes=(\d+)-(\d+)$/.exec(headers.get("range") ?? "");
    if (!match) return new Response(BYTES, { status: 200 });
    const [from, to] = [Number(match[1]), Number(match[2])];
    return new Response(BYTES.subarray(from, to + 1), {
      status: 206,
      headers: {
        "content-range": `bytes ${from}-${to}/${BYTES.length}`,
        "content-type": "video/mp4",
      },
    });
  }) as unknown as typeof fetch;
  const follow = (location: string, headers: Record<string, string> = {}) =>
    handleCloudDownloadRequest(new Request(location, { headers }), {
      config,
      fetchCell,
      upstream: testUpstream(),
      takeRateLimit: async () => true,
    });
  return { reached, follow };
}

describe("Signed-in media download PostgreSQL boundary", { skip: !databaseUrl }, () => {
  before(async () => {
    await ensureExomemPostgresTestExtensions(databaseUrl!);
    schema = `media_download_it_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);
    await applyMigrations({ databaseUrl: scoped.toString() });
    pool = new Pool({ connectionString: scoped.toString() });
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
    await pool?.end();
    if (schema) {
      const admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it("answers 401 with no redirect and no grant when nobody is signed in", async () => {
    const response = await link(null);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("location"), null);
    const garbage = await link({ cookie: generateExternalToken() } as Owner);
    assert.equal(garbage.status, 401);
  });

  it("sends a signed-in owner to the gateway, where the same ticket plays and seeks", async () => {
    const a = await owner();
    const { reached, follow } = gateway([a]);
    const response = await link(a);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    const location = response.headers.get("location")!;
    assert.equal(
      new URL(location).origin + new URL(location).pathname,
      "https://cloud.example.test/download"
    );
    assert.equal(new URL(location).searchParams.get("path"), PATH);

    const first = await follow(location, { range: "bytes=0-3" });
    assert.equal(first.status, 206);
    assert.equal(first.headers.get("content-range"), "bytes 0-3/10");
    assert.equal(await first.text(), "0123");
    const seek = await follow(location, { range: "bytes=6-9" });
    assert.equal(seek.status, 206);
    assert.equal(await seek.text(), "6789");
    assert.deepEqual(
      reached.map((call) => call.range),
      ["bytes=0-3", "bytes=6-9"]
    );
    for (const call of reached) {
      assert.equal(call.bearer, `Bearer ${deriveCloudCellBearer(CELL_TOKEN_KEY, a.cellId)}`);
      assert.ok(call.cellUrl.includes(a.cellId));
    }
  });

  it("reuses one Home grant and family however many links the owner opens", async () => {
    const a = await owner();
    for (let index = 0; index < 4; index += 1) {
      assert.equal((await link(a, `Recordings/take-${index}.mp4`)).status, 302);
    }
    const counts = await pool.query(
      `SELECT (SELECT count(*) FROM exomem_oauth_grants WHERE tenant_id = $1)::int AS grants,
              (SELECT count(*) FROM exomem_oauth_token_families AS family
                 JOIN exomem_oauth_grants AS oauth_grant ON oauth_grant.id = family.grant_id
                WHERE oauth_grant.tenant_id = $1)::int AS families,
              (SELECT count(*) FROM exomem_oauth_access_tokens AS token
                 JOIN exomem_oauth_grants AS oauth_grant ON oauth_grant.id = token.grant_id
                WHERE oauth_grant.tenant_id = $1)::int AS tokens`,
      [a.tenantId]
    );
    assert.deepEqual(counts.rows[0], { grants: 1, families: 1, tokens: 0 });
  });

  it("gives a ticket a life of hours and only ever names a family that outlives it", async () => {
    const a = await owner();
    const first = claimsOf((await link(a)).headers.get("location")!);
    assert.equal(first.exp - first.iat, 4 * 60 * 60);
    const family = (id: string) =>
      pool.query(
        "UPDATE exomem_oauth_token_families SET expires_at = now() + $2::interval WHERE id = $1",
        [id, "3 hours"]
      );
    // Home's access-token mint reuses a family down to its last two minutes; a ticket may not,
    // because the gateway's login lookup ends at the family's own expiry.
    await family(first.family_id);
    const second = claimsOf((await link(a)).headers.get("location")!);
    assert.notEqual(second.family_id, first.family_id);
    const outlives = await pool.query(
      "SELECT expires_at > to_timestamp($2) AS outlives FROM exomem_oauth_token_families WHERE id = $1",
      [second.family_id, second.exp]
    );
    assert.equal(outlives.rows[0].outlives, true);
    // A family with room beyond the ticket is reused, not replaced.
    await pool.query(
      "UPDATE exomem_oauth_token_families SET expires_at = now() + interval '5 hours' WHERE id = $1",
      [second.family_id]
    );
    assert.equal(claimsOf((await link(a)).headers.get("location")!).family_id, second.family_id);
  });

  it("keeps a ticket alive when the owner signs out, until its grant ends", async () => {
    const a = await owner();
    const { follow } = gateway([a]);
    const location = (await link(a)).headers.get("location")!;
    await pool.query("UPDATE exomem_sessions SET revoked_at = now() WHERE tenant_id = $1", [
      a.tenantId,
    ]);
    assert.equal((await follow(location, { range: "bytes=0-1" })).status, 206);
    assert.equal((await link(a)).status, 401, "the signed-out browser cannot ask for another link");
    await pool.query("UPDATE exomem_oauth_grants SET revoked_at = now() WHERE tenant_id = $1", [
      a.tenantId,
    ]);
    assert.equal((await follow(location)).status, 401);
  });

  it("never lets one owner's session reach another owner's cell or path", async () => {
    const a = await owner();
    const b = await owner();
    const { reached, follow } = gateway([a, b]);
    // The request names tenant A's cell and tenant, as a hostile page might; only the session counts.
    const query = new URLSearchParams({ path: PATH, cell_id: a.cellId, tenant_id: a.tenantId });
    const response = await handleCloudMediaDownloadRequest(homeLink(b, query.toString()), {
      env: ENV,
    });
    assert.equal(response.status, 302);
    const location = response.headers.get("location")!;
    assert.equal(new URL(location).searchParams.get("cell_id"), null);
    assert.equal((await follow(location, { range: "bytes=0-1" })).status, 206);
    assert.ok(reached[0].cellUrl.includes(b.cellId));
    assert.ok(!reached[0].cellUrl.includes(a.cellId));

    // The ticket is for exactly its path: the same ticket on another file never reaches a cell.
    const other = new URL(location);
    other.searchParams.set("path", "Recordings/other.mp4");
    assert.equal((await follow(other.toString())).status, 401);
    assert.equal(reached.length, 1);
  });

  it("ends a ticket the moment its grant is revoked or its account starts deleting", async () => {
    const revoked = await owner();
    const deleting = await owner();
    const { reached, follow } = gateway([revoked, deleting]);
    const revokedLocation = (await link(revoked)).headers.get("location")!;
    const deletingLocation = (await link(deleting)).headers.get("location")!;
    assert.equal((await follow(revokedLocation)).status, 200);
    assert.equal((await follow(deletingLocation)).status, 200);
    const served = reached.length;

    await pool.query("UPDATE exomem_oauth_grants SET revoked_at = now() WHERE tenant_id = $1", [
      revoked.tenantId,
    ]);
    await pool.query("UPDATE exomem_tenants SET status = 'deletion_pending' WHERE id = $1", [
      deleting.tenantId,
    ]);
    assert.equal((await follow(revokedLocation)).status, 401);
    assert.equal((await follow(deletingLocation)).status, 401);
    assert.equal(reached.length, served, "neither refused ticket reached a cell");
  });

  it("answers 503 and mints nothing for a stopped cell", async () => {
    const stopped = await owner("stopped");
    const response = await link(stopped);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("location"), null);
    const grants = await pool.query(
      "SELECT count(*)::int AS count FROM exomem_oauth_grants WHERE tenant_id = $1",
      [stopped.tenantId]
    );
    assert.equal(grants.rows[0].count, 0);
  });

  it("refuses a link that began on another site, before any grant is written", async () => {
    const a = await owner();
    const refused: Array<Record<string, string>> = [
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
      { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" },
      { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" },
      { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "video" },
    ];
    for (const headers of refused) {
      assert.equal((await link(a, PATH, headers)).status, 403, JSON.stringify(headers));
    }
    // A browser without fetch metadata still names a foreign site in Origin.
    const old = new Request(
      `https://app.example.test/api/exomem/cloud/download?${new URLSearchParams({ path: PATH })}`,
      {
        headers: {
          host: "app.example.test",
          cookie: `exomem_session=${a.cookie}`,
          origin: "https://evil.example.test",
        },
      }
    );
    assert.equal((await handleCloudMediaDownloadRequest(old, { env: ENV })).status, 403);
    const grants = await pool.query(
      "SELECT count(*)::int AS count FROM exomem_oauth_grants WHERE tenant_id = $1",
      [a.tenantId]
    );
    assert.equal(grants.rows[0].count, 0);
    // A typed address or a bookmark carries `none` and is the owner's own request.
    assert.equal((await link(a, PATH, { "sec-fetch-site": "none" })).status, 302);
  });

  it("admits a link the owner follows from another site, such as one in a web chat client", async () => {
    const a = await owner();
    const navigation = {
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    };
    const response = await link(a, PATH, navigation);
    assert.equal(response.status, 302);
    assert.ok(response.headers.get("location")?.startsWith("https://cloud.example.test/download?"));
  });

  it("refuses a reviewer's session", async () => {
    const a = await owner();
    const credential = await pool.query(
      `INSERT INTO exomem_marketplace_reviewer_credentials
         (provider, username_digest, password_hash, owner_user_id, tenant_id, fixture_version,
          fixture_payload_digest, created_by_principal_digest, expires_at)
       VALUES ('openai', $1, '$argon2id$fixture', $2, $3, 'v1', $4, $5, now() + interval '1 day')
       RETURNING id`,
      [digestSecret(randomUUID()), a.userId, a.tenantId, "c".repeat(64), digestSecret("principal")]
    );
    await pool.query(
      "UPDATE exomem_sessions SET reviewer_credential_id = $1 WHERE tenant_id = $2",
      [credential.rows[0].id, a.tenantId]
    );
    const response = await link(a);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("location"), null);
  });

  it("needs exactly one non-empty path", async () => {
    const a = await owner();
    for (const query of ["", "path=", "path=a&path=b"]) {
      const response = await handleCloudMediaDownloadRequest(homeLink(a, query), { env: ENV });
      assert.equal(response.status, 400, query);
    }
  });
});
