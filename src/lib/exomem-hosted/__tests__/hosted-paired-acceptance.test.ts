import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import fixture from "./fixtures/hosted-paired-acceptance-v1.json";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";
import {
  attachOpenAiContractLocks,
  getExomemAgentContractForOAuthAccess,
  getLiveExomemAgentContract,
  promoteExomemHostedCohort,
  recordRoutableCellObservation,
  storeRetainedExomemAgentContractCandidate,
} from "../agent-contract-store";
import { exomemHostedContractFixture } from "../agent-contract-fixture";
import { exomemHostedContractFixture as acceptedFixture0340 } from "../agent-contract-fixture-0-34-0";
import { exomemContractFixture0490 } from "../gateway-contract-0-49-0";
import { createCanaryAssignment, createStagedClientRelease } from "../agent-contract-canaries";
import { storeClientArtifact } from "../client-artifacts";
import { createInternalCanaryReviewerCredentialAtomic } from "../reviewer-access-store";
import {
  canonicalPromotionJson,
  pendingArtifactFromEvidence,
  promotionContractFixture,
  signedPromotionEvidence,
  testOpenAiLocks,
  type PromotionFixtureRelease,
} from "./agent-contract-promotion-fixture";
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
import { expectedCellConfiguration, LifecycleReconciler } from "../reconciler";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
// Release A in the lineage tests is whatever contract is currently live, so a
// contract rotation moves it without editing every assertion. B is a retained
// neighbour that stays pinned.
const liveRelease = exomemHostedContractFixture.sourceRelease as PromotionFixtureRelease;
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
    [
      invitationDigest,
      `paired-${randomUUID()}@example.test`,
      marketplaceReviewerPurpose,
      digest(7),
    ]
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

type OAuthClientFixture = {
  id: string;
  clientId: string;
  redirectUri: string;
  platform: "claude" | "openai";
};

