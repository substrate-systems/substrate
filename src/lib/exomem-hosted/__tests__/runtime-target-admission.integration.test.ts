import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";
import {
  activateExomemHostedRuntime,
  storeExomemAgentContractCandidate,
} from "../agent-contract-store";
import { exomemHostedContractFixture } from "../agent-contract-fixture";
import {
  __setExomemSqlForTests,
  __setExomemTransactionForTests,
  createInviteRecord,
  redeemInviteAtomic,
  type ExomemSql,
} from "../db";
import { exomemContractFixture0890 } from "../gateway-contract-0-89-0";
import { handleHostedMcpRequest } from "../mcp";
import { mintOpaqueTokenMaterial } from "../oauth";
import { parseCimdDocument } from "../oauth-client-admission";
import {
  admitFirstOAuthInviteAtomic,
  createAuthorizationTransaction,
  findMcpOAuthAccessToken,
  issueOAuthTokensFromCodeAtomic,
  registerAdmittedCimdClient,
  resolveApprovedOAuthClient,
  revokeOAuthTokenFamily,
  rotateOAuthRefreshTokenAtomic,
} from "../oauth-store";
import { routableSetDigest } from "../routable-authority";
import { getTrustedHostedRuntimeTarget } from "../runtime-target-registry";
import { importTrustedHostedRuntimeTarget } from "../runtime-target-store";
import { encryptSecret } from "../security";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
const resource = "https://substratesystems.io/api/exomem/mcp/v1";
const claudeClientId = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const claudeRedirectUri = "https://claude.ai/api/mcp/auth_callback";
const claudeCimdRaw = JSON.stringify({
  client_id: claudeClientId,
  client_name: "Claude",
  client_uri: "https://claude.ai",
  redirect_uris: [claudeRedirectUri],
  grant_types: [
    "authorization_code",
    "refresh_token",
    "urn:ietf:params:oauth:grant-type:jwt-bearer",
  ],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
});
const emptyRoutableDigest = routableSetDigest("hosted-alpha-agent-v4", []);
const previousV2Issuance = process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED;
let pool: Pool | undefined;
let schema: string | undefined;

function digest(value: number): Buffer {
  const result = Buffer.alloc(32);
  result.writeUInt32BE(value, 28);
  return result;
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
    if (schema) await client.query("SELECT set_config('application_name', $1, true)", [schema]);
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
  return Number((await pool!.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0]!.count);
}

async function configureCapacity(): Promise<void> {
  await pool!.query(
    `UPDATE exomem_capacity_pools
     SET storage_capacity_bytes = 10737418240, runtime_capacity_slots = 2,
         provision_reservation_capacity = 2, provision_claim_capacity = 1,
         reserved_storage_bytes = 0, reserved_runtime_slots = 0,
         reserved_provision_slots = 0, configured_at = now()`
  );
}

async function importAndActivate(): Promise<string> {
  const candidateId = await storeExomemAgentContractCandidate();
  assert.deepEqual(
    await importTrustedHostedRuntimeTarget({ candidateId, operatorPrincipalDigest: digest(1) }),
    {
      candidateId,
      runtimeTargetDigest: getTrustedHostedRuntimeTarget("0.89.0")!.runtimeTargetDigest,
      outcome: "imported",
    }
  );
  assert.equal(
    await activateExomemHostedRuntime({
      candidateId,
      expectedLiveCandidateId: null,
      expectedRoutableCellDigest: emptyRoutableDigest,
    }),
    "activated"
  );
  return candidateId;
}

async function createOrdinaryInvite(sequence: number): Promise<void> {
  await createInviteRecord({
    tokenDigest: digest(sequence),
    emailNormalized: `runtime-target-${sequence}@example.test`,
    entitlementSource: "complimentary",
    capabilities: [],
    resourceLimits: {},
    operatorPrincipalDigest: digest(sequence + 1),
    expiresAt: new Date(Date.now() + 60 * 60_000),
  });
}

