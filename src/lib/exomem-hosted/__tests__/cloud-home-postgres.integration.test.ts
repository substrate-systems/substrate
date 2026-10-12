import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { randomCloudCellId } from "../cloud-admission";
import { handleCloudExportLinkRequest, handleCloudExportsRequest } from "../cloud-exports";
import { handleCloudHomeLevelsRequest, handleCloudHomeLiveRequest } from "../cloud-home-mcp";
import { findCloudOAuthAccessToken, resolveApprovedCloudOAuthClient } from "../cloud-oauth";
import { getOwnerCloudHomeStatus } from "../cloud-status";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
import { revokeOAuthAccountForOwnerTenantAtomic } from "../oauth-store";
import { digestSecret, generateExternalToken } from "../security";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

// The Home channel and the export API against real PostgreSQL. The cell's
// HTTP answer is substituted at the gateway boundary (`fetchCell`); the
// gateway's own token lookup runs for real on every substituted call.

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
const RESOURCE = "https://cloud.example.test/mcp/v1";
const ENV = {
  EXOMEM_CLOUD_MCP_URL: RESOURCE,
  EXOMEM_CLOUD_MCP_PATH: "/mcp/v1",
  EXOMEM_CLOUD_HOME_CHANNEL_ENABLED: "true",
  EXOMEM_CLOUD_EXPORTS_ENABLED: "true",
};
const LEVELS = {
  coding: { level: "balanced", source: "default" },
  conversation: { level: "balanced", source: "default" },
};
let pool: Pool;
let schema: string;

type Owner = { userId: string; tenantId: string; cellId: string; cookie: string; csrf: string };
type CellCall = {
  tool: string;
  arguments: Record<string, unknown>;
  bearer: string;
  routedTenantId: string;
  routedCellId: string;
  rawBody: string;
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
  cell: { desired?: string; ready?: boolean; image?: string | null } = {}
): Promise<Owner> {
  const user = await pool.query("INSERT INTO users (email) VALUES ($1) RETURNING id", [
    `home-${randomUUID()}@example.test`,
  ]);
  const userId = user.rows[0].id;
  const tenant = await pool.query(
    "INSERT INTO exomem_tenants (owner_user_id, status, desired_state) VALUES ($1, 'active', 'running') RETURNING id",
    [userId]
  );
  const tenantId = tenant.rows[0].id;
  const cellId = randomCloudCellId();
  const desired = cell.desired ?? "running";
  await pool.query(
    "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, $3)",
    [cellId, tenantId, desired]
  );
  await pool.query(
    "UPDATE exomem_cloud_cells SET ready = $2, observed_state = $3, observed_image = $4 WHERE cell_id = $1",
    [
      cellId,
      cell.ready ?? true,
      desired === "stopped" ? "stopped" : desired,
      cell.image === undefined
        ? "registry.example.test/exomem@sha256:" + "a".repeat(64)
        : cell.image,
    ]
  );
  const cookie = generateExternalToken();
  const csrf = generateExternalToken();
  await pool.query(
    "INSERT INTO exomem_sessions (user_id, tenant_id, session_digest, csrf_digest, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 hour')",
    [userId, tenantId, digestSecret(cookie), digestSecret(csrf)]
  );
  return { userId, tenantId, cellId, cookie, csrf };
}

