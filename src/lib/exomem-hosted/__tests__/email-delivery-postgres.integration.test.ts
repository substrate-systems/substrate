import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import {
  claimMagicLinkDelivery,
  createInviteRecord,
  createMagicAccessToken,
  markMagicLinkDeliverySent,
  __setExomemSqlForTests,
  __setExomemTransactionForTests,
  type ExomemSql,
} from "../db";
import { readEmailDeliveryReport } from "../email-delivery-report";
import { pruneProviderEvents } from "../email-provider-events";
import { closeHealthProofPool, readHealthProof } from "../functional-health-store";
import { setOperationalEventSinkForTests } from "../observability";
import { EXOMEM_RATE_LIMITS } from "../rate-limit";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

// Email delivery you can see, against real PostgreSQL: the provider's webhook
// events, the report that joins them to the outboxes, and the health proof that
// reads real traffic. The mail provider's HTTP API is not called: each send is
// a function that answers as the provider does.

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
const DEFAULT_PROVIDER_ANSWER = { success: true, messageId: "<health@smtp-relay.example.com>" };
const providerAnswer: { success: boolean; messageId?: string } = { ...DEFAULT_PROVIDER_ANSWER };
const sentTo: string[] = [];
/** While set, the provider does not answer until it resolves: an outage that never refuses. */
let providerGate: Promise<void> | null = null;
mock.module("@/lib/brevo", {
  namedExports: {
    sendTransactionalEmail: async (input: { to: string }) => {
      sentTo.push(input.to);
      if (providerGate) await providerGate;
      return providerAnswer;
    },
  },
});
const CANARY = "canary@example.com";
const WEBHOOK_TOKEN = "synthetic-webhook-token";
let pool: Pool | undefined;
let runEmailHealthCheck: typeof import("../email-health-proof").runEmailHealthCheck;
let requestStart: typeof import("../access").requestStart;
let promoteWaitlistedPeople: typeof import("../self-serve-admission").promoteWaitlistedPeople;
let dispatchExomemEmail: typeof import("../email-outbox").dispatchExomemEmail;
let drainExomemEmailOutbox: typeof import("../email-outbox").drainExomemEmailOutbox;
let startSelfServeAtomic: typeof import("../self-serve-admission").startSelfServeAtomic;
let schema: string | undefined;
const priorEnv: Record<string, string | undefined> = {};

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

