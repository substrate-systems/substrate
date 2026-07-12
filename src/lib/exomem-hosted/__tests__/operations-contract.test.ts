import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Exomem hosted operations contract", () => {
  it("schedules the durable lifecycle reconciler every minute", () => {
    const config = JSON.parse(source("vercel.json")) as {
      crons?: Array<{ path?: string; schedule?: string }>;
    };
    assert.deepEqual(
      config.crons?.find((entry) => entry.path === "/api/cron/exomem-reconcile"),
      { path: "/api/cron/exomem-reconcile", schedule: "* * * * *" }
    );
    assert.deepEqual(
      config.crons?.find((entry) => entry.path === "/api/cron/exomem-access-delivery"),
      { path: "/api/cron/exomem-access-delivery", schedule: "* * * * *" }
    );
  });

  it("documents every alpha secret, provider proof, drill, and rollback boundary", () => {
    const runbook = source("docs/runbooks/exomem-hosted-alpha.md");
    for (const variable of [
      "DATABASE_URL",
      "EXOMEM_ADMIN_TOKEN",
      "EXOMEM_CONTROL_PLANE_KEY",
      "EXOMEM_PROVISIONER_ENDPOINT",
      "EXOMEM_PROVISIONER_CREDENTIAL",
      "EXOMEM_CELL_PROTOCOL_VERSION",
      "EXOMEM_CELL_RELEASE_VERSION",
      "CRON_SECRET",
      "BREVO_API_KEY",
      "EXOMEM_PADDLE_PRICE_ID",
    ]) {
      assert.match(runbook, new RegExp(`\\b${variable}\\b`));
    }
    assert.match(runbook, /computeDestroyed/);
    assert.match(runbook, /storageDestroyed/);
    assert.match(runbook, /keysDestroyed/);
    assert.match(runbook, /Two-cell isolation drill/);
    assert.match(runbook, /Rollback/);
    assert.match(runbook, /not zero-knowledge/i);
  });

  it("serializes migration runners and applies each file with its tracking row", () => {
    const runner = source("scripts/migrate.ts");
    assert.match(runner, /pg_advisory_lock/);
    assert.match(runner, /getAppliedVersions\(client\)/);
    assert.match(runner, /BEGIN/);
    assert.match(runner, /COMMIT/);
    assert.match(runner, /ROLLBACK/);
    assert.match(runner, /INSERT INTO schema_migrations/);
  });

  it("uses idle transfer timeouts rather than aborting healthy long streams", () => {
    for (const route of [
      source("src/app/api/exomem/upload/route.ts"),
      source("src/app/api/exomem/download/route.ts"),
    ]) {
      assert.match(route, /TRANSFER_IDLE_TIMEOUT_MS/);
      assert.doesNotMatch(route, /AbortSignal\.timeout\(30_000\)/);
    }
  });
});