async function redeemOrdinaryInvite(sequence: number) {
  return redeemInviteAtomic({
    tokenDigest: digest(sequence),
    sessionDigest: digest(sequence + 2),
    csrfDigest: digest(sequence + 3),
    sessionExpiresAt: new Date(Date.now() + 60 * 60_000),
  });
}

async function seedOAuthAdmission(sequence: number) {
  const clientId = `https://runtime-target-${sequence}.example.test/metadata.json`;
  const redirectUri = `https://runtime-target-${sequence}.example.test/callback`;
  const client = await pool!.query<{ id: string }>(
    `INSERT INTO exomem_oauth_clients (
       client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest,
       client_platform, oauth_client_config_sha256
     ) VALUES ($1, 'pinned', true, $2::jsonb,
               digest(convert_to($2::jsonb::text, 'utf8'), 'sha256'), 'claude', $3)
     RETURNING id`,
    [clientId, JSON.stringify([redirectUri]), "f".repeat(64)]
  );
  await createOrdinaryInvite(sequence);
  await pool!.query(
    `INSERT INTO exomem_oauth_authorization_transactions (
       transaction_digest, client_id, redirect_uri, resource, requested_scopes,
       state_digest, state_envelope, form_nonce_digest, continuation_binding,
       pkce_challenge, expires_at
     ) VALUES ($1, $2, $3, $4, ARRAY['exomem.read', 'offline_access'], $5,
               '{}'::jsonb, $6, $7, 'runtime-target-challenge', now() + interval '1 hour')`,
    [
      digest(sequence + 10),
      client.rows[0]!.id,
      redirectUri,
      resource,
      digest(sequence + 11),
      digest(sequence + 12),
      digest(sequence + 13),
    ]
  );
  return {
    inviteDigest: digest(sequence),
    transactionDigest: digest(sequence + 10),
    sessionDigest: digest(sequence + 20),
    csrfDigest: digest(sequence + 21),
    sessionExpiresAt: new Date(Date.now() + 60 * 60_000),
    codeDigest: digest(sequence + 22),
    codeExpiresAt: new Date(Date.now() + 60 * 60_000),
  };
}

async function admitConnectedClaude(sequence: number) {
  const candidateId = await importAndActivate();
  await configureCapacity();
  const cimd = parseCimdDocument(claudeCimdRaw, claudeClientId);
  const registered = await registerAdmittedCimdClient(claudeClientId, {
    fetchCimd: async () => cimd,
  });
  assert.ok(registered);
  assert.deepEqual(registered, {
    id: registered.id,
    clientId: claudeClientId,
    redirectUris: [claudeRedirectUri],
    admissionMode: "cimd",
  });
  assert.deepEqual(await resolveApprovedOAuthClient(claudeClientId), registered);
  await createOrdinaryInvite(sequence);
  const transactionDigest = digest(sequence + 10);
  assert.ok(
    await createAuthorizationTransaction({
      transactionDigest,
      stateDigest: digest(sequence + 11),
      stateEnvelope: encryptSecret(
        JSON.stringify({ version: 1, state: `connected-service-${sequence}` }),
        { key: digest(sequence + 14) }
      ),
      formNonceDigest: digest(sequence + 12),
      continuationBinding: digest(sequence + 13),
      clientId: claudeClientId,
      redirectUri: claudeRedirectUri,
      resource,
      scopes: ["exomem.read", "offline_access"],
      pkceChallenge: "connected-service-challenge",
      expiresAt: new Date(Date.now() + 60 * 60_000),
    })
  );
  const admitted = await admitFirstOAuthInviteAtomic({
    inviteDigest: digest(sequence),
    transactionDigest,
    sessionDigest: digest(sequence + 20),
    csrfDigest: digest(sequence + 21),
    sessionExpiresAt: new Date(Date.now() + 60 * 60_000),
    codeDigest: digest(sequence + 22),
    codeExpiresAt: new Date(Date.now() + 60 * 60_000),
  });
  assert.ok(admitted?.operationId);
  const tokens = mintOpaqueTokenMaterial({ refreshAllowed: true });
  const issued = await issueOAuthTokensFromCodeAtomic({
    codeDigest: digest(sequence + 22),
    clientId: claudeClientId,
    redirectUri: claudeRedirectUri,
    resource,
    pkceChallenge: "connected-service-challenge",
    refreshDigest: tokens.refreshTokenDigest!,
    refreshExpiresAt: new Date(Date.now() + 60 * 60_000),
    accessDigest: tokens.accessTokenDigest,
    accessExpiresAt: tokens.accessTokenExpiresAt,
  });
  assert.ok(issued);
  assert.equal(issued.refreshInserted, true);
  assert.equal(
    (await findMcpOAuthAccessToken(tokens.accessTokenDigest))?.tenantId,
    admitted.tenantId
  );
  assert.deepEqual(
    await Promise.all([
      count("exomem_tenants"),
      count("exomem_lifecycle_operations"),
      count("exomem_capacity_allocations"),
      count("exomem_client_artifacts"),
      count("exomem_cells"),
    ]),
    [1, 1, 1, 0, 0]
  );
  return { admitted, candidateId, issued, tokens };
}

