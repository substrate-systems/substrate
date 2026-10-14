import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { Pool } from "pg";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
let accepted: { success: boolean; messageId?: string } = {
  success: true,
  messageId: "synthetic-id",
};
let sends = 0;
let recipient: string | undefined;
mock.module("@/lib/brevo", {
  namedExports: {
    sendTransactionalEmail: async (input: { to: string }) => {
      sends += 1;
      recipient = input.to;
      return accepted;
    },
  },
});

// Real PostgreSQL and real handlers catch storage, ordering and authorization failures together.
describe("functional health PostgreSQL boundary", { skip: !databaseUrl }, () => {
  let admin: Pool;
  let scoped: Pool;
  let schema: string;
  let health: typeof import("../functional-health");
  let store: typeof import("../functional-health-store");
  let control: typeof import("../../../app/healthz/route");
  let email: typeof import("../../../app/healthz/email/route");
  let controlJob: typeof import("../../../app/api/cron/exomem-health-control/route");
  let emailJob: typeof import("../../../app/api/cron/exomem-health-email/route");

  before(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    schema = `health_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema},public`);
    process.env.DATABASE_URL = url.toString();
    process.env.EXOMEM_HOSTED_SCHEDULER_SECRET = "synthetic-scheduler";
    process.env.EXOMEM_HEALTH_EMAIL_RECIPIENT = "probe@example.invalid";
    scoped = new Pool({ connectionString: url.toString() });
    await scoped.query(await readFile("migrations/0070_exomem_functional_health.sql", "utf8"));
    health = await import("../functional-health");
    store = await import("../functional-health-store");
    control = await import("../../../app/healthz/route");
    email = await import("../../../app/healthz/email/route");
    controlJob = await import("../../../app/api/cron/exomem-health-control/route");
    emailJob = await import("../../../app/api/cron/exomem-health-email/route");
  });
  beforeEach(async () => {
    await scoped.query("TRUNCATE exomem_health_proofs");
    sends = 0;
    accepted = { success: true, messageId: "synthetic-id" };
  });
  after(async () => {
    await store?.closeHealthProofPool();
    await scoped?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
    mock.reset();
  });

  function schedulerRequest(token: string) {
    return new Request("https://control.example.invalid/api/cron/exomem-health-control", {
      headers: { authorization: `Bearer ${token}` },
    }) as import("next/server").NextRequest;
  }
  async function finalProof(success: boolean, startedAt: Date, checkedAt = new Date()) {
    await store.saveHealthProof({
      component: "control",
      runId: randomUUID(),
      startedAt,
      checkedAt,
      success,
    });
  }
  async function expectPublic(handler: () => Promise<Response>, ok: boolean) {
    const response = await handler();
    assert.equal(response.status, ok ? 200 : 503);
    assert.deepEqual(await response.json(), { ok });
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }

  it("reports missing, stale and newer failed proofs without reviving an older late success", async () => {
    await expectPublic(control.GET, false);
    const old = new Date(Date.now() - 600_000);
    await finalProof(true, old, old);
    await expectPublic(control.GET, false);
    const earlier = new Date(Date.now() - 2_000);
    await finalProof(true, earlier);
    await expectPublic(control.GET, true);
    await finalProof(false, new Date(Date.now() - 1_000));
    await expectPublic(control.GET, false);
    await finalProof(true, earlier);
    await expectPublic(control.GET, false);
    assert.equal(
      (await scoped.query("SELECT success FROM exomem_health_proofs")).rows[0].success,
      false
    );
  });

  it("keeps concurrent same-time failures unavailable in both storage paths", async (context) => {
    context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    try {
      for (const component of ["control", "memory"] as const) {
        const successful = health.runFunctionalHealthCheck(component, async () => true);
        const failed = health.runFunctionalHealthCheck(component, async () => {
          await successful;
          return false;
        });
        assert.deepEqual(await Promise.all([successful, failed]), [true, false]);
        const proof = await store.readHealthProof(component);
        assert.equal(proof?.success, false);
        await expectPublic(() => health.functionalHealthResponse(component), false);
        await store.saveHealthProof(proof!);
        assert.deepEqual(await store.readHealthProof(component), proof);
      }
    } finally {
      context.mock.timers.reset();
    }
  });

  it("rejects inconsistent timestamps and treats future observations as unavailable", async () => {
    await assert.rejects(
      scoped.query(
        "INSERT INTO exomem_health_proofs VALUES ('control', $1, now(), now() - interval '1 second', true)",
        [randomUUID()]
      )
    );
    const future = new Date(Date.now() + 60_000);
    await finalProof(true, future, future);
    await expectPublic(control.GET, false);
  });

  it("rejects unauthorized checks before sends or writes; authorized control proves the fresh round trip", async () => {
    assert.equal((await controlJob.GET(schedulerRequest("wrong"))).status, 401);
    assert.equal((await emailJob.GET(schedulerRequest("wrong"))).status, 401);
    assert.equal(sends, 0);
    assert.equal(
      (await scoped.query("SELECT count(*)::int AS n FROM exomem_health_proofs")).rows[0].n,
      0
    );
    assert.equal((await controlJob.GET(schedulerRequest("synthetic-scheduler"))).status, 200);
    await expectPublic(control.GET, true);
  });

  it("records email provider acceptance only with its identifier, then exposes a newer failure", async () => {
    assert.equal((await emailJob.GET(schedulerRequest("synthetic-scheduler"))).status, 200);
    await expectPublic(email.GET, true);
    accepted = { success: true };
    assert.equal((await emailJob.GET(schedulerRequest("synthetic-scheduler"))).status, 503);
    await expectPublic(email.GET, false);
    assert.equal(recipient, "probe@example.invalid");
    accepted = { success: false, messageId: "failed-id" };
    assert.equal((await emailJob.GET(schedulerRequest("synthetic-scheduler"))).status, 503);
    await expectPublic(email.GET, false);
    assert.equal(sends, 3);
    const row = (await scoped.query("SELECT * FROM exomem_health_proofs")).rows[0];
    assert.deepEqual(Object.keys(row).sort(), [
      "checked_at",
      "component",
      "run_id",
      "started_at",
      "success",
    ]);
  });

  it("cancels blocked reads and exhausted acquisition under one second, leaving no blocked query", async () => {
    await finalProof(true, new Date(Date.now() - 1_000));
    const blocker = await scoped.connect();
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE exomem_health_proofs IN ACCESS EXCLUSIVE MODE");
    try {
      const started = performance.now();
      const responses = await Promise.all([control.GET(), control.GET(), control.GET()]);
      assert.ok(performance.now() - started < 1_000);
      for (const response of responses) {
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { ok: false });
      }
      const pending = await scoped.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'exomem-functional-health' AND state = 'active'"
      );
      assert.equal(pending.rows[0].n, 0);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    await expectPublic(control.GET, true);
  });

  it("limits the runner grant to memory proof and rejects invalid database input", async () => {
    const role = `health_runner_${randomUUID().replaceAll("-", "")}`;
    const client = await scoped.connect();
    await admin.query(`CREATE ROLE "${role}"`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    await scoped.query(
      `GRANT EXECUTE ON FUNCTION exomem_record_memory_health_proof(uuid, timestamptz, timestamptz, boolean) TO "${role}"`
    );
    try {
      await client.query(`SET ROLE "${role}"`);
      await assert.rejects(client.query("SELECT * FROM exomem_health_proofs"), { code: "42501" });
      await assert.rejects(
        client.query(
          "INSERT INTO exomem_health_proofs VALUES ('control', $1, now(), now(), true)",
          [randomUUID()]
        ),
        { code: "42501" }
      );
      await assert.rejects(
        client.query(
          "SELECT exomem_record_memory_health_proof($1, now(), now() - interval '1 second', true)",
          [randomUUID()]
        ),
        { code: "22023" }
      );
      await assert.rejects(
        client.query(
          "SELECT exomem_record_memory_health_proof($1, now(), now() + interval '1 hour', true)",
          [randomUUID()]
        ),
        { code: "22023" }
      );
      await client.query("SELECT exomem_record_memory_health_proof($1, now(), now(), false)", [
        randomUUID(),
      ]);
      await client.query(
        "SELECT exomem_record_memory_health_proof($1, now() - interval '1 minute', now(), true)",
        [randomUUID()]
      );
      await client.query("RESET ROLE");
      const rows = (await scoped.query("SELECT component, success FROM exomem_health_proofs")).rows;
      assert.deepEqual(rows, [{ component: "memory", success: false }]);
    } finally {
      await client.query("RESET ROLE");
      client.release();
      await admin.query(`DROP OWNED BY "${role}"`);
      await admin.query(`DROP ROLE "${role}"`);
    }
  });

  it("exposes the gateway memory proof while direct pod probes remain green", async () => {
    const { createGatewayServer } = await import("../../../exomem-gateway/server");
    const server = createGatewayServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    try {
      await expectPublic(() => fetch(`${url}/healthz/canary`), false);
      await store.saveHealthProof({
        component: "memory",
        runId: randomUUID(),
        startedAt: new Date(Date.now() - 1000),
        checkedAt: new Date(),
        success: true,
      });
      await expectPublic(() => fetch(`${url}/healthz/canary`), true);
      await store.saveHealthProof({
        component: "memory",
        runId: randomUUID(),
        startedAt: new Date(),
        checkedAt: new Date(),
        success: false,
      });
      await expectPublic(() => fetch(`${url}/healthz/canary`), false);
      for (const path of ["/healthz", "/readyz"])
        assert.equal((await fetch(`${url}${path}`)).status, 200);
      assert.equal((await fetch(`${url}/healthz/canary`, { method: "POST" })).status, 404);
      assert.equal(sends, 0);
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  });

  it("caps email freshness at one hour and rejects invalid freshness configuration", async () => {
    process.env.EXOMEM_HEALTH_EMAIL_FRESHNESS_SECONDS = "7200";
    assert.equal(health.healthFreshnessSeconds("email"), 3600);
    process.env.EXOMEM_HEALTH_EMAIL_FRESHNESS_SECONDS = "invalid";
    await expectPublic(email.GET, false);
    delete process.env.EXOMEM_HEALTH_EMAIL_FRESHNESS_SECONDS;
  });
});
