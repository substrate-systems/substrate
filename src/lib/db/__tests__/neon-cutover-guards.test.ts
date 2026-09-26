import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  runCutover,
  withReadWriteOverride,
  type CutoverEnv,
} from "../../../../scripts/neon-cutover";

// The cutover script's own guards (task 4.1, design D8), which run before it
// opens any connection: they need no database. The end-to-end behaviour is
// the Docker rehearsal in neon-cutover-rehearsal.test.ts.

const REMOTE =
  "postgresql://someone:not-a-real-secret@cutover-guard.invalid:5432/neondb?sslmode=verify-full";

async function run(
  args: string[],
  env: CutoverEnv = {}
): Promise<{ code: number; output: string }> {
  const lines: string[] = [];
  const code = await runCutover(args, env, {
    log: (line) => lines.push(line),
    error: (line) => lines.push(line),
  });
  return { code, output: lines.join("\n") };
}

describe("neon-cutover guards", () => {
  const remoteEnv = {
    CUTOVER_SOURCE_ADMIN_URL: REMOTE,
    CUTOVER_SOURCE_DUMP_URL: REMOTE,
    CUTOVER_TARGET_OWNER_URL: REMOTE.replace("neondb", "exomem_control_session"),
    CUTOVER_ROLE_URL_APP: REMOTE.replace("someone", "app"),
  };

  for (const args of [
    ["freeze", "--app-roles=app"],
    ["rollback", "--app-roles=app"],
    ["create-dump-role"],
  ]) {
    it(`${args[0]} refuses a non-local database without --confirm-production, before connecting`, async () => {
      const started = Date.now();
      const { code, output } = await run(args, remoteEnv);
      assert.equal(code, 1, output);
      assert.match(output, /--confirm-production/);
      assert.match(output, /cutover-guard\.invalid/);
      assert.doesNotMatch(output, /not-a-real-secret/);
      assert.ok(Date.now() - started < 2_000, "the refusal must not wait on a connection attempt");
    });
  }

  // restore and grants are bounded by their own checks instead: an empty
  // target, and a schema_migrations equal to this checkout's migrations.
  it("restore and grants need no --confirm-production", async () => {
    const restore = await run(["restore", "--archive=/nonexistent/neondb.dump"], remoteEnv);
    assert.equal(restore.code, 1, restore.output);
    assert.doesNotMatch(restore.output, /--confirm-production/);
    assert.match(restore.output, /must both exist/);
    const grants = await run(["grants"], remoteEnv);
    assert.equal(grants.code, 1, grants.output);
    assert.doesNotMatch(grants.output, /--confirm-production/);
    assert.match(grants.output, /ENOTFOUND/);
    assert.doesNotMatch(grants.output, /not-a-real-secret/);
  });

  it("rollback needs the password file that recorded the database's ACL", async () => {
    const { code, output } = await run(
      ["rollback", "--app-roles=app", "--confirm-production"],
      remoteEnv
    );
    assert.equal(code, 1, output);
    assert.match(output, /--password-file/);
  });

  it("refuses a transaction-pooled endpoint for the phases that hold session state", async () => {
    const pooled = await run(["inventory"], {
      CUTOVER_SOURCE_ADMIN_URL:
        "postgresql://a:b@ep-quiet-sky-123456-pooler.eu-central-1.aws.neon.tech/neondb",
    });
    assert.equal(pooled.code, 1, pooled.output);
    assert.match(pooled.output, /pooler/);
    const transactionAlias = await run(["grants", "--confirm-production"], {
      CUTOVER_TARGET_OWNER_URL:
        "postgresql://substrate_owner:b@db.example.test:6432/exomem_control",
    });
    assert.equal(transactionAlias.code, 1, transactionAlias.output);
    assert.match(transactionAlias.output, /_session/);
  });

  it("requires each application role's pre-freeze credential before freezing", async () => {
    const { code, output } = await run(
      ["freeze", "--app-roles=app,other", "--confirm-production"],
      remoteEnv
    );
    assert.equal(code, 1, output);
    assert.match(output, /CUTOVER_ROLE_URL_OTHER/);
  });

  it("rejects an unknown phase or option with usage", async () => {
    assert.equal((await run(["copy"])).code, 1);
    assert.equal((await run(["verify", "--force"])).code, 1);
    assert.equal((await run([])).code, 1);
  });

  it("switch-plan only prints commands, and never a credential", async () => {
    const { code, output } = await run(["switch-plan"], remoteEnv);
    assert.equal(code, 0, output);
    assert.match(output, /vercel env rm DATABASE_URL production/);
    assert.match(output, /vercel redeploy/);
    assert.doesNotMatch(output, /not-a-real-secret/);
  });

  it("probes a frozen role on Neon's direct endpoint, overriding the read-only default", () => {
    const probe = new URL(
      withReadWriteOverride(
        "postgresql://app:pw@ep-quiet-sky-123456-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require"
      )
    );
    assert.equal(probe.hostname, "ep-quiet-sky-123456.eu-central-1.aws.neon.tech");
    assert.equal(probe.searchParams.get("options"), "-c default_transaction_read_only=off");
    assert.equal(probe.searchParams.get("sslmode"), "require");
  });
});