async function connectMcp(accessToken: string) {
  const transport = new StreamableHTTPClientTransport(new URL(resource), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    fetch: (input, init) =>
      handleHostedMcpRequest(new Request(input.toString(), init), {
        baseUrl: "https://substratesystems.io",
        takeRateLimit: async () => true,
      }),
  });
  const client = new Client({ name: "runtime-target-service-acceptance", version: "1" });
  await client.connect(transport);
  return { client, transport };
}

async function assertDiscoveryAndPreparing(accessToken: string): Promise<void> {
  const { client, transport } = await connectMcp(accessToken);
  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      exomemHostedContractFixture.compatibility.agent_contract.commands.map(
        (command) => command.mcp_tool.name
      )
    );
    const result = await client.callTool({ name: "coordination_status", arguments: {} });
    assert.equal(result.isError, true);
    const content = (result.content as Array<{ type: string; text?: string }>)[0];
    assert.equal(content?.type, "text");
    const refusal = JSON.parse(content?.type === "text" ? (content.text ?? "{}") : "{}") as {
      code?: string;
      retryable?: boolean;
      remediation?: string;
    };
    assert.equal(refusal.code, "CELL_PREPARING");
    assert.equal(refusal.retryable, true);
    assert.equal(refusal.remediation, "retry_later");
  } finally {
    await transport.close();
  }
}

async function assertFrozenOperation(
  operationId: string,
  candidateId: string,
  expectedReservations: 0 | 1
): Promise<void> {
  const trusted = getTrustedHostedRuntimeTarget("0.89.0")!;
  const operation = await pool!.query(
    `SELECT provisioner_wire_protocol, target_candidate_id::text, target_assignment_id::text,
            target_assignment_generation::text, target_source_release, target_protocol_version,
            target_gateway_contract_digest, target_command_fingerprint, target_schema_digest,
            target_compatibility_digest
     FROM exomem_lifecycle_operations WHERE id = $1`,
    [operationId]
  );
  assert.deepEqual(operation.rows, [
    {
      provisioner_wire_protocol: "exomem-cell-provisioner.v2",
      target_candidate_id: candidateId,
      target_assignment_id: null,
      target_assignment_generation: null,
      target_source_release: trusted.target.releaseVersion,
      target_protocol_version: trusted.target.protocolVersion,
      target_gateway_contract_digest: trusted.target.gatewayContractDigest,
      target_command_fingerprint: trusted.target.commandFingerprint,
      target_schema_digest: trusted.target.schemaDigest,
      target_compatibility_digest: trusted.target.compatibilityDigest,
    },
  ]);
  assert.deepEqual(
    await Promise.all([
      count("exomem_tenants"),
      count("exomem_lifecycle_operations"),
      count("exomem_capacity_allocations"),
    ]),
    [1, 1, expectedReservations]
  );
  if (expectedReservations === 0) return;
  assert.deepEqual(
    (
      await pool!.query(
        `SELECT state, storage_bytes::text, runtime_slots, provision_slots
         FROM exomem_capacity_allocations`
      )
    ).rows,
    [
      {
        state: "reserved",
        storage_bytes: "5368709120",
        runtime_slots: 1,
        provision_slots: 1,
      },
    ]
  );
}

