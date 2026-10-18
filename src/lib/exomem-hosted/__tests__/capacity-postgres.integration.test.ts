import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { Pool, type PoolClient } from "pg";
import { exomemEmailSchemeQuery } from "@/lib/email-templates/exomem-email";
import { applyMigrations } from "../../../../scripts/migrate";
import { drainMagicLinkDeliveries } from "../access-delivery";
import { redeemCloudInviteAtomic } from "../cloud-admission";
import { getCloudCapacityStatus, lockCloudCapacity } from "../cloud-capacity";
import {
  __setExomemSqlForTests,
  __setExomemTransactionForTests,
  createInviteRecord,
  executeExomemSql,
  type ExomemSql,
} from "../db";
import { clearSettledEmailRecipients, drainExomemEmailOutbox } from "../email-outbox";
import { setOperationalEventSinkForTests } from "../observability";
import {
  EXOMEM_INVITE_CAPABILITIES,
  EXOMEM_INVITE_LIMITS,
  promoteWaitlistedPeople,
  pruneStaleSelfServeRecords,
  startSelfServeAtomic,
} from "../self-serve-admission";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

// "Start with your email" against real PostgreSQL: the start route's uniform
// answer, Cloud capacity under concurrency, waitlist order and promotion, the
// Turnstile check, and the email outbox the outcomes are written to.

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
let pool: Pool | undefined;
let schema: string | undefined;

// Cloudflare's documented Turnstile test secrets. The fake siteverify below
// answers for them the way Cloudflare does.
const TURNSTILE_ALWAYS_PASSES = "1x0000000000000000000000000000000AA";
const TURNSTILE_ALWAYS_FAILS = "2x0000000000000000000000000000000AA";
let siteverifyReachable = true;
let siteverifyCalls = 0;

const FIXED_REQUEST_ID = "00000000-0000-4000-8000-0000000000aa";
const FIXED_CHALLENGE = {
  challengeToken: Buffer.alloc(32, 0x41).toString("base64url"),
  challengeDigest: Buffer.alloc(32, 0x42),
  expiresAt: new Date("2026-10-12T12:15:00.000Z"),
};

const ENV = {
  EXOMEM_CONTROL_PLANE_KEY: randomBytes(32).toString("base64url"),
  EXOMEM_TURNSTILE_SECRET_KEY: TURNSTILE_ALWAYS_PASSES,
  EXOMEM_SELF_SERVE_ADMISSION: undefined,
  EXOMEM_SELF_SERVE_ADMISSIONS_PER_HOUR: undefined,
} as Record<string, string | undefined>;
const priorEnv: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

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

async function configureCapacity(slots: number): Promise<void> {
  await pool!.query("DELETE FROM exomem_cloud_capacity");
  await pool!.query(
    "INSERT INTO exomem_cloud_capacity (node, cell_slots, observed_at) VALUES ($1, $2, now())",
    [`node-${randomUUID()}`, slots]
  );
}

async function count(sql: string, values: unknown[] = []): Promise<number> {
  const { rows } = await pool!.query<{ n: number }>(sql, values);
  return Number(rows[0]!.n);
}

function newAddress(label: string): string {
  return `${label}-${randomUUID()}@example.test`;
}

