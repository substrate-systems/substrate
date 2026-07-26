import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import fixture from "./fixtures/hosted-paired-acceptance-v1.json";
import { exomemHostedContractFixture } from "../agent-contract-fixture";
import { promoteClientArtifact } from "../client-artifacts";
import {
  __setExomemSqlForTests,
  __setExomemTransactionForTests,
  consumeDeletionConfirmationAtomic,
  createDeletionConfirmationToken,
  type ExomemSql,
} from "../db";
import { handleHostedMcpRequest } from "../mcp";
import {
  admitFirstOAuthInviteAtomic,
  attachExistingOwnerAuthorizationAtomic,
  findActiveOAuthAccessToken,
  findMcpOAuthAccessToken,
  revokeOAuthAccountForOwnerTenantAtomic,
} from "../oauth-store";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
const resource = "https://substratesystems.io/api/exomem/mcp/v1";
let pool: Pool | undefined;
let schema: string | undefined;

function digest(byte: number): Buffer {
  return Buffer.alloc(32, byte);
}

function sql(client: Pool | PoolClient): ExomemSql {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1)
      text += `$${index + 1}${strings[index + 1]}`;
    const result = await client.query(text, values);
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount ?? 0 };
  };
}

async function transaction<T>(work: (tx: ExomemSql) => Promise<T>): Promise<T> {
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    const result = await work(sql(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function count(table: string): Promise<number> {
  const result = await pool!.query(`SELECT count(*)::int AS count FROM ${table}`);
  return Number(result.rows[0]?.count);
}

async function seedCohort(clientId: string): Promise<string> {
  const client = await pool!.query(
    `INSERT INTO exomem_oauth_clients (client_id, admission_mode, enabled, redirect_uris)
     VALUES ($1, 'pinned', true, '["https://client.example.test/callback"]'::jsonb) RETURNING id`,
    [clientId]
  );
  const lock = (platform: "claude" | "openai", packageSha256: string, archiveSha256: string) => ({
    platform,
    artifact_sha256: packageSha256,
    archive_sha256: archiveSha256,
    compatibility_sha256: fixture.compatibility_sha256,
    schema_contract_sha256: fixture.schema_contract_sha256,
    plugin_version: "0.1.0",
    ...(platform === "openai" ? { registered_app_id_sha256: "a".repeat(64) } : {}),
  });
  const claude = lock("claude", fixture.claude_package_sha256, fixture.claude_archive_sha256);
  const openai = lock("openai", "b".repeat(64), "c".repeat(64));
  await pool!.query(
    `INSERT INTO exomem_agent_contract_candidates (
       state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
       compatibility_digest, protocol_version, contract, claude_package_lock, claude_archive_lock,
       openai_package_lock, openai_archive_lock, promoted_at
     ) VALUES ('live', $1, $2, $3, $4, $5, $6, '1', '{}'::jsonb,
       $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, now())`,
    [
      fixture.profile,
      resource,
      fixture.exomem_release,
      fixture.command_surface_sha256,
      fixture.schema_contract_sha256,
      fixture.compatibility_sha256,
      JSON.stringify(claude),
      JSON.stringify(claude),
      JSON.stringify(openai),
      JSON.stringify(openai),
    ]
  );
  await pool!.query(
    `UPDATE exomem_capacity_pools SET storage_capacity_bytes = $1, runtime_capacity_slots = 2,
      provision_reservation_capacity = 2, provision_claim_capacity = 1,
      reserved_storage_bytes = 0, reserved_runtime_slots = 0, reserved_provision_slots = 0`,
    [10_737_418_240]
  );
  return String(client.rows[0]?.id);
}

async function seedAdmission(clientId: string, byte: number, email: string): Promise<void> {
  await pool!.query(
    `INSERT INTO exomem_invites (token_digest, email_normalized, entitlement_source,
       entitlement_capabilities, entitlement_limits, created_by_principal_digest, expires_at)
     VALUES ($1, $2, 'complimentary', '[]'::jsonb, '{}'::jsonb, $3, now() + interval '1 hour')`,
    [digest(byte), email, digest(byte + 1)]
  );
  await pool!.query(
    `INSERT INTO exomem_oauth_authorization_transactions (
       transaction_digest, client_id, redirect_uri, resource, requested_scopes, state_digest,
       pkce_challenge, expires_at
     ) VALUES ($1, $2, 'https://client.example.test/callback', $3,
       ARRAY['exomem.read'], $4, 'challenge', now() + interval '1 hour')`,
    [digest(byte + 20), clientId, resource, digest(byte + 2)]
  );
}

function sample(schema: unknown, root: unknown = schema): unknown {
  const value = schema as Record<string, unknown>;
  if (typeof value.$ref === "string" && value.$ref.startsWith("#/")) {
    const target = value.$ref
      .slice(2)
      .split("/")
      .reduce<unknown>(
        (current, key) => (current as Record<string, unknown> | undefined)?.[key],
        root
      );
    return sample(target, root);
  }
  if (Object.hasOwn(value, "const")) return value.const;
  if (Array.isArray(value.enum) && value.enum.length) return value.enum[0];
  const alternative = [
    ...((value.anyOf as unknown[]) ?? []),
    ...((value.oneOf as unknown[]) ?? []),
  ].find((candidate) => (candidate as { type?: string }).type !== "null");
  if (alternative) return sample(alternative, root);
  if (value.type === "boolean") return false;
  if (value.type === "integer" || value.type === "number") return value.minimum ?? 0;
  if (value.type === "array") return [];
  if (value.type === "object" || value.properties)
    return Object.fromEntries(
      ((value.required as string[]) ?? []).map((key) => [
        key,
        sample((value.properties as Record<string, unknown>)[key], root),
      ])
    );
  return "acceptance";
}

function localPromotionEvidence(): Record<string, unknown> {
  return {
    schema_version: 1,
    platform: "claude",
    client_version: "0.1.0",
    clean_client_identity_hmac_sha256: "1".repeat(64),
    timestamp: new Date().toISOString(),
    paired_run_hmac_sha256: "2".repeat(64),
    test_identity: fixture.run_id,
    exomem_identity_hmac_sha256: "3".repeat(64),
    tenant_hmac_sha256: "4".repeat(64),
    entitlement_hmac_sha256: "5".repeat(64),
    provisioning_operation_hmac_sha256: "6".repeat(64),
    cell_hmac_sha256: "7".repeat(64),
    identity_count: 1,
    tenant_count: 1,
    entitlement_count: 1,
    operation_count: 1,
    cell_count: 1,
    volume_count: 1,
    result_sha256: "8".repeat(64),
    package_artifact_sha256: fixture.claude_package_sha256,
    archive_sha256: fixture.claude_archive_sha256,
    compatibility_sha256: fixture.compatibility_sha256,
    schema_contract_sha256: fixture.schema_contract_sha256,
    command_surface_sha256: fixture.command_surface_sha256,
    endpoint: fixture.resource,
    plugin_version: "0.1.0",
    profile: fixture.profile,
    operator_key_id: "local-mock",
    native_install: true,
    authorization: true,
    tool_discovery: true,
    content_recall: true,
    citation: true,
    durable_capture: true,
    fresh_chat_recall: true,
    operator_signature: "00",
    mocked: true,
  };
}

describe("Hosted Exomem paired acceptance fixture", () => {
  it("pins the shipped contract and marks committed evidence as local provenance", () => {
    assert.deepEqual(fixture, {
      schema_version: 2,
      run_id: "hosted-client-plugins-v1",
      resource,
      profile: exomemHostedContractFixture.compatibility.profile,
      exomem_release: exomemHostedContractFixture.compatibility.source_release,
      source_commit: exomemHostedContractFixture.sourceCommit,
      compatibility_sha256: exomemHostedContractFixture.compatibility.compatibility_sha256,
      schema_contract_sha256: exomemHostedContractFixture.compatibility.schema_contract_sha256,
      command_surface_sha256: exomemHostedContractFixture.compatibility.command_surface_sha256,
      claude_package_sha256: exomemHostedContractFixture.packageLock.artifact_sha256,
      claude_archive_sha256: exomemHostedContractFixture.archiveLock.archive_sha256,
      local_provenance: "mock",
      external_release_gates: [
        "registered_openai_asdk_app",
        "clean_content_bearing_cross_client_run",
      ],
    });
  });
});

describe("Hosted Exomem paired control-plane acceptance", { skip: !databaseUrl }, () => {
  before(async () => {
    schema = `paired_acceptance_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    await applyMigrations({ databaseUrl: scoped.toString() });
    await admin.end();
    pool = new Pool({ connectionString: scoped.toString() });
    __setExomemSqlForTests(sql(pool));
    __setExomemTransactionForTests(transaction);
  });

  after(async () => {
    __setExomemSqlForTests(null);
    __setExomemTransactionForTests(null);
    await pool?.end();
    if (schema) {
      const admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it("uses admission, attachment, MCP, revocation, and promotion boundaries without inventing control-plane state", async () => {
    const clientId = `https://client.example.test/${randomUUID()}`;
    const internalClientId = await seedCohort(clientId);
    const email = `paired-${randomUUID()}@example.test`;
    const providerCalls: string[] = [];
    const noBearer = await handleHostedMcpRequest(
      new Request(resource, { method: "POST", body: "{}" }),
      {
        baseUrl: "https://substratesystems.io",
        takeRateLimit: async () => true,
        routeCommand: async () => {
          providerCalls.push("route");
          throw new Error("unreachable");
        },
      }
    );
    assert.equal(noBearer.status, 401);
    assert.deepEqual(providerCalls, []);

    await seedAdmission(internalClientId, 11, email);
    const admitted = await admitFirstOAuthInviteAtomic({
      inviteDigest: digest(11),
      transactionDigest: digest(31),
      sessionDigest: digest(51),
      csrfDigest: digest(71),
      sessionExpiresAt: new Date(Date.now() + 60_000),
      codeDigest: digest(91),
      codeExpiresAt: new Date(Date.now() + 60_000),
    });
    assert.ok(admitted);
    assert.equal(await count("users"), 1);
    assert.equal(await count("exomem_tenants"), 1);
    assert.equal(await count("exomem_entitlements"), 1);
    assert.equal(await count("exomem_capacity_allocations"), 1);
    assert.equal(await count("exomem_lifecycle_operations"), 1);

    await pool!.query(
      `INSERT INTO exomem_oauth_authorization_transactions (transaction_digest, client_id, redirect_uri,
       resource, requested_scopes, state_digest, pkce_challenge, expires_at)
       VALUES ($1, $2, 'https://client.example.test/callback', $3, ARRAY['exomem.read'], $4, 'challenge', now() + interval '1 hour')`,
      [digest(32), internalClientId, resource, digest(12)]
    );
    const attached = await attachExistingOwnerAuthorizationAtomic({
      sessionId: admitted!.sessionId,
      transactionDigest: digest(32),
      codeDigest: digest(92),
      codeExpiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal(attached?.tenantId, admitted!.tenantId);
    assert.equal(await count("exomem_capacity_allocations"), 1);
    assert.equal(await count("exomem_lifecycle_operations"), 1);

    const access = {
      familyId: "family",
      grantId: admitted!.grantId,
      clientId,
      resource,
      scopes: ["exomem.read"],
      userId: (
        await pool!.query("SELECT owner_user_id FROM exomem_tenants WHERE id = $1", [
          admitted!.tenantId,
        ])
      ).rows[0].owner_user_id,
      tenantId: admitted!.tenantId,
    };
    const transport = new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: { headers: { authorization: `Bearer ${"a".repeat(43)}` } },
      fetch: (input, init) =>
        handleHostedMcpRequest(new Request(input.toString(), init), {
          baseUrl: "https://substratesystems.io",
          findAccessToken: async () => access,
          getLiveContract: async () => ({
            profile: fixture.profile as "hosted-alpha-agent-v1",
            endpoint: resource,
            sourceRelease: fixture.exomem_release,
            commandFingerprint: fixture.command_surface_sha256,
            schemaDigest: fixture.schema_contract_sha256,
            compatibilityDigest: fixture.compatibility_sha256,
            protocolVersion: "1",
            contract: exomemHostedContractFixture.compatibility,
          }),
          statusForTenant: async () => ({ state: "ready", code: "READY", retryable: false }),
          takeRateLimit: async () => true,
          routeCommand: async ({ commandName }) => ({
            status: 200,
            requestId: "paired",
            body: {
              success: true,
              data: sample(
                exomemHostedContractFixture.compatibility.agent_contract.commands.find(
                  (command) => command.name === commandName
                )?.mcp_tool.outputSchema
              ),
            },
          }),
        }),
    });
    const client = new Client({ name: "paired-acceptance", version: "1" });
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 13);
    const result = await client.callTool({
      name: "ask_memory",
      arguments: { query: "acceptance" },
    });
    assert.notEqual(result.isError, true);
    await transport.close();
    assert.deepEqual(providerCalls, []);

    const tokenDigest = digest(127);
    await pool!
      .query(
        `INSERT INTO exomem_oauth_token_families (grant_id, client_id, resource, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour') RETURNING id`,
        [admitted!.grantId, internalClientId, resource]
      )
      .then(async (family) =>
        pool!.query(
          `INSERT INTO exomem_oauth_access_tokens (token_digest, family_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
          [tokenDigest, family.rows[0].id]
        )
      );
    assert.ok(
      await createDeletionConfirmationToken({
        userId: access.userId,
        tenantId: admitted!.tenantId,
        tokenDigest: digest(126),
        expiresAt: new Date(Date.now() + 60_000),
      })
    );
    assert.ok(
      await consumeDeletionConfirmationAtomic({
        userId: access.userId,
        tenantId: admitted!.tenantId,
        tokenDigest: digest(126),
      })
    );
    assert.equal(await count("exomem_capacity_allocations"), 1);
    assert.equal(
      await revokeOAuthAccountForOwnerTenantAtomic({
        ownerUserId: access.userId,
        tenantId: admitted!.tenantId,
        reason: "lifecycle_deleted",
      }),
      1
    );
    assert.equal(await findActiveOAuthAccessToken(tokenDigest), null);
    assert.equal(await findMcpOAuthAccessToken(tokenDigest), null);

    const before = await count("exomem_client_artifacts");
    const contractBefore = await pool!.query("SELECT state FROM exomem_agent_contract_candidates");
    await assert.rejects(
      () =>
        promoteClientArtifact({
          artifactId: randomUUID(),
          platform: "claude",
          evidence: localPromotionEvidence(),
        }),
      /live promotion requires exact real content-bearing client evidence/
    );
    assert.equal(await count("exomem_client_artifacts"), before);
    assert.deepEqual(
      (await pool!.query("SELECT state FROM exomem_agent_contract_candidates")).rows,
      contractBefore.rows
    );
  });
});
