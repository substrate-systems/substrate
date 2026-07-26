import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import fixture from "./fixtures/hosted-paired-acceptance-v1.json";
import { getLiveExomemAgentContract } from "../agent-contract-store";
import { exomemHostedContractFixture } from "../agent-contract-fixture";
import { loadOwnerInstallActions } from "../account-install-actions";
import {
  __setExomemSqlForTests,
  __setExomemTransactionForTests,
  consumeDeletionConfirmationAtomic,
  createDeletionConfirmationToken,
  type ExomemSql,
} from "../db";
import { SqlLifecycleStore } from "../lifecycle-store";
import { handleHostedMcpRequest } from "../mcp";
import {
  admitFirstOAuthInviteAtomic,
  attachExistingOwnerAuthorizationAtomic,
  findMcpOAuthAccessToken,
  issueOAuthTokensFromCodeAtomic,
} from "../oauth-store";
import { mintAuthorizationCode, mintOpaqueTokenMaterial, pkceS256 } from "../oauth";
import { FakeCellProvisioner, ProvisionerPending } from "../provisioner";
import { expectedCellConfiguration, LifecycleReconciler } from "../reconciler";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
const resource = "https://substratesystems.io/api/exomem/mcp/v1";
const verifier = "v".repeat(43);
const previousBaseUrl = process.env.EXOMEM_PUBLIC_BASE_URL;
let pool: Pool | undefined;
let schema: string | undefined;

type Cohort = {
  candidateId: string;
  claude: { id: string; clientId: string; redirectUri: string };
  openai: { id: string; clientId: string; redirectUri: string };
};

function digest(byte: number): Buffer {
  return Buffer.alloc(32, byte);
}

function sha(byte: string): string {
  return byte.repeat(64);
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
  return Number((await pool!.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0]?.count);
}

function sample(schema: unknown, root: unknown = schema): unknown {
  const record = schema as Record<string, unknown>;
  if (typeof record.$ref === "string" && record.$ref.startsWith("#/")) {
    const resolved = record.$ref
      .slice(2)
      .split("/")
      .reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], root);
    return sample(resolved, root);
  }
  if (Object.hasOwn(record, "const")) return record.const;
  if (Array.isArray(record.enum) && record.enum.length) return record.enum[0];
  const variant = [
    ...((record.anyOf as unknown[]) ?? []),
    ...((record.oneOf as unknown[]) ?? []),
  ].find((value) => (value as { type?: string }).type !== "null");
  if (variant) return sample(variant, root);
  if (record.type === "boolean") return false;
  if (record.type === "integer" || record.type === "number") return record.minimum ?? 0;
  if (record.type === "array") return [];
  if (record.type === "object" || record.properties)
    return Object.fromEntries(
      ((record.required as string[]) ?? []).map((key) => [
        key,
        sample((record.properties as Record<string, unknown>)[key], root),
      ])
    );
  return "acceptance";
}

function artifact(
  platform: "claude" | "openai",
  candidateId: string,
  lock: { artifact_sha256: string; archive_sha256: string; registered_app_id_sha256?: string }
) {
  return [
    platform,
    "live",
    lock.artifact_sha256,
    lock.archive_sha256,
    exomemHostedContractFixture.compatibility.compatibility_sha256,
    exomemHostedContractFixture.compatibility.schema_contract_sha256,
    "0.1.0",
    sha("1"),
    sha("2"),
    sha("3"),
    sha("4"),
    platform === "claude"
      ? "https://claude.ai/plugins/exomem-hosted"
      : "https://chatgpt.com/plugins/exomem-hosted",
    sha("5"),
    sha("6"),
    candidateId,
    platform === "openai" ? lock.registered_app_id_sha256 : null,
  ];
}