function browserRequest(who: Owner, method: string, path: string, body?: unknown): Request {
  return new Request(`https://app.example.test${path}`, {
    method,
    headers: {
      cookie: `exomem_session=${who.cookie}; exomem_csrf=${who.csrf}`,
      origin: "https://app.example.test",
      host: "app.example.test",
      "x-exomem-csrf": who.csrf,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * A stand-in for the gateway and the cell behind it. It resolves the bearer
 * with the gateway's real lookup, as the gateway does, and refuses an
 * unknown token with the gateway's 401. `answer` returns the tool's
 * structured content, or a whole Response for the cases that need one.
 */
function fakeCell(answer: (call: CellCall) => unknown) {
  const calls: CellCall[] = [];
  const fetchCell = (async (_url: string, init: RequestInit) => {
    const bearer = new Headers(init.headers).get("authorization")!.slice("Bearer ".length);
    const access = await findCloudOAuthAccessToken(digestSecret(bearer), RESOURCE);
    if (!access) return Response.json({ error: "ACCESS_TOKEN_INVALID" }, { status: 401 });
    const rawBody = String(init.body);
    const request = JSON.parse(rawBody);
    const call: CellCall = {
      tool: request.params.name,
      arguments: request.params.arguments,
      bearer,
      routedTenantId: access.tenantId,
      routedCellId: access.cellId,
      rawBody,
    };
    calls.push(call);
    const result = answer(call);
    if (result instanceof Response) return result;
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: { isError: false, structuredContent: result, content: [] },
    });
  }) as unknown as typeof fetch;
  return { fetchCell, calls };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function getLevels(who: Owner, fetchCell: typeof fetch): Promise<Response> {
  return handleCloudHomeLevelsRequest(browserRequest(who, "GET", "/api/exomem/cloud/home/levels"), {
    fetchCell,
    env: ENV,
  });
}

async function putLevel(who: Owner, fetchCell: typeof fetch, body: unknown): Promise<Response> {
  return handleCloudHomeLevelsRequest(
    browserRequest(who, "PUT", "/api/exomem/cloud/home/levels", body),
    { fetchCell, env: ENV }
  );
}

async function startExport(who: Owner, body: unknown = {}): Promise<Response> {
  return handleCloudExportsRequest(browserRequest(who, "POST", "/api/exomem/cloud/exports", body), {
    env: ENV,
  });
}

async function requestLink(who: Owner, exportId: string, linkWaitMs = 300): Promise<Response> {
  return handleCloudExportLinkRequest(
    browserRequest(who, "POST", `/api/exomem/cloud/exports/${exportId}/link`),
    exportId,
    { env: ENV, linkWaitMs }
  );
}

/** What cellctl writes when it finishes packing (its own columns only). */
async function markReady(exportId: string, hours = 24): Promise<void> {
  await pool.query(
    `UPDATE exomem_cloud_exports
     SET observed_state = 'ready', archive_bytes = 2048, archive_sha256 = $2,
         ready_at = now(), expires_at = now() + make_interval(hours => $3)
     WHERE export_id = $1`,
    [exportId, "b".repeat(64), hours]
  );
}

describe("Cloud Home channel and exports PostgreSQL boundary", { skip: !databaseUrl }, () => {
  before(async () => {
    await ensureExomemPostgresTestExtensions(databaseUrl!);
    schema = `cloud_home_it_${randomUUID().replaceAll("-", "")}`;
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

  describe("Home channel", () => {
    it("mints a token that the gateway routes only to the session's own cell, for 120 seconds", async () => {
      const alice = await owner();
      const bob = await owner();
      const cell = fakeCell(() => ({ revision: "r1", levels: LEVELS }));

      assert.equal((await getLevels(alice, cell.fetchCell)).status, 200);
      assert.equal((await getLevels(bob, cell.fetchCell)).status, 200);

      const [aliceCall, bobCall] = cell.calls;
      assert.equal(aliceCall!.routedTenantId, alice.tenantId);
      assert.equal(aliceCall!.routedCellId, alice.cellId);
      assert.equal(bobCall!.routedCellId, bob.cellId);
      assert.notEqual(aliceCall!.bearer, bobCall!.bearer);
      // The request names no tenant or cell; the gateway routes from the token alone.
      assert.equal(aliceCall!.rawBody.includes(alice.tenantId), false);
      assert.equal(aliceCall!.rawBody.includes(alice.cellId), false);
      const { rows } = await pool.query(
        `SELECT token.scopes, token.resource, client.first_party,
                extract(epoch FROM token.expires_at - token.created_at)::integer AS lifetime_seconds
         FROM exomem_oauth_access_tokens AS token
         JOIN exomem_oauth_clients AS client ON client.id = token.client_id
         WHERE token.access_digest = $1`,
        [digestSecret(aliceCall!.bearer)]
      );
      assert.deepEqual(rows[0].scopes, ["exomem.read", "exomem.write"]);
      assert.equal(rows[0].resource, RESOURCE);
      assert.equal(rows[0].lifetime_seconds, 120);
      assert.equal(rows[0].first_party, true);
    });

    it("lets the gateway refuse a Home token minted before an account block or a started deletion", async () => {
      const blocked = await owner();
      const deleting = await owner();
      const cell = fakeCell(() => ({ revision: "r1", levels: LEVELS }));
      await getLevels(blocked, cell.fetchCell);
      await getLevels(deleting, cell.fetchCell);
      const [blockedCall, deletingCall] = cell.calls;

      await revokeOAuthAccountForOwnerTenantAtomic({
        ownerUserId: blocked.userId,
        tenantId: blocked.tenantId,
      });
      await pool.query("UPDATE exomem_tenants SET status = 'deletion_pending' WHERE id = $1", [
        deleting.tenantId,
      ]);

      assert.equal(
        await findCloudOAuthAccessToken(digestSecret(blockedCall!.bearer), RESOURCE),
        null
      );
      assert.equal(
        await findCloudOAuthAccessToken(digestSecret(deletingCall!.bearer), RESOURCE),
        null
      );
    });

    it("replaces a Home grant left by a reviewer credential the session no longer carries", async () => {
      const alice = await owner();
      const credential = await pool.query(
        `INSERT INTO exomem_marketplace_reviewer_credentials (
           provider, username_digest, password_hash, owner_user_id, tenant_id, fixture_version,
           fixture_payload_digest, created_by_principal_digest, expires_at, credential_kind
         ) VALUES ('anthropic', $1, '$argon2id$test', $2, $3, 'sample-v1', $4, $5,
                   now() + interval '1 day', 'cloud_provider_review') RETURNING id`,
        [
          digestSecret(randomUUID()),
          alice.userId,
          alice.tenantId,
          "a".repeat(64),
          digestSecret(randomUUID()),
        ]
      );
      const old = await pool.query(
        `INSERT INTO exomem_oauth_grants (user_id, tenant_id, client_id, resource, scopes, reviewer_credential_id)
         SELECT $1, $2, id, $3, ARRAY['exomem.read', 'exomem.write'], $4
         FROM exomem_oauth_clients WHERE first_party RETURNING id`,
        [alice.userId, alice.tenantId, RESOURCE, credential.rows[0].id]
      );
      const cell = fakeCell(() => ({ revision: "r1", levels: LEVELS }));

      assert.equal((await getLevels(alice, cell.fetchCell)).status, 200);
      assert.equal(cell.calls[0]!.routedCellId, alice.cellId);
      const retired = await pool.query("SELECT revoked_at FROM exomem_oauth_grants WHERE id = $1", [
        old.rows[0].id,
      ]);
      assert.notEqual(retired.rows[0].revoked_at, null);
    });

    it("answers a stopped or starting cell as unavailable without minting a token or calling it", async () => {
      const stopped = await owner({ desired: "stopped" });
      const starting = await owner({ ready: false });
      const cell = fakeCell(() => assert.fail("a cell that cannot answer must not be called"));

      assert.deepEqual(await json(await getLevels(stopped, cell.fetchCell)), {
        state: "unavailable",
        reason: "CELL_STOPPED",
      });
      const live = await handleCloudHomeLiveRequest(
        browserRequest(starting, "GET", "/api/exomem/cloud/home/live"),
        { fetchCell: cell.fetchCell, env: ENV }
      );
      assert.deepEqual(await json(live), { state: "unavailable", reason: "CELL_NOT_READY" });
      const minted = await pool.query(
        `SELECT count(*)::integer AS tokens FROM exomem_oauth_access_tokens AS token
         JOIN exomem_oauth_grants AS oauth_grant ON oauth_grant.id = token.grant_id
         WHERE oauth_grant.tenant_id = ANY($1::uuid[])`,
        [[stopped.tenantId, starting.tenantId]]
      );
      assert.equal(minted.rows[0].tokens, 0);
    });

    it("writes a level with the revision it read, and answers a stale revision with the current levels", async () => {
      const alice = await owner();
      let stored = { revision: "r1", conversation: "balanced" };
      const cell = fakeCell((call) => {
        const args = call.arguments as Record<string, string>;
        if (args.action === "set") {
          if (args.expected_revision !== stored.revision) {
            return { success: false, error: { code: "PREFERENCE_CONFLICT" } };
          }
          stored = { revision: "r2", conversation: args.prominence! };
        }
        return {
          revision: stored.revision,
          levels: {
            ...LEVELS,
            conversation: { level: stored.conversation, source: "preference:context" },
          },
        };
      });

      const written = await putLevel(alice, cell.fetchCell, {
        context: "conversation",
        level: "light",
        expected_revision: "r1",
      });
      assert.equal(written.status, 200);
      const view = await json(written);
      assert.equal(view.revision, "r2");
      assert.deepEqual((view.levels as typeof LEVELS).conversation, {
        level: "light",
        source: "preference:context",
      });
      assert.deepEqual(cell.calls[0]!.arguments, {
        action: "set",
        prominence: "light",
        expected_revision: "r1",
        context: "conversation",
      });

      const stale = await putLevel(alice, cell.fetchCell, {
        context: "conversation",
        level: "off",
        expected_revision: "r1",
      });
      assert.equal(stale.status, 409);
      const refusal = await json(stale);
      assert.equal((refusal.error as { code: string }).code, "PREFERENCE_CONFLICT");
      assert.equal((refusal.current as { revision: string }).revision, "r2");
    });

    it("refuses a level write on a read-only cell before calling the cell, and shows the switch locked", async () => {
      const alice = await owner({ desired: "read_only" });
      const cell = fakeCell(() => ({ revision: "r1", levels: LEVELS }));

      const shown = await json(await getLevels(alice, cell.fetchCell));
      assert.equal(shown.writable, false);
      assert.equal(shown.locked_by, "read_only");
      const refused = await putLevel(alice, cell.fetchCell, {
        context: "coding",
        level: null,
        expected_revision: "r1",
      });
      assert.equal(refused.status, 409);
      assert.equal(((await json(refused)).error as { code: string }).code, "CLOUD_CELL_READ_ONLY");
      assert.deepEqual(
        cell.calls.map((call) => call.arguments.action),
        ["inspect", "inspect"]
      );
    });

    it("shows an operator override as locked and passes its refusal on as 409", async () => {
      const alice = await owner();
      const cell = fakeCell((call) =>
        call.arguments.action === "set"
          ? { success: false, error: { code: "PREFERENCE_OPERATOR_OVERRIDE" } }
          : {
              revision: "r1",
              levels: {
                coding: { level: "off", source: "env" },
                conversation: { level: "off", source: "env" },
              },
            }
      );
      const shown = await json(await getLevels(alice, cell.fetchCell));
      assert.equal(shown.locked_by, "operator");
      const refused = await putLevel(alice, cell.fetchCell, {
        context: "coding",
        level: "maximal",
        expected_revision: "r1",
      });
      assert.equal(refused.status, 409);
      assert.equal(
        ((await json(refused)).error as { code: string }).code,
        "PREFERENCE_OPERATOR_OVERRIDE"
      );
    });

    it("passes on only the content-free activity fields, and keeps a zero note count", async () => {
      const alice = await owner();
      const cell = fakeCell(() => ({
        contract_version: "1",
        section: "activity",
        activity: {
          since: "2026-10-12T08:00:00Z",
          as_of: "2026-10-12T09:00:00Z",
          note_count: 0,
          events: [
            {
              client: "claude",
              action: "recalled",
              items: 5,
              at: "2026-10-12T08:59:30Z",
              query: "a private question",
            },
          ],
        },
      }));
      const response = await handleCloudHomeLiveRequest(
        browserRequest(alice, "GET", "/api/exomem/cloud/home/live"),
        { fetchCell: cell.fetchCell, env: ENV }
      );
      assert.deepEqual(await json(response), {
        state: "live",
        since: "2026-10-12T08:00:00Z",
        as_of: "2026-10-12T09:00:00Z",
        note_count: 0,
        events: [{ client: "claude", action: "recalled", items: 5, at: "2026-10-12T08:59:30Z" }],
      });
      assert.deepEqual(cell.calls[0]!.arguments, { profile: "compact", section: "activity" });
    });

    it("reports an older image as outdated and an unanswered call as unreachable, never as empty", async () => {
      const alice = await owner();
      const olderImage = fakeCell((call) =>
        call.tool === "bootstrap"
          ? Response.json({
              jsonrpc: "2.0",
              id: JSON.parse(call.rawBody).id,
              result: { isError: true, content: [{ type: "text", text: "unknown section" }] },
            })
          : { revision: "r1" }
      );
      const live = await handleCloudHomeLiveRequest(
        browserRequest(alice, "GET", "/api/exomem/cloud/home/live"),
        { fetchCell: olderImage.fetchCell, env: ENV }
      );
      assert.deepEqual(await json(live), { state: "unavailable", reason: "CELL_OUTDATED" });
      assert.deepEqual(await json(await getLevels(alice, olderImage.fetchCell)), {
        state: "unavailable",
        reason: "CELL_OUTDATED",
      });

      const silent = (async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }) as unknown as typeof fetch;
      assert.deepEqual(await json(await getLevels(alice, silent)), {
        state: "unavailable",
        reason: "CELL_UNREACHABLE",
      });
      const refusedWrite = await putLevel(alice, silent, {
        context: "coding",
        level: "light",
        expected_revision: "r1",
      });
      assert.equal(refusedWrite.status, 503);
    });

    it("keeps the first-party client out of client slots and out of browser authorization", async () => {
      const home = await pool.query(
        "SELECT client_id, first_party, enabled FROM exomem_oauth_clients WHERE first_party"
      );
      assert.deepEqual(home.rows, [
        { client_id: "exomem-cloud-home", first_party: true, enabled: true },
      ]);
      assert.equal(await resolveApprovedCloudOAuthClient("exomem-cloud-home"), null);
      const cli = await pool.query(
        "SELECT client_name FROM exomem_oauth_clients WHERE client_id = 'exomem-cloud-cli'"
      );
      assert.equal(cli.rows[0].client_name, "Exomem CLI");

      // Fill the operator partition to its last free slot; the Home client is not counted.
      const counted = await pool.query(
        "SELECT count(*)::integer AS used FROM exomem_oauth_clients WHERE NOT auto_registered AND admission_mode <> 'generic' AND NOT first_party"
      );
      for (let index = counted.rows[0].used; index < 95; index += 1) {
        await pool.query(
          `INSERT INTO exomem_oauth_clients (client_id, admission_mode, redirect_uris, redirect_uris_digest)
           VALUES ($1, 'pinned', '["http://127.0.0.1/cb"]'::jsonb,
                   digest(convert_to('["http://127.0.0.1/cb"]'::jsonb::text, 'utf8'), 'sha256'))`,
          [`operator-slot-${index}`]
        );
      }
      const last = await pool.query(
        "SELECT exomem_oauth_client_partition_available('one-more-operator-client', false) AS free"
      );
      assert.equal(last.rows[0].free, true);
    });

    it("is absent while its release flag is off", async () => {
      const alice = await owner();
      const response = await handleCloudHomeLevelsRequest(
        browserRequest(alice, "GET", "/api/exomem/cloud/home/levels"),
        { env: { ...ENV, EXOMEM_CLOUD_HOME_CHANNEL_ENABLED: undefined } }
      );
      assert.equal(response.status, 404);
    });
  });

  describe("exports", () => {
    it("hides one tenant's export and its link from another tenant", async () => {
      const alice = await owner();
      const bob = await owner();
      const started = await json(await startExport(alice));
      const exportId = (started.export as { export_id: string }).export_id;
      await markReady(exportId);

      assert.equal((await requestLink(bob, exportId)).status, 404);
      const bobsView = await handleCloudExportsRequest(
        browserRequest(bob, "GET", "/api/exomem/cloud/exports"),
        { env: ENV }
      );
      assert.equal(((await json(bobsView)).export as { state: string }).state, "none");
      const untouched = await pool.query(
        "SELECT link_requested_at FROM exomem_cloud_exports WHERE export_id = $1",
        [exportId]
      );
      assert.equal(untouched.rows[0].link_requested_at, null);
    });

    it("answers a retry of the same export id with that export, and refuses a second one while packing", async () => {
      const alice = await owner();
      const exportId = randomUUID();
      const first = await startExport(alice, { export_id: exportId });
      assert.equal(first.status, 201);
      const retry = await startExport(alice, { export_id: exportId });
      assert.equal(retry.status, 200);
      assert.equal(((await json(retry)).export as { export_id: string }).export_id, exportId);
      const second = await startExport(alice);
      assert.equal(second.status, 409);
      assert.equal(((await json(second)).error as { code: string }).code, "EXPORT_IN_PROGRESS");
    });

    it("supersedes a ready export only together with starting the next one", async () => {
      const alice = await owner();
      const bob = await owner();
      const ready = (await json(await startExport(alice))).export as { export_id: string };
      await markReady(ready.export_id);
      const bobs = (await json(await startExport(bob))).export as { export_id: string };

      // The insert fails on an id another tenant holds: the supersede must roll back with it.
      const clash = await startExport(alice, { export_id: bobs.export_id });
      assert.equal(clash.status, 409);
      const kept = await pool.query(
        "SELECT requested_state FROM exomem_cloud_exports WHERE export_id = $1",
        [ready.export_id]
      );
      assert.equal(kept.rows[0].requested_state, "requested");

      const next = await startExport(alice);
      assert.equal(next.status, 201);
      assert.equal(((await json(next)).export as { state: string }).state, "packing");
      const replaced = await pool.query(
        "SELECT requested_state FROM exomem_cloud_exports WHERE export_id = $1",
        [ready.export_id]
      );
      assert.equal(replaced.rows[0].requested_state, "superseded");
      assert.equal((await requestLink(alice, ready.export_id)).status, 410);
    });

    it("refuses a cell that never ran, and lets a stopped cell that ran export without a pause", async () => {
      const neverRan = await owner({ desired: "stopped", image: null });
      const refused = await startExport(neverRan);
      assert.equal(refused.status, 409);
      assert.equal(((await json(refused)).error as { code: string }).code, "EXPORT_NO_DATA");

      const suspended = await owner({ desired: "stopped" });
      const started = await startExport(suspended);
      assert.equal(started.status, 201);
      assert.equal(
        ((await json(started)).export as { pauses_assistants: boolean }).pauses_assistants,
        false
      );
      const running = await owner();
      const runningExport = (await json(await startExport(running))).export as {
        pauses_assistants: boolean;
      };
      assert.equal(runningExport.pauses_assistants, true);
    });

    it("refuses an export once the cell's deletion has begun", async () => {
      const alice = await owner();
      await pool.query(
        "UPDATE exomem_cloud_cells SET desired_state = 'deleted' WHERE cell_id = $1",
        [alice.cellId]
      );
      const refused = await startExport(alice);
      assert.equal(refused.status, 403);
      assert.equal(((await json(refused)).error as { code: string }).code, "EXPORT_UNAVAILABLE");
    });

    it("refuses a fourth export within 24 hours", async () => {
      const alice = await owner();
      for (let index = 0; index < 3; index += 1) {
        const started = await startExport(alice);
        assert.equal(started.status, 201);
        const id = ((await json(started)).export as { export_id: string }).export_id;
        await pool.query(
          "UPDATE exomem_cloud_exports SET observed_state = 'failed', error_code = 'EXPORT_FAILED' WHERE export_id = $1",
          [id]
        );
      }
      const fourth = await startExport(alice);
      assert.equal(fourth.status, 429);
      assert.ok(((await json(fourth)).error as { retryAfterMs?: number }).retryAfterMs! > 0);
    });

    it("waits for the controller's link: pending when it is late, then only a link issued for this request", async () => {
      const alice = await owner();
      const id = ((await json(await startExport(alice))).export as { export_id: string }).export_id;
      await markReady(id);
      // A link the controller issued for an earlier request is never handed out again.
      await pool.query(
        `UPDATE exomem_cloud_exports
         SET download_url = 'https://objects.example.test/old', download_url_expires_at = now() + interval '5 minutes',
             link_issued_at = now() - interval '1 minute', link_requested_at = now() - interval '2 minutes'
         WHERE export_id = $1`,
        [id]
      );

      const pending = await requestLink(alice, id);
      assert.equal(pending.status, 202);
      assert.deepEqual(await json(pending), { state: "pending" });
      assert.equal(pending.headers.get("cache-control"), "private, no-store, max-age=0");
      assert.equal(pending.headers.get("referrer-policy"), "no-referrer");

      // The controller answers the next request while it waits, as cellctl writes it.
      const firstRequest = await pool.query(
        "SELECT link_requested_at::text AS requested FROM exomem_cloud_exports WHERE export_id = $1",
        [id]
      );
      const answering = (async () => {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const { rowCount } = await pool.query(
            `UPDATE exomem_cloud_exports
             SET download_url = 'https://objects.example.test/fresh',
                 download_url_expires_at = now() + interval '5 minutes',
                 link_issued_at = GREATEST(clock_timestamp(), COALESCE(link_requested_at, '-infinity'))
             WHERE export_id = $1 AND link_requested_at > $2::timestamptz`,
            [id, firstRequest.rows[0].requested]
          );
          if (rowCount) return;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      })();
      const issued = await requestLink(alice, id, 4_000);
      await answering;
      assert.equal(issued.status, 200);
      const link = await json(issued);
      assert.equal(link.url, "https://objects.example.test/fresh");
      assert.ok(Date.parse(link.url_expires_at as string) > Date.now());
      assert.equal(issued.headers.get("referrer-policy"), "no-referrer");
    });

    it("answers 410 for a link to an export past its expiry", async () => {
      const alice = await owner();
      const id = ((await json(await startExport(alice))).export as { export_id: string }).export_id;
      await markReady(id);
      await pool.query(
        "UPDATE exomem_cloud_exports SET ready_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE export_id = $1",
        [id]
      );
      const gone = await requestLink(alice, id);
      assert.equal(gone.status, 410);
      assert.equal(((await json(gone)).error as { code: string }).code, "EXPORT_EXPIRED");
    });
  });

  describe("storage", () => {
    it("reports measured storage when cellctl has reported it, unknown before, and refuses an impossible report", async () => {
      const alice = await owner();
      assert.deepEqual((await getOwnerCloudHomeStatus(alice.tenantId)).storage, {
        state: "unknown",
      });

      await pool.query(
        "UPDATE exomem_cloud_cells SET used_bytes = 1288490189, filesystem_bytes = 10737418240, usage_observed_at = '2026-10-12T03:00:00Z' WHERE cell_id = $1",
        [alice.cellId]
      );
      assert.deepEqual((await getOwnerCloudHomeStatus(alice.tenantId)).storage, {
        state: "known",
        used_bytes: 1288490189,
        filesystem_bytes: 10737418240,
        observed_at: "2026-10-12T03:00:00.000Z",
      });
      await assert.rejects(
        pool.query(
          "UPDATE exomem_cloud_cells SET used_bytes = 11, filesystem_bytes = 10 WHERE cell_id = $1",
          [alice.cellId]
        ),
        /exomem_cloud_cells_usage_check/
      );
    });
  });
});
