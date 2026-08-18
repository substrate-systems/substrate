import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Exomem hosted operations contract", () => {
  it("keeps frequent hosted schedules external to Vercel Hobby", () => {
    const vercel = JSON.parse(source("vercel.json")) as {
      crons?: Array<{ path?: string; schedule?: string }>;
    };
    const frequentPaths = [
      "/api/cron/exomem-access-delivery",
      "/api/cron/exomem-reconcile",
      "/api/cron/exomem-export-gc",
    ];
    for (const path of frequentPaths) {
      assert.equal(
        vercel.crons?.some((entry) => entry.path === path),
        false
      );
    }
    for (const entry of vercel.crons ?? []) {
      const [minute, hour, ...rest] = String(entry.schedule ?? "").split(" ");
      assert.match(minute, /^\d{1,2}$/, `${entry.path} must run at most once per day`);
      assert.match(hour, /^\d{1,2}$/, `${entry.path} must run at most once per day`);
      assert.ok(Number(minute) <= 59 && Number(hour) <= 23);
      assert.equal(rest.length, 3);
    }

    const external = JSON.parse(source("ops/exomem-hosted-schedules.json")) as {
      version?: number;
      scheduler?: string;
      origin?: string;
      authentication?: Record<string, unknown>;
      requestPolicy?: Record<string, unknown>;
      kubernetesJobPolicy?: Record<string, unknown>;
      observability?: Record<string, unknown>;
      jobs?: Array<{
        name?: string;
        path?: string;
        schedule?: string;
      }>;
    };
    assert.equal(external.version, 1);
    assert.equal(external.scheduler, "kubernetes-cronjob");
    assert.equal(external.origin, "https://substratesystems.io");
    assert.deepEqual(external.authentication, {
      scheme: "bearer",
      schedulerEnvironmentVariable: "EXOMEM_HOSTED_SCHEDULER_SECRET",
      receiverActiveEnvironmentVariable: "EXOMEM_HOSTED_SCHEDULER_SECRET",
      receiverPreviousEnvironmentVariable: "EXOMEM_HOSTED_SCHEDULER_SECRET_PREVIOUS",
      maxReceiverVersions: 2,
    });
    assert.deepEqual(external.requestPolicy, {
      method: "GET",
      redirect: "error",
      connectTimeoutSeconds: 5,
      totalTimeoutSeconds: 20,
      successStatusCodes: [200],
    });
    assert.deepEqual(external.kubernetesJobPolicy, {
      concurrencyPolicy: "Forbid",
      startingDeadlineSeconds: 45,
      activeDeadlineSeconds: 30,
      backoffLimit: 1,
      maxAttempts: 2,
      successfulJobsHistoryLimit: 1,
      failedJobsHistoryLimit: 3,
      ttlSecondsAfterFinished: 300,
    });
    assert.deepEqual(external.observability, {
      contentFree: true,
      attemptCounterMetric: "exomem_hosted_scheduler_attempts_total",
      durationHistogramMetric: "exomem_hosted_scheduler_duration_seconds",
      lastSuccessMetric: "exomem_hosted_scheduler_last_success_unixtime",
      failureCounterMetric: "exomem_hosted_scheduler_failures_total",
      missedRunAlertAfterSeconds: 180,
      consecutiveFailureAlertThreshold: 2,
    });
    assert.deepEqual(external.jobs, [
      {
        name: "exomem-access-delivery",
        path: "/api/cron/exomem-access-delivery",
        schedule: "* * * * *",
      },
      {
        name: "exomem-reconcile",
        path: "/api/cron/exomem-reconcile",
        schedule: "* * * * *",
      },
      {
        name: "exomem-export-gc",
        path: "/api/cron/exomem-export-gc",
        schedule: "17 * * * *",
      },
    ]);
  });

  it("documents every alpha secret, provider proof, drill, and rollback boundary", () => {
    const runbook = source("docs/runbooks/exomem-hosted-alpha.md");
    for (const variable of [
      "DATABASE_URL",
      "EXOMEM_ADMIN_TOKEN",
      "EXOMEM_CONTROL_PLANE_KEY",
      "EXOMEM_PROVISIONER_ENDPOINT",
      "EXOMEM_PROVISIONER_CREDENTIAL",
      "EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED",
      "EXOMEM_CELL_PROTOCOL_VERSION",
      "EXOMEM_CELL_RELEASE_VERSION",
      "CRON_SECRET",
      "EXOMEM_HOSTED_SCHEDULER_SECRET",
      "BREVO_API_KEY",
    ]) {
      assert.match(runbook, new RegExp(`\\b${variable}\\b`));
    }
    assert.doesNotMatch(runbook, /\bEXOMEM_PADDLE_PRICE_ID\b/);
    assert.match(runbook, /New Exomem checkout remains disabled regardless of Paddle/i);
    assert.match(
      runbook,
      /set\s+`EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED=true` for the 0\.54\.1\s+reviewer canary/i
    );
    assert.match(
      runbook,
      /outer v2 carries the existing `hosted-alpha-agent-v1` runtime\s+target/i
    );
    assert.match(
      runbook,
      /transactions or subscriptions that already have a stored, tenant-bound provider\s+reference/i
    );
    assert.match(runbook, /computeDestroyed/);
    assert.match(runbook, /storageDestroyed/);
    assert.match(runbook, /keysDestroyed/);
    assert.match(runbook, /Two-cell isolation drill/);
    assert.match(runbook, /Rollback/);
    assert.match(runbook, /not zero-knowledge/i);
    assert.match(runbook, /outer provisioner wire protocol/i);
    assert.match(runbook, /inner Hosted\s+runtime protocol/i);
    assert.match(runbook, /ced714a5aa204a837e22cab831262cc0ae4766e44720b2896e61b8c157ddd3b5/);
    assert.match(runbook, /fe4daf1b190e8e4efc737a7197d8df73c28a8672bd8e331fc95dcabf339e0881/);
    assert.match(runbook, /contractionReadiness/);
    assert.match(runbook, /unfinishedV1Operations/);
    assert.match(runbook, /retainedV1Exports/);
    assert.match(runbook, /v1-origin export download\s+and export-GC continuations/i);
    assert.match(runbook, /Keep expand mode until both\s+counts are zero/i);
    assert.match(runbook, /scripts\/exomem-d1-expand-preflight\.ts/);
    assert.match(runbook, /7eeac57b3457846d00974da0e4d8dd3ddb2819687634fc2cf70dd43d2c5a840c/);
    assert.match(runbook, /85cdcbac931f3aa9357bf59c5530a1ba73ce1c81176286aa2b56b421276bdd79/);
    assert.match(runbook, /type the exact line\s+`release`/i);
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

  it("keeps file streams out of Vercel and sends them only from the browser", () => {
    for (const route of [
      source("src/app/api/exomem/upload/route.ts"),
      source("src/app/api/exomem/download/route.ts"),
    ]) {
      assert.match(route, /createDirectTransferTicket/);
      assert.doesNotMatch(route, /fetch\(endpoint/);
    }
    const browser = source("src/lib/exomem-hosted/hosted-browser.ts");
    assert.match(browser, /credentials: "omit"/);
    assert.match(browser, /body: file/);
    assert.match(browser, /redirect: "error"/);
  });
});