async function seedCohort(): Promise<Cohort> {
  const claudeClientId = `https://claude.example.test/${randomUUID()}`;
  const openaiClientId = `https://openai.example.test/${randomUUID()}`;
  const claudeRedirect = "https://claude.example.test/callback";
  const openaiRedirect = "https://openai.example.test/callback";
  const clients = await Promise.all(
    [
      [claudeClientId, claudeRedirect, "claude"],
      [openaiClientId, openaiRedirect, "openai"],
    ].map(async ([clientId, redirectUri, platform]) =>
      pool!.query(
        `INSERT INTO exomem_oauth_clients (
           client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest,
           client_platform, oauth_client_config_sha256
         ) VALUES ($1, 'pinned', true, jsonb_build_array($2),
                   digest(convert_to(jsonb_build_array($2)::text, 'utf8'), 'sha256'), $3, $4) RETURNING id`,
        [clientId, redirectUri, platform, sha("oauth-client-config")]
      )
    )
  );
  const claudeLock = {
    ...exomemHostedContractFixture.packageLock,
    archive_sha256: exomemHostedContractFixture.archiveLock.archive_sha256,
  };
  const openaiPackage = {
    ...exomemHostedContractFixture.packageLock,
    platform: "openai",
    artifact_sha256: sha("a"),
    registered_app_id_sha256: sha("c"),
  };
  const openaiArchive = {
    platform: "openai",
    archive_sha256: sha("b"),
    registered_app_id_sha256: sha("c"),
  };
  const candidate = await pool!.query<{ id: string }>(
    `INSERT INTO exomem_agent_contract_candidates (
      state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
      compatibility_digest, protocol_version, mcp_protocol_versions, contract,
      claude_package_lock, claude_archive_lock, openai_package_lock, openai_archive_lock, promoted_at
    ) VALUES ('live', $1, $2, $3, $4, $5, $6, '1', '["2025-11-25", "2025-06-18"]'::jsonb,
      $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, now()) RETURNING id`,
    [
      exomemHostedContractFixture.compatibility.profile,
      resource,
      exomemHostedContractFixture.compatibility.source_release,
      exomemHostedContractFixture.compatibility.command_surface_sha256,
      exomemHostedContractFixture.compatibility.schema_contract_sha256,
      exomemHostedContractFixture.compatibility.compatibility_sha256,
      JSON.stringify(exomemHostedContractFixture.compatibility),
      JSON.stringify(exomemHostedContractFixture.packageLock),
      JSON.stringify(exomemHostedContractFixture.archiveLock),
      JSON.stringify(openaiPackage),
      JSON.stringify(openaiArchive),
    ]
  );
  const candidateId = candidate.rows[0]!.id;
  for (const [platform, lock] of [
    ["claude", claudeLock],
    ["openai", { ...openaiPackage, archive_sha256: openaiArchive.archive_sha256 }],
  ] as const) {
    await pool!.query(
      `INSERT INTO exomem_client_artifacts (
        platform, state, package_sha256, archive_sha256, compatibility_sha256, contract_sha256,
        plugin_version, client_identity_sha256, paired_run_hmac_sha256, exomem_identity_hmac_sha256,
        tenant_hmac_sha256, install_url, evidence_sha256, result_sha256, contract_candidate_id,
        registered_app_id_sha256, oauth_client_config_sha256, observed_at, promoted_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
        $15::uuid, $16, $17, now(), now())`,
      [...artifact(platform, candidateId, lock), sha("oauth-client-config")]
    );
  }
  await pool!.query(
    `UPDATE exomem_capacity_pools SET storage_capacity_bytes = $1, runtime_capacity_slots = 2,
     provision_reservation_capacity = 2, provision_claim_capacity = 1, configured_at = now(),
     reserved_storage_bytes = 0, reserved_runtime_slots = 0, reserved_provision_slots = 0`,
    [10_737_418_240]
  );
  return {
    candidateId,
    claude: { id: clients[0].rows[0].id, clientId: claudeClientId, redirectUri: claudeRedirect },
    openai: { id: clients[1].rows[0].id, clientId: openaiClientId, redirectUri: openaiRedirect },
  };
}