async function issueAccess(input: {
  client: OAuthClientFixture;
  userId: string;
  tenantId: string;
  credentialId?: string;
  candidateId?: string;
  assignmentId?: string;
  assignmentGeneration?: number;
  stageId?: string;
}) {
  const code = mintAuthorizationCode({
    clientId: input.client.clientId,
    redirectUri: input.client.redirectUri,
    resource,
    scopes: ["exomem.read"],
    codeChallenge: pkceS256(verifier),
  });
  const candidate = input.candidateId !== undefined;
  const grant = await pool!.query<{ id: string }>(
    `INSERT INTO exomem_oauth_grants (
       user_id, tenant_id, client_id, resource, scopes, refresh_allowed, reviewer_credential_id,
       candidate_id, assignment_id, assignment_generation, staged_client_release_id
     ) VALUES ($1, $2, $3, $4, ARRAY['exomem.read'], true, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      input.userId,
      input.tenantId,
      input.client.id,
      resource,
      input.credentialId ?? null,
      input.candidateId ?? null,
      input.assignmentId ?? null,
      input.assignmentGeneration ?? null,
      input.stageId ?? null,
    ]
  );
  await pool!.query(
    `INSERT INTO exomem_oauth_authorization_codes (
       code_digest, grant_id, client_id, redirect_uri, resource, pkce_challenge, refresh_allowed,
       expires_at, reviewer_credential_id, candidate_id, assignment_id, assignment_generation,
       staged_client_release_id
     ) VALUES ($1, $2, $3, $4, $5, $6, true, now() + interval '1 hour', $7, $8, $9, $10, $11)`,
    [
      code.codeDigest,
      grant.rows[0]!.id,
      input.client.id,
      input.client.redirectUri,
      resource,
      pkceS256(verifier),
      input.credentialId ?? null,
      input.candidateId ?? null,
      input.assignmentId ?? null,
      input.assignmentGeneration ?? null,
      input.stageId ?? null,
    ]
  );
  const material = mintOpaqueTokenMaterial({ refreshAllowed: true });
  const issued = await issueOAuthTokensFromCodeAtomic({
    codeDigest: code.codeDigest,
    clientId: input.client.clientId,
    redirectUri: input.client.redirectUri,
    resource,
    pkceChallenge: pkceS256(verifier),
    refreshDigest: material.refreshTokenDigest!,
    refreshExpiresAt: new Date(Date.now() + 60 * 60_000),
    accessDigest: material.accessTokenDigest,
    accessExpiresAt: new Date(Date.now() + 60 * 60_000),
  });
  assert.ok(issued, candidate ? "candidate token issuance" : "live token issuance");
  return {
    bearer: material.accessToken.reveal(),
    digest: material.accessTokenDigest,
    issued: issued!,
  };
}

async function attachCandidateLocksAndStages(input: {
  candidateId: string;
  release: PromotionFixtureRelease;
  oauthClientConfigSha256: string;
  digestSeed: { artifact: string; archive: string; registeredApp: string };
}) {
  const fixture = promotionContractFixture(input.release);
  const openAiLocks = testOpenAiLocks(input.release, {
    artifact: sha(input.digestSeed.artifact),
    archive: sha(input.digestSeed.archive),
    registeredApp: sha(input.digestSeed.registeredApp),
  });
  const unsigned = {
    candidateId: input.candidateId,
    packageLock: openAiLocks.packageLock,
    archiveLock: openAiLocks.archiveLock,
    operatorKeyId: "integration-importer",
  };
  assert.equal(
    await attachOpenAiContractLocks({
      ...unsigned,
      operatorSignature: createHmac("sha256", "integration-import-secret")
        .update(canonicalPromotionJson(unsigned))
        .digest("hex"),
    }),
    true
  );
  const stage = async (platform: "claude" | "openai") => {
    const locks =
      platform === "claude"
        ? { packageLock: fixture.packageLock, archiveLock: fixture.archiveLock }
        : openAiLocks;
    return createStagedClientRelease({
      candidateId: input.candidateId,
      platform,
      packageSha256: locks.packageLock.artifact_sha256,
      archiveSha256: locks.archiveLock.archive_sha256,
      compatibilitySha256: fixture.compatibility.compatibility_sha256,
      contractSha256: fixture.compatibility.schema_contract_sha256,
      pluginVersion: locks.packageLock.plugin_version,
      oauthClientConfigSha256: input.oauthClientConfigSha256,
      registeredAppIdSha256:
        platform === "openai" ? openAiLocks.packageLock.registered_app_id_sha256 : null,
      operatorPrincipalDigest: sha("9"),
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
  };
  return {
    fixture,
    openAiLocks,
    claudeStage: await stage("claude"),
    openAiStage: await stage("openai"),
  };
}

async function importPairedEvidence(input: {
  candidateId: string;
  release: PromotionFixtureRelease;
  assignment: { id: string; generation: number };
  stages: Awaited<ReturnType<typeof attachCandidateLocksAndStages>>;
  suffix: string;
  oauthClientConfigSha256: string;
}) {
  const create = async (platform: "claude" | "openai", stageId: string) => {
    const evidence = signedPromotionEvidence({
      platform,
      release: input.release,
      secret: "integration-secret",
      suffix: `${input.suffix}-${platform}`,
      candidateId: input.candidateId,
      stageId,
      assignmentId: input.assignment.id,
      assignmentGeneration: input.assignment.generation,
      oauthClientConfigSha256: input.oauthClientConfigSha256,
      openAiLocks: input.stages.openAiLocks,
    });
    const artifactId = await storeClientArtifact(pendingArtifactFromEvidence(platform, evidence));
    return { evidence, artifactId };
  };
  return {
    claude: await create("claude", input.stages.claudeStage.id),
    openai: await create("openai", input.stages.openAiStage.id),
  };
}

async function internalCanaryAccess(input: {
  client: OAuthClientFixture;
  tenantId: string;
  userId: string;
  candidateId: string;
  assignment: { id: string; generation: number };
  stageId: string;
  suffix: number;
}) {
  const credential = await createInternalCanaryReviewerCredentialAtomic({
    platform: input.client.platform,
    usernameDigest: digest(input.suffix),
    passwordHash: "$argon2id$paired-acceptance",
    tenantId: input.tenantId,
    candidateId: input.candidateId,
    assignmentId: input.assignment.id,
    assignmentGeneration: input.assignment.generation,
    stagedClientReleaseId: input.stageId,
    oauthClientId: input.client.id,
    fixtureVersion: "paired-acceptance-v1",
    fixturePayloadDigest: sha(String(input.suffix % 10)),
    expiresAt: new Date(Date.now() + 60 * 60_000),
    operatorPrincipalDigest: digest(input.suffix + 1),
  });
  assert.ok(credential);
  return issueAccess({
    client: input.client,
    userId: input.userId,
    tenantId: input.tenantId,
    credentialId: credential!.credentialId,
    candidateId: input.candidateId,
    assignmentId: input.assignment.id,
    assignmentGeneration: input.assignment.generation,
    stageId: input.stageId,
  });
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
    assert.deepEqual(
      await loadOwnerInstallActions(
        ownerId,
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
    await seedAdmission(client.id, client.redirect_uri, inviteDigest, transactionDigest, undefined, true);
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
      [admitted.tenantId, exomemContractFixture0490.digest, sha("9"), candidate.id]
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
             ON route.cell_id = cell.id AND route.profile_id = 'hosted-alpha-agent-v1'
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
          protocol_version: exomemHostedContractFixture.compatibility.agent_contract.protocol_version,
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
        exomemContractFixture0490.digest,
        exomemHostedContractFixture.compatibility.command_surface_sha256,
        exomemHostedContractFixture.compatibility.schema_contract_sha256,
        exomemHostedContractFixture.compatibility.compatibility_sha256,
        admitted.tenantId,
      ]
    );
  });

  it("keeps A live through paired B proof, promotes B atomically, and rolls forward to fresh A", async () => {
    if (!(await getLiveExomemAgentContract())) await seedCohort();
    const priorRoutes = await pool!.query<{
      cell_id: string;
      source_release: string;
      protocol_version: string;
      command_fingerprint: string;
      contract_digest: string;
      compatibility_digest: string;
      v1_bound: boolean;
    }>(
      `SELECT route.cell_id::text AS cell_id, route.source_release, route.protocol_version,
              route.command_fingerprint, route.contract_digest, route.compatibility_digest,
              EXISTS (
                SELECT 1 FROM exomem_lifecycle_operations AS operation
                WHERE operation.cell_id = route.cell_id
                  AND operation.provisioner_wire_protocol = 'exomem-cell-provisioner.v1'
                  AND operation.operation_type IN ('provision', 'restore')
                  AND operation.state = 'succeeded'
                  AND operation.checkpoint = 'bound'
              ) AS v1_bound
       FROM exomem_routable_cell_contracts AS route
       WHERE profile_id = 'hosted-alpha-agent-v1' AND routable = true`
    );
    for (const route of priorRoutes.rows) {
      if (route.v1_bound) continue;
      await recordRoutableCellObservation({
        cellId: route.cell_id,
        sourceRelease: route.source_release,
        protocolVersion: route.protocol_version,
        commandSurfaceSha256: route.command_fingerprint,
        schemaDigest: route.contract_digest,
        compatibilitySha256: route.compatibility_digest,
        routable: false,
      });
    }
    const createTenant = async (reviewer: boolean) => {
      const user = await pool!.query<{ id: string }>(
        "INSERT INTO users (email) VALUES ($1) RETURNING id",
        [`paired-rollout-${randomUUID()}@example.test`]
      );
      const tenant = await pool!.query<{ id: string }>(
        `INSERT INTO exomem_tenants (
           owner_user_id, status, desired_state, marketplace_reviewer_purpose, legacy_unmetered
         ) VALUES ($1, 'active', 'running', $2, true) RETURNING id`,
        [user.rows[0]!.id, reviewer]
      );
      const cell = await pool!.query<{ id: string }>(
        `INSERT INTO exomem_cells (
           tenant_id, lifecycle_state, routing_state, desired_state, protocol_version, release_version,
           readiness_code, observed_gateway_contract_digest, observed_command_fingerprint,
           observed_schema_digest, observed_compatibility_digest
         ) VALUES ($1, 'active', 'bound', 'running', $2, $3, 'CELL_READY', $4, $5, $6, $7)
         RETURNING id`,
        [
          tenant.rows[0]!.id,
          exomemHostedContractFixture.compatibility.agent_contract.protocol_version,
          exomemHostedContractFixture.sourceRelease,
          sha("8"),
          exomemHostedContractFixture.compatibility.command_surface_sha256,
          exomemHostedContractFixture.compatibility.schema_contract_sha256,
          exomemHostedContractFixture.compatibility.compatibility_sha256,
        ]
      );
      await pool!.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [
        cell.rows[0]!.id,
        tenant.rows[0]!.id,
      ]);
      await pool!.query(
        `INSERT INTO exomem_routable_cell_contracts (
           cell_id, profile_id, source_release, protocol_version, command_fingerprint,
           contract_digest, compatibility_digest, routable
         ) VALUES ($1, 'hosted-alpha-agent-v1', $2, $3, $4, $5, $6, true)`,
        [
          cell.rows[0]!.id,
          exomemHostedContractFixture.sourceRelease,
          exomemHostedContractFixture.compatibility.agent_contract.protocol_version,
          exomemHostedContractFixture.compatibility.command_surface_sha256,
          exomemHostedContractFixture.compatibility.schema_contract_sha256,
          exomemHostedContractFixture.compatibility.compatibility_sha256,
        ]
      );
      await pool!.query(
        "INSERT INTO exomem_entitlements (tenant_id, source, source_state, effective_state) VALUES ($1, 'complimentary', 'active', 'active')",
        [tenant.rows[0]!.id]
      );
      return { userId: user.rows[0]!.id, tenantId: tenant.rows[0]!.id, cellId: cell.rows[0]!.id };
    };
    const activate = async (
      tenant: { tenantId: string; cellId: string },
      candidateId: string,
      assignment: { id: string; generation: number },
      release: PromotionFixtureRelease
    ) => {
      const fixture = promotionContractFixture(release);
      const previous = (
        await pool!.query<{
          source_release: string;
          protocol_version: string;
          command_fingerprint: string;
          contract_digest: string;
          compatibility_digest: string;
        }>(
          `SELECT source_release, protocol_version, command_fingerprint, contract_digest,
                  compatibility_digest
           FROM exomem_routable_cell_contracts
           WHERE cell_id = $1`,
          [tenant.cellId]
        )
      ).rows[0];
      const target = (
        await pool!.query<{
          gateway_contract_digest: string;
          command_fingerprint: string;
          schema_digest: string;
          compatibility_digest: string;
        }>(
          `SELECT gateway_contract_digest, command_fingerprint, schema_digest, compatibility_digest
           FROM exomem_agent_contract_rollout_assignments WHERE id = $1`,
          [assignment.id]
        )
      ).rows[0]!;
      const replacement = await pool!.query<{ id: string }>(
        `INSERT INTO exomem_cells (
           tenant_id, lifecycle_state, routing_state, desired_state, protocol_version, release_version,
           readiness_code, observed_gateway_contract_digest, observed_command_fingerprint,
           observed_schema_digest, observed_compatibility_digest
         ) VALUES ($1, 'provisioning', 'unbound', 'running', $2, $3, 'CELL_READY', $4, $5, $6, $7)
         RETURNING id`,
        [
          tenant.tenantId,
          fixture.compatibility.agent_contract.protocol_version,
          fixture.sourceRelease,
          target.gateway_contract_digest,
          target.command_fingerprint,
          target.schema_digest,
          target.compatibility_digest,
        ]
      );
      const operationId = randomUUID();
      await pool!.query(
        `INSERT INTO exomem_lifecycle_operations (
           id, tenant_id, cell_id, expected_previous_cell_id, operation_type, state, idempotency_key,
           fence_generation, checkpoint, lease_owner, lease_expires_at, provisioner_wire_protocol,
           target_candidate_id, target_assignment_id, target_assignment_generation,
           target_source_release, target_protocol_version, target_gateway_contract_digest,
           target_command_fingerprint, target_schema_digest, target_compatibility_digest
         ) VALUES ($1, $2, $3, $4, 'provision', 'running', $5, 1, 'readiness-proved',
                   'paired-bind', now() + interval '1 hour', 'exomem-cell-provisioner.v2',
                   $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          operationId,
          tenant.tenantId,
          replacement.rows[0]!.id,
          tenant.cellId,
          `paired-${operationId}`,
          candidateId,
          assignment.id,
          assignment.generation,
          fixture.sourceRelease,
          fixture.compatibility.agent_contract.protocol_version,
          target.gateway_contract_digest,
          target.command_fingerprint,
          target.schema_digest,
          target.compatibility_digest,
        ]
      );
      assert.equal(await new SqlLifecycleStore().bindCandidate(operationId, "paired-bind"), true);
      assert.equal(
        await new SqlLifecycleStore().advance(
          operationId,
          "paired-bind",
          "readiness-proved",
          "bound"
        ),
        true
      );
      assert.ok(
        await new SqlLifecycleStore().claim({
          owner: "paired-bind-finalize",
          leaseMs: 60_000,
          maxAttempts: 3,
          tenantId: tenant.tenantId,
        })
      );
      assert.equal(await new SqlLifecycleStore().succeed(operationId, "paired-bind-finalize"), true);
      if (previous) {
        await recordRoutableCellObservation({
          cellId: tenant.cellId,
          sourceRelease: previous.source_release,
          protocolVersion: previous.protocol_version,
          commandSurfaceSha256: previous.command_fingerprint,
          schemaDigest: previous.contract_digest,
          compatibilitySha256: previous.compatibility_digest,
          routable: false,
        });
      }
      tenant.cellId = replacement.rows[0]!.id;
      return replacement.rows[0]!.id;
    };
    const ordinary = await createTenant(false);
    const reviewer = await createTenant(true);
    const oauthClients = await pool!.query<{
      id: string;
      client_id: string;
      client_platform: "claude" | "openai";
      redirect_uri: string;
      oauth_client_config_sha256: string;
    }>(
      `SELECT id, client_id, client_platform, redirect_uris->>0 AS redirect_uri,
              oauth_client_config_sha256
       FROM exomem_oauth_clients
       WHERE enabled = true AND client_platform IN ('claude', 'openai')
       ORDER BY client_platform`
    );
    const clients = Object.fromEntries(
      oauthClients.rows.map((row) => [
        row.client_platform,
        {
          id: row.id,
          clientId: row.client_id,
          redirectUri: row.redirect_uri,
          platform: row.client_platform,
        } satisfies OAuthClientFixture,
      ])
    ) as Record<"claude" | "openai", OAuthClientFixture>;
    const oauthConfigDigest = oauthClients.rows[0]!.oauth_client_config_sha256;
    assert.equal(oauthClients.rows.length, 2);
    assert.ok(
      oauthClients.rows.every((row) => row.oauth_client_config_sha256 === oauthConfigDigest)
    );
    const liveCandidateId = (
      await pool!.query<{ id: string }>("SELECT id FROM exomem_hosted_alpha_cohort")
    ).rows[0]!.id;
    const ordinaryA = await issueAccess({
      client: clients.claude,
      userId: ordinary.userId,
      tenantId: ordinary.tenantId,
    });
    assert.equal((await findMcpOAuthAccessToken(ordinaryA.digest))?.tenantId, ordinary.tenantId);
    const candidateId = await storeRetainedExomemAgentContractCandidate("0.35.0");
    const assignment = await createCanaryAssignment({
      tenantId: reviewer.tenantId,
      candidateId,
      expiresAt: new Date(Date.now() + 60 * 60_000),
      operatorPrincipalDigest: sha("9"),
    });
    await activate(reviewer, candidateId, assignment, "0.35.0");
    assert.equal(
      (await getExomemAgentContractForOAuthAccess({ tenantId: ordinary.tenantId }))?.sourceRelease,
      liveRelease
    );
    assert.equal(
      (
        await getExomemAgentContractForOAuthAccess({
          tenantId: reviewer.tenantId,
          candidateId,
          assignmentId: assignment.id,
          assignmentGeneration: BigInt(assignment.generation),
        })
      )?.sourceRelease,
      "0.35.0"
    );
    const bStages = await attachCandidateLocksAndStages({
      candidateId,
      release: "0.35.0",
      oauthClientConfigSha256: oauthConfigDigest,
      digestSeed: { artifact: "d", archive: "e", registeredApp: "f" },
    });
    const bEvidence = await importPairedEvidence({
      candidateId,
      release: "0.35.0",
      assignment,
      stages: bStages,
      suffix: `pending-b-${randomUUID()}`,
      oauthClientConfigSha256: oauthConfigDigest,
    });
    const bClaude = await internalCanaryAccess({
      client: clients.claude,
      tenantId: reviewer.tenantId,
      userId: reviewer.userId,
      candidateId,
      assignment,
      stageId: bStages.claudeStage.id,
      suffix: 31,
    });
    const bOpenAi = await internalCanaryAccess({
      client: clients.openai,
      tenantId: reviewer.tenantId,
      userId: reviewer.userId,
      candidateId,
      assignment,
      stageId: bStages.openAiStage.id,
      suffix: 41,
    });
    assert.equal((await findMcpOAuthAccessToken(bClaude.digest))?.candidateId, candidateId);
    assert.equal((await findMcpOAuthAccessToken(bOpenAi.digest))?.candidateId, candidateId);

    const mcpDependencies = {
      baseUrl: "https://hosted.example.test",
      findAccessToken: findMcpOAuthAccessToken,
      getContractForAccess: getExomemAgentContractForOAuthAccess,
      takeRateLimit: async () => true,
    };
    const initialize = async (bearer: string, url = resource, headers: HeadersInit = {}) => {
      const response = await handleHostedMcpRequest(
        new Request(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearer}`,
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            ...headers,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              clientInfo: { name: "paired", version: "1" },
            },
          }),
        }),
        mcpDependencies
      );
      return {
        response,
        body: (await response.json()) as {
          error?: string;
          result?: { serverInfo?: { version?: string } };
        },
      };
    };
    const assertRelease = async (bearer: string, expected: PromotionFixtureRelease) => {
      const initialized = await initialize(bearer);
      assert.equal(initialized.response.status, 200, JSON.stringify(initialized.body));
      assert.equal(
        initialized.body.result?.serverInfo?.version,
        expected,
        JSON.stringify(initialized.body)
      );
    };
    await assertRelease(ordinaryA.bearer, liveRelease);
    await assertRelease(bClaude.bearer, "0.35.0");
    await assertRelease(bOpenAi.bearer, "0.35.0");
    for (const spoof of [
      initialize(bClaude.bearer, `${resource}?candidate_id=${candidateId}`),
      initialize(bClaude.bearer, resource, { "x-exomem-release": "0.35.0" }),
      initialize(bClaude.bearer, resource, {
        cookie: `assignment_generation=${assignment.generation}`,
      }),
    ]) {
      const { response, body } = await spoof;
      assert.equal(response.status, 400);
      assert.equal(body.error, "HOSTED_SELECTOR_REJECTED");
    }
    const nestedSpoof = await handleHostedMcpRequest(
      new Request(resource, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bClaude.bearer}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "ask_memory",
            arguments: {
              query: "paired",
              nested: {
                candidate_id: liveCandidateId,
                assignment_generation: assignment.generation + 1,
                cell_id: ordinary.cellId,
                artifact_id: bEvidence.claude.artifactId,
                schema_digest: sha("0"),
              },
            },
          },
        }),
      }),
      mcpDependencies
    );
    assert.match(await nestedSpoof.text(), /HOSTED_SELECTOR_REJECTED/);
    assert.equal(
      await getExomemAgentContractForOAuthAccess({
        tenantId: reviewer.tenantId,
        candidateId,
        assignmentId: assignment.id,
        assignmentGeneration: BigInt(assignment.generation + 1),
      }),
      null
    );
    await pool!.query(
      `UPDATE exomem_routable_cell_contracts SET source_release = '${liveRelease}' WHERE cell_id = $1`,
      [reviewer.cellId]
    );
    assert.equal(
      await getExomemAgentContractForOAuthAccess({
        tenantId: reviewer.tenantId,
        candidateId,
        assignmentId: assignment.id,
        assignmentGeneration: BigInt(assignment.generation),
      }),
      null
    );
    await pool!.query(
      "UPDATE exomem_routable_cell_contracts SET source_release = '0.35.0' WHERE cell_id = $1",
      [reviewer.cellId]
    );

    const ordinaryBAssignment = await createCanaryAssignment({
      tenantId: ordinary.tenantId,
      candidateId,
      expiresAt: new Date(Date.now() + 60 * 60_000),
      operatorPrincipalDigest: sha("9"),
    });
    await activate(ordinary, candidateId, ordinaryBAssignment, "0.35.0");
    assert.equal(await findMcpOAuthAccessToken(ordinaryA.digest), null);
    const observe = async (
      cellId: string,
      release: PromotionFixtureRelease | "0.24.0",
      locksRelease: PromotionFixtureRelease
    ) => {
      const fixture = promotionContractFixture(locksRelease);
      await recordRoutableCellObservation({
        cellId,
        sourceRelease: release,
        protocolVersion: fixture.compatibility.agent_contract.protocol_version,
        commandSurfaceSha256: fixture.compatibility.command_surface_sha256,
        schemaDigest: fixture.compatibility.schema_contract_sha256,
        compatibilitySha256: fixture.compatibility.compatibility_sha256,
        routable: true,
      });
    };
    await observe(reviewer.cellId, "0.35.0", "0.35.0");
    await observe(ordinary.cellId, "0.35.0", "0.35.0");
    const authorityDigest = async () =>
      (
        await pool!.query<{ routable_set_digest: string }>(
          "SELECT routable_set_digest FROM exomem_agent_contract_profile_authority WHERE profile_id = 'hosted-alpha-agent-v1'"
        )
      ).rows[0]!.routable_set_digest;
    const bAuthorityDigest = await authorityDigest();
    const bRouting = await pool!.query<{
      cell_id: string;
      source_release: string;
      protocol_version: string;
      command_fingerprint: string;
      contract_digest: string;
      compatibility_digest: string;
    }>(
      `SELECT cell_id::text AS cell_id, source_release, protocol_version, command_fingerprint, contract_digest,
              compatibility_digest
       FROM exomem_routable_cell_contracts
       WHERE profile_id = 'hosted-alpha-agent-v1' AND routable = true
       ORDER BY cell_id`
    );
    assert.ok(bRouting.rows.length > 2);
    assert.equal(bRouting.rows.filter((row) => row.source_release === "0.35.0").length, 2);
    assert.ok(
      bRouting.rows.filter((row) => row.source_release === "0.35.0").every(
        (row) =>
          row.source_release === bStages.fixture.sourceRelease &&
          row.protocol_version === bStages.fixture.compatibility.agent_contract.protocol_version &&
          row.command_fingerprint === bStages.fixture.compatibility.command_surface_sha256 &&
          row.contract_digest === bStages.fixture.compatibility.schema_contract_sha256 &&
          row.compatibility_digest === bStages.fixture.compatibility.compatibility_sha256
      )
    );
    assert.deepEqual(
      (
        await pool!.query<{ id: string }>(
          "SELECT id::text AS id FROM exomem_agent_contract_candidates WHERE profile_id = 'hosted-alpha-agent-v1' AND state = 'live' ORDER BY id"
        )
      ).rows.map((row) => row.id),
      [liveCandidateId]
    );
    const promotionProof = await pool!.query(
      `SELECT route.cell_id, operation.state, operation.checkpoint,
              operation.target_candidate_id = $1::uuid AS target_matches,
              cell.observed_gateway_contract_digest = operation.target_gateway_contract_digest AS gateway_matches,
              cell.observed_command_fingerprint = operation.target_command_fingerprint AS command_matches,
              cell.observed_schema_digest = operation.target_schema_digest AS schema_matches,
              cell.observed_compatibility_digest = operation.target_compatibility_digest AS compatibility_matches
       FROM exomem_routable_cell_contracts AS route
       JOIN exomem_cells AS cell ON cell.id = route.cell_id
       LEFT JOIN exomem_lifecycle_operations AS operation
         ON operation.cell_id = route.cell_id AND operation.target_candidate_id = $1::uuid
       WHERE route.profile_id = 'hosted-alpha-agent-v1' AND route.routable
       ORDER BY route.cell_id`,
      [candidateId]
    );
    assert.ok(
      promotionProof.rows.filter((row) => row.target_matches === true).length === 2 &&
      promotionProof.rows
        .filter((row) => row.target_matches === true)
        .every(
        (row) =>
          row.state === "succeeded" &&
          row.checkpoint === "bound" &&
          row.target_matches === true &&
          row.gateway_matches === true &&
          row.command_matches === true &&
          row.schema_matches === true &&
          row.compatibility_matches === true
        ),
      JSON.stringify(promotionProof.rows)
    );
    const promotionInput = {
        candidateId,
        claudeArtifactId: bEvidence.claude.artifactId,
        openaiArtifactId: bEvidence.openai.artifactId,
        expectedLiveCandidateId: liveCandidateId,
        expectedRoutableCellDigest: bAuthorityDigest,
        claudeEvidence: bEvidence.claude.evidence,
        openaiEvidence: bEvidence.openai.evidence,
      };
    const beforeV1PromotionStop = await pool!.query(
      `SELECT candidate.state AS candidate_state, artifact.state AS artifact_state
       FROM exomem_agent_contract_candidates AS candidate
       CROSS JOIN exomem_client_artifacts AS artifact
       WHERE candidate.id = $1 AND artifact.id IN ($2, $3) ORDER BY artifact.id`,
      [candidateId, bEvidence.claude.artifactId, bEvidence.openai.artifactId]
    );
    assert.equal(await promoteExomemHostedCohort(promotionInput), "precondition_failed");
    assert.deepEqual(
      (
        await pool!.query(
          `SELECT candidate.state AS candidate_state, artifact.state AS artifact_state
           FROM exomem_agent_contract_candidates AS candidate
           CROSS JOIN exomem_client_artifacts AS artifact
           WHERE candidate.id = $1 AND artifact.id IN ($2, $3) ORDER BY artifact.id`,
          [candidateId, bEvidence.claude.artifactId, bEvidence.openai.artifactId]
        )
      ).rows,
      beforeV1PromotionStop.rows
    );
    await pool!.query(
      `UPDATE exomem_routable_cell_contracts AS route SET routable = false
       WHERE route.profile_id = 'hosted-alpha-agent-v1' AND route.routable
         AND NOT EXISTS (
           SELECT 1 FROM exomem_lifecycle_operations AS operation
           WHERE operation.cell_id = route.cell_id
             AND operation.target_candidate_id = $1::uuid
             AND operation.provisioner_wire_protocol = 'exomem-cell-provisioner.v2'
             AND operation.operation_type IN ('provision', 'restore')
             AND operation.state = 'succeeded'
             AND operation.checkpoint = 'bound'
         )`,
      [candidateId]
    );
    for (const route of bRouting.rows.filter((row) => row.source_release === "0.35.0")) {
      await recordRoutableCellObservation({
        cellId: route.cell_id,
        sourceRelease: route.source_release,
        protocolVersion: route.protocol_version,
        commandSurfaceSha256: route.command_fingerprint,
        schemaDigest: route.contract_digest,
        compatibilitySha256: route.compatibility_digest,
        routable: true,
      });
    }
    assert.equal(
      await promoteExomemHostedCohort({
        ...promotionInput,
        expectedRoutableCellDigest: await authorityDigest(),
      }),
      "promoted"
    );
    assert.equal((await findMcpOAuthAccessToken(bClaude.digest))?.candidateId, candidateId);
    assert.equal((await findMcpOAuthAccessToken(bOpenAi.digest))?.candidateId, candidateId);
    const ordinaryB = await issueAccess({
      client: clients.claude,
      userId: ordinary.userId,
      tenantId: ordinary.tenantId,
    });
    await assertRelease(ordinaryB.bearer, "0.35.0");

    const rollbackCandidateId = await storeRetainedExomemAgentContractCandidate(liveRelease);
    assert.notEqual(rollbackCandidateId, liveCandidateId);
    assert.notEqual(rollbackCandidateId, candidateId);
    const rollbackStages = await attachCandidateLocksAndStages({
      candidateId: rollbackCandidateId,
      release: liveRelease,
      oauthClientConfigSha256: oauthConfigDigest,
      digestSeed: { artifact: "6", archive: "7", registeredApp: "8" },
    });
    const reviewerRollbackAssignment = await createCanaryAssignment({
      tenantId: reviewer.tenantId,
      candidateId: rollbackCandidateId,
      expiresAt: new Date(Date.now() + 60 * 60_000),
      operatorPrincipalDigest: sha("9"),
    });
    await activate(reviewer, rollbackCandidateId, reviewerRollbackAssignment, liveRelease);
    const rollbackEvidence = await importPairedEvidence({
      candidateId: rollbackCandidateId,
      release: liveRelease,
      assignment: reviewerRollbackAssignment,
      stages: rollbackStages,
      suffix: `rollback-a-${randomUUID()}`,
      oauthClientConfigSha256: oauthConfigDigest,
    });
    const rollbackClaude = await internalCanaryAccess({
      client: clients.claude,
      tenantId: reviewer.tenantId,
      userId: reviewer.userId,
      candidateId: rollbackCandidateId,
      assignment: reviewerRollbackAssignment,
      stageId: rollbackStages.claudeStage.id,
      suffix: 51,
    });
    const rollbackOpenAi = await internalCanaryAccess({
      client: clients.openai,
      tenantId: reviewer.tenantId,
      userId: reviewer.userId,
      candidateId: rollbackCandidateId,
      assignment: reviewerRollbackAssignment,
      stageId: rollbackStages.openAiStage.id,
      suffix: 61,
    });
    const ordinaryRollbackAssignment = await createCanaryAssignment({
      tenantId: ordinary.tenantId,
      candidateId: rollbackCandidateId,
      expiresAt: new Date(Date.now() + 60 * 60_000),
      operatorPrincipalDigest: sha("9"),
    });
    await activate(ordinary, rollbackCandidateId, ordinaryRollbackAssignment, liveRelease);
    assert.equal(await findMcpOAuthAccessToken(ordinaryB.digest), null);
    assert.ok(reviewerRollbackAssignment.generation > assignment.generation);
    assert.ok(ordinaryRollbackAssignment.generation > ordinaryBAssignment.generation);
    assert.notEqual(reviewerRollbackAssignment.id, assignment.id);
    assert.notEqual(ordinaryRollbackAssignment.id, ordinaryBAssignment.id);
    assert.notEqual(rollbackStages.claudeStage.id, bStages.claudeStage.id);
    assert.notEqual(rollbackStages.openAiStage.id, bStages.openAiStage.id);
    assert.notEqual(rollbackEvidence.claude.artifactId, bEvidence.claude.artifactId);
    assert.notEqual(rollbackEvidence.openai.artifactId, bEvidence.openai.artifactId);

    await observe(reviewer.cellId, liveRelease, liveRelease);
    await observe(ordinary.cellId, "0.24.0", liveRelease);
    assert.equal(
      await promoteExomemHostedCohort({
        candidateId: rollbackCandidateId,
        claudeArtifactId: rollbackEvidence.claude.artifactId,
        openaiArtifactId: rollbackEvidence.openai.artifactId,
        expectedLiveCandidateId: candidateId,
        expectedRoutableCellDigest: await authorityDigest(),
        claudeEvidence: rollbackEvidence.claude.evidence,
        openaiEvidence: rollbackEvidence.openai.evidence,
      }),
      "precondition_failed"
    );
    await observe(ordinary.cellId, liveRelease, liveRelease);
    assert.equal(
      await promoteExomemHostedCohort({
        candidateId: rollbackCandidateId,
        claudeArtifactId: rollbackEvidence.claude.artifactId,
        openaiArtifactId: rollbackEvidence.openai.artifactId,
        expectedLiveCandidateId: candidateId,
        expectedRoutableCellDigest: await authorityDigest(),
        claudeEvidence: rollbackEvidence.claude.evidence,
        openaiEvidence: rollbackEvidence.openai.evidence,
      }),
      "promoted"
    );
    assert.equal(
      (await findMcpOAuthAccessToken(rollbackClaude.digest))?.candidateId,
      rollbackCandidateId
    );
    assert.equal(
      (await findMcpOAuthAccessToken(rollbackOpenAi.digest))?.candidateId,
      rollbackCandidateId
    );
    const candidates = await pool!.query<{ id: string; state: string }>(
      "SELECT id, state FROM exomem_agent_contract_candidates WHERE id = ANY($1::uuid[])",
      [[liveCandidateId, candidateId, rollbackCandidateId]]
    );
    assert.deepEqual(Object.fromEntries(candidates.rows.map((row) => [row.id, row.state])), {
      [liveCandidateId]: "retired",
      [candidateId]: "retired",
      [rollbackCandidateId]: "live",
    });
    const retiredLineage = await pool!.query<{ id: string; state: string }>(
      `SELECT id, state FROM exomem_agent_contract_rollout_assignments
       WHERE id = ANY($1::uuid[])
       UNION ALL
       SELECT id, state FROM exomem_staged_client_releases WHERE id = ANY($2::uuid[])`,
      [
        [assignment.id, ordinaryBAssignment.id],
        [bStages.claudeStage.id, bStages.openAiStage.id],
      ]
    );
    assert.equal(retiredLineage.rows.length, 4);
    assert.ok(retiredLineage.rows.every((row) => row.state === "retired"));
    const ordinaryRollbackA = await issueAccess({
      client: clients.claude,
      userId: ordinary.userId,
      tenantId: ordinary.tenantId,
    });
    await assertRelease(ordinaryRollbackA.bearer, liveRelease);
  });
});
