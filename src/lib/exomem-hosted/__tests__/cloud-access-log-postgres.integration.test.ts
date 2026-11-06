import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { ACCESS_LOG_COOKIE, handleAccessLogRequest, issueLogRecovery } from "../cloud-access-log";
import {
  __setExomemSqlForTests,
  __setExomemTransactionForTests,
  findExomemSessionByDigest,
  type ExomemSql,
} from "../db";
import { digestSecret } from "../security";
import { resolveCloudOwnerPrincipal } from "../cloud-owner-principal";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
let pool: Pool;
let schema: string;
function sqlFor(client: Pool | PoolClient): ExomemSql {
  return async (strings, ...values) => {
    const text = strings.reduce(
      (text, part, index) => text + (index ? `$${index}` : "") + part,
      ""
    );
    const result = await client.query(text, values);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  };
}
async function owner(cell: string) {
  const user = (
    await pool.query("INSERT INTO exomem_users(email) VALUES($1) RETURNING id", [
      `${randomUUID()}@example.test`,
    ])
  ).rows[0].id;
  const tenant = (
    await pool.query(
      "INSERT INTO exomem_tenants(owner_user_id,status,desired_state) VALUES($1,'active','running') RETURNING id",
      [user]
    )
  ).rows[0].id;
  await pool.query(
    "INSERT INTO exomem_cloud_cells(cell_id,tenant_id,desired_state) VALUES($1,$2,'running')",
    [cell, tenant]
  );
  return { user, tenant, cell };
}
function post(path: string, body: unknown, cookie?: string) {
  return new Request(`http://app.example.test${path}`, {
    method: "POST",
    headers: {
      host: "app.example.test",
      origin: "http://app.example.test",
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("retained access log PostgreSQL workflow", { skip: !databaseUrl }, () => {
  before(async () => {
    process.env.EXOMEM_CONTROL_PLANE_KEY = randomBytes(32).toString("base64url");
    process.env.EXOMEM_CLOUD_ACCESS_LOG_ENABLED = "true";
    process.env.EXOMEM_ACCESS_LOG_RETENTION_DAYS = "365";
    process.env.EXOMEM_ACCESS_RECORD_HEARTBEAT_MAX_AGE_SECONDS = "180";
    schema = `access_log_it_${randomUUID().replaceAll("-", "")}`;
    await ensureExomemPostgresTestExtensions(databaseUrl!);
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema},public`);
    await applyMigrations({ databaseUrl: url.toString() });
    await admin.end();
    pool = new Pool({ connectionString: url.toString() });
    __setExomemSqlForTests(sqlFor(pool));
    __setExomemTransactionForTests(async (work) => {
      const client = await pool.connect();
      await client.query("BEGIN");
      try {
        const result = await work(sqlFor(client));
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
    if (pool) await pool.end();
    if (schema) {
      const admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
    delete process.env.EXOMEM_CLOUD_ACCESS_LOG_ENABLED;
    delete process.env.EXOMEM_ACCESS_LOG_RETENTION_DAYS;
    delete process.env.EXOMEM_ACCESS_RECORD_HEARTBEAT_MAX_AGE_SECONDS;
  });

  it("fresh recovery after erasure reads only the old cell and cannot become an ordinary session after readmission", async () => {
    const a = await owner("aaaaaaaaaaaaaaaa"),
      b = await owner("bbbbbbbbbbbbbbbb");
    const code = await issueLogRecovery(a.user, a.tenant, a.cell);
    const receipt = (
      await pool.query(
        "INSERT INTO exomem_cloud_access_receipts(bucket_id,object_key,version_id,provider_at,processed_at) VALUES('bucket','access/events','exact-version',now(),now()) RETURNING id"
      )
    ).rows[0].id;
    const record = (
      await pool.query(
        "INSERT INTO exomem_cloud_access_records(receipt_id,line_number,kind,source_at,provider_at,node,boot_id,event_id,identity_tier,action,target) VALUES($1,0,'kubernetes',now(),now(),'node-a','boot-a','event-a','admin','get','<img src=x onerror=alert(1)>') RETURNING id",
        [receipt]
      )
    ).rows[0].id;
    await pool.query("INSERT INTO exomem_cloud_access_entries(cell_id,record_id) VALUES($1,$2)", [
      a.cell,
      record,
    ]);
    await pool.query(
      "INSERT INTO exomem_cloud_placements(cell_id,pod_uid,node,first_observed_at,last_observed_at,workload_kind,workload_uid) VALUES($1,'pod-old','node-a',now()-interval '1 hour',now()-interval '30 minutes','StatefulSet','workload-a'),($1,'pod-new','node-a',now()-interval '20 minutes',now(),'StatefulSet','workload-a')",
      [a.cell]
    );
    await pool.query(
      "INSERT INTO exomem_cloud_access_records(receipt_id,line_number,kind,source_at,provider_at,node,boot_id,event_id,identity_tier,action) VALUES($1,1,'heartbeat',now()-interval '1 minute',now(),'node-a','boot-a','later-beat','unknown','heartbeat')",
      [receipt]
    );
    await pool.query("UPDATE exomem_cloud_cells SET desired_state='deleted' WHERE cell_id=$1", [
      a.cell,
    ]);
    await pool.query(
      "UPDATE exomem_tenants SET status='deleted',desired_state='deleted',deleted_at=now() WHERE id=$1",
      [a.tenant]
    );
    await pool.query(
      "UPDATE exomem_users SET email=NULL,email_verified_at=NULL,deleted_at=now() WHERE id=$1",
      [a.user]
    );
    const challengeResponse = await handleAccessLogRequest(
      post("/api/exomem/cloud/access-log/challenge", {}),
      "challenge"
    );
    assert.equal(challengeResponse.status, 200);
    const challenge = (await challengeResponse.json()).challenge as string;
    const challengeCookie = challengeResponse.headers.get("set-cookie")!.split(";", 1)[0];
    const recovered = await handleAccessLogRequest(
      post("/api/exomem/cloud/access-log/recover", { code: code.code, challenge }, challengeCookie),
      "recover"
    );
    assert.equal(recovered.status, 200);
    const cookie = recovered.headers.get("set-cookie")!.split(";", 1)[0];
    assert.ok(cookie.startsWith(`${ACCESS_LOG_COOKIE}=`));
    const crossTenant = new Request(
      `http://app.example.test/api/exomem/cloud/access-log?cellId=${b.cell}`,
      { headers: { cookie } }
    );
    assert.equal((await handleAccessLogRequest(crossTenant, "read")).status, 401);
    const request = new Request("http://app.example.test/api/exomem/cloud/access-log", {
      headers: { cookie },
    });
    const response = await handleAccessLogRequest(request, "read");
    assert.equal(response.status, 200);
    const view = await response.json();
    assert.equal(view.cellId, a.cell);
    assert.equal(view.entries.length, 1);
    assert.equal(view.entries[0].target, "<img src=x onerror=alert(1)>");
    assert.equal(view.coverage, "partial");
    assert.equal(view.placements[0].heartbeat, null);
    assert.equal(view.placements[0].gap, true);
    assert.equal(view.placements[1].gap, false);
    assert.ok(
      new Date(view.placements[1].heartbeat.source_at).getTime() <=
        new Date(view.placements[1].last_observed_at).getTime()
    );
    assert.equal(view.entries[0].reason, null);
    await assert.rejects(resolveCloudOwnerPrincipal(request));
    const raw = cookie.slice(cookie.indexOf("=") + 1);
    assert.equal(await findExomemSessionByDigest(digestSecret(raw)), null);
    await pool.query("UPDATE exomem_users SET email=$2,deleted_at=NULL WHERE id=$1", [
      a.user,
      `${randomUUID()}@example.test`,
    ]);
    await pool.query(
      "UPDATE exomem_tenants SET status='active',desired_state='running',deleted_at=NULL WHERE id=$1",
      [a.tenant]
    );
    await pool.query(
      "INSERT INTO exomem_cloud_cells(cell_id,tenant_id,desired_state) VALUES('cccccccccccccccc',$1,'running')",
      [a.tenant]
    );
    await assert.rejects(resolveCloudOwnerPrincipal(request));
    assert.equal((await (await handleAccessLogRequest(request, "read")).json()).cellId, a.cell);
    await pool.query(
      "UPDATE exomem_cloud_access_grants SET revoked_at=now() WHERE code_digest=$1",
      [digestSecret(code.code)]
    );
    assert.equal((await handleAccessLogRequest(request, "read")).status, 401);
  });

  it("invalid or replayed browser challenges do not exchange a code or create product authority", async () => {
    const a = await owner("dddddddddddddddd");
    const code = await issueLogRecovery(a.user, a.tenant, a.cell);
    const result = await handleAccessLogRequest(
      post(
        "/api/exomem/cloud/access-log/recover",
        { code: code.code, challenge: "forged" },
        "exomem_access_log_challenge=forged"
      ),
      "recover"
    );
    assert.equal(result.status, 401);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM exomem_cloud_access_sessions session JOIN exomem_cloud_access_grants grant_row ON grant_row.id=session.grant_id WHERE grant_row.owner_user_id=$1",
          [a.user]
        )
      ).rows[0].count,
      0
    );
    const challengeResponse = await handleAccessLogRequest(
      post("/api/exomem/cloud/access-log/challenge", {}),
      "challenge"
    );
    const challenge = (await challengeResponse.json()).challenge as string;
    const cookie = challengeResponse.headers.get("set-cookie")!.split(";", 1)[0];
    const exchange = () =>
      handleAccessLogRequest(
        post("/api/exomem/cloud/access-log/recover", { code: code.code, challenge }, cookie),
        "recover"
      );
    assert.equal((await exchange()).status, 200);
    assert.equal((await exchange()).status, 401);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM exomem_cloud_access_sessions session JOIN exomem_cloud_access_grants grant_row ON grant_row.id=session.grant_id WHERE grant_row.owner_user_id=$1",
          [a.user]
        )
      ).rows[0].count,
      1
    );
    await assert.rejects(issueLogRecovery(a.user, a.tenant, "bbbbbbbbbbbbbbbb"));
  });
});