async function seedAdmission(
  clientId: string,
  redirectUri: string,
  invitationDigest: Buffer,
  transactionDigest: Buffer
) {
  await pool!.query(
    `INSERT INTO exomem_invites (token_digest, email_normalized, entitlement_source,
     entitlement_capabilities, entitlement_limits, created_by_principal_digest, expires_at)
     VALUES ($1, $2, 'complimentary', '[]'::jsonb, '{}'::jsonb, $3, now() + interval '1 hour')`,
    [invitationDigest, `paired-${randomUUID()}@example.test`, digest(7)]
  );
  await pool!.query(
    `INSERT INTO exomem_oauth_authorization_transactions (
      transaction_digest, client_id, redirect_uri, resource, requested_scopes, state_digest,
      pkce_challenge, expires_at
    ) VALUES ($1, $2::uuid, $3, $4, ARRAY['exomem.read'], $5, $6, now() + interval '1 hour')`,
    [transactionDigest, clientId, redirectUri, resource, digest(8), pkceS256(verifier)]
  );
}

async function converge(reconciler: LifecycleReconciler, tenantId: string): Promise<void> {
  for (let index = 0; index < 16; index += 1) {
    const result = await reconciler.reconcileOne({ owner: `paired-worker-${index}`, tenantId });
    if (result.kind === "idle") break;
  }
}

function localPromotionEvidence(): Record<string, unknown> {
  return {
    schema_version: 1,
    platform: "claude",
    client_version: "0.1.0",
    clean_client_identity_hmac_sha256: sha("1"),
    timestamp: new Date().toISOString(),
    paired_run_hmac_sha256: sha("2"),
    test_identity: "hosted-client-plugins-v1",
    exomem_identity_hmac_sha256: sha("3"),
    tenant_hmac_sha256: sha("4"),
    entitlement_hmac_sha256: sha("5"),
    provisioning_operation_hmac_sha256: sha("6"),
    cell_hmac_sha256: sha("7"),
    identity_count: 1,
    tenant_count: 1,
    entitlement_count: 1,
    operation_count: 1,
    cell_count: 1,
    volume_count: 1,
    result_sha256: sha("8"),
    package_artifact_sha256: exomemHostedContractFixture.packageLock.artifact_sha256,
    archive_sha256: exomemHostedContractFixture.archiveLock.archive_sha256,
    compatibility_sha256: exomemHostedContractFixture.compatibility.compatibility_sha256,
    schema_contract_sha256: exomemHostedContractFixture.compatibility.schema_contract_sha256,
    command_surface_sha256: exomemHostedContractFixture.compatibility.command_surface_sha256,
    endpoint: resource,
    plugin_version: "0.1.0",
    profile: "hosted-alpha-agent-v1",
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
  it("pins the released contract and requires two native client identities", () => {
    assert.equal(
      exomemHostedContractFixture.sourceCommit,
      "08f1cee281bd0dbcaf82094421c11d6be04dc5c2"
    );
    assert.equal(exomemHostedContractFixture.compatibility.source_release, "0.33.0");
    assert.equal(fixture.local_provenance, "mock");
    assert.deepEqual(fixture.external_release_gates, [
      "registered_openai_asdk_app",
      "clean_content_bearing_cross_client_run",
    ]);
    assert.equal(
      fixture.compatibility_sha256,
      exomemHostedContractFixture.compatibility.compatibility_sha256
    );
    assert.equal(
      fixture.schema_contract_sha256,
      exomemHostedContractFixture.compatibility.schema_contract_sha256
    );
    assert.equal(
      fixture.command_surface_sha256,
      exomemHostedContractFixture.compatibility.command_surface_sha256
    );
  });
});