async function waitForAdvisoryWaiters(expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool!.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_stat_activity
       WHERE datname = current_database()
         AND application_name = $1
         AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
      [schema]
    );
    if (result.rows[0]!.count >= expected) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`expected ${expected} advisory-lock waiters`);
}

describe("Hosted runtime target admission", { skip: !databaseUrl, concurrency: false }, () => {
  before(() => {
    process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED = "true";
  });

  beforeEach(async () => {
    schema = `runtime_target_admission_${randomUUID().replaceAll("-", "")}`;
    await ensureExomemPostgresTestExtensions(databaseUrl!);
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);
    await applyMigrations({ databaseUrl: scoped.toString() });
    pool = new Pool({ connectionString: scoped.toString() });
    __setExomemSqlForTests(sql(pool));
    __setExomemTransactionForTests(transaction);
  });

  afterEach(async () => {
    __setExomemSqlForTests(null);
    __setExomemTransactionForTests(null);
    await pool?.end();
    pool = undefined;
    if (schema) {
      const admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    schema = undefined;
  });

  after(() => {
    if (previousV2Issuance === undefined) delete process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED;
    else process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED = previousV2Issuance;
  });

  it("activates the reviewed target and preserves legacy ordinary-invite admission semantics", async () => {
    assert.deepEqual(
      await Promise.all([
        count("exomem_tenants"),
        count("exomem_cells"),
        count("exomem_agent_contract_candidates"),
      ]),
      [0, 0, 0]
    );
    const candidateId = await importAndActivate();
    assert.deepEqual(
      (
        await pool!.query(
          `SELECT conname FROM pg_constraint
           WHERE conrelid = 'exomem_lifecycle_operations'::regclass
             AND conname IN (
               'exomem_lifecycle_operations_provisioner_wire_protocol_check',
               'exomem_lifecycle_v2_target_check'
             ) ORDER BY conname`
        )
      ).rows,
      [
        { conname: "exomem_lifecycle_operations_provisioner_wire_protocol_check" },
        { conname: "exomem_lifecycle_v2_target_check" },
      ]
    );
    assert.equal(
      Number(
        (
          await pool!.query(
            `SELECT count(*)::int AS count FROM pg_trigger
             WHERE tgrelid = 'exomem_lifecycle_operations'::regclass
               AND tgname = 'exomem_lifecycle_provisioner_wire_protocol_immutable'
               AND NOT tgisinternal`
          )
        ).rows[0]!.count
      ),
      1
    );
    await configureCapacity();
    await createOrdinaryInvite(100);
    const admitted = await redeemOrdinaryInvite(100);
    assert.ok(admitted?.operationId);
    await assertFrozenOperation(admitted.operationId, candidateId, 0);
  });

  it("admits the first OAuth invite against the reviewed empty-fleet target", async () => {
    const candidateId = await importAndActivate();
    await configureCapacity();
    const admitted = await admitFirstOAuthInviteAtomic(await seedOAuthAdmission(200));
    assert.ok(admitted?.operationId);
    await assertFrozenOperation(admitted.operationId, candidateId, 1);
  });

  it("connects Claude through real OAuth admission while the empty fleet prepares", async () => {
    const service = await admitConnectedClaude(800);
    const initialAccess = service.tokens.accessToken.reveal();
    await assertDiscoveryAndPreparing(initialAccess);
    assert.equal(
      (await findMcpOAuthAccessToken(service.tokens.accessTokenDigest))?.familyId,
      service.issued.familyId
    );

    const rotatedTokens = mintOpaqueTokenMaterial({ refreshAllowed: true });
    assert.equal(
      await rotateOAuthRefreshTokenAtomic({
        refreshDigest: service.tokens.refreshTokenDigest!,
        replacementRefreshDigest: rotatedTokens.refreshTokenDigest!,
        accessDigest: rotatedTokens.accessTokenDigest,
        accessExpiresAt: rotatedTokens.accessTokenExpiresAt,
        clientId: claudeClientId,
        resource: `${resource}/wrong`,
      }),
      null
    );
    assert.ok(await findMcpOAuthAccessToken(service.tokens.accessTokenDigest));
    const rotated = await rotateOAuthRefreshTokenAtomic({
      refreshDigest: service.tokens.refreshTokenDigest!,
      replacementRefreshDigest: rotatedTokens.refreshTokenDigest!,
      accessDigest: rotatedTokens.accessTokenDigest,
      accessExpiresAt: rotatedTokens.accessTokenExpiresAt,
      clientId: claudeClientId,
      resource,
    });
    assert.equal(rotated?.familyId, service.issued.familyId);
    assert.equal(
      (await findMcpOAuthAccessToken(rotatedTokens.accessTokenDigest))?.tenantId,
      service.admitted.tenantId
    );
    await assertDiscoveryAndPreparing(rotatedTokens.accessToken.reveal());
    assert.deepEqual(
      await Promise.all([
        count("exomem_tenants"),
        count("exomem_lifecycle_operations"),
        count("exomem_capacity_allocations"),
      ]),
      [1, 1, 1]
    );

    await revokeOAuthTokenFamily(service.issued.familyId);
    assert.equal(await findMcpOAuthAccessToken(rotatedTokens.accessTokenDigest), null);
    const denied = await handleHostedMcpRequest(
      new Request(resource, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${rotatedTokens.accessToken.reveal()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "revoked-service-acceptance", version: "1" },
          },
        }),
      }),
      { baseUrl: "https://substratesystems.io", takeRateLimit: async () => true }
    );
    assert.equal(denied.status, 401);
    assert.deepEqual(
      (
        await pool!.query(
          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE consumed_at IS NOT NULL)::int AS consumed
           FROM exomem_invites`
        )
      ).rows,
      [{ total: 1, consumed: 1 }]
    );
  });

  it("keeps discovery available when the admitted tenant has a nonready bound cell", async () => {
    const service = await admitConnectedClaude(900);
    const cell = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_cells (
         tenant_id, lifecycle_state, routing_state, desired_state, protocol_version,
         release_version
       ) VALUES ($1, 'active', 'bound', 'running', $2, $3) RETURNING id`,
      [
        service.admitted.tenantId,
        exomemContractFixture0890.protocol,
        exomemHostedContractFixture.sourceRelease,
      ]
    );
    await pool!.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [
      cell.rows[0]!.id,
      service.admitted.tenantId,
    ]);
    assert.equal(await count("exomem_routable_cell_contracts"), 0);

    await assertDiscoveryAndPreparing(service.tokens.accessToken.reveal());
    const rotatedTokens = mintOpaqueTokenMaterial({ refreshAllowed: true });
    assert.equal(
      (
        await rotateOAuthRefreshTokenAtomic({
          refreshDigest: service.tokens.refreshTokenDigest!,
          replacementRefreshDigest: rotatedTokens.refreshTokenDigest!,
          accessDigest: rotatedTokens.accessTokenDigest,
          accessExpiresAt: rotatedTokens.accessTokenExpiresAt,
          clientId: claudeClientId,
          resource,
        })
      )?.familyId,
      service.issued.familyId
    );
    assert.ok(await findMcpOAuthAccessToken(rotatedTokens.accessTokenDigest));
    assert.deepEqual(
      await Promise.all([
        count("exomem_tenants"),
        count("exomem_lifecycle_operations"),
        count("exomem_capacity_allocations"),
      ]),
      [1, 1, 1]
    );
  });

  it("refuses empty-fleet activation without an imported target and changes no state", async () => {
    const candidateId = await storeExomemAgentContractCandidate();
    assert.equal(
      await activateExomemHostedRuntime({
        candidateId,
        expectedLiveCandidateId: null,
        expectedRoutableCellDigest: emptyRoutableDigest,
      }),
      "precondition_failed"
    );
    assert.deepEqual(
      (
        await pool!.query(
          `SELECT state, promoted_at IS NULL AS never_promoted
           FROM exomem_agent_contract_candidates WHERE id = $1`,
          [candidateId]
        )
      ).rows,
      [{ state: "pending", never_promoted: true }]
    );
    assert.deepEqual(
      await Promise.all([
        count("exomem_runtime_targets"),
        count("exomem_tenants"),
        count("exomem_lifecycle_operations"),
      ]),
      [0, 0, 0]
    );
  });

  it("keeps identical imports and active retries idempotent while the first provision is pending", async () => {
    const candidateId = await importAndActivate();
    await configureCapacity();
    await createOrdinaryInvite(300);
    const admitted = await redeemOrdinaryInvite(300);
    assert.ok(admitted?.operationId);
    assert.equal(
      (
        await pool!.query("SELECT state FROM exomem_lifecycle_operations WHERE id = $1", [
          admitted.operationId,
        ])
      ).rows[0]!.state,
      "pending"
    );
    assert.equal(
      (
        await importTrustedHostedRuntimeTarget({
          candidateId,
          operatorPrincipalDigest: digest(301),
        })
      ).outcome,
      "unchanged"
    );
    assert.equal(
      await activateExomemHostedRuntime({
        candidateId,
        expectedLiveCandidateId: candidateId,
        expectedRoutableCellDigest: emptyRoutableDigest,
      }),
      "already_active"
    );
    assert.deepEqual(
      await Promise.all([
        count("exomem_runtime_targets"),
        count("exomem_tenants"),
        count("exomem_lifecycle_operations"),
        count("exomem_capacity_allocations"),
      ]),
      [1, 1, 1, 0]
    );
  });

  it("rejects a corrupted stored target without overwriting it", async () => {
    const candidateId = await storeExomemAgentContractCandidate();
    await importTrustedHostedRuntimeTarget({
      candidateId,
      operatorPrincipalDigest: digest(400),
    });
    const corrupted = "e".repeat(64);
    await pool!.query(
      "UPDATE exomem_runtime_targets SET gateway_contract_digest = $2 WHERE candidate_id = $1",
      [candidateId, corrupted]
    );
    await assert.rejects(
      importTrustedHostedRuntimeTarget({
        candidateId,
        operatorPrincipalDigest: digest(401),
      }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "IDEMPOTENCY_KEY_REUSED" &&
        "status" in error &&
        error.status === 409
    );
    assert.deepEqual(
      (
        await pool!.query(
          `SELECT gateway_contract_digest, imported_by_principal_digest
           FROM exomem_runtime_targets WHERE candidate_id = $1`,
          [candidateId]
        )
      ).rows,
      [{ gateway_contract_digest: corrupted, imported_by_principal_digest: digest(400) }]
    );
    assert.equal(
      await activateExomemHostedRuntime({
        candidateId,
        expectedLiveCandidateId: null,
        expectedRoutableCellDigest: emptyRoutableDigest,
      }),
      "precondition_failed"
    );
    assert.deepEqual(
      (
        await pool!.query(
          "SELECT state, promoted_at IS NULL AS never_promoted FROM exomem_agent_contract_candidates WHERE id = $1",
          [candidateId]
        )
      ).rows,
      [{ state: "pending", never_promoted: true }]
    );
  });

  it("refuses empty-projection activation while an actual bound cell exists", async () => {
    const candidateId = await storeExomemAgentContractCandidate();
    await importTrustedHostedRuntimeTarget({
      candidateId,
      operatorPrincipalDigest: digest(450),
    });
    const owner = await pool!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ($1) RETURNING id",
      [`bound-cell-${randomUUID()}@example.test`]
    );
    const tenant = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_tenants (owner_user_id, status, desired_state, legacy_unmetered)
       VALUES ($1, 'active', 'running', true) RETURNING id`,
      [owner.rows[0]!.id]
    );
    await pool!.query(
      `INSERT INTO exomem_cells (
         tenant_id, lifecycle_state, routing_state, desired_state, protocol_version,
         release_version, readiness_code
       ) VALUES ($1, 'active', 'bound', 'running', $2, $3, 'CELL_READY')`,
      [
        tenant.rows[0]!.id,
        exomemContractFixture0890.protocol,
        exomemHostedContractFixture.sourceRelease,
      ]
    );
    assert.equal(await count("exomem_routable_cell_contracts"), 0);
    assert.equal(
      await activateExomemHostedRuntime({
        candidateId,
        expectedLiveCandidateId: null,
        expectedRoutableCellDigest: emptyRoutableDigest,
      }),
      "precondition_failed"
    );
    assert.equal(
      (
        await pool!.query("SELECT state FROM exomem_agent_contract_candidates WHERE id = $1", [
          candidateId,
        ])
      ).rows[0]!.state,
      "pending"
    );
  });

  it("preserves the imported target after the last cell is deleted and admits again", async () => {
    const candidateId = await importAndActivate();
    const owner = await pool!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ($1) RETURNING id",
      [`last-cell-${randomUUID()}@example.test`]
    );
    const tenant = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_tenants (owner_user_id, status, desired_state, legacy_unmetered)
       VALUES ($1, 'active', 'running', true) RETURNING id`,
      [owner.rows[0]!.id]
    );
    const cell = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_cells (
         tenant_id, lifecycle_state, routing_state, desired_state, protocol_version,
         release_version, readiness_code, observed_gateway_contract_digest,
         observed_command_fingerprint, observed_schema_digest, observed_compatibility_digest
       ) VALUES ($1, 'active', 'bound', 'running', $2, $3, 'CELL_READY', $4, $5, $6, $7)
       RETURNING id`,
      [
        tenant.rows[0]!.id,
        exomemContractFixture0890.protocol,
        exomemHostedContractFixture.sourceRelease,
        exomemContractFixture0890.digest,
        exomemHostedContractFixture.compatibility.command_surface_sha256,
        exomemHostedContractFixture.compatibility.schema_contract_sha256,
        exomemHostedContractFixture.compatibility.compatibility_sha256,
      ]
    );
    await pool!.query(
      `INSERT INTO exomem_routable_cell_contracts (
         cell_id, profile_id, source_release, protocol_version, command_fingerprint,
         contract_digest, compatibility_digest, routable
       ) VALUES ($1, 'hosted-alpha-agent-v4', $2, $3, $4, $5, $6, true)`,
      [
        cell.rows[0]!.id,
        exomemHostedContractFixture.sourceRelease,
        exomemContractFixture0890.protocol,
        exomemHostedContractFixture.compatibility.command_surface_sha256,
        exomemHostedContractFixture.compatibility.schema_contract_sha256,
        exomemHostedContractFixture.compatibility.compatibility_sha256,
      ]
    );
    assert.equal(
      await activateExomemHostedRuntime({
        candidateId,
        expectedLiveCandidateId: candidateId,
        expectedRoutableCellDigest: emptyRoutableDigest,
      }),
      "already_active"
    );
    await pool!.query("DELETE FROM exomem_routable_cell_contracts WHERE cell_id = $1", [
      cell.rows[0]!.id,
    ]);
    await pool!.query("DELETE FROM exomem_cells WHERE id = $1", [cell.rows[0]!.id]);
    await pool!.query("DELETE FROM exomem_tenants WHERE id = $1", [tenant.rows[0]!.id]);
    await pool!.query("DELETE FROM users WHERE id = $1", [owner.rows[0]!.id]);
    assert.deepEqual(
      await Promise.all([
        count("exomem_cells"),
        count("exomem_tenants"),
        count("exomem_runtime_targets"),
      ]),
      [0, 0, 1]
    );
    await configureCapacity();
    await createOrdinaryInvite(500);
    const admitted = await redeemOrdinaryInvite(500);
    assert.ok(admitted?.operationId);
    await assertFrozenOperation(admitted.operationId, candidateId, 0);
  });

  it("serializes empty-fleet activation before a racing admission", async () => {
    const candidateId = await storeExomemAgentContractCandidate();
    await importTrustedHostedRuntimeTarget({
      candidateId,
      operatorPrincipalDigest: digest(600),
    });
    await configureCapacity();
    await createOrdinaryInvite(601);
    const blocker = await pool!.connect();
    let committed = false;
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))");
    try {
      const activation = activateExomemHostedRuntime({
        candidateId,
        expectedLiveCandidateId: null,
        expectedRoutableCellDigest: emptyRoutableDigest,
      });
      await waitForAdvisoryWaiters(1);
      const admission = redeemOrdinaryInvite(601);
      await waitForAdvisoryWaiters(2);
      await blocker.query("COMMIT");
      committed = true;
      assert.equal(await activation, "activated");
      const admitted = await admission;
      assert.ok(admitted?.operationId);
      await assertFrozenOperation(admitted.operationId, candidateId, 0);
    } finally {
      if (!committed) await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });

  it("blocks activation on same-target canary work before retiring its assignment", async () => {
    const candidateId = await storeExomemAgentContractCandidate();
    await importTrustedHostedRuntimeTarget({
      candidateId,
      operatorPrincipalDigest: digest(700),
    });
    const target = getTrustedHostedRuntimeTarget("0.89.0")!.target;
    const owner = await pool!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ($1) RETURNING id",
      [`canary-prep-${randomUUID()}@example.test`]
    );
    const tenant = await pool!.query<{ id: string; fence_generation: string }>(
      `INSERT INTO exomem_tenants (
         owner_user_id, status, desired_state, marketplace_reviewer_purpose, legacy_unmetered
       ) VALUES ($1, 'provisioning', 'running', true, true)
       RETURNING id, fence_generation`,
      [owner.rows[0]!.id]
    );
    const assignment = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_agent_contract_rollout_assignments (
         tenant_id, candidate_id, generation, state, source_release, protocol_version,
         command_fingerprint, schema_digest, compatibility_digest, gateway_contract_digest,
         marketplace_reviewer_purpose, created_by_principal_digest, expires_at
       ) VALUES ($1, $2, 1, 'preparing', $3, $4, $5, $6, $7, $8, true, $9,
                 now() + interval '1 hour') RETURNING id`,
      [
        tenant.rows[0]!.id,
        candidateId,
        target.releaseVersion,
        target.protocolVersion,
        target.commandFingerprint,
        target.schemaDigest,
        target.compatibilityDigest,
        target.gatewayContractDigest,
        "9".repeat(64),
      ]
    );
    await pool!.query(
      `INSERT INTO exomem_lifecycle_operations (
         tenant_id, operation_type, state, idempotency_key, fence_generation,
         provisioner_wire_protocol, target_candidate_id, target_assignment_id,
         target_assignment_generation, target_source_release, target_protocol_version,
         target_gateway_contract_digest, target_command_fingerprint, target_schema_digest,
         target_compatibility_digest
       ) VALUES ($1, 'provision', 'pending', 'same-target-canary-prep', $2,
                 'exomem-cell-provisioner.v2', $3, $4, 1, $5, $6, $7, $8, $9, $10)`,
      [
        tenant.rows[0]!.id,
        tenant.rows[0]!.fence_generation,
        candidateId,
        assignment.rows[0]!.id,
        target.releaseVersion,
        target.protocolVersion,
        target.gatewayContractDigest,
        target.commandFingerprint,
        target.schemaDigest,
        target.compatibilityDigest,
      ]
    );
    assert.equal(
      await activateExomemHostedRuntime({
        candidateId,
        expectedLiveCandidateId: null,
        expectedRoutableCellDigest: emptyRoutableDigest,
      }),
      "precondition_failed"
    );
    assert.deepEqual(
      (
        await pool!.query(
          `SELECT candidate.state AS candidate_state, assignment.state AS assignment_state,
                  assignment.ended_at IS NULL AS assignment_not_ended
           FROM exomem_agent_contract_candidates AS candidate
           JOIN exomem_agent_contract_rollout_assignments AS assignment
             ON assignment.candidate_id = candidate.id
           WHERE candidate.id = $1`,
          [candidateId]
        )
      ).rows,
      [
        {
          candidate_state: "pending",
          assignment_state: "preparing",
          assignment_not_ended: true,
        },
      ]
    );
  });
});
