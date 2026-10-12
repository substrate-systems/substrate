import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { startOwnerCheckout } from "../billing-account";
import { redeemCloudInvite, redeemCloudInviteAtomic } from "../cloud-admission";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
import { drainExomemEmailOutbox } from "../email-outbox";
import { ExomemHostedError } from "../errors";
import { decideInvitation, issueOperatorInvite } from "../invites";
import { __clearExomemPriceCacheForTests } from "../paddle-billing";
import { createSqlExomemPaddleEventStore } from "../paddle-event-store";
import { dispatchVerifiedExomemPaddleEvent } from "../paddle-webhook";
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
  transactions: new Map<string, Record<string, unknown>>(),
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
  if (method === "PATCH" && pathname.startsWith("/subscriptions/")) {
    await new Promise((resolve) => setTimeout(resolve, paddle.subscriptionUpdateDelayMs));
    if (paddle.subscriptionUpdateFails) return new Response("{}", { status: 500 });
    return Response.json({
      data: { id: pathname.split("/")[2], next_billed_at: "2026-11-12T09:00:00Z" },
    });
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
    const transaction = paddle.transactions.get(pathname.split("/")[2]!);
    return transaction ? Response.json({ data: transaction }) : new Response("{}", { status: 404 });
  }
  return new Response("{}", { status: 404 });
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
}): Promise<Owner & { customerRef: string; subscriptionRef: string }> {
  const email = newAddress("owner");
  const session = mintSessionMaterial();
  const admitted = await redeemCloudInviteAtomic({
    tokenDigest: tokenDigest(await insertStandardInvitation(email))!,
    sessionDigest: session.sessionDigest,
    csrfDigest: session.csrfDigest,
    sessionExpiresAt: session.expiresAt,
  });
  assert.ok(admitted, "sanity: the owner was admitted");
  const customerRef = `ctm_${randomUUID().replaceAll("-", "").slice(0, 26)}`;
  const subscriptionRef = `sub_${randomUUID().replaceAll("-", "").slice(0, 26)}`;
  // The subscription's last transaction, as Paddle knows it.
  const transactionRef = `txn_${randomUUID().replaceAll("-", "").slice(0, 26)}`;
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
         source_occurred_at = now() - ($7 * interval '1 day')
     WHERE tenant_id = $1`,
    [
      admitted.tenantId,
      state.sourceState,
      state.sourceState === "active" ? "active" : "cancelled",
      customerRef,
      subscriptionRef,
      transactionRef,
      state.endedDaysAgo ?? 1,
    ]
  );
  await pool!.query("UPDATE exomem_cloud_cells SET desired_state = $2 WHERE cell_id = $1", [
    admitted.cellId,
    state.cell,
  ]);
  await pool!.query("UPDATE exomem_tenants SET status = 'active' WHERE id = $1", [
    admitted.tenantId,
  ]);
  return { ...admitted, email, customerRef, subscriptionRef };
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
    assert.match(String(friendEmail.textContent), /€10 a month \(instead of €15\)/);
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
        friend: { amount: "1000", currencyCode: "EUR" },
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
    assert.equal(anonymous.headers.get("set-cookie"), null);

    const signedIn = await POST(
      inspectRequest(token, {
        ip: "203.0.113.42",
        cookie: `exomem_session=${ownerSession.sessionToken}`,
      })
    );
    assert.equal(((await signedIn.json()) as Record<string, unknown>).signedIn, true);

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

    const sent: Array<{ to: string; subject: string }> = [];
    await drainExomemEmailOutbox(
      {},
      {
        publicBaseUrl: PUBLIC_BASE_URL,
        sendEmail: async (message) => {
          sent.push({ to: message.to, subject: message.subject });
          return { success: true };
        },
      }
    );

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
});