describe("Hosted Exomem paired control-plane acceptance", { skip: !databaseUrl }, () => {
  before(async () => {
    process.env.EXOMEM_PUBLIC_BASE_URL = "https://hosted.example.test";
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
    if (previousBaseUrl === undefined) delete process.env.EXOMEM_PUBLIC_BASE_URL;
    else process.env.EXOMEM_PUBLIC_BASE_URL = previousBaseUrl;
  });

  it("composes cohort admission, MCP, lifecycle attachment, deletion, and non-promotion", async () => {
    const cohort = await seedCohort();
    assert.equal(await count("exomem_hosted_alpha_cohort"), 1);
    const cohortClients = await pool!.query<{ client_id: string }>(
      "SELECT client_id FROM exomem_oauth_clients WHERE enabled = true ORDER BY client_id"
    );
    assert.deepEqual(
      cohortClients.rows.map((row) => row.client_id),
      [cohort.claude.clientId, cohort.openai.clientId].sort()
    );
    class PendingDestroyProvider extends FakeCellProvisioner {
      pendingDestroy = true;

      override async destroy(request: Parameters<FakeCellProvisioner["destroy"]>[0]) {
        if (this.pendingDestroy) {
          this.pendingDestroy = false;
          throw new ProvisionerPending({
            operationId: request.context.operationId,
            checkpoint: request.context.checkpoint,
            retryAfterSeconds: 1,
          });
        }
        return super.destroy(request);
      }
    }
    const provider = new PendingDestroyProvider();
    const store = new SqlLifecycleStore();
    let ownerId = "";
    const reconciler = new LifecycleReconciler({
      store,
      provisioner: provider,
      config: expectedCellConfiguration({
        protocolVersion: "1",
        releaseVersion: "0.33.0",
        workerPolicy: { workerCount: 0, semantic: false, media: false },
      }),
      envelopeKey: Buffer.alloc(32, 9),
      randomBytes: (size) => Buffer.alloc(size, 8),
      terminateBilling: async (tenantId) => ({
        tenantId,
        userId: ownerId,
        source: "complimentary",
        sourceState: "complimentary_active",
        sourceRevision: null,
        providerEnvironment: null,
        customerRef: null,
        subscriptionRef: null,
        transactionRef: null,
      }),
    });
    let privateRoutes = 0;
    const baseline = await Promise.all([
      count("exomem_tenants"),
      count("exomem_capacity_allocations"),
      count("exomem_lifecycle_operations"),
      count("exomem_cells"),
    ]);
    const { GET: protectedResourceMetadata } =
      await import("../../../app/.well-known/oauth-protected-resource/api/exomem/mcp/v1/route");
    const { GET: authorizationServerMetadata } =
      await import("../../../app/.well-known/oauth-authorization-server/api/exomem/oauth/route");
    assert.equal((await protectedResourceMetadata()).status, 200);
    assert.equal((await authorizationServerMetadata()).status, 200);
    const noBearer = await handleHostedMcpRequest(
      new Request(resource, { method: "POST", body: "{}" }),
      {
        baseUrl: "https://substratesystems.io",
        findAccessToken: findMcpOAuthAccessToken,
        getLiveContract: getLiveExomemAgentContract,
        statusForTenant: (tenantId) => store.statusForTenant(tenantId),
        takeRateLimit: async () => true,
        routeCommand: async () => {
          privateRoutes += 1;
          throw new Error("unreachable");
        },
      }
    );
    assert.equal(noBearer.status, 401);
    assert.equal(provider.calls.length, 0);
    assert.equal(privateRoutes, 0);
    assert.deepEqual(await loadOwnerInstallActions(randomUUID(), randomUUID()), []);
    assert.equal(provider.calls.length, 0);
    assert.deepEqual(
      await Promise.all([
        count("exomem_tenants"),
        count("exomem_capacity_allocations"),
        count("exomem_lifecycle_operations"),
        count("exomem_cells"),
      ]),
      baseline
    );

    const code = mintAuthorizationCode({
      clientId: cohort.claude.clientId,
      redirectUri: cohort.claude.redirectUri,
      resource,
      scopes: ["exomem.read"],
      codeChallenge: pkceS256(verifier),
    });
    await seedAdmission(cohort.claude.id, cohort.claude.redirectUri, digest(11), digest(12));
    const admitted = await admitFirstOAuthInviteAtomic({
      inviteDigest: digest(11),
      transactionDigest: digest(12),
      sessionDigest: digest(13),
      csrfDigest: digest(14),
      sessionExpiresAt: new Date(Date.now() + 60_000),
      codeDigest: code.codeDigest,
      codeExpiresAt: code.record.expiresAt,
    });
    assert.ok(admitted);
    if (!admitted) throw new Error("first OAuth admission was rejected");
    ownerId = (
      await pool!.query<{ owner_user_id: string }>(
        "SELECT owner_user_id FROM exomem_tenants WHERE id = $1",
        [admitted.tenantId]
      )
    ).rows[0]!.owner_user_id;
    assert.deepEqual(
      await Promise.all([
        count("users"),
        count("exomem_tenants"),
        count("exomem_entitlements"),
        count("exomem_capacity_allocations"),
        count("exomem_lifecycle_operations"),
      ]),
      [1, 1, 1, 1, 1]
    );
    assert.deepEqual(
      (
        await pool!.query(
          "SELECT storage_bytes = 5368709120 AS exact_storage, runtime_slots = 1 AS exact_runtime, provision_slots = 1 AS exact_provision, state FROM exomem_capacity_allocations"
        )
      ).rows[0],
      { exact_storage: true, exact_runtime: true, exact_provision: true, state: "reserved" }
    );
    assert.equal(provider.calls.length, 0);

    await converge(reconciler, admitted.tenantId);
    assert.equal((await store.statusForTenant(admitted.tenantId)).state, "ready");
    assert.equal(provider.resources.size, 1);
    const providerCallsBeforeAttachment = provider.calls.length;
    const boundCellBeforeAttachment = (
      await pool!.query<{ bound_cell_id: string }>(
        "SELECT bound_cell_id FROM exomem_tenants WHERE id = $1",
        [admitted.tenantId]
      )
    ).rows[0]!.bound_cell_id;
    assert.equal(await count("exomem_cells"), 1);
    assert.deepEqual((await pool!.query("SELECT state FROM exomem_capacity_allocations")).rows[0], {
      state: "occupied",
    });
    assert.deepEqual(
      (
        await pool!.query(
          "SELECT reserved_storage_bytes = 5368709120 AS exact_storage, reserved_runtime_slots = 1 AS exact_runtime, reserved_provision_slots = 0 AS provision_released FROM exomem_capacity_pools"
        )
      ).rows[0],
      { exact_storage: true, exact_runtime: true, provision_released: true }
    );
    assert.deepEqual(
      await loadOwnerInstallActions(
        (await pool!.query("SELECT owner_user_id FROM exomem_tenants")).rows[0].owner_user_id,
        admitted.tenantId
      ),
      [
        {
          platform: "claude",
          version: "0.1.0",
          installUrl: "https://claude.ai/plugins/exomem-hosted",
        },
        {
          platform: "openai",
          version: "0.1.0",
          installUrl: "https://chatgpt.com/plugins/exomem-hosted",
        },
      ]
    );

    const claudeMaterial = mintOpaqueTokenMaterial({ refreshAllowed: true });
    const claudeIssued = await issueOAuthTokensFromCodeAtomic({
      codeDigest: code.codeDigest,
      clientId: cohort.claude.clientId,
      redirectUri: cohort.claude.redirectUri,
      resource,
      pkceChallenge: pkceS256(verifier),
      refreshDigest: claudeMaterial.refreshTokenDigest!,
      refreshExpiresAt: new Date(Date.now() + 60_000),
      accessDigest: claudeMaterial.accessTokenDigest,
      accessExpiresAt: claudeMaterial.accessTokenExpiresAt,
    });
    assert.ok(claudeIssued);
    assert.deepEqual(await findMcpOAuthAccessToken(claudeMaterial.accessTokenDigest), {
      ...claudeIssued,
      userId: (await pool!.query("SELECT owner_user_id FROM exomem_tenants")).rows[0].owner_user_id,
      tenantId: admitted.tenantId,
    });
    const dependencies = {
      baseUrl: "https://substratesystems.io",
      findAccessToken: findMcpOAuthAccessToken,
      getLiveContract: getLiveExomemAgentContract,
      statusForTenant: (tenantId: string) => store.statusForTenant(tenantId),
      takeRateLimit: async () => true,
      routeCommand: async ({ commandName }: { commandName: string }) => ({
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
    };
    const transport = new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: { headers: { authorization: `Bearer ${claudeMaterial.accessToken.reveal()}` } },
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        handleHostedMcpRequest(new Request(input.toString(), init), dependencies),
    });
    const client = new Client({ name: "paired-acceptance", version: "1" });
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      exomemHostedContractFixture.compatibility.agent_contract.commands.map(
        (command) => command.mcp_tool.name
      )
    );
    assert.notEqual(
      (await client.callTool({ name: "ask_memory", arguments: { query: "acceptance" } })).isError,
      true
    );
    await transport.close();

    const second = mintAuthorizationCode({
      clientId: cohort.openai.clientId,
      redirectUri: cohort.openai.redirectUri,
      resource,
      scopes: ["exomem.read"],
      codeChallenge: pkceS256(verifier),
    });
    await pool!.query(
      `INSERT INTO exomem_oauth_authorization_transactions (transaction_digest, client_id, redirect_uri, resource, requested_scopes, state_digest, pkce_challenge, expires_at) VALUES ($1, $2::uuid, $3, $4, ARRAY['exomem.read'], $5, $6, now() + interval '1 hour')`,
      [
        digest(21),
        cohort.openai.id,
        cohort.openai.redirectUri,
        resource,
        digest(22),
        pkceS256(verifier),
      ]
    );
    const attached = await attachExistingOwnerAuthorizationAtomic({
      sessionId: admitted.sessionId,
      transactionDigest: digest(21),
      codeDigest: second.codeDigest,
      codeExpiresAt: second.record.expiresAt,
    });
    assert.equal(attached?.tenantId, admitted.tenantId);
    const openaiMaterial = mintOpaqueTokenMaterial({ refreshAllowed: false });
    const openaiIssued = await issueOAuthTokensFromCodeAtomic({
      codeDigest: second.codeDigest,
      clientId: cohort.openai.clientId,
      redirectUri: cohort.openai.redirectUri,
      resource,
      pkceChallenge: pkceS256(verifier),
      refreshDigest: digest(23),
      refreshExpiresAt: new Date(Date.now() + 60_000),
      accessDigest: openaiMaterial.accessTokenDigest,
      accessExpiresAt: openaiMaterial.accessTokenExpiresAt,
    });
    assert.ok(openaiIssued);
    const openaiContext = await findMcpOAuthAccessToken(openaiMaterial.accessTokenDigest);
    assert.ok(openaiContext);
    assert.equal(openaiContext?.tenantId, admitted.tenantId);
    assert.equal(openaiContext?.userId, ownerId);
    assert.equal(openaiContext?.clientId, cohort.openai.clientId);
    assert.equal(provider.resources.size, 1);
    assert.equal(provider.calls.length, providerCallsBeforeAttachment);
    assert.equal(
      (
        await pool!.query<{ bound_cell_id: string }>(
          "SELECT bound_cell_id FROM exomem_tenants WHERE id = $1",
          [admitted.tenantId]
        )
      ).rows[0]!.bound_cell_id,
      boundCellBeforeAttachment
    );
    assert.deepEqual(
      await Promise.all([
        count("exomem_capacity_allocations"),
        count("exomem_cells"),
        count("exomem_lifecycle_operations"),
      ]),
      [1, 1, 1]
    );
    assert.equal(
      (
        await pool!.query(
          "SELECT count(DISTINCT client_id)::int AS count FROM exomem_oauth_grants WHERE tenant_id = $1",
          [admitted.tenantId]
        )
      ).rows[0].count,
      2
    );
    assert.equal(
      (await pool!.query("SELECT count(*)::int AS count FROM exomem_oauth_token_families")).rows[0]
        .count,
      2
    );

    assert.ok(
      await createDeletionConfirmationToken({
        userId: ownerId,
        tenantId: admitted.tenantId,
        tokenDigest: digest(24),
        expiresAt: new Date(Date.now() + 60_000),
      })
    );
    assert.ok(
      await consumeDeletionConfirmationAtomic({
        userId: ownerId,
        tenantId: admitted.tenantId,
        tokenDigest: digest(24),
      })
    );
    assert.equal(
      (await reconciler.reconcileOne({ owner: "delete-local-gate", tenantId: admitted.tenantId }))
        .kind,
      "advanced"
    );
    assert.equal(await findMcpOAuthAccessToken(claudeMaterial.accessTokenDigest), null);
    assert.equal(await findMcpOAuthAccessToken(openaiMaterial.accessTokenDigest), null);
    for (const bearer of [
      claudeMaterial.accessToken.reveal(),
      openaiMaterial.accessToken.reveal(),
    ]) {
      const rejected = await handleHostedMcpRequest(
        new Request(resource, {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}` },
          body: "{}",
        }),
        dependencies
      );
      assert.equal(rejected.status, 401);
    }
    for (let step = 0; step < 4; step += 1)
      await reconciler.reconcileOne({ owner: `delete-step-${step}`, tenantId: admitted.tenantId });
    assert.deepEqual((await pool!.query("SELECT state FROM exomem_capacity_allocations")).rows[0], {
      state: "occupied",
    });
    await pool!.query(
      "UPDATE exomem_lifecycle_operations SET next_attempt_at = now() - interval '1 second' WHERE tenant_id = $1 AND operation_type = 'delete'",
      [admitted.tenantId]
    );
    await converge(reconciler, admitted.tenantId);
    assert.equal((await store.statusForTenant(admitted.tenantId)).state, "deleted");
    assert.equal(provider.resources.size, 0);
    assert.deepEqual((await pool!.query("SELECT state FROM exomem_capacity_allocations")).rows[0], {
      state: "released",
    });
    assert.deepEqual(
      (
        await pool!.query(
          "SELECT reserved_storage_bytes = 0 AS storage_released, reserved_runtime_slots = 0 AS runtime_released, reserved_provision_slots = 0 AS provision_released FROM exomem_capacity_pools"
        )
      ).rows[0],
      { storage_released: true, runtime_released: true, provision_released: true }
    );
    assert.equal(
      (
        await pool!.query(
          "SELECT count(*)::int AS count FROM exomem_oauth_token_families WHERE revoked_at IS NULL"
        )
      ).rows[0].count,
      0
    );

    const pending = artifact("claude", cohort.candidateId, {
      artifact_sha256: sha("d"),
      archive_sha256: sha("e"),
    });
    pending[1] = "pending";
    const pendingArtifact = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_client_artifacts (
        platform, state, package_sha256, archive_sha256, compatibility_sha256, contract_sha256,
        plugin_version, client_identity_sha256, paired_run_hmac_sha256, exomem_identity_hmac_sha256,
        tenant_hmac_sha256, install_url, evidence_sha256, result_sha256, contract_candidate_id,
        registered_app_id_sha256, observed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
        $15::uuid, $16, now()) RETURNING id`,
      pending
    );
    const artifactsBefore = await pool!.query(
      "SELECT platform, state FROM exomem_client_artifacts ORDER BY platform"
    );
    const candidateBefore = await pool!.query(
      "SELECT state FROM exomem_agent_contract_candidates WHERE id = $1",
      [cohort.candidateId]
    );
    // Pending artifacts cannot change a published cohort outside the atomic cohort endpoint.
    assert.equal(
      (
        await pool!.query("SELECT state FROM exomem_client_artifacts WHERE id = $1", [
          pendingArtifact.rows[0]!.id,
        ])
      ).rows[0]?.state,
      "pending"
    );
    assert.deepEqual(
      (await pool!.query("SELECT platform, state FROM exomem_client_artifacts ORDER BY platform"))
        .rows,
      artifactsBefore.rows
    );
    assert.deepEqual(
      (
        await pool!.query("SELECT state FROM exomem_agent_contract_candidates WHERE id = $1", [
          cohort.candidateId,
        ])
      ).rows,
      candidateBefore.rows
    );
  });
});
