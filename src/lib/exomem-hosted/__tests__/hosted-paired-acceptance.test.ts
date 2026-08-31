import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import fixture from "./fixtures/hosted-paired-acceptance-v1.json";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";
import {
  getLiveExomemAgentContract,
  storeRetainedExomemAgentContractCandidate,
} from "../agent-contract-store";
import { exomemHostedContractFixture } from "../agent-contract-fixture";
import { exomemHostedContractFixture as acceptedFixture0340 } from "../agent-contract-fixture-0-34-0";
import { exomemContractFixture0680 } from "../gateway-contract-0-68-0";
import { createCanaryAssignment } from "../agent-contract-canaries";
import { loadOwnerInstallActions } from "../account-install-actions";
import {
  __setExomemSqlForTests,
  __setExomemTransactionForTests,
  consumeDeletionConfirmationAtomic,
  createDeletionConfirmationToken,
  type ExomemSql,
  type ExomemTransaction,
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
import { __setPromotionProvisionerForTests } from "../promotion-runtime";
import { expectedCellConfiguration, LifecycleReconciler } from "../reconciler";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
const resource = "https://substratesystems.io/api/exomem/mcp/v1";
const verifier = "v".repeat(43);
const oauthClientConfigSha256 = sha("f");
const previousBaseUrl = process.env.EXOMEM_PUBLIC_BASE_URL;
const promotionEnvironment = [
  "EXOMEM_HOSTED_CLAUDE_INSTALL_URL",
  "EXOMEM_HOSTED_OPENAI_INSTALL_URL",
  "EXOMEM_HOSTED_PROMOTION_KEY_ID",
  "EXOMEM_HOSTED_PROMOTION_SECRET",
  "EXOMEM_HOSTED_CONTRACT_IMPORT_KEY_ID",
  "EXOMEM_HOSTED_CONTRACT_IMPORT_SECRET",
  "EXOMEM_CONTROL_PLANE_KEY",
] as const;
const previousPromotionEnvironment = Object.fromEntries(
  promotionEnvironment.map((key) => [key, process.env[key]])
);
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

function transactionSql(client: PoolClient): ExomemSql & ExomemTransaction {
  const tagged = sql(client) as ExomemSql & ExomemTransaction;
  tagged.query = async (text, values = []) => {
    const result = await client.query(text, values);
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount ?? 0 };
  };
  return tagged;
}

