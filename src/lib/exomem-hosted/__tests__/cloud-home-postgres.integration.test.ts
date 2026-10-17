import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { randomCloudCellId } from "../cloud-admission";
import { handleCloudExportLinkRequest, handleCloudExportsRequest } from "../cloud-exports";
import { handleCloudHomeLevelsRequest, handleCloudHomeLiveRequest } from "../cloud-home-mcp";
import { handleCloudViewerRequest } from "../cloud-viewer";
import { findCloudOAuthAccessToken, resolveApprovedCloudOAuthClient } from "../cloud-oauth";
import { getOwnerCloudHomeStatus } from "../cloud-status";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
import { revokeOAuthAccountForOwnerTenantAtomic } from "../oauth-store";
import { digestSecret, generateExternalToken } from "../security";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";
import { handleCloudStorage } from "../cloud-storage";
import { loadExomemPaddleConfig } from "../paddle-config";
import { EXOMEM_ALPHA_BUNDLE } from "../entitlements";
import { createSqlExomemPaddleEventStore } from "../paddle-event-store";
import { dispatchVerifiedExomemPaddleEvent } from "../paddle-webhook";

// The Home channel and the export API against real PostgreSQL. The cell's
// HTTP answer is substituted at the gateway boundary (`fetchCell`); the
// gateway's own token lookup runs for real on every substituted call.

// The export link's per-account rate limit keys its bucket with this key.
process.env.EXOMEM_CONTROL_PLANE_KEY ??= randomBytes(32).toString("base64url");

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
  firstParty: boolean;
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
      firstParty: access.firstParty,
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

