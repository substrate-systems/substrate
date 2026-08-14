import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Client, Pool } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { holdD1ExpandPreflight } from "../../../../scripts/exomem-d1-expand-preflight";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
let admin: Pool | undefined;
let schema: string | undefined;
let scopedDatabaseUrl: string | undefined;

function releaseSetDigest(
  pairs: Array<{ releaseVersion: string; protocolVersion: string }>
): string {
  return createHash("sha256")
    .update(
      `${JSON.stringify(
        pairs.map(({ releaseVersion, protocolVersion }) => ({ protocolVersion, releaseVersion }))
      )}\n`
    )
    .digest("hex");
}

function canonical(value: unknown): string {
  const sort = (entry: unknown): unknown =>
    Array.isArray(entry)
      ? entry.map(sort)
      : entry && typeof entry === "object"
        ? Object.fromEntries(
            Object.entries(entry)
              .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
              .map(([key, child]) => [key, sort(child)])
          )
        : entry;
  return `${JSON.stringify(sort(value))}\n`;
}

function lockPairBytes(): Buffer {
  const pairs = [
    { releaseVersion: "0.39.2", protocolVersion: "1" },
    { releaseVersion: "0.49.0", protocolVersion: "1" },
  ];
  const member = (admissionMode: "expand" | "contract") => ({
    artifact: "exomem-hosted-deployment-lock",
    schemaVersion: 2,
    admissionMode,
    runtimeTarget: {
      releaseVersion: "0.50.0",
      protocolVersion: "1",
      agentProfile: "hosted-alpha-agent-v1",
    },
    composition: {
      legacyCatalog: pairs,
      legacyReleaseSetSha256: releaseSetDigest(pairs),
    },
  });
  return Buffer.from(
    canonical({
      artifact: "exomem-hosted-deployment-lock-pair",
      schemaVersion: 2,
      locks: [member("expand"), member("contract")],
    })
  );
}

describe("Hosted Exomem D1 expand PostgreSQL preflight", { skip: !databaseUrl }, () => {
  before(async () => {
    schema = `d1_expand_it_${randomUUID().replaceAll("-", "")}`;
    await ensureExomemPostgresTestExtensions(databaseUrl!);
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);
    scopedDatabaseUrl = scoped.toString();
    await applyMigrations({ databaseUrl: scopedDatabaseUrl });
    await admin.query(
      `INSERT INTO "${schema}".exomem_agent_contract_candidates (
         state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
         compatibility_digest, protocol_version, contract, claude_package_lock,
         claude_archive_lock, promoted_at
       ) VALUES (
         'live', 'hosted-alpha-agent-v1', 'https://example.invalid', '0.39.2',
         repeat('a', 64), repeat('b', 64), repeat('c', 64), '1', '{}'::jsonb,
         '{}'::jsonb, '{}'::jsonb, now()
       )`
    );
    const owner = await admin.query<{ id: string }>(
      `INSERT INTO "${schema}".users (email) VALUES ('d1-duplicate-039@example.test')
       RETURNING id::text AS id`
    );
    const tenant = await admin.query<{ id: string }>(
      `INSERT INTO "${schema}".exomem_tenants (owner_user_id)
       VALUES ($1::uuid) RETURNING id::text AS id`,
      [owner.rows[0]!.id]
    );
    const candidate = await admin.query<{ id: string }>(
      `INSERT INTO "${schema}".exomem_agent_contract_candidates (
         state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
         compatibility_digest, protocol_version, contract, claude_package_lock,
         claude_archive_lock
       ) VALUES (
         'pending', 'hosted-alpha-agent-v1', 'https://duplicate.example.invalid', '0.39.2',
         repeat('d', 64), repeat('e', 64), repeat('f', 64), '1', '{}'::jsonb,
         '{}'::jsonb, '{}'::jsonb
       ) RETURNING id::text AS id`
    );
    await admin.query(
      `INSERT INTO "${schema}".exomem_agent_contract_rollout_assignments (
         tenant_id, candidate_id, generation, state, source_release, protocol_version,
         command_fingerprint, schema_digest, compatibility_digest, gateway_contract_digest,
         marketplace_reviewer_purpose, created_by_principal_digest, expires_at
       ) VALUES (
         $1::uuid, $2::uuid, 1, 'preparing', '0.39.2', '1', repeat('d', 64),
         repeat('e', 64), repeat('f', 64), repeat('a', 64), false, repeat('9', 64),
         now() + interval '1 hour'
       )`,
      [tenant.rows[0]!.id, candidate.rows[0]!.id]
    );
  });

  after(async () => {
    if (schema) await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });

  it("holds the real cohort lock while duplicate current sources collapse inside a larger reviewed catalog", async () => {
    const bytes = lockPairBytes();
    const expectedLockPairSha256 = createHash("sha256").update(bytes).digest("hex");
    const preflightClient = new Client({ connectionString: scopedDatabaseUrl });
    const competingClient = new Client({ connectionString: scopedDatabaseUrl });
    await preflightClient.connect();
    await competingClient.connect();
    let release!: () => void;
    let held!: () => void;
    let heldStatus: Record<string, unknown> | undefined;
    const releaseSignal = new Promise<void>((resolve) => {
      release = resolve;
    });
    const heldSignal = new Promise<void>((resolve) => {
      held = resolve;
    });
    try {
      const preflight = holdD1ExpandPreflight({
        client: preflightClient,
        deploymentLockPairBytes: bytes,
        expectedLockPairSha256,
        waitForRelease: () => releaseSignal,
        onStatus: (status) => {
          heldStatus = status;
          held();
        },
      });
      await Promise.race([
        heldSignal,
        preflight.then(() => {
          throw new Error("preflight released before reporting its held state");
        }),
      ]);
      assert.deepEqual(heldStatus, {
        status: "held",
        lockPairSha256: expectedLockPairSha256,
        catalogReleaseSetSha256: releaseSetDigest([
          { releaseVersion: "0.39.2", protocolVersion: "1" },
          { releaseVersion: "0.49.0", protocolVersion: "1" },
        ]),
        catalogReleasePairCount: 2,
        currentReleaseSetSha256: releaseSetDigest([
          { releaseVersion: "0.39.2", protocolVersion: "1" },
        ]),
        currentReleasePairCount: 1,
      });
      await competingClient.query("BEGIN");
      const competing = competingClient.query(
        "SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))"
      );
      const state = await Promise.race([
        competing.then(() => "acquired"),
        new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 100)),
      ]);
      assert.equal(state, "waiting");
      release();
      assert.equal((await preflight).status, "released");
      await competing;
      await competingClient.query("ROLLBACK");
    } finally {
      await competingClient.query("ROLLBACK").catch(() => undefined);
      await preflightClient.end();
      await competingClient.end();
    }
  });
});
