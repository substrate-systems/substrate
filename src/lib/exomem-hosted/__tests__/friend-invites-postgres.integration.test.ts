import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { friendPriceOffered, friendPriceUnchecked } from "../../../app/exomem/invite/invite-view";
import { loadExomemAccountView } from "../account-view";
import { resumeReturnedOwnerCheckout, startOwnerCheckout } from "../billing-account";
import { redeemCloudInvite, redeemCloudInviteAtomic } from "../cloud-admission";
import { reconcileCloudCellDesiredState, runBoundedCloudReconcile } from "../cloud-lifecycle";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
import { drainExomemEmailOutbox } from "../email-outbox";
import { ExomemHostedError } from "../errors";
import { decideInvitation, issueOperatorInvite, type InvitationInspection } from "../invites";
import { __clearExomemPriceCacheForTests } from "../paddle-billing";
import { loadExomemPaddleConfig } from "../paddle-config";
import { createSqlExomemPaddleEventStore } from "../paddle-event-store";
import { reconcileExomemPaddleSubscription } from "../paddle-reconciliation";
import { dispatchVerifiedExomemPaddleEvent, type CloudPaddleHook } from "../paddle-webhook";
import { decryptSecret, tokenDigest, type SecretEnvelope } from "../security";
import { mintSessionMaterial } from "../sessions";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

// Friend invitations, the friend price and resubscribe, against real
// PostgreSQL. Paddle is substituted at its HTTP boundary (global fetch), so
// every Paddle call the product makes is the one these tests see.

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
let pool: Pool | undefined;
let schema: string | undefined;

const PRODUCT = `pro_${"p".repeat(26)}`;
const BASE_PRICE = `pri_${"b".repeat(26)}`;
const STORAGE_PRICE = `pri_${"s".repeat(26)}`;
const FRIEND_DISCOUNT = `dsc_${"f".repeat(26)}`;
const PUBLIC_BASE_URL = "https://substratesystems.io";
const DAY_MS = 24 * 60 * 60 * 1000;

const ENV: Record<string, string> = {
  EXOMEM_CONTROL_PLANE_KEY: randomBytes(32).toString("base64url"),
  PADDLE_ENVIRONMENT: "sandbox",
  PADDLE_API_KEY: "pdl_sdbx_apikey_example",
  PADDLE_WEBHOOK_SECRET: "pdl_ntfset_example",
  NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "test_client_token",
  NEXT_PUBLIC_PADDLE_ENVIRONMENT: "sandbox",
  EXOMEM_PADDLE_PRODUCT_ID: PRODUCT,
  EXOMEM_PADDLE_PRICE_ID: BASE_PRICE,
  EXOMEM_PADDLE_FRIEND_DISCOUNT_ID: FRIEND_DISCOUNT,
  EXOMEM_PUBLIC_BASE_URL: PUBLIC_BASE_URL,
};
const priorEnv: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

type PaddleCall = { method: string; path: string; body: Record<string, unknown> | null };

// The fake Paddle: one valid friend discount unless a test changes it, and
// €15 usual / €10 friend prices.
const paddle = {
  calls: [] as PaddleCall[],
  discount: {} as Record<string, unknown>,
  subscriptionUpdateFails: false,
  // Holds Paddle's answer, so two requests overlap while one waits on it.
  subscriptionUpdateDelayMs: 0,
  // Paddle applies a subscription update, but its answer never arrives.
  subscriptionUpdateAnswerLost: false,
  // Paddle's transaction API is unreachable.
  transactionsDown: false,
  // Paddle's transaction API answers nothing until the caller gives up.
  transactionsHang: false,
  // Paddle's subscription API is unreachable.
  subscriptionsDown: false,
  // Runs while Paddle answers a transaction read, as a concurrent request would.
  duringTransactionRead: null as null | (() => Promise<void>),
  // Runs while Paddle answers a subscription update, as a concurrent request would.
  duringSubscriptionUpdate: null as null | (() => Promise<void>),
  transactions: new Map<string, Record<string, unknown>>(),
  subscriptions: new Map<string, Record<string, unknown>>(),
};

function validDiscount(): Record<string, unknown> {
  return {
    id: FRIEND_DISCOUNT,
    status: "active",
    recur: true,
    maximum_recurring_intervals: null,
    code: null,
    enabled_for_checkout: false,
    restrict_to: [BASE_PRICE],
    type: "flat",
    amount: "500",
    currency_code: "EUR",
  };
}

async function fakePaddle(url: string, init?: RequestInit): Promise<Response> {
  const { pathname } = new URL(url);
  const method = init?.method ?? "GET";
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
  paddle.calls.push({ method, path: pathname, body });
  if (method === "GET" && pathname === `/discounts/${FRIEND_DISCOUNT}`) {
    return Response.json({ data: paddle.discount });
  }
  if (method === "POST" && pathname === "/pricing-preview") {
    const discounted = body?.discount_id === FRIEND_DISCOUNT;
    return Response.json({
      data: {
        currency_code: "EUR",
        details: {
          line_items: [
            {
              price: { id: BASE_PRICE },
              totals: { total: discounted ? "1000" : "1500" },
              discounts: discounted ? [{ discount: { id: FRIEND_DISCOUNT } }] : [],
            },
          ],
        },
      },
    });
  }
  if (method === "GET" && pathname.startsWith("/subscriptions/")) {
    if (paddle.subscriptionsDown) return new Response("{}", { status: 503 });
    const subscription = paddle.subscriptions.get(pathname.split("/")[2]!);
    if (!subscription) return new Response("{}", { status: 404 });
    if (new URL(url).searchParams.get("include") !== "next_transaction") {
      return Response.json({ data: subscription });
    }
    // Paddle previews the next transaction with the subscription's own discount.
    const friend = (subscription.discount as { id?: string } | null)?.id === FRIEND_DISCOUNT;
    const totals = { grand_total: friend ? "1000" : "1500", currency_code: "EUR" };
    return Response.json({
      data: {
        ...subscription,
        next_transaction: subscription.status === "active" ? { details: { totals } } : null,
      },
    });
  }
  if (method === "PATCH" && pathname.startsWith("/subscriptions/")) {
    await new Promise((resolve) => setTimeout(resolve, paddle.subscriptionUpdateDelayMs));
    if (paddle.duringSubscriptionUpdate) await paddle.duringSubscriptionUpdate();
    if (paddle.subscriptionUpdateFails) return new Response("{}", { status: 500 });
    const subscription = paddle.subscriptions.get(pathname.split("/")[2]!);
    const discount = body?.discount as { id: string } | undefined;
    if (subscription && discount) subscription.discount = { id: discount.id };
    if (paddle.subscriptionUpdateAnswerLost) return new Response("{}", { status: 504 });
    return Response.json({
      data: { id: pathname.split("/")[2], next_billed_at: "2026-11-12T09:00:00Z" },
    });
  }
  if (paddle.transactionsHang && pathname.startsWith("/transactions")) {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }
  if (paddle.transactionsDown && pathname.startsWith("/transactions")) {
    return new Response("{}", { status: 503 });
  }
  if (method === "PATCH" && pathname.startsWith("/transactions/")) {
    const transaction = paddle.transactions.get(pathname.split("/")[2]!);
    if (!transaction) return new Response("{}", { status: 404 });
    if (body?.status === "canceled") transaction.status = "canceled";
    return Response.json({ data: transaction });
  }
  if (method === "POST" && pathname === "/transactions") {
    const id = `txn_${randomUUID().replaceAll("-", "").slice(0, 26)}`;
    const transaction = {
      id,
      status: "draft",
      discount_id: body?.discount_id ?? null,
      customer_id: body?.customer_id ?? null,
      custom_data: body?.custom_data,
      items: [{ price: { id: BASE_PRICE, product_id: PRODUCT } }],
      checkout: { url: `${PUBLIC_BASE_URL}/exomem/home?_ptxn=${id}` },
    };
    paddle.transactions.set(id, transaction);
    return Response.json({ data: transaction });
  }
  if (method === "GET" && pathname.startsWith("/transactions/")) {
    if (paddle.duringTransactionRead) await paddle.duringTransactionRead();
    const transaction = paddle.transactions.get(pathname.split("/")[2]!);
    return transaction ? Response.json({ data: transaction }) : new Response("{}", { status: 404 });
  }
  return new Response("{}", { status: 404 });
}