async function transaction<T>(work: (tx: ExomemSql) => Promise<T>): Promise<T> {
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    const result = await work(transactionSql(client));
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

/**
 * What the cell actually puts in `data`, which is NOT the published outputSchema.
 *
 * The private command route answers `{success, data}` with `data` set to the raw
 * command result. FastMCP's `{result: ...}` wrapper lives only on FastMCP's own MCP
 * surface, so a tool whose published schema carries `x-fastmcp-wrap-result` reaches
 * the gateway UNWRAPPED and the gateway applies the wrap itself.
 *
 * Sampling the published schema here instead -- as this stub used to -- hands back an
 * already-wrapped `{result: ...}`, which satisfies the validator by construction and
 * makes a double wrap indistinguishable from a correct one. That is how `ask_memory`
 * and `connect_memory` shipped returning CELL_RESPONSE_INVALID against every real
 * cell while this suite stayed green.
 */
function cellData(commandName: string): unknown {
  const schema = exomemHostedContractFixture.compatibility.agent_contract.commands.find(
    (command) => command.name === commandName
  )?.mcp_tool.outputSchema as Record<string, unknown> | undefined;
  assert.ok(schema, `no published output schema for ${commandName}`);
  if (schema["x-fastmcp-wrap-result"] === true) {
    const inner = (schema.properties as Record<string, unknown> | undefined)?.result;
    assert.ok(inner, "wrap-result schema must declare a result property");
    return sample(inner, schema);
  }
  return sample(schema);
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
    exomemHostedContractFixture.packageLock.plugin_version,
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
         ) VALUES ($1, 'pinned', true, jsonb_build_array($2::text),
                   digest(convert_to(jsonb_build_array($2::text)::text, 'utf8'), 'sha256'), $3, $4) RETURNING id`,
        [clientId, redirectUri, platform, oauthClientConfigSha256]
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
      exomemHostedContractFixture.sourceRelease,
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
  const catalogOwner = await pool!.query<{ id: string }>(
    "INSERT INTO users (email) VALUES ($1) RETURNING id",
    [`paired-catalog-${randomUUID()}@example.test`]
  );
  const catalogTenant = await pool!.query<{ id: string }>(
    `INSERT INTO exomem_tenants (owner_user_id, status, desired_state, legacy_unmetered)
     VALUES ($1, 'active', 'running', true) RETURNING id`,
    [catalogOwner.rows[0]!.id]
  );
  const catalogCell = await pool!.query<{ id: string }>(
    `INSERT INTO exomem_cells (
       tenant_id, lifecycle_state, routing_state, desired_state, protocol_version, release_version,
       readiness_code, observed_gateway_contract_digest, observed_command_fingerprint,
       observed_schema_digest, observed_compatibility_digest
     ) VALUES ($1, 'active', 'bound', 'running', '1', $2, 'CELL_READY', $3, $4, $5, $6)
     RETURNING id`,
    [
      catalogTenant.rows[0]!.id,
      exomemHostedContractFixture.sourceRelease,
      sha("8"),
      exomemHostedContractFixture.compatibility.command_surface_sha256,
      exomemHostedContractFixture.compatibility.schema_contract_sha256,
      exomemHostedContractFixture.compatibility.compatibility_sha256,
    ]
  );
  await pool!.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [
    catalogCell.rows[0]!.id,
    catalogTenant.rows[0]!.id,
  ]);
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
      [...artifact(platform, candidateId, lock), oauthClientConfigSha256]
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
  transactionDigest: Buffer,
  requestedScopes: string[] = ["exomem.read"],
  marketplaceReviewerPurpose = false
) {
  await pool!.query(
    `INSERT INTO exomem_invites (token_digest, email_normalized, entitlement_source,
     entitlement_capabilities, entitlement_limits, marketplace_reviewer_purpose,
     created_by_principal_digest, expires_at)
     VALUES ($1, $2, 'complimentary', '[]'::jsonb, '{}'::jsonb, $3, $4, now() + interval '1 hour')`,
    [invitationDigest, `paired-${randomUUID()}@example.test`, marketplaceReviewerPurpose, digest(7)]
  );
  await pool!.query(
    `INSERT INTO exomem_oauth_authorization_transactions (
      transaction_digest, client_id, redirect_uri, resource, requested_scopes, state_digest,
      state_envelope, form_nonce_digest, continuation_binding, pkce_challenge, expires_at
    ) VALUES ($1, $2::uuid, $3, $4, $5::text[], $6, '{}'::jsonb, $7, $8, $9, now() + interval '1 hour')`,
    [
      transactionDigest,
      clientId,
      redirectUri,
      resource,
      requestedScopes,
      digest(8),
      digest(9),
      digest(10),
      pkceS256(verifier),
    ]
  );
}

async function converge(reconciler: LifecycleReconciler, tenantId: string): Promise<void> {
  for (let index = 0; index < 16; index += 1) {
    const result = await reconciler.reconcileOne({ owner: `paired-worker-${index}`, tenantId });
    if (result.kind === "idle") break;
  }
}

describe("Hosted Exomem paired acceptance fixture", () => {
  it("pins the released contract and requires two native client identities", () => {
    // The paired-acceptance evidence was gathered against 0.34.0, so it pins that
    // contract. It does not follow the live release; a new release needs its own
    // acceptance run before this fixture can move.
    assert.equal(acceptedFixture0340.sourceCommit, "253c9aa365d7afd8829dc7843f1cac53353ac825");
    assert.equal(acceptedFixture0340.sourceRelease, "0.34.0");
    assert.equal(fixture.local_provenance, "mock");
    assert.deepEqual(fixture.external_release_gates, [
      "registered_openai_asdk_app",
      "clean_content_bearing_cross_client_run",
    ]);
    assert.equal(
      fixture.compatibility_sha256,
      acceptedFixture0340.compatibility.compatibility_sha256
    );
    assert.equal(
      fixture.schema_contract_sha256,
      acceptedFixture0340.compatibility.schema_contract_sha256
    );
    assert.equal(
      fixture.command_surface_sha256,
      acceptedFixture0340.compatibility.command_surface_sha256
    );
  });
});

describe("Hosted Exomem paired control-plane acceptance", { skip: !databaseUrl }, () => {
  before(async () => {
    process.env.EXOMEM_PUBLIC_BASE_URL = "https://hosted.example.test";
    process.env.EXOMEM_HOSTED_CLAUDE_INSTALL_URL = "https://claude.ai/plugins/exomem-hosted";
    process.env.EXOMEM_HOSTED_OPENAI_INSTALL_URL = "https://chatgpt.com/plugins/exomem-hosted";
    process.env.EXOMEM_HOSTED_PROMOTION_KEY_ID = "integration-operator";
    process.env.EXOMEM_HOSTED_PROMOTION_SECRET = "integration-secret";
    process.env.EXOMEM_HOSTED_CONTRACT_IMPORT_KEY_ID = "integration-importer";
    process.env.EXOMEM_HOSTED_CONTRACT_IMPORT_SECRET = "integration-import-secret";
    schema = `paired_acceptance_${randomUUID().replaceAll("-", "")}`;
    await ensureExomemPostgresTestExtensions(databaseUrl!);
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);
    await applyMigrations({ databaseUrl: scoped.toString() });
    // This isolated fixture also exercises the future full-identity branch.
    // Production 0039 intentionally remains strict-v1 until its successor widens this check.
    await admin.query(
      `ALTER TABLE "${schema}".exomem_lifecycle_operations
       DROP CONSTRAINT exomem_lifecycle_operations_provisioner_wire_protocol_check`
    );
    await admin.query(
      `DROP TRIGGER exomem_lifecycle_provisioner_wire_protocol_immutable
       ON "${schema}".exomem_lifecycle_operations`
    );
    await admin.end();
    pool = new Pool({ connectionString: scoped.toString() });
    __setExomemSqlForTests(sql(pool));
    __setExomemTransactionForTests(transaction);
  });

  after(async () => {
    __setExomemSqlForTests(null);
    __setExomemTransactionForTests(null);
    __setPromotionProvisionerForTests(null);
    await pool?.end();
    if (schema) {
      const admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    if (previousBaseUrl === undefined) delete process.env.EXOMEM_PUBLIC_BASE_URL;
    else process.env.EXOMEM_PUBLIC_BASE_URL = previousBaseUrl;
    for (const key of promotionEnvironment) {
      const previous = previousPromotionEnvironment[key];
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
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
    process.env.EXOMEM_CONTROL_PLANE_KEY = Buffer.alloc(32, 9).toString("base64url");
    __setPromotionProvisionerForTests(provider);
    const store = new SqlLifecycleStore();
    let ownerId = "";
    const reconciler = new LifecycleReconciler({
      store,
      provisioner: provider,
      config: expectedCellConfiguration({
        protocolVersion: "1",
        releaseVersion: "0.34.0",
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
    const baseline = {
      users: await count("users"),
      tenants: await count("exomem_tenants"),
      entitlements: await count("exomem_entitlements"),
      allocations: await count("exomem_capacity_allocations"),
      operations: await count("exomem_lifecycle_operations"),
      cells: await count("exomem_cells"),
    };
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
      [baseline.tenants, baseline.allocations, baseline.operations, baseline.cells]
    );

    const code = mintAuthorizationCode({
      clientId: cohort.claude.clientId,
      redirectUri: cohort.claude.redirectUri,
      resource,
      scopes: ["exomem.read"],
      offlineAccess: true,
      codeChallenge: pkceS256(verifier),
    });
    await seedAdmission(cohort.claude.id, cohort.claude.redirectUri, digest(11), digest(12), [
      "exomem.read",
      "offline_access",
    ]);
    const previousV2Issuance = process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED;
    const admitted = await (async () => {
      process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED = "true";
      try {
        return await admitFirstOAuthInviteAtomic({
          inviteDigest: digest(11),
          transactionDigest: digest(12),
          sessionDigest: digest(13),
          csrfDigest: digest(14),
          sessionExpiresAt: new Date(Date.now() + 60_000),
          codeDigest: code.codeDigest,
          codeExpiresAt: code.record.expiresAt,
        });
      } finally {
        if (previousV2Issuance === undefined)
          delete process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED;
        else process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED = previousV2Issuance;
      }
    })();
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
      [
        baseline.users + 1,
        baseline.tenants + 1,
        baseline.entitlements + 1,
        baseline.allocations + 1,
        baseline.operations + 1,
      ]
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
    assert.equal(await count("exomem_cells"), baseline.cells + 1);
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
    assert.deepEqual(await loadOwnerInstallActions(ownerId, admitted.tenantId), [
      {
        platform: "claude",
        version: exomemHostedContractFixture.packageLock.plugin_version,
        installUrl: "https://claude.ai/plugins/exomem-hosted",
      },
      {
        platform: "openai",
        version: exomemHostedContractFixture.openaiPackageLock.plugin_version,
        installUrl: "https://chatgpt.com/plugins/exomem-hosted",
      },
    ]);

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
    assert.equal(claudeIssued.refreshAllowed, true);
    assert.equal(claudeIssued.refreshInserted, true);
    assert.deepEqual(await findMcpOAuthAccessToken(claudeMaterial.accessTokenDigest), {
      grantId: claudeIssued.grantId,
      familyId: claudeIssued.familyId,
      clientId: claudeIssued.clientId,
      resource: claudeIssued.resource,
      scopes: claudeIssued.scopes,
      userId: ownerId,
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
        body: { success: true, data: cellData(commandName) },
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
      `INSERT INTO exomem_oauth_authorization_transactions (
         transaction_digest, client_id, redirect_uri, resource, requested_scopes, state_digest,
         state_envelope, form_nonce_digest, continuation_binding, pkce_challenge, expires_at
       ) VALUES ($1, $2::uuid, $3, $4, ARRAY['exomem.read'], $5,
         '{}'::jsonb, $6, $7, $8, now() + interval '1 hour')`,
      [
        digest(21),
        cohort.openai.id,
        cohort.openai.redirectUri,
        resource,
        digest(22),
        digest(25),
        digest(26),
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
      [baseline.allocations + 1, baseline.cells + 1, baseline.operations + 1]
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

  it("binds a targetless OAuth reviewer provision over strict v1 without runtime identity", async () => {
    const client = (
      await pool!.query<{ id: string; client_id: string; redirect_uri: string }>(
        `SELECT id, client_id, redirect_uris->>0 AS redirect_uri
         FROM exomem_oauth_clients WHERE client_platform = 'claude' AND enabled
         ORDER BY created_at LIMIT 1`
      )
    ).rows[0]!;
    const candidate = (
      await pool!.query<{ id: string }>(
        "SELECT id FROM exomem_agent_contract_candidates WHERE state = 'live' ORDER BY promoted_at LIMIT 1"
      )
    ).rows[0]!;
    const inviteDigest = digest(31);
    const transactionDigest = digest(32);
    await seedAdmission(
      client.id,
      client.redirect_uri,
      inviteDigest,
      transactionDigest,
      undefined,
      true
    );
    const admitted = await admitFirstOAuthInviteAtomic({
      inviteDigest,
      transactionDigest,
      sessionDigest: digest(33),
      csrfDigest: digest(34),
      codeDigest: digest(35),
      codeExpiresAt: new Date(Date.now() + 60_000),
      sessionExpiresAt: new Date(Date.now() + 60_000),
    });
    assert.ok(admitted);
    if (!admitted) throw new Error("reviewer OAuth admission was rejected");
    await pool!.query(
      `INSERT INTO exomem_agent_contract_rollout_assignments (
         tenant_id, candidate_id, generation, state, source_release, protocol_version,
         command_fingerprint, schema_digest, compatibility_digest, gateway_contract_digest,
         marketplace_reviewer_purpose, created_by_principal_digest, expires_at
       )
       SELECT $1, candidate.id, 1, 'preparing', candidate.source_release, candidate.protocol_version,
              candidate.command_fingerprint, candidate.schema_digest, candidate.compatibility_digest, $2,
              true, $3, now() + interval '1 hour'
       FROM exomem_agent_contract_candidates AS candidate WHERE candidate.id = $4`,
      [admitted.tenantId, exomemContractFixture0680.digest, sha("9"), candidate.id]
    );
    const reconciler = new LifecycleReconciler({
      store: new SqlLifecycleStore(),
      provisioner: new FakeCellProvisioner(),
      config: expectedCellConfiguration({
        protocolVersion: "1",
        releaseVersion: "0.34.0",
        workerPolicy: { workerCount: 0, semantic: false, media: false },
      }),
      envelopeKey: Buffer.alloc(32, 9),
      randomBytes: (size) => Buffer.alloc(size, 8),
    });
    await converge(reconciler, admitted.tenantId);
    assert.equal((await new SqlLifecycleStore().statusForTenant(admitted.tenantId)).state, "ready");
    assert.deepEqual(
      (
        await pool!.query(
          `SELECT assignment.state AS assignment_state, tenant.status AS tenant_status,
                  allocation.state AS allocation_state, cell.lifecycle_state, cell.routing_state,
                  cell.observed_gateway_contract_digest, cell.observed_command_fingerprint,
                  cell.observed_schema_digest, cell.observed_compatibility_digest,
                  route.source_release, route.protocol_version
           FROM exomem_tenants AS tenant
           JOIN exomem_agent_contract_rollout_assignments AS assignment ON assignment.tenant_id = tenant.id
           JOIN exomem_capacity_allocations AS allocation ON allocation.tenant_id = tenant.id
           JOIN exomem_cells AS cell ON cell.id = tenant.bound_cell_id
           JOIN exomem_routable_cell_contracts AS route
             ON route.cell_id = cell.id AND route.profile_id = 'hosted-alpha-agent-v4'
           WHERE tenant.id = $1`,
          [admitted.tenantId]
        )
      ).rows,
      [
        {
          assignment_state: "active",
          tenant_status: "active",
          allocation_state: "occupied",
          lifecycle_state: "active",
          routing_state: "bound",
          observed_gateway_contract_digest: null,
          observed_command_fingerprint: null,
          observed_schema_digest: null,
          observed_compatibility_digest: null,
          source_release: exomemHostedContractFixture.sourceRelease,
          protocol_version:
            exomemHostedContractFixture.compatibility.agent_contract.protocol_version,
        },
      ]
    );
    await pool!.query(
      `UPDATE exomem_cells AS cell
       SET observed_gateway_contract_digest = $1,
           observed_command_fingerprint = $2,
           observed_schema_digest = $3,
           observed_compatibility_digest = $4
       WHERE cell.id = (SELECT bound_cell_id FROM exomem_tenants WHERE id = $5)`,
      [
        exomemContractFixture0680.digest,
        exomemHostedContractFixture.compatibility.command_surface_sha256,
        exomemHostedContractFixture.compatibility.schema_contract_sha256,
        exomemHostedContractFixture.compatibility.compatibility_sha256,
        admitted.tenantId,
      ]
    );
  });

  it("keeps retained v1 candidates catalog-only after the v4 cutover", async () => {
    if (!(await getLiveExomemAgentContract())) await seedCohort();
    const liveBefore = (
      await pool!.query<{ id: string; profile_id: string; source_release: string }>(
        `SELECT candidate.id::text, candidate.profile_id, candidate.source_release
         FROM exomem_agent_contract_candidates AS candidate
         JOIN exomem_hosted_alpha_cohort AS cohort ON cohort.id = candidate.id`
      )
    ).rows[0]!;
    assert.deepEqual(
      { profile: liveBefore.profile_id, release: liveBefore.source_release },
      { profile: "hosted-alpha-agent-v4", release: "0.68.0" }
    );

    const user = await pool!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ($1) RETURNING id",
      [`retained-v1-${randomUUID()}@example.test`]
    );
    const tenant = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_tenants (
         owner_user_id, status, desired_state, marketplace_reviewer_purpose, legacy_unmetered
       ) VALUES ($1, 'active', 'running', true, true) RETURNING id`,
      [user.rows[0]!.id]
    );
    const retainedCandidateId = await storeRetainedExomemAgentContractCandidate("0.35.0");

    await assert.rejects(
      createCanaryAssignment({
        tenantId: tenant.rows[0]!.id,
        candidateId: retainedCandidateId,
        expiresAt: new Date(Date.now() + 60 * 60_000),
        operatorPrincipalDigest: sha("9"),
      }),
      /canary assignment precondition failed/
    );

    assert.deepEqual(
      (
        await pool!.query<{ state: string; profile_id: string; source_release: string }>(
          `SELECT state, profile_id, source_release
           FROM exomem_agent_contract_candidates
           WHERE id = $1`,
          [retainedCandidateId]
        )
      ).rows,
      [{ state: "pending", profile_id: "hosted-alpha-agent-v1", source_release: "0.35.0" }]
    );
    assert.equal(
      (
        await pool!.query<{ count: number }>(
          `SELECT count(*)::int AS count
           FROM exomem_agent_contract_rollout_assignments
           WHERE tenant_id = $1`,
          [tenant.rows[0]!.id]
        )
      ).rows[0]!.count,
      0
    );
    assert.equal(
      (await pool!.query<{ id: string }>("SELECT id::text FROM exomem_hosted_alpha_cohort"))
        .rows[0]!.id,
      liveBefore.id
    );
  });
});