function webhookRequest(body: unknown, token: string | null = WEBHOOK_TOKEN): Request {
  return new Request("https://substratesystems.io/api/webhooks/brevo", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function postWebhook(body: unknown, token: string | null = WEBHOOK_TOKEN) {
  const { POST } = await import("../../../app/api/webhooks/brevo/route");
  return POST(webhookRequest(body, token) as unknown as import("next/server").NextRequest);
}

async function eventCount(): Promise<number> {
  const { rows } = await pool!.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM exomem_email_provider_events"
  );
  return rows[0]!.n;
}

/** A sent waitlist email, accepted `acceptedAgoSeconds` ago, `queueSeconds` after it was first due. */
async function insertSentEmail(input: {
  providerMessageId: string | null;
  acceptedAgoSeconds: number;
  queueSeconds: number;
}): Promise<{ id: string; sentAt: Date }> {
  // Whole milliseconds, so a test can name the exact gap to an event time.
  const { rows } = await pool!.query<{ id: string; sent_at: Date }>(
    `INSERT INTO exomem_email_outbox
       (kind, dedupe_key, recipient, state, created_at, due_at, sent_at, updated_at, provider_message_id)
     VALUES ('waitlist', $1, NULL, 'sent',
             date_trunc('milliseconds', now() - ($2::int + $3::int) * interval '1 second'),
             date_trunc('milliseconds', now() - ($2::int + $3::int) * interval '1 second'),
             date_trunc('milliseconds', now() - $2::int * interval '1 second'), now(), $4)
     RETURNING id, sent_at`,
    [`test:${randomUUID()}`, input.acceptedAgoSeconds, input.queueSeconds, input.providerMessageId]
  );
  return { id: rows[0]!.id, sentAt: rows[0]!.sent_at };
}

async function insertPendingEmail(input: { notBeforeSecondsAgo: number }): Promise<string> {
  const { rows } = await pool!.query<{ id: string }>(
    `INSERT INTO exomem_email_outbox
       (kind, dedupe_key, recipient, state, payload_ciphertext, not_before)
     VALUES ('waitlist', $1, $2, 'pending', '{}'::jsonb, now() - $3::int * interval '1 second')
     RETURNING id`,
    [`test:${randomUUID()}`, `person-${randomUUID()}@example.com`, input.notBeforeSecondsAgo]
  );
  return rows[0]!.id;
}

describe("Exomem email delivery evidence PostgreSQL integration", { skip: !databaseUrl }, () => {
  before(async () => {
    const env: Record<string, string | undefined> = {
      EXOMEM_CONTROL_PLANE_KEY: randomBytes(32).toString("base64url"),
      BREVO_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
      EXOMEM_HEALTH_START_CANARY_EMAIL: CANARY,
      EXOMEM_HEALTH_EMAIL_OVERDUE_SECONDS: undefined,
      EXOMEM_HEALTH_CANARY_QUEUE_SECONDS: undefined,
      EXOMEM_HEALTH_CANARY_DELIVERY_SECONDS: undefined,
      EXOMEM_PUBLIC_BASE_URL: "https://exomem.example.com",
      EXOMEM_SELF_SERVE_ADMISSION: undefined,
    };
    for (const [key, value] of Object.entries(env)) {
      priorEnv[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    schema = `email_delivery_it_${randomUUID().replaceAll("-", "")}`;
    await ensureExomemPostgresTestExtensions(databaseUrl!);
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);
    await applyMigrations({ databaseUrl: scoped.toString() });
    priorEnv.DATABASE_URL = process.env.DATABASE_URL;
    // The health proof reads through its own pool, which takes DATABASE_URL.
    process.env.DATABASE_URL = scoped.toString();
    // The name lets a test list this file's own backends in pg_stat_activity.
    scoped.searchParams.set("application_name", `${schema}`);
    pool = new Pool({ connectionString: scoped.toString(), max: 10 });
    __setExomemSqlForTests(taggedSql(pool));
    __setExomemTransactionForTests(interactiveTransaction);
    // These modules import the mail provider, so they load after it is mocked.
    ({ runEmailHealthCheck } = await import("../email-health-proof"));
    ({ requestStart } = await import("../access"));
    ({ dispatchExomemEmail, drainExomemEmailOutbox } = await import("../email-outbox"));
    ({ startSelfServeAtomic, promoteWaitlistedPeople } = await import("../self-serve-admission"));
  });

  after(async () => {
    __setExomemSqlForTests(null);
    __setExomemTransactionForTests(null);
    await closeHealthProofPool();
    if (pool) await pool.end();
    if (schema) {
      const admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    mock.reset();
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(async () => {
    process.env.BREVO_WEBHOOK_TOKEN = WEBHOOK_TOKEN;
    process.env.EXOMEM_HEALTH_START_CANARY_EMAIL = CANARY;
    delete process.env.EXOMEM_SELF_SERVE_ADMISSION;
    Object.assign(providerAnswer, DEFAULT_PROVIDER_ANSWER);
    sentTo.length = 0;
    providerGate = null;
    // The canary's requests count against the same limits as any start request.
    await pool!.query("DELETE FROM exomem_rate_limit_buckets");
    await pool!.query("DELETE FROM exomem_email_provider_events");
    await pool!.query("DELETE FROM exomem_email_outbox");
    await pool!.query("DELETE FROM exomem_access_delivery_outbox");
    await pool!.query("DELETE FROM exomem_access_tokens");
    await pool!.query("DELETE FROM exomem_waitlist_entries");
    await pool!.query("DELETE FROM exomem_tenants");
    await pool!.query("DELETE FROM exomem_users");
    await pool!.query("DELETE FROM exomem_health_proofs");
    await pool!.query("DELETE FROM exomem_invites");
    await pool!.query("DELETE FROM exomem_cloud_capacity");
  });

  describe("provider webhook", () => {
    it("stores nothing without the right token, or while no token is configured", async () => {
      const event = { event: "delivered", "message-id": "<a@b.example>", ts_epoch: Date.now() };
      assert.equal((await postWebhook(event, "wrong-token")).status, 401);
      assert.equal((await postWebhook(event, null)).status, 401);
      // A token of another length takes the same path: no early exit on length.
      assert.equal((await postWebhook(event, "x")).status, 401);
      delete process.env.BREVO_WEBHOOK_TOKEN;
      assert.equal((await postWebhook(event)).status, 503);
      assert.equal(await eventCount(), 0);
    });

    it("stores a redelivered event once, because the provider retries any answer but 200", async () => {
      const event = {
        event: "delivered",
        "message-id": "<a@b.example>",
        ts_epoch: 1_790_000_000_000,
      };
      const first = await postWebhook(event);
      assert.equal(first.status, 200);
      assert.deepEqual(await first.json(), { success: true, stored: 1, duplicates: 0, ignored: 0 });
      const again = await postWebhook(event);
      assert.equal(again.status, 200);
      assert.deepEqual(await again.json(), { success: true, stored: 0, duplicates: 1, ignored: 0 });
      assert.equal(await eventCount(), 1);
    });

    it("answers 200 and stores nothing for opens, clicks and events it does not know", async () => {
      for (const event of ["opened", "click", "proxy_open", "unique_opened", "invented_event"]) {
        const response = await postWebhook({
          event,
          "message-id": "<a@b.example>",
          ts_epoch: 1_790_000_000_000,
        });
        assert.equal(response.status, 200, event);
        assert.equal((await response.json()).ignored, 1, event);
      }
      assert.equal(await eventCount(), 0);
    });

    it("stores every event of a batched array, and reads seconds when milliseconds are absent", async () => {
      const response = await postWebhook([
        { event: "request", "message-id": "<m1@b.example>", ts_epoch: 1_790_000_000_000 },
        { event: "delivered", "message-id": "<m1@b.example>", ts_epoch: 1_790_000_003_000 },
        // No ts_epoch: the seconds fields stand in for it.
        { event: "soft_bounce", "message-id": "m2@b.example", ts_event: 1_790_000_005 },
        { event: "hard_bounce", "message-id": "<m3@b.example>", ts: 1_790_000_006 },
        { event: "opened", "message-id": "<m1@b.example>", ts_epoch: 1_790_000_007_000 },
      ]);
      assert.deepEqual(await response.json(), {
        success: true,
        stored: 4,
        duplicates: 0,
        ignored: 1,
      });
      const { rows } = await pool!.query<{
        provider_message_id: string;
        event: string;
        at: string;
      }>(
        `SELECT provider_message_id, event, (extract(epoch FROM occurred_at) * 1000)::bigint::text AS at
         FROM exomem_email_provider_events ORDER BY occurred_at`
      );
      assert.deepEqual(rows, [
        { provider_message_id: "m1@b.example", event: "request", at: "1790000000000" },
        { provider_message_id: "m1@b.example", event: "delivered", at: "1790000003000" },
        { provider_message_id: "m2@b.example", event: "soft_bounce", at: "1790000005000" },
        { provider_message_id: "m3@b.example", event: "hard_bounce", at: "1790000006000" },
      ]);
    });

    it("keeps no address, subject, reason or IP from what the provider sends", async () => {
      await postWebhook({
        event: "hard_bounce",
        email: "person@example.com",
        subject: "Your sign-in link",
        reason: "mailbox person@example.com does not exist",
        sending_ip: "203.0.113.9",
        tag: "campaign-tag",
        "message-id": "<a@b.example>",
        ts_epoch: 1_790_000_000_000,
      });
      const { rows } = await pool!.query<{ stored: string }>(
        "SELECT row_to_json(e)::text AS stored FROM exomem_email_provider_events AS e"
      );
      assert.equal(rows.length, 1);
      for (const leaked of [
        "person@example.com",
        "sign-in",
        "mailbox",
        "203.0.113.9",
        "campaign",
      ]) {
        assert.equal(rows[0]!.stored.includes(leaked), false, leaked);
      }
      assert.deepEqual(Object.keys(JSON.parse(rows[0]!.stored)).sort(), [
        "event",
        "occurred_at",
        "provider_message_id",
        "received_at",
      ]);
    });

    it("answers 400 to a body that is not JSON, so the provider discards it", async () => {
      assert.equal((await postWebhook("{not json")).status, 400);
      assert.equal((await postWebhook(JSON.stringify("a string"))).status, 400);
      assert.equal(await eventCount(), 0);
    });

    it("deletes events 30 days after receipt, in a bounded batch, and keeps newer ones", async () => {
      await pool!.query(
        `INSERT INTO exomem_email_provider_events (provider_message_id, event, occurred_at, received_at)
         VALUES ('old-1', 'delivered', now() - interval '40 days', now() - interval '31 days'),
                ('old-2', 'delivered', now() - interval '40 days', now() - interval '35 days'),
                ('new-1', 'delivered', now(), now())`
      );
      assert.equal(await pruneProviderEvents(1), 1);
      assert.equal(await pruneProviderEvents(), 1);
      assert.equal(await eventCount(), 1);
    });
  });

  describe("delivery report", () => {
    it("says delivery is unknown, not zero, until the provider has reported an event", async () => {
      await insertSentEmail({
        providerMessageId: "m1@b.example",
        acceptedAgoSeconds: 600,
        queueSeconds: 2,
      });
      const report = await readEmailDeliveryReport(24);
      assert.equal(report.deliveryEvidence, "none_received");
      assert.equal(report.providerEventsSince, null);
      const waitlist = report.kinds.find((kind) => kind.kind === "waitlist");
      assert.ok(waitlist);
      assert.equal(waitlist.sent, 1);
      assert.equal(waitlist.delivery, null);
      assert.equal(waitlist.queueToAccepted.p50Ms, 2_000);
    });

    it("joins a delivered event to the email it names and reports accepted-to-delivered time", async () => {
      const a = await insertSentEmail({
        providerMessageId: "m1@b.example",
        acceptedAgoSeconds: 600,
        queueSeconds: 1,
      });
      const b = await insertSentEmail({
        providerMessageId: "m2@b.example",
        acceptedAgoSeconds: 500,
        queueSeconds: 3,
      });
      await insertSentEmail({ providerMessageId: null, acceptedAgoSeconds: 400, queueSeconds: 1 });
      // The provider names ids with angle brackets, and the report matches them bare.
      await postWebhook([
        {
          event: "delivered",
          "message-id": "<m1@b.example>",
          ts_epoch: a.sentAt.getTime() + 4_000,
        },
        { event: "delivered", "message-id": "m2@b.example", ts_epoch: b.sentAt.getTime() + 6_000 },
        { event: "deferred", "message-id": "<m2@b.example>", ts_epoch: b.sentAt.getTime() + 1_000 },
        { event: "delivered", "message-id": "<nobody@b.example>", ts_epoch: Date.now() },
      ]);
      // The webhook began just now, so it cannot speak for the first part of a 24 hour window.
      assert.equal((await readEmailDeliveryReport(24)).deliveryEvidence, "received_partial_window");
      await pool!.query(
        "UPDATE exomem_email_provider_events SET received_at = now() - interval '3 days' WHERE provider_message_id = 'm1@b.example'"
      );
      const report = await readEmailDeliveryReport(24);
      assert.equal(report.deliveryEvidence, "received");
      const waitlist = report.kinds.find((kind) => kind.kind === "waitlist");
      assert.ok(waitlist?.delivery);
      assert.equal(waitlist.sent, 3);
      assert.equal(waitlist.acceptedWithoutProviderId, 1);
      assert.equal(waitlist.delivery.delivered, 2);
      assert.equal(waitlist.delivery.deferred, 1);
      assert.equal(waitlist.delivery.hardBounce, 0);
      assert.deepEqual(waitlist.delivery.acceptedToDelivered, {
        p50Ms: 5_000,
        p95Ms: 5_900,
        samples: 2,
      });
      assert.equal(waitlist.queueToAccepted.samples, 3);
    });

    it("leaves the canary out of the per-kind numbers and reports it in a section of its own", async () => {
      assert.equal(await runEmailHealthCheck(), true);
      await insertSentEmail({
        providerMessageId: "m1@b.example",
        acceptedAgoSeconds: 600,
        queueSeconds: 2,
      });
      await postWebhook({
        event: "delivered",
        "message-id": "<health@smtp-relay.example.com>",
        ts_epoch: Date.now() + 1_000,
      });

      const report = await readEmailDeliveryReport(24);
      const waitlist = report.kinds.find((kind) => kind.kind === "waitlist");
      assert.equal(waitlist?.queued, 1);
      assert.equal(waitlist?.sent, 1);
      // The one delivery event the provider reported is the canary's, so none counts for real mail.
      assert.equal(waitlist?.delivery?.delivered, 0);
      assert.equal(report.canary.configured, true);
      assert.deepEqual(report.canary.bounds, { queueSeconds: 60, deliverySeconds: 600 });
      assert.equal(report.canary.runs.length, 1);
      const [run] = report.canary.runs;
      assert.equal(run!.kind, "waitlist");
      assert.equal(run!.outcome, "passed");
      assert.equal(typeof run!.queueSeconds, "number");
      assert.equal(typeof run!.deliverySeconds, "number");
    });

    it("says that no canary is sent, instead of listing no runs, when none is configured", async () => {
      delete process.env.EXOMEM_HEALTH_START_CANARY_EMAIL;
      const report = await readEmailDeliveryReport(24);
      assert.equal(report.canary.configured, false);
      assert.match(report.canary.reason ?? "", /EXOMEM_HEALTH_START_CANARY_EMAIL/);
      assert.deepEqual(report.canary.runs, []);
    });

    it("names the window, the backlog that is past due, and a sign-in link as its own kind", async () => {
      await insertPendingEmail({ notBeforeSecondsAgo: 900 });
      const owner = `owner-${randomUUID()}@example.com`;
      const user = await pool!.query<{ id: string }>(
        "INSERT INTO exomem_users (email, email_verified_at) VALUES ($1, now()) RETURNING id",
        [owner]
      );
      await pool!.query(
        "INSERT INTO exomem_tenants (owner_user_id, status, desired_state) VALUES ($1, 'active', 'running')",
        [user.rows[0]!.id]
      );
      const link = await createMagicAccessToken({
        emailNormalized: owner,
        tokenDigest: randomBytes(32),
        browserChallengeDigest: randomBytes(32),
        expiresAt: new Date(Date.now() + 15 * 60_000),
        deliverySecretCiphertext: {
          version: 1,
          algorithm: "A256GCM",
          iv: "i",
          ciphertext: "c",
          tag: "t",
        },
      });
      assert.ok(link);
      const leaseOwner = randomUUID();
      assert.ok(await claimMagicLinkDelivery({ leaseOwner, deliveryId: link.deliveryId }));
      assert.equal(
        await markMagicLinkDeliverySent({
          deliveryId: link.deliveryId,
          leaseOwner,
          providerMessageId: "link-1@b.example",
        }),
        true
      );
      const report = await readEmailDeliveryReport(48);
      assert.equal(report.window.hours, 48);
      assert.deepEqual(report.sources.queue, [
        "exomem_email_outbox",
        "exomem_access_delivery_outbox",
      ]);
      const waitlist = report.kinds.find((kind) => kind.kind === "waitlist");
      assert.equal(waitlist?.pending, 1);
      assert.equal(waitlist?.pendingPastDue, 1);
      const magicLink = report.kinds.find((kind) => kind.kind === "magic_link");
      assert.equal(magicLink?.sent, 1);
      assert.equal(magicLink?.queueToAccepted.samples, 1);
      const stored = await pool!.query<{ provider_message_id: string }>(
        "SELECT provider_message_id FROM exomem_access_delivery_outbox"
      );
      assert.equal(stored.rows[0]!.provider_message_id, "link-1@b.example");
    });

    it("matches the id the provider gave on acceptance, brackets and all, with its later event", async () => {
      const entry = await startSelfServeAtomic({
        emailNormalized: `person-${randomUUID()}@example.com`,
        timeZone: null,
        mode: "waitlist",
      });
      assert.ok(entry.emailId);
      const delivery = await dispatchExomemEmail(entry.emailId, {
        sendEmail: async () => ({
          success: true,
          messageId: "<202611121200.1234.abcd@smtp-relay.example.com>",
        }),
      });
      assert.equal(delivery, "sent");
      const row = await pool!.query<{ provider_message_id: string; sent_at: Date }>(
        "SELECT provider_message_id, sent_at FROM exomem_email_outbox WHERE id = $1",
        [entry.emailId]
      );
      assert.equal(
        row.rows[0]!.provider_message_id,
        "202611121200.1234.abcd@smtp-relay.example.com"
      );
      await postWebhook({
        event: "delivered",
        "message-id": "<202611121200.1234.abcd@smtp-relay.example.com>",
        ts_epoch: row.rows[0]!.sent_at.getTime() + 2_000,
      });
      const report = await readEmailDeliveryReport(1);
      const waitlist = report.kinds.find((kind) => kind.kind === "waitlist");
      assert.equal(waitlist?.delivery?.delivered, 1);
      // sent_at keeps microseconds that a JavaScript date drops.
      assert.ok(Math.abs(waitlist!.delivery!.acceptedToDelivered.p50Ms! - 2_000) <= 1);
    });
  });

  describe("sign-in canary", () => {
    type CanaryRow = {
      id: string;
      kind: string;
      state: string;
      provider_message_id: string | null;
    };
    async function canaryEmails(): Promise<CanaryRow[]> {
      const { rows } = await pool!.query<CanaryRow>(
        `SELECT id, kind, state, provider_message_id FROM exomem_email_outbox
         WHERE recipient = $1 ORDER BY created_at, id`,
        [CANARY]
      );
      return rows;
    }
    /** Makes a sent canary look as if it was accepted `acceptedMinutesAgo` ago, `queueSeconds` after it was due. */
    async function ageEmail(
      id: string,
      input: { acceptedMinutesAgo: number; queueSeconds?: number }
    ) {
      const { rows } = await pool!.query<{ sent_at: Date }>(
        `UPDATE exomem_email_outbox
         SET created_at = now() - $2::int * interval '1 minute' - $3::int * interval '1 second',
             due_at = now() - $2::int * interval '1 minute' - $3::int * interval '1 second',
             sent_at = date_trunc('milliseconds', now() - $2::int * interval '1 minute')
         WHERE id = $1 RETURNING sent_at`,
        [id, input.acceptedMinutesAgo, input.queueSeconds ?? 1]
      );
      return rows[0]!.sent_at;
    }
    async function deliveredAfter(messageId: string, sentAt: Date, seconds: number) {
      await postWebhook({
        event: "delivered",
        "message-id": `<${messageId}>`,
        ts_epoch: sentAt.getTime() + seconds * 1000,
      });
    }
    function captureEvents(): { events: Array<Record<string, unknown>>; stop: () => void } {
      const events: Array<Record<string, unknown>> = [];
      setOperationalEventSinkForTests((line) => events.push(JSON.parse(line)));
      return { events, stop: () => setOperationalEventSinkForTests(null) };
    }
    const canaryEvents = (events: Array<Record<string, unknown>>) =>
      events.filter((event) => event.event === "access.start.canary_checked");
    async function seedFreeCloudCapacity() {
      await pool!.query(
        "INSERT INTO exomem_cloud_capacity (node, cell_slots, observed_at) VALUES ('node-canary', 50, now())"
      );
    }
    async function placesHeldBy(address: string): Promise<number> {
      const { rows } = await pool!.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM exomem_invites WHERE email_normalized = $1",
        [address]
      );
      return rows[0]!.n;
    }

    it("sends a canary through the start request at once and records the provider's acceptance", async () => {
      const captured = captureEvents();
      try {
        assert.equal(await runEmailHealthCheck(), true);
      } finally {
        captured.stop();
      }
      const emails = await canaryEmails();
      assert.equal(emails.length, 1);
      assert.equal(emails[0]!.kind, "waitlist");
      assert.equal(emails[0]!.state, "sent");
      assert.equal(emails[0]!.provider_message_id, "health@smtp-relay.example.com");
      assert.deepEqual(sentTo, [CANARY]);
      const [event] = canaryEvents(captured.events);
      assert.equal(event?.outcome, "succeeded");
      assert.equal(typeof event?.queueMs, "number");
      // No earlier canary exists, so no delivery time is known and none is invented.
      assert.equal(event?.deliveryMs, undefined);
      assert.equal(JSON.stringify(captured.events).includes(CANARY), false);
    });

    it("fails the next run when the previous canary was never reported delivered", async () => {
      assert.equal(await runEmailHealthCheck(), true);
      const [first] = await canaryEmails();
      await ageEmail(first!.id, { acceptedMinutesAgo: 30 });
      const captured = captureEvents();
      try {
        providerAnswer.messageId = "<canary-2@smtp-relay.example.com>";
        assert.equal(await runEmailHealthCheck(), false);
      } finally {
        captured.stop();
      }
      // The new canary was still sent, so the proof can recover on the run after it.
      assert.equal((await canaryEmails()).length, 2);
      assert.equal(canaryEvents(captured.events)[0]?.errorCode, "CANARY_NOT_DELIVERED");
    });

    it("passes the next run when the previous canary was reported delivered within ten minutes", async () => {
      assert.equal(await runEmailHealthCheck(), true);
      const [first] = await canaryEmails();
      const sentAt = await ageEmail(first!.id, { acceptedMinutesAgo: 30 });
      await deliveredAfter("health@smtp-relay.example.com", sentAt, 4);
      const captured = captureEvents();
      try {
        providerAnswer.messageId = "<canary-2@smtp-relay.example.com>";
        assert.equal(await runEmailHealthCheck(), true);
      } finally {
        captured.stop();
      }
      const [event] = canaryEvents(captured.events);
      assert.equal(event?.outcome, "succeeded");
      assert.equal(event?.deliveryMs, 4_000);
      assert.equal(event?.emailKind, "waitlist_still_waiting");
    });

    it("fails the next run when the previous canary was delivered later than ten minutes", async () => {
      assert.equal(await runEmailHealthCheck(), true);
      const [first] = await canaryEmails();
      const sentAt = await ageEmail(first!.id, { acceptedMinutesAgo: 30 });
      await deliveredAfter("health@smtp-relay.example.com", sentAt, 11 * 60);
      providerAnswer.messageId = "<canary-2@smtp-relay.example.com>";
      assert.equal(await runEmailHealthCheck(), false);
    });

    it("fails the next run when the provider took the previous canary more than a minute after it was due", async () => {
      assert.equal(await runEmailHealthCheck(), true);
      const [first] = await canaryEmails();
      const sentAt = await ageEmail(first!.id, { acceptedMinutesAgo: 30, queueSeconds: 120 });
      await deliveredAfter("health@smtp-relay.example.com", sentAt, 4);
      const captured = captureEvents();
      try {
        providerAnswer.messageId = "<canary-2@smtp-relay.example.com>";
        assert.equal(await runEmailHealthCheck(), false);
      } finally {
        captured.stop();
      }
      assert.equal(canaryEvents(captured.events)[0]?.errorCode, "CANARY_ACCEPTED_LATE");
    });

    it("does not fail a run that repeats within minutes of the last, before delivery can be judged", async () => {
      // A person triggering the check by hand must not turn the health proof red.
      for (const answer of ["<c1@smtp-relay.example.com>", "<c2@smtp-relay.example.com>"]) {
        providerAnswer.messageId = answer;
        assert.equal(await runEmailHealthCheck(), true);
      }
      // A third run in the same 15 minutes queues nothing new: that window's email already went out.
      assert.equal(await runEmailHealthCheck(), true);
    });

    async function makeCanaryAnOwner() {
      const user = await pool!.query<{ id: string }>(
        "INSERT INTO exomem_users (email, email_verified_at) VALUES ($1, now()) RETURNING id",
        [CANARY]
      );
      await pool!.query(
        "INSERT INTO exomem_tenants (owner_user_id, status, desired_state) VALUES ($1, 'active', 'running')",
        [user.rows[0]!.id]
      );
    }
    async function failedCode(run: () => Promise<boolean>): Promise<unknown> {
      const captured = captureEvents();
      try {
        assert.equal(await run(), false);
      } finally {
        captured.stop();
      }
      return canaryEvents(captured.events)[0]?.errorCode;
    }

    it("fails, naming the account, when the canary address becomes an owner within the window of a passing run", async () => {
      assert.equal(await runEmailHealthCheck(), true);
      await makeCanaryAnOwner();
      // A real sign-in link goes to this address now; a recent canary row must not hide that.
      assert.equal(await failedCode(runEmailHealthCheck), "CANARY_ADDRESS_HAS_ACCOUNT");
    });

    it("fails, naming the invitation, when the canary address holds an operator invitation", async () => {
      await seedFreeCloudCapacity();
      await createInviteRecord({
        tokenDigest: randomBytes(32),
        emailNormalized: CANARY,
        entitlementSource: "complimentary",
        capabilities: ["capture"],
        resourceLimits: { storageBytes: 1, uploadBytes: 1, workerCount: 0 },
        operatorPrincipalDigest: randomBytes(32),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      assert.equal(await failedCode(runEmailHealthCheck), "CANARY_ADDRESS_HAS_INVITATION");
    });

    it("fails when the start itself throws, though a canary email went out minutes ago", async () => {
      assert.equal(await runEmailHealthCheck(), true);
      __setExomemTransactionForTests(async () => {
        throw new Error("connection lost");
      });
      try {
        // Within the same window the start queues nothing, so only its own result can tell a repeat from a failure.
        assert.equal(await failedCode(runEmailHealthCheck), "CANARY_START_FAILED");
      } finally {
        __setExomemTransactionForTests(interactiveTransaction);
      }
    });

    it("fails every run of a window while the provider has not accepted its canary email, and passes once it has", async () => {
      providerAnswer.success = false;
      for (const run of [1, 2, 3]) {
        assert.equal(await failedCode(runEmailHealthCheck), "CANARY_NOT_ACCEPTED", `run ${run}`);
      }
      // The first run queued the waitlist email and the second the window's reply: neither was accepted.
      const queued = await canaryEmails();
      assert.deepEqual(
        queued.map((email) => [email.kind, email.state, email.provider_message_id]),
        [
          ["waitlist", "pending", null],
          ["waitlist_still_waiting", "pending", null],
        ]
      );
      // The provider recovers and the drain sends both; the next run of the window sees its reply accepted.
      providerAnswer.success = true;
      await pool!.query("UPDATE exomem_email_outbox SET not_before = now() WHERE recipient = $1", [
        CANARY,
      ]);
      for (const email of queued) assert.equal(await dispatchExomemEmail(email.id), "sent");
      assert.equal(await runEmailHealthCheck(), true);
    });

    it("fails with a timeout code, and saves the failed proof, while the Cloud capacity lock is held", async () => {
      const holder = await pool!.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock(hashtext('exomem-cloud-capacity'))");
        const startedAt = Date.now();
        assert.equal(await failedCode(runEmailHealthCheck), "CANARY_TIMED_OUT");
        // The scheduler gives a run 20 s; the lock wait is bounded well inside that.
        assert.ok(Date.now() - startedAt < 10_000);
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }
      assert.equal((await readHealthProof("email"))?.success, false);
    });

    it("leaves no canary transaction open when the owner lookup waits behind a table lock past the deadline", async () => {
      const holder = await pool!.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("LOCK TABLE exomem_tenants IN ACCESS EXCLUSIVE MODE");
        const startedAt = Date.now();
        // The deadline is shorter than the lock wait, so the abort comes while the lookup still waits.
        assert.equal(
          await failedCode(() => runEmailHealthCheck({ deadlineMs: 500 })),
          "CANARY_TIMED_OUT"
        );
        // The wait ends on its own limit, well inside the scheduler's 20 s.
        assert.ok(Date.now() - startedAt < 8_000);
        const { rows } = await pool!.query(
          `SELECT state, wait_event_type, left(query, 40) AS query FROM pg_stat_activity
           WHERE application_name = $1 AND pid <> pg_backend_pid() AND pid <> $2
             AND state <> 'idle'`,
          [schema, (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid]
        );
        assert.deepEqual(rows, []);
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }
      assert.equal((await readHealthProof("email"))?.success, false);
    });

    it("saves the failed proof soon after its deadline when a canary transaction never ends", async () => {
      // A pool with no free connection leaves a transaction waiting for one, with no limit to end it.
      __setExomemTransactionForTests(() => new Promise(() => {}));
      try {
        const startedAt = Date.now();
        assert.equal(
          await failedCode(() => runEmailHealthCheck({ deadlineMs: 500 })),
          "CANARY_TIMED_OUT"
        );
        assert.ok(Date.now() - startedAt < 8_000);
      } finally {
        __setExomemTransactionForTests(interactiveTransaction);
      }
      assert.equal((await readHealthProof("email"))?.success, false);
    });

    it("stops at its deadline, and saves the failed proof, when the provider never answers", async () => {
      let release!: () => void;
      providerGate = new Promise<void>((resolve) => (release = resolve));
      try {
        assert.equal(
          await failedCode(() => runEmailHealthCheck({ deadlineMs: 1_000 })),
          "CANARY_TIMED_OUT"
        );
        assert.equal((await readHealthProof("email"))?.success, false);
      } finally {
        release();
      }
    });

    it("fails, and sends nothing, when no usable canary address is configured", async () => {
      for (const value of [undefined, "   ", "not-an-address"]) {
        if (value === undefined) delete process.env.EXOMEM_HEALTH_START_CANARY_EMAIL;
        else process.env.EXOMEM_HEALTH_START_CANARY_EMAIL = value;
        assert.equal(await runEmailHealthCheck(), false, String(value));
      }
      assert.deepEqual(sentTo, []);
    });

    it("never gives the canary a Cloud place in open mode, nor promotes it into one", async () => {
      process.env.EXOMEM_SELF_SERVE_ADMISSION = "open";
      await seedFreeCloudCapacity();
      assert.equal(await runEmailHealthCheck(), true);
      // The canary is the oldest waiting entry; a real person waits behind it.
      const person = `person-${randomUUID()}@example.com`;
      await startSelfServeAtomic({ emailNormalized: person, timeZone: null, mode: "waitlist" });

      const promotion = await promoteWaitlistedPeople();
      assert.deepEqual(promotion, { status: "ran", promoted: 1, settled: 0 });
      assert.equal(await placesHeldBy(CANARY), 0);
      assert.equal(await placesHeldBy(person), 1);
      const entry = await pool!.query<{ admitted_at: Date | null }>(
        "SELECT admitted_at FROM exomem_waitlist_entries WHERE email_normalized = $1",
        [CANARY]
      );
      assert.equal(entry.rows[0]!.admitted_at, null);
    });

    it("gives the canary address no invitation and takes no admission pace when a person asks for it, in open mode with free capacity", async () => {
      process.env.EXOMEM_SELF_SERVE_ADMISSION = "open";
      await seedFreeCloudCapacity();
      // An ordinary public start: nothing of the cron's own path is involved.
      await requestStart({
        email: CANARY,
        networkKey: "203.0.113.9",
        browserChallengeDigest: randomBytes(32),
        timeZone: null,
        emailScheme: null,
      });
      assert.equal(await placesHeldBy(CANARY), 0);
      const pace = await pool!.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM exomem_rate_limit_buckets WHERE scope = $1",
        [EXOMEM_RATE_LIMITS.selfServeAdmission.scope]
      );
      assert.equal(pace.rows[0]!.n, 0);
      assert.deepEqual(
        (await canaryEmails()).map((email) => email.kind),
        ["waitlist"]
      );
    });

    it("lets a newcomer in at once in open mode while only the canary waits", async () => {
      process.env.EXOMEM_SELF_SERVE_ADMISSION = "open";
      await seedFreeCloudCapacity();
      assert.equal(await runEmailHealthCheck(), true);
      const person = `person-${randomUUID()}@example.com`;
      const result = await startSelfServeAtomic({
        emailNormalized: person,
        timeZone: null,
        mode: "open",
      });
      // A canary that counted as a person in the queue would make every newcomer wait for a promotion.
      assert.equal(result.outcome, "admitted");
    });
  });

  describe("email health proof", () => {
    const healthProof = () => runEmailHealthCheck();

    it("fails while a queued email has been ready but unsent for more than five minutes", async () => {
      assert.equal(await healthProof(), true);
      // Due ten minutes ago and never sent: the drain has stalled, whatever the provider says.
      await insertPendingEmail({ notBeforeSecondsAgo: 600 });
      assert.equal(await healthProof(), false);
    });

    it("does not fail for an email that is queued for later, or only just due", async () => {
      await insertPendingEmail({ notBeforeSecondsAgo: -86_400 });
      await insertPendingEmail({ notBeforeSecondsAgo: 60 });
      assert.equal(await healthProof(), true);
    });

    it("fails for an email that failed in the last hour, but not for one the provider refused", async () => {
      const refused = await insertPendingEmail({ notBeforeSecondsAgo: -3_600 });
      await pool!.query(
        `UPDATE exomem_email_outbox
         SET state = 'failed', payload_ciphertext = NULL, last_error_code = 'EMAIL_REFUSED', updated_at = now()
         WHERE id = $1`,
        [refused]
      );
      assert.equal(await healthProof(), true);
      await pool!.query(
        "UPDATE exomem_email_outbox SET last_error_code = 'EMAIL_DELIVERY_UNAVAILABLE' WHERE id = $1",
        [refused]
      );
      assert.equal(await healthProof(), false);
      await pool!.query(
        "UPDATE exomem_email_outbox SET updated_at = now() - interval '2 hours' WHERE id = $1",
        [refused]
      );
      assert.equal(await healthProof(), true);
    });

    it("fails for a sign-in link that failed for any reason except being used, replaced or expired", async () => {
      const owner = `owner-${randomUUID()}@example.com`;
      const user = await pool!.query<{ id: string }>(
        "INSERT INTO exomem_users (email, email_verified_at) VALUES ($1, now()) RETURNING id",
        [owner]
      );
      await pool!.query(
        "INSERT INTO exomem_tenants (owner_user_id, status, desired_state) VALUES ($1, 'active', 'running')",
        [user.rows[0]!.id]
      );
      const link = await createMagicAccessToken({
        emailNormalized: owner,
        tokenDigest: randomBytes(32),
        browserChallengeDigest: randomBytes(32),
        expiresAt: new Date(Date.now() + 15 * 60_000),
        deliverySecretCiphertext: {
          version: 1,
          algorithm: "A256GCM",
          iv: "i",
          ciphertext: "c",
          tag: "t",
        },
      });
      assert.ok(link);
      const failWith = (code: string) =>
        pool!.query(
          `UPDATE exomem_access_delivery_outbox
           SET state = 'failed', secret_ciphertext = NULL, last_error_code = $1, updated_at = now()
           WHERE id = $2`,
          [code, link.deliveryId]
        );
      // Superseded by a newer link, or no longer usable: ordinary, not an outage.
      for (const ordinary of ["SUPERSEDED_MAGIC_LINK", "ACCESS_TOKEN_UNAVAILABLE"]) {
        await failWith(ordinary);
        assert.equal(await healthProof(), true, ordinary);
      }
      // A failure code nobody listed still trips the proof.
      await failWith("SOME_FUTURE_FAILURE");
      assert.equal(await healthProof(), false);
    });
  });

  describe("email drain", () => {
    it("keeps draining when the provider-event prune fails", async () => {
      await pool!.query("ALTER TABLE exomem_email_provider_events RENAME TO prune_broken");
      try {
        const result = await drainExomemEmailOutbox();
        assert.equal(result.providerEventsPruned, null);
      } finally {
        await pool!.query("ALTER TABLE prune_broken RENAME TO exomem_email_provider_events");
      }
    });
  });
});