function startRequest(body: Record<string, unknown>): import("next/server").NextRequest {
  return new Request("https://substratesystems.io/api/exomem/access/start", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "substratesystems.io",
      origin: "https://substratesystems.io",
      "x-forwarded-for": "203.0.113.20",
    },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

describe("Exomem start admission PostgreSQL integration", { skip: !databaseUrl }, () => {
  before(async () => {
    for (const [key, value] of Object.entries(ENV)) {
      priorEnv[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // Siteverify is Cloudflare's; it is substituted here, at the boundary.
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      siteverifyCalls += 1;
      if (!siteverifyReachable) throw new TypeError("fetch failed");
      const { secret } = JSON.parse(String(init?.body)) as { secret: string };
      const passes = secret === TURNSTILE_ALWAYS_PASSES;
      return Response.json({
        success: passes,
        "error-codes": passes ? [] : ["invalid-input-response"],
        hostname: "example.com",
        action: "",
      });
    }) as typeof fetch;

    // Fix public metadata; encrypted cookie values remain random and carry no account outcome.
    const actualHttp = await import("@/lib/exomem-hosted/http");
    const actualSessions = await import("@/lib/exomem-hosted/sessions");
    mock.module("@/lib/exomem-hosted/http", {
      namedExports: { ...actualHttp, newRequestId: () => FIXED_REQUEST_ID },
    });
    mock.module("@/lib/exomem-hosted/sessions", {
      namedExports: { ...actualSessions, mintMagicLinkChallenge: () => FIXED_CHALLENGE },
    });

    schema = `start_admission_it_${randomUUID().replaceAll("-", "")}`;
    await ensureExomemPostgresTestExtensions(databaseUrl!);
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);
    await applyMigrations({ databaseUrl: scoped.toString() });
    await admin.end();
    pool = new Pool({ connectionString: scoped.toString(), max: 20 });
    __setExomemSqlForTests(taggedSql(pool));
    __setExomemTransactionForTests(interactiveTransaction);
  });

  after(async () => {
    mock.reset();
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
    siteverifyReachable = true;
    siteverifyCalls = 0;
    process.env.EXOMEM_TURNSTILE_SECRET_KEY = TURNSTILE_ALWAYS_PASSES;
    delete process.env.EXOMEM_SELF_SERVE_ADMISSION;
    delete process.env.EXOMEM_SELF_SERVE_ADMISSIONS_PER_HOUR;
    // The waitlist row must go before the invite it names (its admitted-pair
    // CHECK refuses the SET NULL), and tokens before the tenants they name.
    await pool!.query("DELETE FROM exomem_email_outbox");
    await pool!.query("DELETE FROM exomem_waitlist_entries");
    await pool!.query("DELETE FROM exomem_access_delivery_outbox");
    await pool!.query("DELETE FROM exomem_access_tokens");
    await pool!.query("DELETE FROM exomem_invites");
    await pool!.query("DELETE FROM exomem_cloud_cells");
    await pool!.query("DELETE FROM exomem_tenants");
    await pool!.query("DELETE FROM exomem_users");
    await pool!.query("DELETE FROM users");
    await pool!.query("DELETE FROM exomem_rate_limit_buckets");
    await pool!.query("DELETE FROM exomem_cloud_capacity");
  });

  it("answers every start outcome with the same bytes, never under the floor", async () => {
    const { POST } = await import("../../../app/api/exomem/access/start/route");
    const owner = newAddress("owner");
    const ownerUser = await pool!.query<{ id: string }>(
      "INSERT INTO users (email, email_verified_at) VALUES ($1, now()) RETURNING id",
      [owner]
    );
    await pool!.query(
      "INSERT INTO exomem_tenants (owner_user_id, status, desired_state) VALUES ($1, 'active', 'running')",
      [ownerUser.rows[0]!.id]
    );
    const defaultWaitlisted = newAddress("default");
    const admitted = newAddress("admitted");
    const waitlisted = newAddress("waitlisted");
    const queuedWithFreePlace = newAddress("queued");
    await configureCapacity(1);

    const answers: Array<{ status: number; body: string; cookies: string; elapsedMs: number }> = [];
    async function ask(email: string): Promise<void> {
      const startedAt = performance.now();
      const response = await POST(
        startRequest({ email, turnstileToken: "XXXX.DUMMY.TOKEN.XXXX", timeZone: "Europe/Paris" })
      );
      answers.push({
        status: response.status,
        body: await response.text(),
        cookies: JSON.stringify(
          response.cookies.getAll().map((cookie) => ({ ...cookie, value: undefined }))
        ),
        elapsedMs: performance.now() - startedAt,
      });
    }

    // The cookie's Expires comes from the wall clock, so the clock is held
    // still across the requests. Timers and the database run for real.
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    try {
      await ask(defaultWaitlisted);
      await ask(owner);
      // The default request queued a person; retire that fixture before testing a free place.
      await pool!.query("DELETE FROM exomem_waitlist_entries WHERE email_normalized = $1", [
        defaultWaitlisted,
      ]);
      process.env.EXOMEM_SELF_SERVE_ADMISSION = "open";
      await ask(admitted);
      await ask(waitlisted);
      // A waiting person asking again, and a live link being sent again.
      await ask(waitlisted);
      await ask(admitted);
      // Waitlist mode queues a new address even while a place is free.
      await configureCapacity(5);
      process.env.EXOMEM_SELF_SERVE_ADMISSION = "waitlist";
      await ask(queuedWithFreePlace);
    } finally {
      mock.timers.reset();
    }

    // Each outcome really happened, so the comparison below is not vacuous.
    assert.equal(
      await count("SELECT count(*) AS n FROM exomem_access_tokens WHERE purpose = 'magic_link'"),
      1
    );
    assert.equal(
      await count(
        "SELECT count(*) AS n FROM exomem_email_outbox WHERE kind = 'start' AND recipient = $1",
        [admitted]
      ),
      2
    );
    for (const address of [waitlisted, queuedWithFreePlace]) {
      assert.equal(
        await count(
          "SELECT count(*) AS n FROM exomem_waitlist_entries WHERE email_normalized = $1 AND admitted_at IS NULL",
          [address]
        ),
        1
      );
      assert.equal(
        await count("SELECT count(*) AS n FROM exomem_email_outbox WHERE recipient = $1", [
          address,
        ]),
        1
      );
    }
    assert.equal(
      await count("SELECT count(*) AS n FROM exomem_email_outbox WHERE recipient = $1", [
        defaultWaitlisted,
      ]),
      1
    );

    for (const answer of answers.slice(1)) {
      assert.equal(answer.status, answers[0]!.status);
      assert.equal(answer.body, answers[0]!.body);
      assert.equal(answer.cookies, answers[0]!.cookies);
    }
    assert.equal(answers[0]!.status, 202);
    assert.deepEqual(JSON.parse(answers[0]!.body), {
      success: true,
      status: "if_eligible_email_sent",
      retryAfterSeconds: 60,
      retryLimited: false,
      requestId: FIXED_REQUEST_ID,
    });
    assert.match(answers[0]!.cookies, /exomem_magic_challenge/);
    for (const answer of answers) assert.ok(answer.elapsedMs >= 600, `${answer.elapsedMs} ms`);
  });

  it("builds the emails a light page asks for on light, for an owner and a newcomer alike", async () => {
    const { POST } = await import("../../../app/api/exomem/access/start/route");
    const owner = newAddress("owner");
    const ownerUser = await pool!.query<{ id: string }>(
      "INSERT INTO users (email, email_verified_at) VALUES ($1, now()) RETURNING id",
      [owner]
    );
    await pool!.query(
      "INSERT INTO exomem_tenants (owner_user_id, status, desired_state) VALUES ($1, 'active', 'running')",
      [ownerUser.rows[0]!.id]
    );
    const newcomer = newAddress("newcomer");
    process.env.EXOMEM_SELF_SERVE_ADMISSION = "open";
    await configureCapacity(1);
    for (const email of [owner, newcomer]) {
      const response = await POST(
        startRequest({ email, turnstileToken: "XXXX.DUMMY.TOKEN.XXXX", emailScheme: "light" })
      );
      assert.equal(response.status, 202);
    }

    // The owner's sign-in link and the newcomer's start link leave by their two outboxes.
    const sent = new Map<string, string>();
    const capture = async (input: { to: string; htmlContent: string }) => {
      sent.set(input.to, input.htmlContent);
      return { success: true };
    };
    await drainMagicLinkDeliveries({}, { sendEmail: capture });
    await drainExomemEmailOutbox({}, { sendEmail: capture });

    // A light-based email switches to dark in its block; a dark-based one would switch to light.
    for (const email of [owner, newcomer]) {
      assert.ok(sent.get(email)?.includes(`@media ${exomemEmailSchemeQuery("dark")}`), email);
    }
  });

  it("refuses an invalid Turnstile token with 400 and writes nothing at all", async () => {
    const { POST } = await import("../../../app/api/exomem/access/start/route");
    process.env.EXOMEM_TURNSTILE_SECRET_KEY = TURNSTILE_ALWAYS_FAILS;
    process.env.EXOMEM_SELF_SERVE_ADMISSION = "open";
    await configureCapacity(1);

    const response = await POST(
      startRequest({ email: newAddress("bot"), turnstileToken: "XXXX.DUMMY.TOKEN.XXXX" })
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { success: false, error: "challenge_failed" });
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.equal(siteverifyCalls, 1);
    assert.equal(await count("SELECT count(*) AS n FROM exomem_email_outbox"), 0);
    assert.equal(await count("SELECT count(*) AS n FROM exomem_invites"), 0);
    assert.equal(await count("SELECT count(*) AS n FROM exomem_waitlist_entries"), 0);
    assert.equal(await count("SELECT count(*) AS n FROM exomem_rate_limit_buckets"), 0);
  });

  it("proceeds under the rate limits when siteverify cannot be reached", async () => {
    const { POST } = await import("../../../app/api/exomem/access/start/route");
    siteverifyReachable = false;
    process.env.EXOMEM_SELF_SERVE_ADMISSION = "open";
    await configureCapacity(1);
    const email = newAddress("outage");

    const response = await POST(startRequest({ email, turnstileToken: "XXXX.DUMMY.TOKEN.XXXX" }));

    assert.equal(response.status, 202);
    assert.equal(
      await count("SELECT count(*) AS n FROM exomem_email_outbox WHERE recipient = $1", [email]),
      1
    );
    // The request's address, browser and network limits, and the admission's pace.
    assert.equal(await count("SELECT count(*) AS n FROM exomem_rate_limit_buckets"), 4);
  });

  it("admits exactly one of many simultaneous starts at the last free slot and queues the rest", async () => {
    await configureCapacity(1);
    const addresses = Array.from({ length: 8 }, (_, index) => newAddress(`race-${index}`));

    const outcomes = await Promise.all(
      addresses.map((emailNormalized) =>
        startSelfServeAtomic({ emailNormalized, timeZone: null, mode: "open" })
      )
    );

    assert.equal(outcomes.filter((outcome) => outcome === "admitted").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome === "waitlisted").length, 7);
    assert.equal(await count("SELECT count(*) AS n FROM exomem_invites WHERE self_serve"), 1);
    assert.equal(
      await count("SELECT count(*) AS n FROM exomem_waitlist_entries WHERE admitted_at IS NULL"),
      7
    );

    // A slot frees while people wait: a newcomer still joins the back.
    await configureCapacity(2);
    const newcomer = newAddress("newcomer");
    assert.equal(
      await startSelfServeAtomic({ emailNormalized: newcomer, timeZone: null, mode: "open" }),
      "waitlisted"
    );
    assert.equal(await count("SELECT count(*) AS n FROM exomem_invites WHERE self_serve"), 1);
    const last = await pool!.query<{ email_normalized: string }>(
      "SELECT email_normalized FROM exomem_waitlist_entries ORDER BY created_at DESC, id DESC LIMIT 1"
    );
    assert.equal(last.rows[0]!.email_normalized, newcomer);
  });

  it("promotes the oldest waiting person once when a slot frees, with exactly one email, and only while open", async () => {
    await configureCapacity(1);
    const holder = newAddress("holder");
    const nowAnOwner = newAddress("now-an-owner");
    const first = newAddress("first-waiting");
    const second = newAddress("second-waiting");
    for (const emailNormalized of [holder, nowAnOwner, first, second]) {
      await startSelfServeAtomic({ emailNormalized, timeZone: null, mode: "open" });
    }
    // The oldest waiting address came to own an Exomem another way.
    const owner = await pool!.query<{ id: string }>(
      "INSERT INTO users (email, email_verified_at) VALUES ($1, now()) RETURNING id",
      [nowAnOwner]
    );
    await pool!.query(
      "INSERT INTO exomem_tenants (owner_user_id, status, desired_state) VALUES ($1, 'active', 'running')",
      [owner.rows[0]!.id]
    );
    await configureCapacity(2);

    assert.deepEqual(await promoteWaitlistedPeople({ mode: "waitlist" }), {
      status: "not_open",
      promoted: null,
      settled: null,
    });
    assert.equal(
      await count(
        "SELECT count(*) AS n FROM exomem_waitlist_entries WHERE admitted_at IS NOT NULL"
      ),
      0
    );

    const runs = await Promise.all([
      promoteWaitlistedPeople({ mode: "open" }),
      promoteWaitlistedPeople({ mode: "open" }),
    ]);

    assert.equal(
      runs.reduce((total, run) => total + (run.promoted ?? 0), 0),
      1
    );
    assert.equal(
      runs.reduce((total, run) => total + (run.settled ?? 0), 0),
      1
    );
    const entries = await pool!.query<{ email_normalized: string; admitted: boolean }>(
      "SELECT email_normalized, admitted_at IS NOT NULL AS admitted FROM exomem_waitlist_entries ORDER BY created_at, id"
    );
    assert.deepEqual(
      entries.rows.map((row) => [row.email_normalized, row.admitted]),
      [
        [first, true],
        [second, false],
      ]
    );
    assert.equal(
      await count("SELECT count(*) AS n FROM exomem_email_outbox WHERE kind = 'place_opened'"),
      1
    );
    assert.equal(
      await count(
        "SELECT count(*) AS n FROM exomem_email_outbox WHERE kind = 'place_opened' AND recipient = $1",
        [first]
      ),
      1
    );
  });

  it("queues a newcomer and promotes nobody once the hour's self-serve admissions are used, while places are free", async () => {
    await configureCapacity(5);
    process.env.EXOMEM_SELF_SERVE_ADMISSIONS_PER_HOUR = "1";
    const paced = newAddress("paced");
    const logs: string[] = [];
    setOperationalEventSinkForTests((line) => logs.push(line));
    try {
      assert.equal(
        await startSelfServeAtomic({
          emailNormalized: newAddress("first"),
          timeZone: null,
          mode: "open",
        }),
        "admitted"
      );
      assert.equal(
        await startSelfServeAtomic({ emailNormalized: paced, timeZone: null, mode: "open" }),
        "waitlisted"
      );
      assert.deepEqual(await promoteWaitlistedPeople({ mode: "open" }), {
        status: "ran",
        promoted: 0,
        settled: 0,
      });
    } finally {
      setOperationalEventSinkForTests(null);
    }

    // Queued exactly as a full Cloud queues: a waitlist place and its one email.
    assert.equal(await count("SELECT count(*) AS n FROM exomem_invites WHERE self_serve"), 1);
    assert.equal(
      await count(
        "SELECT count(*) AS n FROM exomem_waitlist_entries WHERE email_normalized = $1 AND admitted_at IS NULL",
        [paced]
      ),
      1
    );
    assert.equal(
      await count(
        "SELECT count(*) AS n FROM exomem_email_outbox WHERE kind = 'waitlist' AND recipient = $1",
        [paced]
      ),
      1
    );
    // Each refusal raises the alert, and the alert names nobody.
    const alerts = logs.filter((line) => JSON.parse(line).event === "access.start.admission_paced");
    assert.equal(alerts.length, 2);
    assert.equal(alerts.join(" ").includes(paced), false);

    // The next hour, the queue moves again.
    await pool!.query(
      "UPDATE exomem_rate_limit_buckets SET window_started_at = now() - interval '2 hours'"
    );
    assert.deepEqual(await promoteWaitlistedPeople({ mode: "open" }), {
      status: "ran",
      promoted: 1,
      settled: 0,
    });
  });

  it("refuses an unknown invitation without waiting on the capacity lock", async () => {
    await configureCapacity(1);
    const holder = await pool!.connect();
    try {
      await holder.query("BEGIN");
      await lockCloudCapacity(taggedSql(holder));
      const answer = await Promise.race([
        redeemCloudInviteAtomic({
          tokenDigest: randomBytes(32),
          sessionDigest: randomBytes(32),
          csrfDigest: randomBytes(32),
          sessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        }),
        new Promise((resolve) => setTimeout(resolve, 2_000, "waited on the lock")),
      ]);
      assert.equal(answer, null);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });

  it("keeps a waiting person's place when they ask again, and sends the back of the queue to one whose link lapsed", async () => {
    await configureCapacity(0);
    const early = newAddress("early");
    const later = newAddress("later");
    await startSelfServeAtomic({ emailNormalized: early, timeZone: "Europe/Paris", mode: "open" });
    await startSelfServeAtomic({ emailNormalized: later, timeZone: null, mode: "open" });
    const before = await pool!.query<{ id: string }>(
      "SELECT id FROM exomem_waitlist_entries WHERE email_normalized = $1",
      [early]
    );

    await startSelfServeAtomic({ emailNormalized: early, timeZone: "Asia/Kolkata", mode: "open" });

    const after = await pool!.query<{ id: string; time_zone: string }>(
      "SELECT id, time_zone FROM exomem_waitlist_entries WHERE email_normalized = $1",
      [early]
    );
    assert.equal(after.rows[0]!.id, before.rows[0]!.id);
    // A start request carries the zone only for delivery, never for a stored preference.
    assert.equal(after.rows[0]!.time_zone, null);
    // One waitlist email per entry, however often they ask.
    assert.equal(
      await count(
        "SELECT count(*) AS n FROM exomem_email_outbox WHERE kind = 'waitlist' AND recipient = $1",
        [early]
      ),
      1
    );

    // The early person is promoted, lets the start link lapse, and asks again.
    await configureCapacity(1);
    assert.deepEqual(await promoteWaitlistedPeople({ mode: "open" }), {
      status: "ran",
      promoted: 1,
      settled: 0,
    });
    await pool!.query(
      "UPDATE exomem_invites SET created_at = now() - interval '3 days', expires_at = now() - interval '1 hour' WHERE email_normalized = $1",
      [early]
    );
    await configureCapacity(0);
    await startSelfServeAtomic({ emailNormalized: early, timeZone: null, mode: "open" });

    const queue = await pool!.query<{ email_normalized: string }>(
      "SELECT email_normalized FROM exomem_waitlist_entries WHERE admitted_at IS NULL ORDER BY created_at, id"
    );
    assert.deepEqual(
      queue.rows.map((row) => row.email_normalized),
      [later, early]
    );
  });

  it("adds a same-expiry link on a repeat request, keeps the earlier one, counts the address once, and revokes the rest on use", async () => {
    await configureCapacity(2);
    const repeater = newAddress("repeater");
    assert.equal(
      await startSelfServeAtomic({ emailNormalized: repeater, timeZone: null, mode: "open" }),
      "admitted"
    );
    assert.equal(
      await startSelfServeAtomic({ emailNormalized: repeater, timeZone: null, mode: "open" }),
      "reissued"
    );
    const links = await pool!.query<{ token_digest: Buffer; expires_at: string }>(
      "SELECT token_digest, expires_at::text FROM exomem_invites WHERE email_normalized = $1 AND revoked_at IS NULL ORDER BY created_at",
      [repeater]
    );
    assert.equal(links.rows.length, 2);
    assert.equal(links.rows[0]!.expires_at, links.rows[1]!.expires_at);

    // Two links, one address, one place: the second place is still free.
    assert.equal(
      await startSelfServeAtomic({
        emailNormalized: newAddress("next"),
        timeZone: null,
        mode: "open",
      }),
      "admitted"
    );
    assert.equal(
      await startSelfServeAtomic({
        emailNormalized: newAddress("last"),
        timeZone: null,
        mode: "open",
      }),
      "waitlisted"
    );

    const redeemed = await redeemCloudInviteAtomic({
      tokenDigest: links.rows[0]!.token_digest,
      sessionDigest: randomBytes(32),
      csrfDigest: randomBytes(32),
      sessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    assert.ok(redeemed);
    assert.equal(
      await count(
        "SELECT count(*) AS n FROM exomem_invites WHERE email_normalized = $1 AND consumed_at IS NULL AND revoked_at IS NULL",
        [repeater]
      ),
      0
    );
  });

  // Asking again hands out a younger link. If Cloud then shrinks, the person
  // must still redeem in the turn their first link gave them.
  it("redeems a person who asked again in their first link's turn when capacity shrinks", async () => {
    await configureCapacity(2);
    const early = newAddress("early");
    const later = newAddress("later");
    await startSelfServeAtomic({ emailNormalized: early, timeZone: null, mode: "open" });
    await startSelfServeAtomic({ emailNormalized: later, timeZone: null, mode: "open" });
    assert.equal(
      await startSelfServeAtomic({ emailNormalized: early, timeZone: null, mode: "open" }),
      "reissued"
    );
    await configureCapacity(1);
    const earlyNewest = await pool!.query<{ token_digest: Buffer }>(
      "SELECT token_digest FROM exomem_invites WHERE email_normalized = $1 ORDER BY created_at DESC LIMIT 1",
      [early]
    );
    const laterLink = await pool!.query<{ token_digest: Buffer }>(
      "SELECT token_digest FROM exomem_invites WHERE email_normalized = $1",
      [later]
    );
    const redemption = (tokenDigest: Buffer) => ({
      tokenDigest,
      sessionDigest: randomBytes(32),
      csrfDigest: randomBytes(32),
      sessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    assert.ok(await redeemCloudInviteAtomic(redemption(earlyNewest.rows[0]!.token_digest)));
    await assert.rejects(
      redeemCloudInviteAtomic(redemption(laterLink.rows[0]!.token_digest)),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "HOSTED_ADMISSION_CLOSED"
    );
  });

  it("keeps retrying a start link through a provider outage until the link itself expires", async () => {
    await configureCapacity(1);
    const email = newAddress("outage");
    await startSelfServeAtomic({ emailNormalized: email, timeZone: null, mode: "open" });
    const providerDown = async () => ({ success: false });
    // Twenty failed attempts already: far past any fixed attempt budget.
    await pool!.query("UPDATE exomem_email_outbox SET attempts = 20 WHERE recipient = $1", [email]);

    const duringOutage = await drainExomemEmailOutbox({}, { sendEmail: providerDown });

    assert.equal(duringOutage.retryScheduled, 1);
    assert.equal(
      await count(
        "SELECT count(*) AS n FROM exomem_invites WHERE email_normalized = $1 AND revoked_at IS NULL",
        [email]
      ),
      1
    );

    // Once the link expires before the next retry, the email fails and the
    // place returns. The last answer was a refusal, and the link records the
    // same cause as its email.
    await pool!.query(
      "UPDATE exomem_email_outbox SET not_before = now(), expires_at = now() + interval '30 seconds' WHERE recipient = $1",
      [email]
    );
    const atDeadline = await drainExomemEmailOutbox(
      {},
      { sendEmail: async () => ({ success: false, status: 400 }) }
    );
    assert.equal(atDeadline.failed, 1);
    const settled = await pool!.query<{ email_code: string; link_code: string }>(
      `SELECT outbox.last_error_code AS email_code, link.delivery_error_code AS link_code
       FROM exomem_email_outbox AS outbox
       JOIN exomem_invites AS link ON link.email_normalized = outbox.recipient
       WHERE outbox.recipient = $1 AND link.revoked_at IS NOT NULL`,
      [email]
    );
    assert.deepEqual(settled.rows, [{ email_code: "EMAIL_REFUSED", link_code: "EMAIL_REFUSED" }]);
  });

  // A refused waitlist email costs nobody their place, so it fails at once. A
  // refused start link retries: failing it would revoke the link and its place.
  for (const [kind, status, settles] of [
    ["waitlist", 400, true],
    ["waitlist", 503, false],
    ["start", 400, false],
  ] as const) {
    it(`${settles ? "fails at once" : "retries"} a ${kind} email the provider answers ${status}`, async () => {
      await configureCapacity(kind === "start" ? 1 : 0);
      const email = newAddress(`${kind}-${status}`);
      await startSelfServeAtomic({ emailNormalized: email, timeZone: null, mode: "open" });

      const drained = await drainExomemEmailOutbox(
        {},
        { sendEmail: async () => ({ success: false, status }) }
      );

      assert.equal(drained.failed, settles ? 1 : 0);
      assert.equal(drained.retryScheduled, settles ? 0 : 1);
      const row = await pool!.query<{ kind: string; state: string; last_error_code: string }>(
        "SELECT kind, state, last_error_code FROM exomem_email_outbox WHERE recipient = $1",
        [email]
      );
      assert.deepEqual(row.rows[0], {
        kind,
        state: settles ? "failed" : "pending",
        last_error_code: status === 400 ? "EMAIL_REFUSED" : "EMAIL_DELIVERY_UNAVAILABLE",
      });
      // The person keeps what they had: a place in the queue, or a live start link.
      assert.equal(
        await count(
          kind === "start"
            ? "SELECT count(*) AS n FROM exomem_invites WHERE email_normalized = $1 AND revoked_at IS NULL"
            : "SELECT count(*) AS n FROM exomem_waitlist_entries WHERE email_normalized = $1 AND admitted_at IS NULL",
          [email]
        ),
        1
      );
    });
  }

  it("sends a start link ahead of an older waitlist email", async () => {
    await configureCapacity(1);
    const admitted = newAddress("admitted");
    const waiting = newAddress("waiting");
    await startSelfServeAtomic({ emailNormalized: admitted, timeZone: null, mode: "open" });
    await startSelfServeAtomic({ emailNormalized: waiting, timeZone: null, mode: "open" });
    await pool!.query(
      "UPDATE exomem_email_outbox SET created_at = now() - interval '1 hour', not_before = now() - interval '1 hour' WHERE recipient = $1",
      [waiting]
    );
    const sentTo: string[] = [];

    await drainExomemEmailOutbox(
      { maxMessages: 1 },
      {
        sendEmail: async (input) => {
          sentTo.push(input.to);
          return { success: true };
        },
      }
    );

    assert.deepEqual(sentTo, [admitted]);
  });

  it("clears settled email addresses after 30 days and deletes waitlist entries 180 days after their last activity", async () => {
    await configureCapacity(0);
    const stale = newAddress("stale");
    const recent = newAddress("recent");
    const recentLink = newAddress("recent-link");
    const owner = newAddress("owner");
    for (const emailNormalized of [stale, recent, recentLink, owner]) {
      await startSelfServeAtomic({ emailNormalized, timeZone: null, mode: "open" });
    }
    await drainExomemEmailOutbox({}, { sendEmail: async () => ({ success: true }) });
    await pool!.query(
      "UPDATE exomem_email_outbox SET updated_at = now() - interval '31 days' WHERE recipient = $1",
      [stale]
    );
    await pool!.query(
      "UPDATE exomem_waitlist_entries SET updated_at = now() - interval '181 days' WHERE email_normalized = ANY($1)",
      [[stale, recentLink, owner]]
    );
    // Their last request is old, but their start link lapsed only 10 days ago.
    await pool!.query(
      `INSERT INTO exomem_invites (
         token_digest, email_normalized, entitlement_source, entitlement_capabilities,
         entitlement_limits, created_by_principal_digest, created_at, expires_at, self_serve
       ) VALUES ($1, $2, 'paddle', '[]'::jsonb, '{}'::jsonb, $3,
                 now() - interval '12 days', now() - interval '10 days', true)`,
      [randomBytes(32), recentLink, randomBytes(32)]
    );
    // An address that owns an Exomem keeps its entry; account deletion removes it.
    const ownerUser = await pool!.query<{ id: string }>(
      "INSERT INTO users (email, email_verified_at) VALUES ($1, now()) RETURNING id",
      [owner]
    );
    await pool!.query(
      "INSERT INTO exomem_tenants (owner_user_id, status, desired_state) VALUES ($1, 'active', 'running')",
      [ownerUser.rows[0]!.id]
    );

    assert.equal(await clearSettledEmailRecipients(), 1);
    assert.deepEqual(await pruneStaleSelfServeRecords(), { waitlistEntries: 1, startLinks: 0 });

    const cleared = await pool!.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM exomem_email_outbox WHERE recipient IS NULL"
    );
    assert.equal(cleared.rows[0]!.n, 1);
    assert.equal(
      await count("SELECT count(*) AS n FROM exomem_email_outbox WHERE recipient = $1", [stale]),
      0
    );
    const kept = await pool!.query<{ email_normalized: string }>(
      "SELECT email_normalized FROM exomem_waitlist_entries"
    );
    assert.deepEqual(
      kept.rows.map((row) => row.email_normalized).sort(),
      [owner, recent, recentLink].sort()
    );
  });

  it("deletes a non-customer's unused start links 180 days after their last activity, and keeps the rest", async () => {
    async function linkExpired200DaysAgo(
      email: string,
      kind: { selfServe: boolean; revoked: boolean }
    ): Promise<string> {
      const { rows } = await pool!.query<{ id: string }>(
        `INSERT INTO exomem_invites (
           token_digest, email_normalized, entitlement_source, entitlement_capabilities,
           entitlement_limits, created_by_principal_digest, created_at, expires_at,
           revoked_at, self_serve
         ) VALUES ($1, $2, 'paddle', '[]'::jsonb, '{}'::jsonb, $3,
                   now() - interval '202 days', now() - interval '200 days',
                   CASE WHEN $4 THEN now() - interval '201 days' END, $5)
         RETURNING id`,
        [randomBytes(32), email, randomBytes(32), kind.revoked, kind.selfServe]
      );
      return rows[0]!.id;
    }
    // Promoted, asked again, then let both links lapse: the admitted entry
    // names one of the links it is deleted with.
    const lapsed = newAddress("lapsed");
    await linkExpired200DaysAgo(lapsed, { selfServe: true, revoked: true });
    const promotedLink = await linkExpired200DaysAgo(lapsed, { selfServe: true, revoked: false });
    await pool!.query(
      `INSERT INTO exomem_waitlist_entries (email_normalized, created_at, updated_at, admitted_at, admitted_invite_id)
       VALUES ($1, now() - interval '210 days', now() - interval '203 days', now() - interval '203 days', $2)`,
      [lapsed, promotedLink]
    );
    // An old link, but the person asked again 10 days ago.
    const askedAgain = newAddress("asked-again");
    await linkExpired200DaysAgo(askedAgain, { selfServe: true, revoked: false });
    await pool!.query(
      `INSERT INTO exomem_waitlist_entries (email_normalized, created_at, updated_at)
       VALUES ($1, now() - interval '10 days', now() - interval '10 days')`,
      [askedAgain]
    );
    // A customer's spare link, and an operator invitation nobody used.
    const customer = newAddress("customer");
    await linkExpired200DaysAgo(customer, { selfServe: true, revoked: true });
    const customerUser = await pool!.query<{ id: string }>(
      "INSERT INTO users (email, email_verified_at) VALUES ($1, now()) RETURNING id",
      [customer]
    );
    await pool!.query(
      "INSERT INTO exomem_tenants (owner_user_id, status, desired_state) VALUES ($1, 'active', 'running')",
      [customerUser.rows[0]!.id]
    );
    const invited = newAddress("invited");
    await linkExpired200DaysAgo(invited, { selfServe: false, revoked: false });

    assert.deepEqual(await pruneStaleSelfServeRecords(), { waitlistEntries: 1, startLinks: 2 });

    const links = await pool!.query<{ email_normalized: string }>(
      "SELECT email_normalized FROM exomem_invites"
    );
    assert.deepEqual(
      links.rows.map((row) => row.email_normalized).sort(),
      [askedAgain, customer, invited].sort()
    );
    const entries = await pool!.query<{ email_normalized: string }>(
      "SELECT email_normalized FROM exomem_waitlist_entries"
    );
    assert.deepEqual(
      entries.rows.map((row) => row.email_normalized),
      [askedAgain]
    );
  });

  it("shows the operator the free places admission uses, and unknown when capacity is stale", async () => {
    await configureCapacity(3);
    const repeater = newAddress("repeater");
    await startSelfServeAtomic({ emailNormalized: repeater, timeZone: null, mode: "open" });
    await startSelfServeAtomic({ emailNormalized: repeater, timeZone: null, mode: "open" });

    const observed = await getCloudCapacityStatus(executeExomemSql);
    assert.equal(observed.freePlaces, 2);
    assert.equal(observed.outstandingInvitations, 1);

    await pool!.query(
      "UPDATE exomem_cloud_capacity SET observed_at = now() - interval '10 minutes'"
    );
    const stale = await getCloudCapacityStatus(executeExomemSql);
    assert.equal(stale.freePlaces, null);
    assert.equal(stale.freePlacesUnknownReason, "capacity_not_observed");
  });

  it("sends a start link once, and cancels one whose link was revoked before it went out", async () => {
    await configureCapacity(2);
    const kept = newAddress("kept");
    const revoked = newAddress("revoked");
    await startSelfServeAtomic({ emailNormalized: kept, timeZone: "Europe/Paris", mode: "open" });
    await startSelfServeAtomic({ emailNormalized: revoked, timeZone: null, mode: "open" });
    await pool!.query("UPDATE exomem_invites SET revoked_at = now() WHERE email_normalized = $1", [
      revoked,
    ]);
    const sent: Array<{ to: string; textContent: string }> = [];
    const sendEmail = async (input: { to: string; textContent: string }) => {
      sent.push({ to: input.to, textContent: input.textContent });
      return { success: true, messageId: "message-1" };
    };

    const firstDrain = await drainExomemEmailOutbox({}, { sendEmail });
    const secondDrain = await drainExomemEmailOutbox({}, { sendEmail });

    assert.equal(firstDrain.sent, 1);
    assert.equal(firstDrain.cancelled, 1);
    assert.equal(secondDrain.claimed, 0);
    assert.deepEqual(
      sent.map((email) => email.to),
      [kept]
    );
    assert.match(sent[0]!.textContent, /https:\/\/substratesystems\.io\/exomem\/invite#/);
    // The time limit is the requester's Paris time, not UTC.
    const link = await pool!.query<{ expires_at: Date }>(
      "SELECT expires_at FROM exomem_invites WHERE email_normalized = $1",
      [kept]
    );
    const parisTime = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Paris",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(link.rows[0]!.expires_at);
    assert.match(sent[0]!.textContent, new RegExp(`until \\d+ \\w+, ${parisTime} \\(`));
    const settled = await pool!.query<{ recipient: string; state: string; has_payload: boolean }>(
      "SELECT recipient::text, state, payload_ciphertext IS NOT NULL AS has_payload FROM exomem_email_outbox ORDER BY recipient"
    );
    assert.deepEqual(
      Object.fromEntries(settled.rows.map((row) => [row.recipient, [row.state, row.has_payload]])),
      { [kept]: ["sent", false], [revoked]: ["cancelled", false] }
    );
  });

  // The count gives an address that already holds a cell no place; the issue
  // gate must agree, or a full Cloud refuses an existing customer's invite.
  it("issues an operator invite to an address that already holds a Cloud cell, even when Cloud is full", async () => {
    await configureCapacity(1);
    const customer = newAddress("customer");
    const operatorInvite = (tokenDigest: Buffer) =>
      createInviteRecord({
        tokenDigest,
        emailNormalized: customer,
        entitlementSource: "complimentary",
        capabilities: EXOMEM_INVITE_CAPABILITIES,
        resourceLimits: EXOMEM_INVITE_LIMITS,
        operatorPrincipalDigest: randomBytes(32),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
    const first = randomBytes(32);
    await operatorInvite(first);
    assert.ok(
      await redeemCloudInviteAtomic({
        tokenDigest: first,
        sessionDigest: randomBytes(32),
        csrfDigest: randomBytes(32),
        sessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
    );

    await operatorInvite(randomBytes(32));

    const status = await getCloudCapacityStatus(executeExomemSql);
    assert.equal(status.freePlaces, 0);
    assert.equal(status.outstandingInvitations, 0);
  });

  for (const entitlementSource of ["paddle", "complimentary"] as const) {
    it(`refuses a ${entitlementSource} operator invite when every Cloud place is already promised`, async () => {
      await configureCapacity(1);
      await startSelfServeAtomic({
        emailNormalized: newAddress("holder"),
        timeZone: null,
        mode: "open",
      });

      await assert.rejects(
        createInviteRecord({
          tokenDigest: randomBytes(32),
          emailNormalized: newAddress("invited"),
          entitlementSource,
          capabilities: [],
          resourceLimits: {},
          operatorPrincipalDigest: randomBytes(32),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        }),
        (error: unknown) =>
          error instanceof Error && "code" in error && error.code === "CAPACITY_UNAVAILABLE"
      );
      assert.equal(await count("SELECT count(*) AS n FROM exomem_invites WHERE NOT self_serve"), 0);
    });
  }
});