/** Substitute only the billing provider; owner, operation and capacity writes use PostgreSQL. */
async function storageFixture() {
  const who = await owner();
  const subscriptionId = `sub_${randomUUID().replaceAll("-", "").slice(0, 26)}`;
  const customerId = `ctm_${randomUUID().replaceAll("-", "").slice(0, 26)}`;
  const basePrice = `pri_${"a".repeat(26)}`;
  const storagePrice = `pri_${"b".repeat(26)}`;
  const otherPrice = `pri_${"c".repeat(26)}`;
  const productId = `pro_${"d".repeat(26)}`;
  const env = {
    PADDLE_ENVIRONMENT: "sandbox",
    PADDLE_API_KEY: "pdl_sdbx_apikey_fixture",
    PADDLE_WEBHOOK_SECRET: "fixture-webhook",
    EXOMEM_PADDLE_PRODUCT_ID: productId,
    EXOMEM_PADDLE_PRICE_ID: basePrice,
  };
  const current = {
    id: subscriptionId,
    customer_id: customerId,
    status: "active",
    updated_at: "2026-01-01T00:00:00Z",
    currency_code: "EUR",
    billing_cycle: { interval: "month", frequency: 1 },
    collection_mode: "automatic",
    scheduled_change: null,
    custom_data: {
      user_id: who.userId,
      tenant_id: who.tenantId,
      product_key: "exomem-hosted",
    } as Record<string, unknown>,
    items: [
      { price: { id: basePrice, product_id: productId }, quantity: 1 },
      { price: { id: otherPrice, product_id: "pro_other" }, quantity: 3 },
    ],
  };
  await pool.query(
    `INSERT INTO exomem_entitlements(tenant_id,source,source_state,effective_state,resource_limits,provider_environment,provider_customer_ref,provider_subscription_ref)
     VALUES($1,'paddle','active','active',$2,'sandbox',$3,$4)`,
    [who.tenantId, EXOMEM_ALPHA_BUNDLE.resourceLimits, customerId, subscriptionId]
  );
  await pool.query(
    `UPDATE exomem_cloud_cells SET observed_storage_pvc_uid='claim-original',observed_storage_pvc_version='1',
     observed_storage_capacity_bytes=10737418240,observed_storage_generation=generation,observed_storage_at=now() WHERE cell_id=$1`,
    [who.cellId]
  );
  const billing = {
    calls: 0,
    loseResponse: false,
    decline: false,
    paid: true,
    cardReady: false,
    due: "198",
    actualDue: "197",
  };
  const cardId = `txn_${"e".repeat(26)}`;
  const paymentId = `txn_${"f".repeat(26)}`;
  let charged: { items: typeof current.items; custom_data: typeof current.custom_data } | null =
    null;
  const transport = async (path: string, init?: RequestInit) => {
    if (path === `/prices/${storagePrice}`)
      return Response.json({
        data: {
          id: storagePrice,
          product_id: `pro_${"b".repeat(26)}`,
          status: "active",
          billing_cycle: { interval: "month", frequency: 1 },
          trial_period: null,
          tax_mode: "location",
          quantity: { minimum: 1, maximum: 100 },
          custom_data: { exomem_storage_bytes: 10_000_000_000, exomem_storage_packs: [1, 5, 10] },
        },
      });
    if (path === `/subscriptions/${subscriptionId}/preview`)
      return Response.json({
        data: {
          currency_code: "EUR",
          next_billed_at: "2026-02-01T00:00:00Z",
          consent_requirements: [],
          immediate_transaction:
            billing.due === "0"
              ? null
              : {
                  details: {
                    totals: { grand_total: billing.due, tax: "38", currency_code: "EUR" },
                  },
                },
          recurring_transaction_details: { totals: { grand_total: "1200", currency_code: "EUR" } },
        },
      });
    if (path === `/subscriptions/${subscriptionId}/update-payment-method-transaction`)
      return Response.json({
        data: {
          id: cardId,
          customer_id: customerId,
          subscription_id: subscriptionId,
          origin: "subscription_payment_method_change",
          status: "ready",
        },
      });
    if (path === `/transactions/${cardId}`)
      return Response.json({
        data: {
          id: cardId,
          customer_id: customerId,
          subscription_id: subscriptionId,
          origin: "subscription_payment_method_change",
          status: billing.cardReady ? "completed" : "ready",
        },
      });
    if (path.startsWith("/transactions?"))
      return Response.json({
        data:
          billing.paid && charged
            ? [
                {
                  id: paymentId,
                  customer_id: customerId,
                  subscription_id: subscriptionId,
                  origin: "subscription_update",
                  status: "completed",
                  custom_data: charged.custom_data,
                  items: charged.items,
                  details: {
                    totals: { grand_total: billing.actualDue, tax: "37", currency_code: "EUR" },
                  },
                },
              ]
            : [],
        meta: { pagination: { has_more: false } },
      });
    if (path === `/subscriptions/${subscriptionId}` && init?.method === "PATCH") {
      billing.calls += 1;
      const body = JSON.parse(String(init.body));
      assert.equal(body.proration_billing_mode, "prorated_immediately");
      assert.equal(body.on_payment_failure, "prevent_change");
      if (billing.decline)
        return Response.json({ error: { code: "subscription_payment_declined" } }, { status: 400 });
      current.items = body.items.map((item: { price_id: string; quantity: number }) => ({
        price: {
          id: item.price_id,
          product_id: item.price_id === basePrice ? productId : "pro_other",
        },
        quantity: item.quantity,
      }));
      current.custom_data = body.custom_data;
      charged = structuredClone({ items: current.items, custom_data: current.custom_data });
      current.updated_at = "2026-01-01T00:01:00Z";
      if (billing.loseResponse) throw new TypeError("provider response lost");
      return Response.json({ data: current });
    }
    if (path === `/subscriptions/${subscriptionId}`) return Response.json({ data: current });
    throw new Error(`Unexpected provider endpoint: ${path}`);
  };
  const deps = { config: loadExomemPaddleConfig(env), priceId: storagePrice, transport };
  const call = (
    request:
      | { action: "inspect" }
      | { action: "preview"; quantity: number }
      | { action: "confirm" | "status" | "payment-method"; operationId: string }
  ) =>
    handleCloudStorage(
      who.userId,
      who.tenantId,
      request.action === "inspect" ? request : { ...request, tenantBinding: who.tenantId },
      deps
    );
  return { who, deps, call, billing, current, basePrice, otherPrice, storagePrice, env };
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

  describe("Manual storage", () => {
    it("preserves existing items and waits for matching claim capacity and generation after payment", async () => {
      const f = await storageFixture();
      const inspected = await f.call({ action: "inspect" });
      assert.equal(
        inspected.packs?.find((pack) => pack.quantity === 1)?.targetBytes,
        20 * 1024 ** 3
      );
      const preview = (await f.call({ action: "preview", quantity: 1 })).operation!;
      const confirmed = (await f.call({ action: "confirm", operationId: preview.id })).operation!;
      assert.equal(confirmed.state, "paid");
      assert.equal(confirmed.quote.due.amount, "197");
      assert.equal(f.billing.calls, 1);
      assert.equal(f.current.items.find((x) => x.price.id === f.otherPrice)?.quantity, 3);
      assert.equal(f.current.items.find((x) => x.price.id === f.basePrice)?.quantity, 1);
      const row = (
        await pool.query("SELECT * FROM exomem_cloud_cells WHERE cell_id=$1", [f.who.cellId])
      ).rows[0];
      assert.equal(row.storage_gib, 20);
      assert.equal(
        (await f.call({ action: "status", operationId: preview.id })).operation!.state,
        "paid"
      );
      await pool.query(
        "UPDATE exomem_cloud_cells SET observed_storage_capacity_bytes=21474836480,observed_storage_generation=generation,observed_storage_pvc_uid='different-claim',observed_storage_at=now() WHERE cell_id=$1",
        [f.who.cellId]
      );
      assert.equal(
        (await f.call({ action: "status", operationId: preview.id })).operation!.state,
        "paid"
      );
      await pool.query(
        "UPDATE exomem_cloud_cells SET observed_storage_pvc_uid='claim-original',observed_storage_generation=generation-1 WHERE cell_id=$1",
        [f.who.cellId]
      );
      assert.equal(
        (await f.call({ action: "status", operationId: preview.id })).operation!.state,
        "paid"
      );
      await pool.query(
        "UPDATE exomem_cloud_cells SET observed_storage_generation=generation WHERE cell_id=$1",
        [f.who.cellId]
      );
      assert.equal(
        (await f.call({ action: "status", operationId: preview.id })).operation!.state,
        "applied"
      );
      const event = await dispatchVerifiedExomemPaddleEvent(
        {
          event_id: `evt_${"g".repeat(26)}`,
          event_type: "subscription.updated",
          occurred_at: new Date().toISOString(),
          data: f.current,
        },
        {
          env: f.env,
          store: createSqlExomemPaddleEventStore(taggedSql(pool)),
          cloudHook: async () => {},
        }
      );
      assert.deepEqual(event, { kind: "handled", outcome: "applied" });
      const entitlement = (
        await pool.query(
          "SELECT paid_storage_bytes,resource_limits FROM exomem_entitlements WHERE tenant_id=$1",
          [f.who.tenantId]
        )
      ).rows[0];
      assert.equal(Number(entitlement.paid_storage_bytes), 10_000_000_000);
      assert.equal(
        entitlement.resource_limits.storageBytes,
        EXOMEM_ALPHA_BUNDLE.resourceLimits.storageBytes + 10_000_000_000
      );
    });

    it("does not repeat a charge after concurrent confirmation and a lost provider response", async () => {
      const f = await storageFixture();
      f.billing.loseResponse = true;
      const preview = (await f.call({ action: "preview", quantity: 1 })).operation!;
      await Promise.all([
        f.call({ action: "confirm", operationId: preview.id }),
        f.call({ action: "confirm", operationId: preview.id }),
      ]);
      assert.equal(f.billing.calls, 1);
      assert.equal(
        (await f.call({ action: "status", operationId: preview.id })).operation!.state,
        "paid"
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM exomem_cloud_storage_operations WHERE tenant_id=$1",
            [f.who.tenantId]
          )
        ).rows[0].count,
        "1"
      );
    });

    it("recovers paid storage after a friend conversion changes the base item", async () => {
      const f = await storageFixture();
      f.billing.loseResponse = true;
      const preview = (await f.call({ action: "preview", quantity: 1 })).operation!;
      assert.equal(
        (await f.call({ action: "confirm", operationId: preview.id })).operation!.state,
        "unknown"
      );
      f.current.items.find((item) => item.price.id === f.basePrice)!.price.id =
        `pri_${"h".repeat(26)}`;

      assert.equal(
        (await f.call({ action: "status", operationId: preview.id })).operation!.state,
        "paid"
      );
      assert.equal(f.billing.calls, 1);
    });

    it("recovers a zero-due confirmation after a nonzero preview and lost response", async () => {
      const f = await storageFixture();
      const preview = (await f.call({ action: "preview", quantity: 1 })).operation!;
      f.billing.due = "0";
      f.billing.paid = false;
      f.billing.loseResponse = true;
      assert.equal(
        (await f.call({ action: "confirm", operationId: preview.id })).operation!.state,
        "unknown"
      );

      const recovered = (await f.call({ action: "status", operationId: preview.id })).operation!;
      assert.equal(recovered.state, "paid");
      assert.equal(recovered.quote.due.amount, "0");
      assert.equal(f.billing.calls, 1);
    });

    it("refuses a higher quote before submitting a provider update", async () => {
      const f = await storageFixture();
      const preview = (await f.call({ action: "preview", quantity: 1 })).operation!;
      f.billing.due = "250";
      assert.equal(
        (await f.call({ action: "confirm", operationId: preview.id })).operation!.state,
        "failed"
      );
      assert.equal(f.billing.calls, 0);
    });

    it("does not let another owner inspect or confirm an operation", async () => {
      const f = await storageFixture();
      const other = await storageFixture();
      const preview = (await f.call({ action: "preview", quantity: 1 })).operation!;
      await assert.rejects(other.call({ action: "confirm", operationId: preview.id }), {
        status: 403,
      });
      assert.equal(f.billing.calls + other.billing.calls, 0);
    });

    it("requires provider card recovery and a fresh priced confirmation after a decline", async () => {
      const f = await storageFixture();
      f.billing.decline = true;
      const preview = (await f.call({ action: "preview", quantity: 1 })).operation!;
      assert.equal(
        (await f.call({ action: "confirm", operationId: preview.id })).operation!.state,
        "payment_required"
      );
      const recovery = (await f.call({ action: "payment-method", operationId: preview.id }))
        .operation!;
      assert.ok(recovery.recoveryTransactionId);
      await assert.rejects(f.call({ action: "preview", quantity: 1 }), {
        code: "STORAGE_CONFLICT",
      });
      assert.equal(
        (
          await pool.query("SELECT storage_gib FROM exomem_cloud_cells WHERE cell_id=$1", [
            f.who.cellId,
          ])
        ).rows[0].storage_gib,
        10
      );
      f.billing.cardReady = true;
      f.billing.decline = false;
      const retry = (await f.call({ action: "preview", quantity: 1 })).operation!;
      assert.notEqual(retry.id, preview.id);
      assert.equal(
        (await f.call({ action: "confirm", operationId: retry.id })).operation!.state,
        "paid"
      );
      assert.equal(f.billing.calls, 2);
    });
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
      assert.equal(aliceCall!.firstParty, true);
      // The request names no tenant or cell; the gateway routes from the token alone.
      assert.equal(aliceCall!.rawBody.includes(alice.tenantId), false);
      assert.equal(aliceCall!.rawBody.includes(alice.cellId), false);
      const { rows } = await pool.query(
        `SELECT token.scopes, token.resource, client.admission_mode,
                extract(epoch FROM token.expires_at - token.created_at)::integer AS lifetime_seconds
         FROM exomem_oauth_access_tokens AS token
         JOIN exomem_oauth_clients AS client ON client.id = token.client_id
         WHERE token.access_digest = $1`,
        [digestSecret(aliceCall!.bearer)]
      );
      assert.deepEqual(rows[0].scopes, ["exomem.read", "exomem.write"]);
      assert.equal(rows[0].resource, RESOURCE);
      assert.equal(rows[0].lifetime_seconds, 120);
      assert.equal(rows[0].admission_mode, "first_party");
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
         FROM exomem_oauth_clients WHERE admission_mode = 'first_party' RETURNING id`,
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

    it("retires a Home grant that an interactive authorization wrote before the mint reuses it", async () => {
      // What a browser authorization and code exchange write for a client: a
      // grant, a family and a 900-second access token, plus a refresh token
      // when the app asked for offline access.
      async function interactiveLineage(
        who: Owner,
        lineage: { refreshAllowed: boolean; accessIssuedSecondsAgo: number }
      ): Promise<{ grantId: string; access: string }> {
        const access = generateExternalToken();
        const { rows } = await pool.query(
          `WITH oauth_grant AS (
             INSERT INTO exomem_oauth_grants (user_id, tenant_id, client_id, resource, scopes, refresh_allowed)
             SELECT $1, $2, id, $3, ARRAY['exomem.read', 'exomem.write'], $4
             FROM exomem_oauth_clients WHERE admission_mode = 'first_party'
             RETURNING id, client_id
           ), family AS (
             INSERT INTO exomem_oauth_token_families (grant_id, client_id, expires_at)
             SELECT id, client_id, now() + interval '30 days' FROM oauth_grant
             RETURNING id, grant_id, client_id
           ), refresh AS (
             INSERT INTO exomem_oauth_refresh_tokens (refresh_digest, family_id, expires_at)
             SELECT $5, id, now() + interval '30 days' FROM family WHERE $4
           )
           INSERT INTO exomem_oauth_access_tokens (
             access_digest, grant_id, family_id, client_id, resource, scopes, created_at, expires_at
           )
           SELECT $6, grant_id, id, client_id, $3, ARRAY['exomem.read', 'exomem.write'],
                  now() - make_interval(secs => $7), now() - make_interval(secs => $7) + interval '900 seconds'
           FROM family
           RETURNING grant_id`,
          [
            who.userId,
            who.tenantId,
            RESOURCE,
            lineage.refreshAllowed,
            digestSecret(randomUUID()),
            digestSecret(access),
            lineage.accessIssuedSecondsAgo,
          ]
        );
        return { grantId: rows[0].grant_id, access };
      }
      // A refreshable lineage whose access token has expired, and one without
      // refresh whose access token still has minutes left.
      const refreshable = await owner();
      const live = await owner();
      const refreshableLineage = await interactiveLineage(refreshable, {
        refreshAllowed: true,
        accessIssuedSecondsAgo: 1200,
      });
      const liveLineage = await interactiveLineage(live, {
        refreshAllowed: false,
        accessIssuedSecondsAgo: 60,
      });
      assert.ok(await findCloudOAuthAccessToken(digestSecret(liveLineage.access), RESOURCE));
      const cell = fakeCell(() => ({ revision: "r1", levels: LEVELS }));

      assert.equal((await getLevels(refreshable, cell.fetchCell)).status, 200);
      assert.equal((await getLevels(live, cell.fetchCell)).status, 200);

      assert.equal(
        await findCloudOAuthAccessToken(digestSecret(liveLineage.access), RESOURCE),
        null
      );
      for (const [index, retired] of [refreshableLineage, liveLineage].entries()) {
        const minted = await findCloudOAuthAccessToken(
          digestSecret(cell.calls[index]!.bearer),
          RESOURCE
        );
        assert.notEqual(minted!.grantId, retired.grantId);
        const grant = await pool.query("SELECT revoked_at FROM exomem_oauth_grants WHERE id = $1", [
          retired.grantId,
        ]);
        assert.notEqual(grant.rows[0].revoked_at, null);
      }
    });

    it("answers unavailable, not an error, while an operator has disabled the Home client", async () => {
      const alice = await owner();
      const cell = fakeCell(() => assert.fail("no token exists to call the cell with"));
      await pool.query(
        "UPDATE exomem_oauth_clients SET enabled = false WHERE admission_mode = 'first_party'"
      );
      try {
        const levels = await getLevels(alice, cell.fetchCell);
        assert.equal(levels.status, 200);
        assert.deepEqual(await json(levels), {
          state: "unavailable",
          reason: "HOME_CLIENT_DISABLED",
        });
        const live = await handleCloudHomeLiveRequest(
          browserRequest(alice, "GET", "/api/exomem/cloud/home/live"),
          { fetchCell: cell.fetchCell, env: ENV }
        );
        assert.deepEqual(await json(live), {
          state: "unavailable",
          reason: "HOME_CLIENT_DISABLED",
        });
      } finally {
        await pool.query(
          "UPDATE exomem_oauth_clients SET enabled = true WHERE admission_mode = 'first_party'"
        );
      }
    });

    it("answers unavailable, not an error, when an OAuth block lands while Home is calling", async () => {
      const alice = await owner();
      // The session lookup refuses a blocked account, so the block lands in
      // the window after the session and cell checks, before the mint.
      __setExomemSqlForTests(async (strings, ...values) => {
        const result = await taggedSql(pool)(strings, ...values);
        if (strings.join("").includes("exomem-cloud:home-serving-cell")) {
          await revokeOAuthAccountForOwnerTenantAtomic({
            ownerUserId: alice.userId,
            tenantId: alice.tenantId,
          });
        }
        return result;
      });
      const cell = fakeCell(() => assert.fail("a blocked account gets no token to call with"));
      try {
        const levels = await getLevels(alice, cell.fetchCell);
        assert.equal(levels.status, 200);
        assert.deepEqual(await json(levels), {
          state: "unavailable",
          reason: "ACCOUNT_ACCESS_CLOSED",
        });
      } finally {
        __setExomemSqlForTests(taggedSql(pool));
      }
      const minted = await pool.query(
        `SELECT count(*)::integer AS tokens FROM exomem_oauth_access_tokens AS token
         JOIN exomem_oauth_grants AS oauth_grant ON oauth_grant.id = token.grant_id
         WHERE oauth_grant.tenant_id = $1`,
        [alice.tenantId]
      );
      assert.equal(minted.rows[0].tokens, 0);
    });

    it("answers unavailable, not an error, when the account's deletion begins while Home is calling", async () => {
      const alice = await owner();
      // The deletion commits after the session and cell checks, before the
      // mint, as one transaction: the tenant and its cell change together.
      __setExomemSqlForTests(async (strings, ...values) => {
        const result = await taggedSql(pool)(strings, ...values);
        if (strings.join("").includes("exomem-cloud:home-serving-cell")) {
          const deletion = await pool.connect();
          try {
            await deletion.query("BEGIN");
            await deletion.query(
              "UPDATE exomem_tenants SET status = 'deletion_pending', desired_state = 'deleted' WHERE id = $1",
              [alice.tenantId]
            );
            await deletion.query(
              "UPDATE exomem_cloud_cells SET desired_state = 'deleted' WHERE cell_id = $1",
              [alice.cellId]
            );
            await deletion.query("COMMIT");
          } finally {
            deletion.release();
          }
        }
        return result;
      });
      const cell = fakeCell(() => assert.fail("a deleting account gets no token to call with"));
      try {
        const levels = await getLevels(alice, cell.fetchCell);
        assert.equal(levels.status, 200);
        assert.deepEqual(await json(levels), {
          state: "unavailable",
          reason: "ACCOUNT_ACCESS_CLOSED",
        });
      } finally {
        __setExomemSqlForTests(taggedSql(pool));
      }
      assert.equal(cell.calls.length, 0);
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
      assert.equal(
        cell.calls.some((call) => call.arguments.action !== "inspect"),
        false,
        "a read-only cell receives no level write"
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

    it("passes only content-free activity and valid actor IDs, and keeps a zero note count", async () => {
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
              app_id: "00000000-0000-4000-8000-000000000001",
              client: "claude-ai",
              action: "recalled",
              items: 5,
              at: "2026-10-12T08:59:30Z",
              query: "a private question",
            },
            {
              app_id: "a private actor label",
              client: "private note: an example recovery phrase",
              action: "saved",
              items: 1,
              at: "2026-10-12T08:59:00Z",
            },
            { client: "codex", action: "recalled", items: 1, at: "2026-10-12T08:58:00Z" },
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
        events: [
          {
            app_id: "00000000-0000-4000-8000-000000000001",
            client: "claude-ai",
            action: "recalled",
            items: 5,
            at: "2026-10-12T08:59:30Z",
          },
          // Not a client family, so possibly content: it arrives as an unknown client.
          { app_id: null, client: null, action: "saved", items: 1, at: "2026-10-12T08:59:00Z" },
          { client: "codex", action: "recalled", items: 1, at: "2026-10-12T08:58:00Z" },
        ],
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
        "SELECT client_id, enabled FROM exomem_oauth_clients WHERE admission_mode = 'first_party'"
      );
      assert.deepEqual(home.rows, [{ client_id: "exomem-cloud-home", enabled: true }]);
      assert.equal(await resolveApprovedCloudOAuthClient("exomem-cloud-home"), null);
      const cli = await pool.query(
        "SELECT client_name FROM exomem_oauth_clients WHERE client_id = 'exomem-cloud-cli'"
      );
      assert.equal(cli.rows[0].client_name, "Exomem CLI");

      // Fill the operator partition to its last free slot; the Home client is not counted.
      const counted = await pool.query(
        "SELECT count(*)::integer AS used FROM exomem_oauth_clients WHERE NOT auto_registered AND admission_mode IN ('pinned', 'cimd')"
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

    it("stops migration 0066 when an ordinary client already holds the Home client id", async () => {
      const migrationRoot = await mkdtemp(join(tmpdir(), "cloud-home-seed-"));
      const upgradeSchema = `cloud_home_seed_${randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ connectionString: databaseUrl });
      let upgrade: Pool | undefined;
      try {
        for (const file of await readdir("migrations")) {
          if (file.endsWith(".sql") && file < "0066")
            await cp(join("migrations", file), join(migrationRoot, file));
        }
        await admin.query(`CREATE SCHEMA "${upgradeSchema}"`);
        const url = new URL(databaseUrl!);
        url.searchParams.set("options", `-c search_path=${upgradeSchema},public`);
        await applyMigrations({ databaseUrl: url.toString(), migrationsDir: migrationRoot });
        upgrade = new Pool({ connectionString: url.toString() });
        await upgrade.query(
          `INSERT INTO exomem_oauth_clients (client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest, client_name)
           VALUES ('exomem-cloud-home', 'pinned', true, '["http://127.0.0.1/callback"]'::jsonb,
                   digest(convert_to('["http://127.0.0.1/callback"]'::jsonb::text, 'utf8'), 'sha256'),
                   'Legacy tool')`
        );
        await cp(
          "migrations/0066_exomem_cloud_home_and_exports.sql",
          join(migrationRoot, "0066_exomem_cloud_home_and_exports.sql")
        );

        await assert.rejects(
          applyMigrations({ databaseUrl: url.toString(), migrationsDir: migrationRoot }),
          /exomem-cloud-home belongs to an ordinary OAuth client/
        );
        const kept = await upgrade.query(
          "SELECT admission_mode, enabled, client_name FROM exomem_oauth_clients WHERE client_id = 'exomem-cloud-home'"
        );
        assert.deepEqual(kept.rows, [
          { admission_mode: "pinned", enabled: true, client_name: "Legacy tool" },
        ]);
        const recorded = await upgrade.query(
          "SELECT count(*)::integer AS applied FROM schema_migrations WHERE version LIKE '0066%'"
        );
        assert.equal(recorded.rows[0].applied, 0);
      } finally {
        await upgrade?.end();
        await admin.query(`DROP SCHEMA IF EXISTS "${upgradeSchema}" CASCADE`);
        await admin.end();
        await rm(migrationRoot, { recursive: true, force: true });
      }
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

  describe("viewer", () => {
    const viewerEnv = { ...ENV, EXOMEM_CLOUD_VIEWER_ENABLED: "true" };
    const emptyMap = {
      state: "complete",
      available: true,
      reason: null,
      snapshot: null,
      observed_at: "2026-10-15T00:00:00Z",
      nodes: [],
      edges: [],
      vocabulary: [],
      counts: {
        eligible_nodes: 0,
        eligible_edges: 0,
        observed_nodes: 0,
        observed_edges: 0,
        drawn_nodes: 0,
        drawn_edges: 0,
      },
      ranking_complete: true,
      truncation: [],
    };

    it("binds the fixed map operation to the session's actual tenant", async () => {
      const alice = await owner();
      const bob = await owner();
      const relation = { instance: "registry-a", definition_key: "vault.checks" };
      const populatedMap = {
        ...emptyMap,
        nodes: ["source", "target"].map((key) => ({
          node_key: `file:${key}.md`,
          kind: "file",
          path: `${key}.md`,
          title: key,
          source_hash: key,
          incoming_edges: key === "target" ? 1 : 0,
          memory_ref: null,
          page_type: "insight",
          origin_date: "2026-09-01",
          updated_date: null,
        })),
        edges: [
          {
            edge_key: "edge-a",
            src_key: "file:source.md",
            dst_key: "file:target.md",
            relation_type: "vault.checks",
            source_path: "source.md",
            relation_identity: relation,
          },
        ],
        vocabulary: [
          {
            ...relation,
            description: "Checks the target",
            family: "testing",
            direction: "directed",
            presentation_role: "future_renderer_role",
          },
        ],
        counts: {
          eligible_nodes: 2,
          eligible_edges: 1,
          observed_nodes: 2,
          observed_edges: 1,
          drawn_nodes: 2,
          drawn_edges: 1,
        },
      };
      const cell = fakeCell(() => populatedMap);
      const response = await handleCloudViewerRequest(
        browserRequest(alice, "POST", "/api/exomem/cloud/viewer/map", {}),
        "map",
        { fetchCell: cell.fetchCell, env: viewerEnv }
      );
      assert.equal(response.status, 200);
      assert.match(response.headers.get("cache-control")!, /no-store/);
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.deepEqual(await json(response), {
        tenantId: alice.tenantId,
        state: "live",
        value: populatedMap,
      });
      assert.equal(cell.calls[0]!.routedTenantId, alice.tenantId);
      assert.notEqual(cell.calls[0]!.routedTenantId, bob.tenantId);
      assert.equal(cell.calls[0]!.firstParty, true);
      assert.equal(cell.calls[0]!.tool, "viewer_map");
      assert.deepEqual(cell.calls[0]!.arguments, { max_nodes: 200, max_edges: 400 });
    });

    it("refuses a changed tenant binding before minting a token or contacting a cell", async () => {
      const alice = await owner();
      const bob = await owner();
      const cell = fakeCell(() => emptyMap);
      const response = await handleCloudViewerRequest(
        browserRequest(alice, "POST", "/api/exomem/cloud/viewer/map", { tenantId: bob.tenantId }),
        "map",
        { fetchCell: cell.fetchCell, env: viewerEnv }
      );
      assert.equal(response.status, 403);
      assert.equal(cell.calls.length, 0);
      const tokens = await pool.query(
        "SELECT count(*)::int AS total FROM exomem_oauth_access_tokens AS token JOIN exomem_oauth_grants AS grant_row ON grant_row.id=token.grant_id WHERE grant_row.tenant_id=$1",
        [alice.tenantId]
      );
      assert.equal(tokens.rows[0].total, 0);
    });

    it("retains Origin and CSRF checks and refuses browser-selected tools", async () => {
      const alice = await owner();
      const cell = fakeCell(() => emptyMap);
      for (const kind of ["origin", "csrf", "tool"] as const) {
        const request = browserRequest(
          alice,
          "POST",
          "/api/exomem/cloud/viewer/map",
          kind === "tool" ? { tool: "remember" } : {}
        );
        if (kind === "origin") request.headers.set("origin", "https://foreign.example.test");
        if (kind === "csrf") request.headers.delete("x-exomem-csrf");
        const response = await handleCloudViewerRequest(request, "map", {
          fetchCell: cell.fetchCell,
          env: viewerEnv,
        });
        assert.equal(response.status, kind === "tool" ? 400 : 403);
      }
      assert.equal(cell.calls.length, 0);
    });

    it("uses assistant retrieval and returns only the declared search fields", async () => {
      const alice = await owner();
      const hit = {
        path: "Knowledge Base/Notes/example.md",
        title: "Example",
        ref: "exomem://memory/00000000-0000-4000-8000-000000000001",
      };
      const cell = fakeCell(() => ({
        result: {
          hits: [hit],
          continuation: "next-page",
          warming: { components: ["vector"], since_s: null },
          due_state: { unrelated: "not a search result" },
        },
      }));
      const response = await handleCloudViewerRequest(
        browserRequest(alice, "POST", "/api/exomem/cloud/viewer/search", {
          tenantId: alice.tenantId,
          query: "release plan",
          continuation: "previous-page",
        }),
        "search",
        { fetchCell: cell.fetchCell, env: viewerEnv }
      );
      assert.equal(response.status, 200);
      assert.deepEqual((await json(response)).value, {
        hits: [hit],
        continuation: "next-page",
        partial: true,
      });
      assert.equal(cell.calls[0]!.tool, "ask_memory");
      assert.deepEqual(cell.calls[0]!.arguments, {
        query: "release plan",
        limit: 20,
        detail: "compact",
        deep: false,
        graph_enrich: false,
        continuation: "previous-page",
      });
    });

    it("opens page and semantic-unit results from the actual MCP list shape", async () => {
      const alice = await owner();
      const cell = fakeCell(() => ({
        result: [
          { path: "Notes/example.md", title: "Example" },
          {
            result_type: "semantic_unit",
            parent_path: "Notes/other.md",
            parent_title: "Other note",
            parent_ref: "exomem://memory/00000000-0000-4000-8000-000000000002",
            excerpt: "A specific finding.",
          },
        ],
      }));
      const response = await handleCloudViewerRequest(
        browserRequest(alice, "POST", "/api/exomem/cloud/viewer/search", {
          tenantId: alice.tenantId,
          query: "finding",
        }),
        "search",
        { fetchCell: cell.fetchCell, env: viewerEnv }
      );
      assert.equal(response.status, 200);
      assert.deepEqual((await json(response)).value, {
        hits: [
          { path: "Notes/example.md", title: "Example" },
          {
            path: "Notes/other.md",
            title: "Other note",
            ref: "exomem://memory/00000000-0000-4000-8000-000000000002",
            excerpt: "A specific finding.",
          },
        ],
        continuation: null,
        partial: false,
      });
    });

    it("reads the chosen reference through the same owner-bound channel", async () => {
      const alice = await owner();
      const note = {
        path: "Knowledge Base/Notes/example.md",
        body: "# Example\n\nA note.",
        frontmatter: { title: "Example" },
        content_hash: "example-hash",
        ref: null,
      };
      const cell = fakeCell(() => note);
      const response = await handleCloudViewerRequest(
        browserRequest(alice, "POST", "/api/exomem/cloud/viewer/read", {
          tenantId: alice.tenantId,
          ref: note.path,
        }),
        "read",
        { fetchCell: cell.fetchCell, env: viewerEnv }
      );
      assert.equal(response.status, 200);
      assert.deepEqual((await json(response)).value, note);
      assert.equal(cell.calls[0]!.routedTenantId, alice.tenantId);
      assert.equal(cell.calls[0]!.tool, "read_memory");
      assert.deepEqual(cell.calls[0]!.arguments, {
        path: note.path,
        links: true,
        include_raw: false,
      });
    });

    it("preserves partial totals and never reports an unavailable map as empty", async () => {
      const alice = await owner();
      let answer = {
        ...emptyMap,
        state: "partial",
        ranking_complete: false,
        counts: { ...emptyMap.counts, eligible_nodes: null, eligible_edges: null },
      };
      const cell = fakeCell(() => answer);
      const call = () =>
        handleCloudViewerRequest(
          browserRequest(alice, "POST", "/api/exomem/cloud/viewer/map", {}),
          "map",
          { fetchCell: cell.fetchCell, env: viewerEnv }
        );
      const partial = await call();
      assert.equal(partial.status, 200);
      assert.deepEqual((await json(partial)).value, answer);
      answer = { ...answer, state: "unavailable", available: false };
      const unavailable = await call();
      assert.equal(unavailable.status, 503);
      assert.deepEqual(await json(unavailable), { tenantId: alice.tenantId, state: "unavailable" });
    });

    it("rejects a dangling edge before it can crash graph placement", async () => {
      const alice = await owner();
      const cell = fakeCell(() => ({
        ...emptyMap,
        edges: [
          {
            edge_key: "edge-a",
            src_key: "file:missing.md",
            dst_key: "file:other.md",
            relation_type: "links_to",
            source_path: "missing.md",
            relation_identity: { instance: "core", definition_key: "links_to" },
          },
        ],
        counts: { ...emptyMap.counts, eligible_edges: 1, observed_edges: 1, drawn_edges: 1 },
      }));
      const response = await handleCloudViewerRequest(
        browserRequest(alice, "POST", "/api/exomem/cloud/viewer/map", {}),
        "map",
        { fetchCell: cell.fetchCell, env: viewerEnv }
      );
      assert.equal(response.status, 503);
      assert.deepEqual(await json(response), { tenantId: alice.tenantId, state: "unavailable" });
    });

    it("cancels an oversized cell answer instead of returning truncated content", async () => {
      const alice = await owner();
      let cancelled = false;
      const cell = fakeCell(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(1024 * 1024 + 1));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { "content-type": "application/json" } }
          )
      );
      const response = await handleCloudViewerRequest(
        browserRequest(alice, "POST", "/api/exomem/cloud/viewer/read", {
          tenantId: alice.tenantId,
          ref: "Knowledge Base/Notes/example.md",
        }),
        "read",
        { fetchCell: cell.fetchCell, env: viewerEnv }
      );
      assert.equal(response.status, 503);
      assert.equal(cancelled, true);
      assert.deepEqual(await json(response), { tenantId: alice.tenantId, state: "unavailable" });
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

    it("never hands out the link of an export that failed while the request waited", async () => {
      const alice = await owner();
      const id = ((await json(await startExport(alice))).export as { export_id: string }).export_id;
      await markReady(id);
      // cellctl reports a failure and still leaves a link and its issue time.
      const failing = (async () => {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const { rowCount } = await pool.query(
            `UPDATE exomem_cloud_exports
             SET observed_state = 'failed', error_code = 'EXPORT_FAILED',
                 download_url = 'https://objects.example.test/failed-export',
                 download_url_expires_at = now() + interval '5 minutes',
                 link_issued_at = GREATEST(clock_timestamp(), link_requested_at)
             WHERE export_id = $1 AND link_requested_at IS NOT NULL`,
            [id]
          );
          if (rowCount) return;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      })();
      const refused = await requestLink(alice, id, 4_000);
      await failing;
      assert.equal(refused.status, 409);
      assert.equal(((await json(refused)).error as { code: string }).code, "EXPORT_NOT_READY");
    });

    for (const [problem, url, lifetime] of [
      ["is not https", "http://objects.example.test/archive", "5 minutes"],
      ["lasts longer than five minutes", "https://objects.example.test/archive", "1 day"],
    ] as const) {
      it(`refuses a controller link that ${problem}, and never shows it`, async () => {
        const alice = await owner();
        const id = ((await json(await startExport(alice))).export as { export_id: string })
          .export_id;
        await markReady(id);
        const answering = (async () => {
          for (let attempt = 0; attempt < 40; attempt += 1) {
            const { rowCount } = await pool.query(
              `UPDATE exomem_cloud_exports
             SET download_url = $2,
                 download_url_expires_at = now() + $3::interval,
                 link_issued_at = GREATEST(clock_timestamp(), link_requested_at)
             WHERE export_id = $1 AND link_requested_at IS NOT NULL`,
              [id, url, lifetime]
            );
            if (rowCount) return;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        })();
        const refused = await requestLink(alice, id, 4_000);
        await answering;
        assert.equal(refused.status, 502);
        const body = await refused.text();
        assert.equal(JSON.parse(body).error.code, "EXPORT_LINK_INVALID");
        assert.equal(body.includes("objects.example.test"), false);
      });
    }

    it("answers 410 for a link to an export past its expiry, and shows when it expired", async () => {
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
      // Home says when the export was deleted.
      const shown = await handleCloudExportsRequest(
        browserRequest(alice, "GET", "/api/exomem/cloud/exports"),
        { env: ENV }
      );
      const expiredExport = (await json(shown)).export as { state: string; expires_at: string };
      assert.equal(expiredExport.state, "expired");
      const stored = await pool.query(
        "SELECT expires_at FROM exomem_cloud_exports WHERE export_id = $1",
        [id]
      );
      assert.equal(expiredExport.expires_at, stored.rows[0].expires_at.toISOString());
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