function paddleId(prefix: "sub" | "ctm" | "txn"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 26)}`;
}

/** A subscription as Paddle reports it for an owner. */
function subscriptionAtPaddle(input: {
  id: string;
  status: "active" | "canceled";
  customerId: string;
  owner: { userId: string; tenantId: string };
  updatedAt: Date;
}): Record<string, unknown> {
  return {
    id: input.id,
    status: input.status,
    customer_id: input.customerId,
    updated_at: input.updatedAt.toISOString(),
    next_billed_at: input.status === "active" ? "2026-11-12T09:00:00Z" : null,
    discount: null,
    items: [{ price: { id: BASE_PRICE, product_id: PRODUCT, name: "Exomem · monthly" } }],
    custom_data: {
      product_key: "exomem-hosted",
      user_id: input.owner.userId,
      tenant_id: input.owner.tenantId,
    },
  };
}

/** Paddle's subscription event for an owner's subscription, as the webhook delivers it. */
function subscriptionEvent(
  owner: { subscriptionRef: string },
  input: { occurredAt: Date; discountId: string | null; cloudHook?: CloudPaddleHook }
) {
  return dispatchVerifiedExomemPaddleEvent(
    {
      event_id: `evt_${randomUUID().replaceAll("-", "")}`,
      event_type: "subscription.updated",
      occurred_at: input.occurredAt.toISOString(),
      environment: "sandbox",
      data: {
        ...paddle.subscriptions.get(owner.subscriptionRef),
        discount: input.discountId ? { id: input.discountId } : null,
      },
    },
    {
      env: ENV,
      store: createSqlExomemPaddleEventStore(taggedSql(pool!)),
      ...(input.cloudHook ? { cloudHook: input.cloudHook } : {}),
    }
  );
}

function paddleCalls(method: string, prefix: string): PaddleCall[] {
  return paddle.calls.filter((call) => call.method === method && call.path.startsWith(prefix));
}

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

function newAddress(label: string): string {
  return `${label}-${randomUUID()}@example.test`;
}

async function issueFriendInvitation(input: {
  email: string;
  inviterEmail?: string;
  expiresAt?: Date;
}): Promise<{ inviteId: string; token: string }> {
  const { inviteId } = await issueOperatorInvite({
    email: input.email,
    kind: "friend",
    inviterName: "Alex Example",
    inviterEmail: input.inviterEmail ?? null,
    inviteeName: "Sam Example",
    note: "This is what I have been building.",
    expiresAt: input.expiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    operatorPrincipalDigest: randomBytes(32),
  });
  return { inviteId, token: await tokenFromInvitationEmail(inviteId) };
}

/** The token exists only in the encrypted invitation email, as it would reach the invitee. */
async function tokenFromInvitationEmail(inviteId: string): Promise<string> {
  const { rows } = await pool!.query<{ payload_ciphertext: SecretEnvelope }>(
    "SELECT payload_ciphertext FROM exomem_email_outbox WHERE dedupe_key = $1",
    [`invite:${inviteId}`]
  );
  const payload = JSON.parse(decryptSecret(rows[0]!.payload_ciphertext).reveal()) as {
    token: string;
  };
  return payload.token;
}

async function insertCoveredInvitation(email: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await pool!.query(
    `INSERT INTO exomem_invites (
       token_digest, email_normalized, entitlement_source, entitlement_capabilities,
       entitlement_limits, created_by_principal_digest, expires_at, kind, inviter_name
     ) VALUES ($1, $2, 'complimentary', '["capture","recall"]'::jsonb, '{}'::jsonb, $3,
               now() + interval '7 days', 'covered', 'Alex Example')`,
    [tokenDigest(token), email, randomBytes(32)]
  );
  return token;
}

async function insertStandardInvitation(email: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await pool!.query(
    `INSERT INTO exomem_invites (
       token_digest, email_normalized, entitlement_source, entitlement_capabilities,
       entitlement_limits, created_by_principal_digest, expires_at
     ) VALUES ($1, $2, 'paddle', '["capture","recall"]'::jsonb, '{}'::jsonb, $3,
               now() + interval '7 days')`,
    [tokenDigest(token), email, randomBytes(32)]
  );
  return token;
}

type Owner = { userId: string; tenantId: string; sessionId: string; cellId: string; email: string };

/** A paid owner admitted through a standard invitation, then set to a Paddle state. */
async function paidOwner(state: {
  sourceState: "active" | "cancelled";
  cell: "running" | "read_only";
  endedDaysAgo?: number;
  /** The price Paddle reported for the subscription; the base price unless a test says otherwise. */
  priceId?: string | null;
}): Promise<Owner & { customerRef: string; subscriptionRef: string; sessionToken: string }> {
  const email = newAddress("owner");
  const session = mintSessionMaterial();
  const admitted = await redeemCloudInviteAtomic({
    tokenDigest: tokenDigest(await insertStandardInvitation(email))!,
    sessionDigest: session.sessionDigest,
    csrfDigest: session.csrfDigest,
    sessionExpiresAt: session.expiresAt,
  });
  assert.ok(admitted, "sanity: the owner was admitted");
  const customerRef = paddleId("ctm");
  const subscriptionRef = paddleId("sub");
  // Paddle changed the subscription last at this time: its start, or its end.
  const occurredAt = new Date(Date.now() - (state.endedDaysAgo ?? 1) * DAY_MS);
  paddle.subscriptions.set(
    subscriptionRef,
    subscriptionAtPaddle({
      id: subscriptionRef,
      status: state.sourceState === "active" ? "active" : "canceled",
      customerId: customerRef,
      owner: admitted,
      updatedAt: occurredAt,
    })
  );
  // The subscription's last transaction, as Paddle knows it.
  const transactionRef = paddleId("txn");
  paddle.transactions.set(transactionRef, {
    id: transactionRef,
    status: "completed",
    subscription_id: subscriptionRef,
    customer_id: customerRef,
    custom_data: {
      product_key: "exomem-hosted",
      user_id: admitted.userId,
      tenant_id: admitted.tenantId,
    },
  });
  await pool!.query(
    `UPDATE exomem_entitlements
     SET source_state = $2, effective_state = $3, provider_environment = 'sandbox',
         provider_customer_ref = $4, provider_subscription_ref = $5,
         provider_transaction_ref = $6, source_revision = 'evt_seed',
         source_occurred_at = $7, provider_price_id = $8
     WHERE tenant_id = $1`,
    [
      admitted.tenantId,
      state.sourceState,
      state.sourceState === "active" ? "active" : "cancelled",
      customerRef,
      subscriptionRef,
      transactionRef,
      occurredAt.toISOString(),
      state.priceId === undefined ? BASE_PRICE : state.priceId,
    ]
  );
  await pool!.query("UPDATE exomem_cloud_cells SET desired_state = $2 WHERE cell_id = $1", [
    admitted.cellId,
    state.cell,
  ]);
  await pool!.query("UPDATE exomem_tenants SET status = 'active' WHERE id = $1", [
    admitted.tenantId,
  ]);
  return {
    ...admitted,
    email,
    customerRef,
    subscriptionRef,
    sessionToken: session.sessionToken,
  };
}

async function invitation(inviteId: string) {
  const { rows } = await pool!.query(
    `SELECT consumed_at, decision, kind FROM exomem_invites WHERE id = $1`,
    [inviteId]
  );
  return rows[0] as { consumed_at: Date | null; decision: string | null; kind: string };
}

async function friendOffer(tenantId: string): Promise<string | null> {
  const { rows } = await pool!.query<{ friend_offer_invite_id: string | null }>(
    "SELECT friend_offer_invite_id FROM exomem_tenants WHERE id = $1",
    [tenantId]
  );
  return rows[0]!.friend_offer_invite_id;
}

async function outboxRows(inviteId: string) {
  const { rows } = await pool!.query<{
    kind: string;
    recipient: string;
    not_before: Date;
    expires_at: Date | null;
    state: string;
  }>(
    `SELECT kind, recipient::text AS recipient, not_before, expires_at, state
     FROM exomem_email_outbox WHERE dedupe_key LIKE $1 ORDER BY kind`,
    [`invite%:${inviteId}`]
  );
  return rows;
}

function inspectRequest(token: string, input: { ip: string; cookie?: string }) {
  const headers = new Headers({
    "content-type": "application/json",
    host: "substratesystems.io",
    origin: "https://substratesystems.io",
    "x-forwarded-for": input.ip,
  });
  if (input.cookie) headers.set("cookie", input.cookie);
  return new Request("https://substratesystems.io/api/exomem/access/inspect", {
    method: "POST",
    headers,
    body: JSON.stringify({ token }),
  }) as unknown as import("next/server").NextRequest;
}

async function sessionCount(): Promise<number> {
  const { rows } = await pool!.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM exomem_sessions"
  );
  return rows[0]!.n;
}

/** An ended owner with an open resubscribe checkout, whose kept window then lapses. */
async function lapsedOwnerWithCheckout() {
  const owner = await paidOwner({ sourceState: "cancelled", cell: "read_only", endedDaysAgo: 29 });
  const { transactionId } = await startOwnerCheckout(owner.userId, owner.tenantId);
  await pool!.query(
    "UPDATE exomem_entitlements SET source_occurred_at = now() - interval '31 days' WHERE tenant_id = $1",
    [owner.tenantId]
  );
  return { ...owner, transactionId };
}

/** Paddle completes an owner's checkout for a new, live subscription, and sends no event. */
function paidAtPaddle(
  owner: { userId: string; tenantId: string; customerRef: string },
  transactionId: string
): string {
  const subscriptionId = paddleId("sub");
  Object.assign(paddle.transactions.get(transactionId)!, {
    status: "completed",
    subscription_id: subscriptionId,
    customer_id: owner.customerRef,
  });
  paddle.subscriptions.set(
    subscriptionId,
    subscriptionAtPaddle({
      id: subscriptionId,
      status: "active",
      customerId: owner.customerRef,
      owner,
      updatedAt: new Date(),
    })
  );
  return subscriptionId;
}

/** Every email the outbox sends now, draining until it sends no more. */
async function drainedEmails(): Promise<Array<{ to: string; subject: string; text: string }>> {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  for (let tick = 0; tick < 10; tick += 1) {
    const before = sent.length;
    await drainExomemEmailOutbox(
      {},
      {
        publicBaseUrl: PUBLIC_BASE_URL,
        sendEmail: async (message) => {
          sent.push({ to: message.to, subject: message.subject, text: message.textContent });
          return { success: true };
        },
      }
    );
    if (sent.length === before) break;
  }
  return sent;
}

function dayMonth(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "long" }).format(at);
}

async function lapsedCell(tenantId: string) {
  const { rows } = await pool!.query<{
    desired_state: string;
    provider_transaction_ref: string | null;
  }>(
    `SELECT cell.desired_state, entitlement.provider_transaction_ref
     FROM exomem_cloud_cells AS cell
     JOIN exomem_entitlements AS entitlement ON entitlement.tenant_id = cell.tenant_id
     WHERE cell.tenant_id = $1`,
    [tenantId]
  );
  return rows[0]!;
}

describe("Exomem friend invitations PostgreSQL integration", { skip: !databaseUrl }, () => {
  before(async () => {
    for (const [key, value] of Object.entries(ENV)) {
      priorEnv[key] = process.env[key];
      process.env[key] = value;
    }
    globalThis.fetch = (async (input: unknown, init?: RequestInit) =>
      fakePaddle(String(input), init)) as typeof fetch;
    schema = `friend_invites_it_${randomUUID().replaceAll("-", "")}`;
    await ensureExomemPostgresTestExtensions(databaseUrl!);
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);
    await applyMigrations({ databaseUrl: scoped.toString() });
    pool = new Pool({ connectionString: scoped.toString(), max: 20 });
    __setExomemSqlForTests(taggedSql(pool));
    __setExomemTransactionForTests(interactiveTransaction);
    await pool.query(
      "INSERT INTO exomem_cloud_capacity (node, cell_slots, observed_at) VALUES ('node-friends', 500, now())"
    );
  });

  after(async () => {
    globalThis.fetch = realFetch;
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

  beforeEach(async () => {
    paddle.calls = [];
    paddle.discount = validDiscount();
    paddle.subscriptionUpdateFails = false;
    paddle.subscriptionUpdateDelayMs = 0;
    paddle.subscriptionUpdateAnswerLost = false;
    paddle.transactionsDown = false;
    paddle.transactionsHang = false;
    paddle.subscriptionsDown = false;
    paddle.duringTransactionRead = null;
    paddle.duringSubscriptionUpdate = null;
    __clearExomemPriceCacheForTests();
    await pool!.query("UPDATE exomem_cloud_capacity SET observed_at = now()");
  });

  it("issues a friend invitation with Paddle's prices, its reminder three days before the end and the inviter's ended notice", async () => {
    const email = newAddress("invitee");
    const inviterEmail = newAddress("inviter");
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const { inviteId, token } = await issueFriendInvitation({ email, inviterEmail, expiresAt });

    const stored = await pool!.query(
      "SELECT kind, entitlement_source, inviter_name, inviter_email::text, invitee_name, note, token_digest FROM exomem_invites WHERE id = $1",
      [inviteId]
    );
    assert.deepEqual(stored.rows[0]!.token_digest, tokenDigest(token));
    assert.equal(stored.rows[0]!.kind, "friend");
    assert.equal(stored.rows[0]!.entitlement_source, "paddle");
    assert.equal(stored.rows[0]!.inviter_email, inviterEmail);

    const rows = await outboxRows(inviteId);
    assert.deepEqual(
      rows.map((row) => [row.kind, row.recipient]),
      [
        ["friend_invitation", email],
        ["invitation_ended", inviterEmail],
        ["invitation_reminder", email],
      ]
    );
    const reminder = rows.find((row) => row.kind === "invitation_reminder")!;
    assert.equal(reminder.not_before.getTime(), expiresAt.getTime() - 3 * 24 * 60 * 60 * 1000);
    assert.equal(reminder.expires_at?.getTime(), expiresAt.getTime());
    const ended = rows.find((row) => row.kind === "invitation_ended")!;
    assert.equal(ended.not_before.getTime(), expiresAt.getTime());

    const sent: Array<Record<string, unknown>> = [];
    await drainExomemEmailOutbox(
      {},
      {
        publicBaseUrl: PUBLIC_BASE_URL,
        sendEmail: async (message) => {
          sent.push(message as unknown as Record<string, unknown>);
          return { success: true };
        },
      }
    );
    const friendEmail = sent.find((message) => message.to === email)!;
    assert.equal(friendEmail.senderName, "Alex Example via Exomem");
    assert.equal(friendEmail.subject, "Alex Example invited you to Exomem");
    assert.match(String(friendEmail.textContent), /Your price: €10 a month, instead of €15/);
    assert.ok(String(friendEmail.textContent).includes(`/exomem/invite#${token}`));
    // The friend price came from Paddle's preview with the configured discount.
    assert.equal(
      paddleCalls("POST", "/pricing-preview").at(-1)?.body?.discount_id,
      FRIEND_DISCOUNT
    );
  });

  it("refuses a friend invitation, creating nothing, while Paddle reports the friend discount has a code", async () => {
    paddle.discount = { ...validDiscount(), code: "FRIEND5" };
    const email = newAddress("refused");
    await assert.rejects(
      issueOperatorInvite({
        email,
        kind: "friend",
        inviterName: "Alex Example",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        operatorPrincipalDigest: randomBytes(32),
      }),
      (error) => error instanceof ExomemHostedError && error.code === "FRIEND_PRICE_UNAVAILABLE"
    );
    const { rows } = await pool!.query(
      "SELECT count(*)::int AS n FROM exomem_invites WHERE email_normalized = $1",
      [email]
    );
    assert.equal(rows[0]!.n, 0);
  });

  it("answers expired, used, revoked and unknown tokens with one identical 404", async () => {
    const { POST } = await import("../../../app/api/exomem/access/inspect/route");
    const expired = await issueFriendInvitation({ email: newAddress("expired") });
    await pool!.query(
      "UPDATE exomem_invites SET created_at = now() - interval '31 days', expires_at = now() - interval '1 day' WHERE id = $1",
      [expired.inviteId]
    );
    const revoked = await issueFriendInvitation({ email: newAddress("revoked") });
    await pool!.query("UPDATE exomem_invites SET revoked_at = now() WHERE id = $1", [
      revoked.inviteId,
    ]);
    const used = await issueFriendInvitation({ email: newAddress("used") });
    await redeemCloudInvite(used.token);
    const unknownToken = randomBytes(32).toString("base64url");

    const answers = [];
    for (const token of [expired.token, used.token, revoked.token, unknownToken]) {
      const response = await POST(inspectRequest(token, { ip: "203.0.113.41" }));
      answers.push({
        status: response.status,
        body: await response.text(),
        headers: [...response.headers.entries()].filter(([name]) => name !== "date"),
      });
    }
    assert.equal(answers[0]!.status, 404);
    assert.equal(answers[0]!.body, JSON.stringify({ status: "unusable" }));
    for (const answer of answers.slice(1)) assert.deepEqual(answer, answers[0]);

    // A usable token's answer carries the prices but never the discount id.
    const usable = await issueFriendInvitation({ email: newAddress("usable") });
    const response = await POST(inspectRequest(usable.token, { ip: "203.0.113.41" }));
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(text.includes(FRIEND_DISCOUNT), false);
    const body = JSON.parse(text) as Record<string, unknown>;
    assert.equal(body.status, "invite");
    assert.deepEqual(body.price, {
      value: {
        usual: { amount: "1500", currencyCode: "EUR" },
        friend: { value: { amount: "1000", currencyCode: "EUR" }, reason: null },
      },
      reason: null,
    });
  });

  it("tells the holder of an existing owner's invitation that the owner exists, and never signs them in", async () => {
    const { POST } = await import("../../../app/api/exomem/access/inspect/route");
    const email = newAddress("existing");
    const ownerSession = await redeemCloudInvite(await insertCoveredInvitation(email));
    const { token } = await issueFriendInvitation({ email });
    const sessionsBefore = await sessionCount();

    const anonymous = await POST(inspectRequest(token, { ip: "203.0.113.42" }));
    const anonymousBody = (await anonymous.json()) as Record<string, unknown>;
    assert.equal(anonymousBody.status, "existing");
    assert.equal(anonymousBody.signedIn, false);
    assert.equal("email" in anonymousBody, false);
    // Whether the friend price fits the owner's plan is for the owner alone.
    assert.equal("price" in anonymousBody, false);
    assert.equal(anonymous.headers.get("set-cookie"), null);

    const signedIn = await POST(
      inspectRequest(token, {
        ip: "203.0.113.42",
        cookie: `exomem_session=${ownerSession.sessionToken}`,
      })
    );
    const signedInBody = (await signedIn.json()) as Record<string, unknown>;
    assert.equal(signedInBody.signedIn, true);
    assert.equal("price" in signedInBody, true);

    // The token cannot be redeemed into a session for the existing owner either.
    await assert.rejects(redeemCloudInvite(token));
    assert.equal(await sessionCount(), sessionsBefore);
  });

  it("applies the friend price to a live subscription from the next billing period, then consumes the invitation and tells the inviter", async () => {
    const owner = await paidOwner({ sourceState: "active", cell: "running" });
    const inviterEmail = newAddress("inviter");
    const { inviteId, token } = await issueFriendInvitation({ email: owner.email, inviterEmail });

    const decision = await decideInvitation({
      token,
      choice: "use_friend_price",
      session: { id: owner.sessionId, userId: owner.userId, tenantId: owner.tenantId },
    });

    assert.deepEqual(decision, {
      status: "applied",
      nextPaymentAt: { value: "2026-11-12T09:00:00.000Z", reason: null },
    });
    const updates = paddleCalls("PATCH", "/subscriptions/");
    assert.deepEqual(
      updates.map((call) => [call.path, call.body]),
      [
        [
          `/subscriptions/${owner.subscriptionRef}`,
          { discount: { id: FRIEND_DISCOUNT, effective_from: "next_billing_period" } },
        ],
      ]
    );
    assert.equal((await invitation(inviteId)).decision, "applied");
    assert.equal(await friendOffer(owner.tenantId), inviteId);
    const used = (await outboxRows(inviteId)).find((row) => row.kind === "invitation_used");
    assert.equal(used?.recipient, inviterEmail);
  });

  it("leaves the invitation usable and answers 503 when Paddle fails to update the subscription", async () => {
    const owner = await paidOwner({ sourceState: "active", cell: "running" });
    const inviterEmail = newAddress("inviter");
    const { inviteId, token } = await issueFriendInvitation({ email: owner.email, inviterEmail });
    paddle.subscriptionUpdateFails = true;
    const session = { id: owner.sessionId, userId: owner.userId, tenantId: owner.tenantId };

    await assert.rejects(
      decideInvitation({ token, choice: "use_friend_price", session }),
      (error) => error instanceof ExomemHostedError && error.status === 503
    );
    assert.equal((await invitation(inviteId)).consumed_at, null);
    assert.equal(await friendOffer(owner.tenantId), null);
    assert.equal(
      (await outboxRows(inviteId)).some((row) => row.kind === "invitation_used"),
      false
    );

    paddle.subscriptionUpdateFails = false;
    const retried = await decideInvitation({ token, choice: "use_friend_price", session });
    assert.equal(retried.status, "applied");
  });

  it("updates the subscription once when the same decision arrives twice at the same moment", async () => {
    const owner = await paidOwner({ sourceState: "active", cell: "running" });
    const { inviteId, token } = await issueFriendInvitation({ email: owner.email });
    const session = { id: owner.sessionId, userId: owner.userId, tenantId: owner.tenantId };
    paddle.subscriptionUpdateDelayMs = 200;

    const [first, second] = await Promise.all([
      decideInvitation({ token, choice: "use_friend_price", session }),
      decideInvitation({ token, choice: "use_friend_price", session }),
    ]);
    // The second waits for the first and returns its stored answer.
    assert.equal(first.status, "applied");
    assert.equal(second.status, "applied");
    assert.equal(paddleCalls("PATCH", "/subscriptions/").length, 1);
    assert.equal((await invitation(inviteId)).decision, "applied");
  });

  it("stores the friend price, not a kept plan, when an earlier answer reached Paddle but was lost", async () => {
    const owner = await paidOwner({ sourceState: "active", cell: "running" });
    const { inviteId, token } = await issueFriendInvitation({ email: owner.email });
    const session = { id: owner.sessionId, userId: owner.userId, tenantId: owner.tenantId };
    paddle.subscriptionUpdateAnswerLost = true;
    await assert.rejects(
      decideInvitation({ token, choice: "use_friend_price", session }),
      (error) => error instanceof ExomemHostedError && error.status === 503
    );
    paddle.subscriptionUpdateAnswerLost = false;

    assert.deepEqual(await decideInvitation({ token, choice: "keep_plan", session }), {
      status: "applied",
      nextPaymentAt: { value: "2026-11-12T09:00:00.000Z", reason: null },
    });
    assert.equal((await invitation(inviteId)).decision, "applied");
    assert.equal(await friendOffer(owner.tenantId), inviteId);

    // An answer that never reached Paddle leaves a plain kept plan.
    const other = await paidOwner({ sourceState: "active", cell: "running" });
    const second = await issueFriendInvitation({ email: other.email });
    const otherSession = { id: other.sessionId, userId: other.userId, tenantId: other.tenantId };
    paddle.subscriptionUpdateFails = true;
    await assert.rejects(
      decideInvitation({ token: second.token, choice: "use_friend_price", session: otherSession }),
      (error) => error instanceof ExomemHostedError && error.status === 503
    );
    assert.deepEqual(
      await decideInvitation({ token: second.token, choice: "keep_plan", session: otherSession }),
      { status: "kept" }
    );
    assert.equal(await friendOffer(other.tenantId), null);
  });

  it("leaves the invitation unused, and answers retryable, when no configured friend discount can show the friend price absent", async () => {
    const owner = await paidOwner({ sourceState: "active", cell: "running" });
    const { inviteId, token } = await issueFriendInvitation({ email: owner.email });
    const session = { id: owner.sessionId, userId: owner.userId, tenantId: owner.tenantId };
    paddle.subscriptionUpdateAnswerLost = true;
    await assert.rejects(
      decideInvitation({ token, choice: "use_friend_price", session }),
      (error) => error instanceof ExomemHostedError && error.status === 503
    );
    paddle.subscriptionUpdateAnswerLost = false;

    delete process.env.EXOMEM_PADDLE_FRIEND_DISCOUNT_ID;
    try {
      await assert.rejects(
        decideInvitation({ token, choice: "keep_plan", session }),
        (error) =>
          error instanceof ExomemHostedError &&
          error.code === "FRIEND_PRICE_UNAVAILABLE" &&
          error.status === 503
      );
    } finally {
      process.env.EXOMEM_PADDLE_FRIEND_DISCOUNT_ID = FRIEND_DISCOUNT;
    }
    assert.equal((await invitation(inviteId)).consumed_at, null);

    // Once the discount is configured again, the answer records the price in force.
    assert.equal(
      (await decideInvitation({ token, choice: "keep_plan", session })).status,
      "applied"
    );
  });

  it("records no friend offer from an older event, and decides from the subscription's current facts rather than a friend offer", async () => {
    const owner = await paidOwner({ sourceState: "active", cell: "running" });
    const { inviteId, token } = await issueFriendInvitation({ email: owner.email });

    // Paddle's newest event shows no discount; an older one, delivered late, shows the friend discount.
    const now = Date.now();
    assert.deepEqual(
      await subscriptionEvent(owner, { occurredAt: new Date(now), discountId: null }),
      {
        kind: "handled",
        outcome: "applied",
      }
    );
    assert.deepEqual(
      await subscriptionEvent(owner, {
        occurredAt: new Date(now - 60 * 60 * 1000),
        discountId: FRIEND_DISCOUNT,
      }),
      { kind: "handled", outcome: "stale" }
    );
    assert.equal(await friendOffer(owner.tenantId), null);

    // A friend offer the tenant holds from history does not stand in for the update.
    await pool!.query("UPDATE exomem_tenants SET friend_offer_invite_id = $2 WHERE id = $1", [
      owner.tenantId,
      inviteId,
    ]);
    const decision = await decideInvitation({
      token,
      choice: "use_friend_price",
      session: { id: owner.sessionId, userId: owner.userId, tenantId: owner.tenantId },
    });
    assert.equal(decision.status, "applied");
    assert.equal(paddleCalls("PATCH", `/subscriptions/${owner.subscriptionRef}`).length, 1);
  });

  it("records the friend offer with the subscription event itself, when the step after it fails and from Paddle reconciliation", async () => {
    const webhooked = await paidOwner({ sourceState: "active", cell: "running" });
    const webhookInvitation = await issueFriendInvitation({ email: webhooked.email });
    const dispatched = await subscriptionEvent(webhooked, {
      occurredAt: new Date(),
      discountId: FRIEND_DISCOUNT,
      cloudHook: async () => {
        throw new Error("the step after the event failed");
      },
    });
    assert.deepEqual(dispatched, { kind: "handled", outcome: "applied" });
    assert.equal(await friendOffer(webhooked.tenantId), webhookInvitation.inviteId);

    const reconciled = await paidOwner({ sourceState: "active", cell: "running" });
    const reconciledInvitation = await issueFriendInvitation({ email: reconciled.email });
    Object.assign(paddle.subscriptions.get(reconciled.subscriptionRef)!, {
      discount: { id: FRIEND_DISCOUNT },
      updated_at: new Date().toISOString(),
    });
    const result = await reconcileExomemPaddleSubscription(
      {
        userId: reconciled.userId,
        tenantId: reconciled.tenantId,
        subscriptionId: reconciled.subscriptionRef,
        environment: "sandbox",
      },
      {
        config: loadExomemPaddleConfig(ENV),
        store: createSqlExomemPaddleEventStore(taggedSql(pool!)),
      }
    );
    assert.equal(result.outcome, "applied");
    assert.equal(await friendOffer(reconciled.tenantId), reconciledInvitation.inviteId);
  });

  it("keeps a second inviter's invitation as kept, and tells that inviter nothing, when the owner already took the friend price", async () => {
    const owner = await paidOwner({ sourceState: "active", cell: "running" });
    const session = { id: owner.sessionId, userId: owner.userId, tenantId: owner.tenantId };
    const first = await issueFriendInvitation({
      email: owner.email,
      inviterEmail: newAddress("first-inviter"),
    });
    assert.equal(
      (await decideInvitation({ token: first.token, choice: "use_friend_price", session })).status,
      "applied"
    );
    const second = await issueFriendInvitation({
      email: owner.email,
      inviterEmail: newAddress("second-inviter"),
    });

    const decision = await decideInvitation({ token: second.token, choice: "keep_plan", session });

    assert.deepEqual(decision, { status: "kept" });
    assert.equal((await invitation(second.inviteId)).decision, "kept");
    assert.equal(await friendOffer(owner.tenantId), first.inviteId);
    assert.equal(
      (await outboxRows(second.inviteId)).some((row) => row.kind === "invitation_used"),
      false
    );
  });

  it("offers nothing to a plan that already has the friend price from another invitation, and changes nothing at Paddle when the owner asks anyway", async () => {
    const { POST } = await import("../../../app/api/exomem/access/inspect/route");
    const owner = await paidOwner({ sourceState: "active", cell: "running" });
    const session = { id: owner.sessionId, userId: owner.userId, tenantId: owner.tenantId };
    const first = await issueFriendInvitation({ email: owner.email });
    await decideInvitation({ token: first.token, choice: "use_friend_price", session });
    // Paddle reports the subscription with the friend discount.
    await subscriptionEvent(owner, { occurredAt: new Date(), discountId: FRIEND_DISCOUNT });
    const second = await issueFriendInvitation({
      email: owner.email,
      inviterEmail: newAddress("second-inviter"),
    });
    paddle.calls = [];

    const inspected = await POST(
      inspectRequest(second.token, {
        ip: "203.0.113.44",
        cookie: `exomem_session=${owner.sessionToken}`,
      })
    );
    const inspection = (await inspected.json()) as InvitationInspection;
    assert.ok(inspection.status === "existing" && inspection.signedIn);
    assert.deepEqual(inspection.price.value?.friend, {
      value: null,
      reason: "friend_price_taken",
    });
    // The page shows no price card and no "Use Alex's friend price", only "Keep my plan as it is".
    assert.equal(friendPriceOffered(inspection), false);
    assert.equal(friendPriceUnchecked(inspection), false);

    await assert.rejects(
      decideInvitation({ token: second.token, choice: "use_friend_price", session }),
      (error) => error instanceof ExomemHostedError && error.code === "FRIEND_PRICE_NOT_OFFERED"
    );
    assert.equal(paddleCalls("PATCH", "/subscriptions/").length, 0);
    assert.equal((await invitation(second.inviteId)).consumed_at, null);
    assert.equal(await friendOffer(owner.tenantId), first.inviteId);
    assert.equal(
      (await outboxRows(second.inviteId)).some((row) => row.kind === "invitation_used"),
      false
    );
  });

  it("applies one friend price when the owner answers two friend invitations at the same moment", async () => {
    const owner = await paidOwner({ sourceState: "active", cell: "running" });
    const session = { id: owner.sessionId, userId: owner.userId, tenantId: owner.tenantId };
    const invitations = [
      await issueFriendInvitation({
        email: owner.email,
        inviterEmail: newAddress("first-inviter"),
      }),
      await issueFriendInvitation({
        email: owner.email,
        inviterEmail: newAddress("second-inviter"),
      }),
    ];
    // Paddle holds its answer, so both answers are in flight together.
    paddle.subscriptionUpdateDelayMs = 200;

    const answers = await Promise.allSettled(
      invitations.map(({ token }) =>
        decideInvitation({ token, choice: "use_friend_price", session })
      )
    );

    const applied = answers.filter(
      (answer) => answer.status === "fulfilled" && answer.value.status === "applied"
    );
    const refused = answers.filter(
      (answer) =>
        answer.status === "rejected" &&
        answer.reason instanceof ExomemHostedError &&
        answer.reason.code === "FRIEND_PRICE_NOT_OFFERED"
    );
    assert.equal(applied.length, 1);
    assert.equal(refused.length, 1);
    assert.equal(paddleCalls("PATCH", "/subscriptions/").length, 1);
    const usedEmails = [];
    for (const { inviteId } of invitations) {
      usedEmails.push(
        ...(await outboxRows(inviteId)).filter((row) => row.kind === "invitation_used")
      );
    }
    assert.equal(usedEmails.length, 1);
  });

  it("lets a reconcile of the owner's Exomem finish while an answer waits on Paddle", async () => {
    const owner = await paidOwner({ sourceState: "active", cell: "running" });
    const session = { id: owner.sessionId, userId: owner.userId, tenantId: owner.tenantId };
    const { token } = await issueFriendInvitation({ email: owner.email });
    let reconciled: unknown = "not run";
    paddle.duringSubscriptionUpdate = async () => {
      // Two seconds stands in for a slow Paddle; the reconcile must not wait on it.
      reconciled = await Promise.race([
        reconcileCloudCellDesiredState(owner.tenantId),
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), 2_000)),
      ]);
    };

    const decision = await decideInvitation({ token, choice: "use_friend_price", session });

    assert.equal(decision.status, "applied");
    assert.equal(reconciled, "running");
  });

  it("offers nothing to an owner who has not paid yet and holds another invitation's friend price, and keeps that offer when the owner asks anyway", async () => {
    const { POST } = await import("../../../app/api/exomem/access/inspect/route");
    const email = newAddress("unpaid");
    const first = await issueFriendInvitation({ email });
    // Accepting admits the person, who has not paid yet, with the first inviter's friend offer.
    const owner = await redeemCloudInvite(first.token);
    const second = await issueFriendInvitation({
      email,
      inviterEmail: newAddress("second-inviter"),
    });

    const inspected = await POST(
      inspectRequest(second.token, {
        ip: "203.0.113.45",
        cookie: `exomem_session=${owner.sessionToken}`,
      })
    );
    const inspection = (await inspected.json()) as InvitationInspection;
    assert.ok(inspection.status === "existing" && inspection.signedIn);
    assert.deepEqual(inspection.price.value?.friend, {
      value: null,
      reason: "friend_price_taken",
    });
    // The page shows no price card and no "Use Alex's friend price", only "Keep my plan as it is".
    assert.equal(friendPriceOffered(inspection), false);
    assert.equal(friendPriceUnchecked(inspection), false);

    paddle.calls = [];
    const session = { id: owner.sessionId, userId: owner.userId, tenantId: owner.tenantId };
    await assert.rejects(
      decideInvitation({ token: second.token, choice: "use_friend_price", session }),
      (error) => error instanceof ExomemHostedError && error.code === "FRIEND_PRICE_NOT_OFFERED"
    );
    assert.equal(paddle.calls.length, 0);
    assert.equal((await invitation(second.inviteId)).consumed_at, null);
    assert.equal(await friendOffer(owner.tenantId), first.inviteId);
    assert.equal(
      (await outboxRows(second.inviteId)).some((row) => row.kind === "invitation_used"),
      false
    );
  });

  it("records the friend price for an answer whose update reached Paddle, when the event gave the offer of another invitation the owner never used", async () => {
    const owner = await paidOwner({ sourceState: "active", cell: "running" });
    const session = { id: owner.sessionId, userId: owner.userId, tenantId: owner.tenantId };
    const answered = await issueFriendInvitation({ email: owner.email });
    const unused = await issueFriendInvitation({ email: owner.email });
    paddle.subscriptionUpdateAnswerLost = true;
    await assert.rejects(
      decideInvitation({ token: answered.token, choice: "use_friend_price", session }),
      (error) => error instanceof ExomemHostedError && error.status === 503
    );
    paddle.subscriptionUpdateAnswerLost = false;
    // Paddle's event gives the tenant the offer of the newest friend invitation.
    await subscriptionEvent(owner, { occurredAt: new Date(), discountId: FRIEND_DISCOUNT });
    assert.equal(await friendOffer(owner.tenantId), unused.inviteId);

    const decision = await decideInvitation({
      token: answered.token,
      choice: "keep_plan",
      session,
    });

    assert.equal(decision.status, "applied");
    assert.equal((await invitation(answered.inviteId)).decision, "applied");
  });

  it("records the friend offer from Paddle's subscription event when the decision's answer was lost", async () => {
    const owner = await paidOwner({ sourceState: "active", cell: "running" });
    const { inviteId, token } = await issueFriendInvitation({ email: owner.email });
    const session = { id: owner.sessionId, userId: owner.userId, tenantId: owner.tenantId };
    paddle.subscriptionUpdateAnswerLost = true;
    await assert.rejects(
      decideInvitation({ token, choice: "use_friend_price", session }),
      (error) => error instanceof ExomemHostedError && error.status === 503
    );
    paddle.subscriptionUpdateAnswerLost = false;
    assert.equal(await friendOffer(owner.tenantId), null);

    // Paddle reports the update it applied, with the friend discount.
    const dispatched = await dispatchVerifiedExomemPaddleEvent(
      {
        event_id: `evt_${randomUUID().replaceAll("-", "")}`,
        event_type: "subscription.updated",
        occurred_at: new Date().toISOString(),
        environment: "sandbox",
        data: paddle.subscriptions.get(owner.subscriptionRef),
      },
      { env: ENV, store: createSqlExomemPaddleEventStore(taggedSql(pool!)) }
    );
    assert.deepEqual(dispatched, { kind: "handled", outcome: "applied" });
    assert.equal(await friendOffer(owner.tenantId), inviteId);

    // The owner's later answer records the price in force without asking Paddle.
    paddle.calls = [];
    const decision = await decideInvitation({ token, choice: "keep_plan", session });
    assert.equal(decision.status, "applied");
    assert.equal(paddle.calls.length, 0);
    assert.equal((await invitation(inviteId)).decision, "applied");
  });

  it("shows the next payment amount Paddle previews for the subscription, its friend price included, and unknown when Paddle cannot answer", async () => {
    const owner = await paidOwner({ sourceState: "active", cell: "running" });
    const { token } = await issueFriendInvitation({ email: owner.email });
    await decideInvitation({
      token,
      choice: "use_friend_price",
      session: { id: owner.sessionId, userId: owner.userId, tenantId: owner.tenantId },
    });
    const session = { userId: owner.userId, tenantId: owner.tenantId, reviewerCredentialId: null };

    // The friend price's own amount, not the usual price that a preview of the base price shows.
    const view = await loadExomemAccountView(session);
    assert.deepEqual(view.nextPaymentAmount, {
      value: { amount: "1000", currencyCode: "EUR" },
      reason: null,
    });

    // Within ten minutes the amount comes from the cache.
    paddle.calls = [];
    assert.deepEqual(
      (await loadExomemAccountView(session)).nextPaymentAmount,
      view.nextPaymentAmount
    );
    assert.equal(paddleCalls("GET", "/subscriptions/").length, 0);

    const unreachable = await paidOwner({ sourceState: "active", cell: "running" });
    paddle.subscriptionsDown = true;
    const unknownView = await loadExomemAccountView({
      userId: unreachable.userId,
      tenantId: unreachable.tenantId,
      reviewerCredentialId: null,
    });
    assert.deepEqual(unknownView.nextPaymentAmount, { value: null, reason: "unavailable" });
  });

  it("keeps an owner whose live subscription is on another price, or an unreported one, to their plan without asking Paddle", async () => {
    const { POST } = await import("../../../app/api/exomem/access/inspect/route");
    const olderPrice = `pri_${"o".repeat(26)}`;
    for (const [priceId, reason] of [
      [olderPrice, "plan_price_differs"],
      [null, "plan_price_unknown"],
    ] as const) {
      const owner = await paidOwner({ sourceState: "active", cell: "running", priceId });
      const { inviteId, token } = await issueFriendInvitation({ email: owner.email });
      paddle.calls = [];

      const inspected = await POST(
        inspectRequest(token, {
          ip: "203.0.113.43",
          cookie: `exomem_session=${owner.sessionToken}`,
        })
      );
      const body = (await inspected.json()) as {
        status: string;
        price: { value: { friend: { value: unknown; reason: string } } | null };
      };
      assert.equal(body.status, "existing");
      assert.deepEqual(body.price.value?.friend, { value: null, reason });

      const session = { id: owner.sessionId, userId: owner.userId, tenantId: owner.tenantId };
      await assert.rejects(
        decideInvitation({ token, choice: "use_friend_price", session }),
        (error) => error instanceof ExomemHostedError && error.code === "FRIEND_PRICE_NOT_OFFERED"
      );
      // Neither the discount nor the subscription was asked about.
      assert.equal(paddleCalls("GET", "/discounts/").length, 0);
      assert.equal(paddleCalls("PATCH", "/subscriptions/").length, 0);
      assert.equal((await invitation(inviteId)).consumed_at, null);
      assert.deepEqual(await decideInvitation({ token, choice: "keep_plan", session }), {
        status: "kept",
      });
    }
  });

  it("keeps the plan of an owner who answers a covered invitation, and refuses it the friend price", async () => {
    const owner = await paidOwner({ sourceState: "active", cell: "running" });
    const token = await insertCoveredInvitation(owner.email);
    const session = { id: owner.sessionId, userId: owner.userId, tenantId: owner.tenantId };

    await assert.rejects(
      decideInvitation({ token, choice: "use_friend_price", session }),
      (error) => error instanceof ExomemHostedError && error.code === "FRIEND_PRICE_NOT_OFFERED"
    );
    assert.deepEqual(await decideInvitation({ token, choice: "keep_plan", session }), {
      status: "kept",
    });
    assert.equal(paddle.calls.length, 0);
    assert.equal(await friendOffer(owner.tenantId), null);
  });

  it("cancels the invitee reminder and the inviter's ended notice once the invitation is used", async () => {
    const inviterEmail = newAddress("inviter");
    const used = await issueFriendInvitation({ email: newAddress("joins"), inviterEmail });
    const unused = await issueFriendInvitation({ email: newAddress("ignores"), inviterEmail });
    const joined = await redeemCloudInvite(used.token);
    // Both invitations reach their timers: the unused one has ended.
    await pool!.query(
      "UPDATE exomem_invites SET created_at = now() - interval '31 days', expires_at = now() - interval '1 minute' WHERE id = $1",
      [unused.inviteId]
    );
    await pool!.query(
      `UPDATE exomem_email_outbox SET not_before = now() - interval '1 minute'
       WHERE dedupe_key = ANY($1::text[])`,
      [
        [
          `invite-reminder:${used.inviteId}`,
          `invite-ended:${used.inviteId}`,
          `invite-ended:${unused.inviteId}`,
        ],
      ]
    );

    // Every due email is sent, however many earlier cases left queued.
    const sent = await drainedEmails();

    const usedRows = await outboxRows(used.inviteId);
    assert.equal(usedRows.find((row) => row.kind === "invitation_reminder")?.state, "cancelled");
    assert.equal(usedRows.find((row) => row.kind === "invitation_ended")?.state, "cancelled");
    assert.equal(usedRows.find((row) => row.kind === "invitation_used")?.state, "sent");
    assert.deepEqual(
      sent
        .filter((message) => message.to === inviterEmail)
        .map((message) => message.subject)
        .sort(),
      ["Sam Example accepted your invitation", "Your invitation to Sam Example ended"]
    );
    assert.equal(await friendOffer(joined.tenantId), used.inviteId);
  });

  it("names the inviter in a hold reminder from the invitation when it is sent, so a scrubbed name is never sent", async () => {
    const named = newAddress("named");
    const scrubbed = newAddress("scrubbed");
    await redeemCloudInvite((await issueFriendInvitation({ email: named })).token);
    const invitation = await issueFriendInvitation({ email: scrubbed });
    await redeemCloudInvite(invitation.token);
    // The inviter's account deletion clears the invitation's inviter fields.
    await pool!.query(
      "UPDATE exomem_invites SET inviter_name = NULL, inviter_email = NULL, note = NULL WHERE id = $1",
      [invitation.inviteId]
    );
    await pool!.query(
      `UPDATE exomem_email_outbox SET not_before = now() - interval '1 minute'
       WHERE kind = 'hold_reminder' AND recipient = ANY($1::text[])`,
      [[named, scrubbed]]
    );

    const sent = await drainedEmails();
    const namedReminder = sent.find((message) => message.to === named);
    const scrubbedReminder = sent.find((message) => message.to === scrubbed);
    assert.ok(namedReminder?.text.includes("Alex Example"));
    assert.ok(scrubbedReminder, "sanity: the hold reminder was sent");
    assert.equal(scrubbedReminder.text.includes("Alex Example"), false);
  });

  it("dates invitation emails in the time zone that the invitee's and the inviter's accounts last reported", async () => {
    const invitee = await paidOwner({ sourceState: "active", cell: "running" });
    const inviter = await paidOwner({ sourceState: "active", cell: "running" });
    await pool!.query("UPDATE exomem_tenants SET time_zone = $2 WHERE id = $1", [
      invitee.tenantId,
      "America/Los_Angeles",
    ]);
    await pool!.query("UPDATE exomem_tenants SET time_zone = $2 WHERE id = $1", [
      inviter.tenantId,
      "Asia/Tokyo",
    ]);
    // 01:00 UTC is still the evening before in Los Angeles.
    const expiresAt = new Date(Date.now() + 10 * DAY_MS);
    expiresAt.setUTCHours(1, 0, 0, 0);
    const { token } = await issueFriendInvitation({
      email: invitee.email,
      inviterEmail: inviter.email,
      expiresAt,
    });

    const invitationEmail = (await drainedEmails()).find((message) => message.to === invitee.email);
    assert.ok(invitationEmail, "sanity: the invitation was sent");
    assert.ok(invitationEmail.text.includes(dayMonth(expiresAt, "America/Los_Angeles")));
    assert.equal(invitationEmail.text.includes("(UTC)"), false);

    await decideInvitation({
      token,
      choice: "use_friend_price",
      session: { id: invitee.sessionId, userId: invitee.userId, tenantId: invitee.tenantId },
    });
    const usedNotice = (await drainedEmails()).find((message) => message.to === inviter.email);
    assert.ok(usedNotice, "sanity: the used notice was sent");
    assert.ok(usedNotice.text.includes(dayMonth(new Date(), "Asia/Tokyo")));
    assert.equal(usedNotice.text.includes("(UTC)"), false);
  });

  it("resubscribes an ended owner inside the kept window with a new transaction for the same customer and the friend discount, and resumes the kept cell", async () => {
    const owner = await paidOwner({ sourceState: "cancelled", cell: "read_only", endedDaysAgo: 5 });
    const { token } = await issueFriendInvitation({ email: owner.email });
    const session = { id: owner.sessionId, userId: owner.userId, tenantId: owner.tenantId };
    assert.deepEqual(await decideInvitation({ token, choice: "use_friend_price", session }), {
      status: "applied_on_resubscribe",
    });
    assert.equal(paddleCalls("PATCH", "/subscriptions/").length, 0);

    const checkout = await startOwnerCheckout(owner.userId, owner.tenantId);
    const created = paddleCalls("POST", "/transactions");
    assert.equal(created.length, 1);
    assert.equal(created[0]!.body?.customer_id, owner.customerRef);
    assert.equal(created[0]!.body?.discount_id, FRIEND_DISCOUNT);
    const entitlement = await pool!.query(
      "SELECT source_state, provider_transaction_ref FROM exomem_entitlements WHERE tenant_id = $1",
      [owner.tenantId]
    );
    assert.deepEqual(entitlement.rows[0], {
      source_state: "cancelled",
      provider_transaction_ref: checkout.transactionId,
    });

    // A second press reopens the same checkout instead of a second transaction.
    const again = await startOwnerCheckout(owner.userId, owner.tenantId);
    assert.equal(again.transactionId, checkout.transactionId);
    assert.equal(paddleCalls("POST", "/transactions").length, 1);

    // Paddle's subscription event for the new subscription binds by the
    // transaction and resumes the kept cell.
    const newSubscription = `sub_${randomUUID().replaceAll("-", "").slice(0, 26)}`;
    const dispatched = await dispatchVerifiedExomemPaddleEvent(
      {
        event_id: `evt_${randomUUID().replaceAll("-", "")}`,
        event_type: "subscription.created",
        occurred_at: new Date().toISOString(),
        environment: "sandbox",
        data: {
          id: newSubscription,
          status: "active",
          transaction_id: checkout.transactionId,
          customer_id: owner.customerRef,
          discount: { id: FRIEND_DISCOUNT },
          items: [{ price: { id: BASE_PRICE, product_id: PRODUCT, name: "Exomem · monthly" } }],
          custom_data: {
            product_key: "exomem-hosted",
            user_id: owner.userId,
            tenant_id: owner.tenantId,
          },
        },
      },
      { env: ENV, store: createSqlExomemPaddleEventStore(taggedSql(pool!)) }
    );
    assert.deepEqual(dispatched, { kind: "handled", outcome: "applied" });
    const resumed = await pool!.query(
      `SELECT entitlement.source_state, entitlement.provider_subscription_ref,
              entitlement.provider_discount_id, cell.desired_state
       FROM exomem_entitlements AS entitlement
       JOIN exomem_cloud_cells AS cell ON cell.tenant_id = entitlement.tenant_id
       WHERE entitlement.tenant_id = $1`,
      [owner.tenantId]
    );
    assert.deepEqual(resumed.rows[0], {
      source_state: "active",
      provider_subscription_ref: newSubscription,
      provider_discount_id: FRIEND_DISCOUNT,
      desired_state: "running",
    });
  });

  it("refuses to resubscribe an owner whose kept window has passed, creating no transaction", async () => {
    const owner = await paidOwner({
      sourceState: "cancelled",
      cell: "read_only",
      endedDaysAgo: 31,
    });
    await assert.rejects(
      startOwnerCheckout(owner.userId, owner.tenantId),
      (error) => error instanceof ExomemHostedError && error.code === "EXOMEM_ENTITLEMENT_DENIED"
    );
    assert.equal(paddleCalls("POST", "/transactions").length, 0);
  });

  it("refuses a friend checkout, creating no transaction, when the discount also reaches the storage price", async () => {
    const owner = await paidOwner({ sourceState: "cancelled", cell: "read_only", endedDaysAgo: 2 });
    const { token } = await issueFriendInvitation({ email: owner.email });
    await decideInvitation({
      token,
      choice: "use_friend_price",
      session: { id: owner.sessionId, userId: owner.userId, tenantId: owner.tenantId },
    });
    paddle.discount = { ...validDiscount(), restrict_to: [BASE_PRICE, STORAGE_PRICE] };

    await assert.rejects(
      startOwnerCheckout(owner.userId, owner.tenantId),
      (error) =>
        error instanceof ExomemHostedError && error.code === "EXOMEM_FRIEND_DISCOUNT_INVALID"
    );
    assert.equal(paddleCalls("POST", "/transactions").length, 0);
  });

  it("reopens a checkout only after checking the friend discount again, and never at the usual price for a friend offer", async () => {
    const owner = await paidOwner({ sourceState: "cancelled", cell: "read_only", endedDaysAgo: 3 });
    const usual = await startOwnerCheckout(owner.userId, owner.tenantId);
    const { token } = await issueFriendInvitation({ email: owner.email });
    await decideInvitation({
      token,
      choice: "use_friend_price",
      session: { id: owner.sessionId, userId: owner.userId, tenantId: owner.tenantId },
    });

    // Without a configured friend discount, the usual-price checkout is not handed back.
    delete process.env.EXOMEM_PADDLE_FRIEND_DISCOUNT_ID;
    try {
      await assert.rejects(
        startOwnerCheckout(owner.userId, owner.tenantId),
        (error) =>
          error instanceof ExomemHostedError && error.code === "EXOMEM_FRIEND_DISCOUNT_INVALID"
      );
    } finally {
      process.env.EXOMEM_PADDLE_FRIEND_DISCOUNT_ID = FRIEND_DISCOUNT;
    }

    // With it configured, a friend-price checkout replaces the usual-price one.
    const friend = await startOwnerCheckout(owner.userId, owner.tenantId);
    assert.notEqual(friend.transactionId, usual.transactionId);
    assert.equal(paddle.transactions.get(usual.transactionId)?.status, "canceled");
    assert.equal(paddle.transactions.get(friend.transactionId)?.discount_id, FRIEND_DISCOUNT);

    // Once Paddle reports the discount with a code, the friend checkout is not reopened either.
    paddle.discount = { ...validDiscount(), code: "FRIENDS" };
    await assert.rejects(
      startOwnerCheckout(owner.userId, owner.tenantId),
      (error) =>
        error instanceof ExomemHostedError && error.code === "EXOMEM_FRIEND_DISCOUNT_INVALID"
    );
  });

  it("gives no payable checkout to an owner who confirms deletion while Paddle answers", async () => {
    const owner = await paidOwner({ sourceState: "cancelled", cell: "read_only", endedDaysAgo: 3 });
    await startOwnerCheckout(owner.userId, owner.tenantId);
    paddle.duringTransactionRead = async () => {
      await pool!.query(
        "UPDATE exomem_tenants SET status = 'deletion_pending', desired_state = 'deleted' WHERE id = $1",
        [owner.tenantId]
      );
    };
    const denied = (error: unknown) =>
      error instanceof ExomemHostedError && error.code === "EXOMEM_ENTITLEMENT_DENIED";

    await assert.rejects(startOwnerCheckout(owner.userId, owner.tenantId), denied);

    // From then on the account is refused before Paddle is asked.
    paddle.duringTransactionRead = null;
    paddle.calls = [];
    await assert.rejects(startOwnerCheckout(owner.userId, owner.tenantId), denied);
    assert.equal(paddle.calls.length, 0);
  });

  it("cancels an open resubscribe checkout at Paddle before the lapsed window deletes the cell, and resumes an owner whose resubscription was paid without its subscription event", async () => {
    const abandoned = await lapsedOwnerWithCheckout();
    const paid = await lapsedOwnerWithCheckout();
    const newSubscription = paidAtPaddle(paid, paid.transactionId);

    await runBoundedCloudReconcile();

    assert.ok(
      paddleCalls("PATCH", `/transactions/${abandoned.transactionId}`).some(
        (call) => call.body?.status === "canceled"
      )
    );
    assert.deepEqual(await lapsedCell(abandoned.tenantId), {
      desired_state: "deleted",
      provider_transaction_ref: null,
    });
    // The paid checkout is not cancelled: the subscription it paid for is
    // bound from Paddle and resumes the cell.
    assert.equal(paddleCalls("PATCH", `/transactions/${paid.transactionId}`).length, 0);
    const resumed = await pool!.query(
      `SELECT entitlement.source_state, entitlement.provider_subscription_ref, cell.desired_state
       FROM exomem_entitlements AS entitlement
       JOIN exomem_cloud_cells AS cell ON cell.tenant_id = entitlement.tenant_id
       WHERE entitlement.tenant_id = $1`,
      [paid.tenantId]
    );
    assert.deepEqual(resumed.rows[0], {
      source_state: "active",
      provider_subscription_ref: newSubscription,
      desired_state: "running",
    });
  });

  it("keeps a lapsed cell whose checkout Paddle reports without its owner fields", async () => {
    const owner = await lapsedOwnerWithCheckout();
    paddle.transactions.get(owner.transactionId)!.custom_data = null;

    await runBoundedCloudReconcile();

    assert.deepEqual(await lapsedCell(owner.tenantId), {
      desired_state: "read_only",
      provider_transaction_ref: owner.transactionId,
    });
    assert.equal(paddleCalls("PATCH", `/transactions/${owner.transactionId}`).length, 0);
  });

  it("keeps a lapsed cell whose checkout Paddle reports paid but not yet subscribed", async () => {
    const owner = await lapsedOwnerWithCheckout();
    Object.assign(paddle.transactions.get(owner.transactionId)!, {
      status: "paid",
      subscription_id: null,
    });

    await runBoundedCloudReconcile();

    assert.deepEqual(await lapsedCell(owner.tenantId), {
      desired_state: "read_only",
      provider_transaction_ref: owner.transactionId,
    });
  });

  it("resumes an ended owner who returns from a paid resubscription whose subscription event never arrives", async () => {
    const owner = await paidOwner({ sourceState: "cancelled", cell: "read_only", endedDaysAgo: 5 });
    const checkout = await startOwnerCheckout(owner.userId, owner.tenantId);
    const newSubscription = paidAtPaddle(owner, checkout.transactionId);

    assert.deepEqual(
      await resumeReturnedOwnerCheckout(owner.userId, owner.tenantId, checkout.transactionId),
      { state: "settled" }
    );
    assert.equal(await reconcileCloudCellDesiredState(owner.tenantId), "running");
    const entitlement = await pool!.query(
      "SELECT source_state, provider_subscription_ref FROM exomem_entitlements WHERE tenant_id = $1",
      [owner.tenantId]
    );
    assert.deepEqual(entitlement.rows[0], {
      source_state: "active",
      provider_subscription_ref: newSubscription,
    });
    // Pressing resubscribe again buys nothing more.
    await assert.rejects(startOwnerCheckout(owner.userId, owner.tenantId));
    assert.equal(paddleCalls("POST", "/transactions").length, 1);
  });

  it("binds nothing when the paid subscription Paddle reports names another owner", async () => {
    const owner = await paidOwner({ sourceState: "cancelled", cell: "read_only", endedDaysAgo: 5 });
    const checkout = await startOwnerCheckout(owner.userId, owner.tenantId);
    const paidSubscription = paidAtPaddle(owner, checkout.transactionId);
    const subscription = paddle.subscriptions.get(paidSubscription)!;
    subscription.custom_data = { ...(subscription.custom_data as object), tenant_id: randomUUID() };

    assert.deepEqual(
      await resumeReturnedOwnerCheckout(owner.userId, owner.tenantId, checkout.transactionId),
      { state: "settled" }
    );
    const entitlement = await pool!.query(
      "SELECT source_state, provider_subscription_ref FROM exomem_entitlements WHERE tenant_id = $1",
      [owner.tenantId]
    );
    assert.deepEqual(entitlement.rows[0], {
      source_state: "cancelled",
      provider_subscription_ref: owner.subscriptionRef,
    });
  });

  it("stops settling lapsed checkouts at its budget while Paddle hangs, and keeps every cell", async () => {
    const owners = [
      await lapsedOwnerWithCheckout(),
      await lapsedOwnerWithCheckout(),
      await lapsedOwnerWithCheckout(),
    ];
    paddle.transactionsHang = true;

    const started = Date.now();
    const result = await runBoundedCloudReconcile({ settleBudgetMs: 300 });
    const elapsedMs = Date.now() - started;

    // Each hanging call would otherwise wait out its own 10-second deadline.
    assert.ok(elapsedMs < 3_000, `the sweep took ${elapsedMs} ms`);
    assert.ok(result.waitingForPaddle !== null && result.waitingForPaddle >= owners.length);
    for (const owner of owners) {
      assert.equal((await lapsedCell(owner.tenantId)).desired_state, "read_only");
    }
  });

  it("keeps a lapsed cell read-only while Paddle cannot settle its checkout, and deletes it once Paddle answers", async () => {
    const owner = await lapsedOwnerWithCheckout();
    paddle.transactionsDown = true;

    const waiting = await runBoundedCloudReconcile();
    assert.ok(waiting.waitingForPaddle !== null && waiting.waitingForPaddle >= 1);
    // No other path deletes it either while the checkout is still bound.
    assert.equal(await reconcileCloudCellDesiredState(owner.tenantId), "read_only");
    assert.deepEqual(await lapsedCell(owner.tenantId), {
      desired_state: "read_only",
      provider_transaction_ref: owner.transactionId,
    });

    paddle.transactionsDown = false;
    await runBoundedCloudReconcile();
    assert.deepEqual(await lapsedCell(owner.tenantId), {
      desired_state: "deleted",
      provider_transaction_ref: null,
    });
  });
});
