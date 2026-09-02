import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
import { exomemHostedContractFixture } from "../agent-contract-fixture";
import { exomemContractFixture0683 } from "../gateway-contract-0-68-3";
import { resolveApprovedOAuthClient } from "../oauth-store";
import {
  getLiveExomemHostedCohortCandidateId,
  listExomemHostedRolloutStatus,
  promoteExomemHostedCohort,
  recordRoutableCellObservation,
  storeExomemAgentContractCandidate,
} from "../agent-contract-store";
import { storeClientArtifact } from "../client-artifacts";
import { createStagedClientRelease } from "../agent-contract-canaries";
import { __setPromotionProvisionerForTests } from "../promotion-runtime";
import { digestSecret, encryptSecret } from "../security";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";
import {
  evidence,
  pendingArtifactFromEvidence,
  testOnlyOpenAiLocks,
} from "./agent-contract-promotion-fixture";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
let pool: Pool | undefined;
let schema: string | undefined;
const sha = (letter: string) => letter.repeat(64);
const envelopeKey = Buffer.alloc(32, 0x3a);

function sql(client: Pool | PoolClient): ExomemSql {
  return (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = "";
    strings.forEach((chunk, index) => {
      text += chunk;
      if (index < values.length) text += `$${index + 1}`;
    });
    return client.query(text, values as never[]);
  }) as unknown as ExomemSql;
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

/** One reviewer-purpose tenant bound to one routable cell. */
async function seedBoundCell(): Promise<string> {
  const user = await pool!.query<{ id: string }>(
    "INSERT INTO users (email) VALUES ($1) RETURNING id",
    [`platform-cohort-${randomUUID()}@example.test`]
  );
  const tenant = await pool!.query<{ id: string }>(
    `INSERT INTO exomem_tenants (owner_user_id, status, desired_state, marketplace_reviewer_purpose)
     VALUES ($1, 'active', 'running', true) RETURNING id`,
    [user.rows[0]!.id]
  );
  const cell = await pool!.query<{ id: string }>(
    `INSERT INTO exomem_cells (
       tenant_id, lifecycle_state, routing_state, desired_state, protocol_version, release_version,
       worker_policy, provider_ref, service_credential_ciphertext, service_credential_digest
     ) VALUES ($1, 'active', 'bound', 'running', '1', 'test',
               '{"workerCount":1,"semantic":true,"media":false}'::jsonb, $2, $3::jsonb, $4) RETURNING id`,
    [
      tenant.rows[0]!.id,
      `platform-cohort-${randomUUID()}`,
      JSON.stringify(encryptSecret("platform-cohort-credential", { key: envelopeKey })),
      digestSecret("platform-cohort-credential"),
    ]
  );
  await pool!.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [
    cell.rows[0]!.id,
    tenant.rows[0]!.id,
  ]);
  return cell.rows[0]!.id;
}

/** Active assignment, observed digests, and the bound provision operation promotion requires. */
async function seedExactBoundProof(candidateId: string): Promise<void> {
  await pool!.query(
    `INSERT INTO exomem_agent_contract_rollout_assignments (
       tenant_id, candidate_id, generation, state, source_release, protocol_version,
       command_fingerprint, schema_digest, compatibility_digest, gateway_contract_digest,
       marketplace_reviewer_purpose, created_by_principal_digest, expires_at, activated_at
     )
     SELECT cell.tenant_id, target.id, 1, 'active', target.source_release, target.protocol_version,
            target.command_fingerprint, target.schema_digest, target.compatibility_digest, $2,
            true, $3, now() + interval '1 hour', now()
     FROM exomem_routable_cell_contracts AS route
     JOIN exomem_cells AS cell ON cell.id = route.cell_id
     JOIN exomem_agent_contract_candidates AS target ON target.id = $1::uuid
     WHERE route.profile_id = 'hosted-alpha-agent-v4' AND route.routable`,
    [candidateId, exomemContractFixture0683.digest, sha("9")]
  );
  await pool!.query(
    `UPDATE exomem_cells AS cell
     SET readiness_code = 'CELL_READY',
         observed_gateway_contract_digest = $2,
         observed_command_fingerprint = target.command_fingerprint,
         observed_schema_digest = target.schema_digest,
         observed_compatibility_digest = target.compatibility_digest
     FROM exomem_agent_contract_candidates AS target,
          exomem_routable_cell_contracts AS route
     WHERE target.id = $1::uuid AND route.cell_id = cell.id
       AND route.profile_id = 'hosted-alpha-agent-v4' AND route.routable`,
    [candidateId, exomemContractFixture0683.digest]
  );
  await pool!.query(
    `INSERT INTO exomem_lifecycle_operations (
       tenant_id, cell_id, operation_type, state, idempotency_key, fence_generation, checkpoint,
       provisioner_wire_protocol, target_candidate_id, target_source_release, target_protocol_version,
       target_assignment_id, target_assignment_generation,
       target_gateway_contract_digest, target_command_fingerprint, target_schema_digest,
       target_compatibility_digest, completed_at
     )
     SELECT cell.tenant_id, cell.id, 'provision', 'succeeded',
            'platform-cohort-' || target.id::text || '-' || cell.id::text,
            tenant.fence_generation, 'bound',
            'exomem-cell-provisioner.v2', target.id, target.source_release, target.protocol_version,
            assignment.id, assignment.generation,
            $2, target.command_fingerprint, target.schema_digest, target.compatibility_digest, now()
     FROM exomem_routable_cell_contracts AS route
     JOIN exomem_cells AS cell ON cell.id = route.cell_id
     JOIN exomem_tenants AS tenant ON tenant.id = cell.tenant_id
     JOIN exomem_agent_contract_candidates AS target ON target.id = $1::uuid
     JOIN exomem_agent_contract_rollout_assignments AS assignment
       ON assignment.tenant_id = cell.tenant_id AND assignment.candidate_id = target.id
      AND assignment.state = 'active' AND assignment.expires_at > now()
     WHERE route.profile_id = 'hosted-alpha-agent-v4' AND route.routable`,
    [candidateId, exomemContractFixture0683.digest]
  );
}

/**
 * A host-allowlisted CIMD client, the shape ChatGPT connectors arrive as. Its
 * `oauth_client_config_sha256` is deliberately unique per client: that is the
 * whole reason the host allowlist exists, since every connector has its own
 * connectorId and therefore its own digest, which can never match a pinned one.
 */
async function registerCimdClient(platform: "claude" | "openai", host: string): Promise<string> {
  const clientId = `https://${host}/connectors/${randomUUID()}`;
  await pool!.query(
    `INSERT INTO exomem_oauth_admitted_cimd_hosts (platform, host)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [platform, host]
  );
  await pool!.query(
    `INSERT INTO exomem_oauth_clients (
       client_id, admission_mode, enabled, metadata_provenance, redirect_uris,
       redirect_uris_digest, client_platform, oauth_client_config_sha256,
       metadata_document_digest, metadata_fetched_at, metadata_ttl_seconds,
       metadata_expires_at, cimd_host, auto_registered
     ) VALUES ($1, 'cimd', true, '{}'::jsonb, $2::jsonb,
               digest(convert_to($2::text, 'utf8'), 'sha256'), $3, $4,
               digest(convert_to($1, 'utf8'), 'sha256'), now(), 3600,
               now() + interval '1 hour', $5, true)`,
    [
      clientId,
      JSON.stringify([`https://${host}/callback`]),
      platform,
      createHash("sha256").update(clientId).digest("hex"),
      host,
    ]
  );
  return clientId;
}

async function registerPinnedClient(platform: "claude" | "openai"): Promise<string> {
  const clientId = `${platform}-${randomUUID()}`;
  await pool!.query(
    `INSERT INTO exomem_oauth_clients (
       client_id, admission_mode, enabled, metadata_provenance, redirect_uris,
       redirect_uris_digest, client_platform, oauth_client_config_sha256
     ) VALUES ($1, 'pinned', true, '{}'::jsonb, '["https://example.test/callback"]'::jsonb,
               digest(convert_to('["https://example.test/callback"]', 'utf8'), 'sha256'), $2, $3)`,
    [clientId, platform, sha("a")]
  );
  return clientId;
}

describe("per-platform cohort admission", { skip: !databaseUrl }, () => {
  before(async () => {
    schema = `platform_cohort_it_${randomUUID().replaceAll("-", "")}`;
    await ensureExomemPostgresTestExtensions(databaseUrl!);
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);
    await applyMigrations({ databaseUrl: scoped.toString() });
    // The promotion proof fixture models the subsequent full-identity codec.
    await admin.query(
      `ALTER TABLE "${schema}".exomem_lifecycle_operations
       DROP CONSTRAINT exomem_lifecycle_operations_provisioner_wire_protocol_check`
    );
    await admin.query(
      `DROP TRIGGER exomem_lifecycle_provisioner_wire_protocol_immutable
       ON "${schema}".exomem_lifecycle_operations`
    );
    await admin.end();
    pool = new Pool({ connectionString: scoped.toString(), max: 3 });
    __setExomemSqlForTests(sql(pool));
    __setExomemTransactionForTests(transaction);
    process.env.EXOMEM_HOSTED_CLAUDE_INSTALL_URL = "https://claude.ai/plugins/exomem-hosted";
    process.env.EXOMEM_HOSTED_OPENAI_INSTALL_URL = "https://chatgpt.com/plugins/exomem-hosted";
    process.env.EXOMEM_HOSTED_PROMOTION_KEY_ID = "integration-operator";
    process.env.EXOMEM_HOSTED_PROMOTION_SECRET = "integration-secret";
    process.env.EXOMEM_CONTROL_PLANE_KEY = envelopeKey.toString("base64url");
    __setPromotionProvisionerForTests({
      health: async (request) => ({
        live: true,
        ready: true,
        cellId: request.cellId,
        protocolVersion: request.runtimeTarget!.protocolVersion,
        releaseVersion: request.runtimeTarget!.releaseVersion,
        serviceAuthenticated: true,
        mutationAuthority: true,
        readAdmission: true,
        writeAdmission: true,
        workerPolicy: request.workerPolicy,
        runtimeIdentity: request.runtimeTarget,
        code: "CELL_READY",
      }),
    });
  });

  after(async () => {
    __setExomemSqlForTests(null);
    __setExomemTransactionForTests(null);
    delete process.env.EXOMEM_HOSTED_CLAUDE_INSTALL_URL;
    delete process.env.EXOMEM_HOSTED_OPENAI_INSTALL_URL;
    delete process.env.EXOMEM_HOSTED_PROMOTION_KEY_ID;
    delete process.env.EXOMEM_HOSTED_PROMOTION_SECRET;
    delete process.env.EXOMEM_CONTROL_PLANE_KEY;
    __setPromotionProvisionerForTests(null);
    await pool?.end();
    if (schema) {
      const admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it("promotes Claude alone, and then cannot pair OpenAI onto that candidate at all", async () => {
    const fixture = exomemHostedContractFixture.compatibility;
    const cellId = await seedBoundCell();
    await recordRoutableCellObservation({
      cellId,
      sourceRelease: exomemHostedContractFixture.sourceRelease,
      protocolVersion: fixture.agent_contract.protocol_version,
      commandSurfaceSha256: fixture.command_surface_sha256,
      schemaDigest: fixture.schema_contract_sha256,
      compatibilitySha256: fixture.compatibility_sha256,
      routable: true,
    });
    const candidateId = await storeExomemAgentContractCandidate();
    await seedExactBoundProof(candidateId);
    const claudeStage = await createStagedClientRelease({
      candidateId,
      platform: "claude",
      packageSha256: exomemHostedContractFixture.packageLock.artifact_sha256,
      archiveSha256: exomemHostedContractFixture.archiveLock.archive_sha256,
      compatibilitySha256: fixture.compatibility_sha256,
      contractSha256: fixture.schema_contract_sha256,
      pluginVersion: exomemHostedContractFixture.packageLock.plugin_version,
      oauthClientConfigSha256: sha("a"),
      registeredAppIdSha256: null,
      expiresAt: new Date(Date.now() + 60 * 60_000),
      operatorPrincipalDigest: sha("9"),
    });
    const assignment = await pool!.query<{ id: string; generation: string }>(
      `SELECT id::text AS id, generation FROM exomem_agent_contract_rollout_assignments
       WHERE candidate_id = $1::uuid AND state = 'active' LIMIT 1`,
      [candidateId]
    );
    // Reassert the checked OpenAI locks while the candidate is still pending.
    // Signed import is covered by the contract tests; what matters here is that
    // the exact locks remain attached before promotion.
    await pool!.query(
      `UPDATE exomem_agent_contract_candidates
       SET openai_package_lock = $2::jsonb, openai_archive_lock = $3::jsonb
       WHERE id = $1::uuid`,
      [
        candidateId,
        JSON.stringify(testOnlyOpenAiLocks.packageLock),
        JSON.stringify(testOnlyOpenAiLocks.archiveLock),
      ]
    );
    const openAiStage = await createStagedClientRelease({
      candidateId,
      platform: "openai",
      packageSha256: testOnlyOpenAiLocks.packageLock.artifact_sha256,
      archiveSha256: testOnlyOpenAiLocks.archiveLock.archive_sha256,
      compatibilitySha256: fixture.compatibility_sha256,
      contractSha256: fixture.schema_contract_sha256,
      pluginVersion: testOnlyOpenAiLocks.packageLock.plugin_version,
      // The promotion evidence fixture signs `oauth_client_config_sha256` as
      // sha("a") for both platforms, and the artifact import compares the stage
      // against the signed value rather than against the platform.
      oauthClientConfigSha256: sha("a"),
      registeredAppIdSha256: testOnlyOpenAiLocks.packageLock.registered_app_id_sha256,
      expiresAt: new Date(Date.now() + 60 * 60_000),
      operatorPrincipalDigest: sha("9"),
    });

    const claudeEvidence = evidence("claude", "integration-secret", randomUUID(), {
      candidateId,
      stageId: claudeStage.id,
      assignmentId: assignment.rows[0]!.id,
      assignmentGeneration: Number(assignment.rows[0]!.generation),
    });
    const claudeArtifactId = await storeClientArtifact(
      pendingArtifactFromEvidence("claude", claudeEvidence)
    );
    // Every OpenAI step below requires `candidate.state = 'pending'` -- the lock
    // attach, the stage, and the artifact import all say so -- so the whole OpenAI
    // evidence chain has to be built now, before the Claude-only promotion flips
    // the candidate to `live`. Only `promoteExomemHostedCohort` itself is
    // deferrable. Building it afterwards is not merely awkward; it is impossible
    // on this candidate.
    const openAiEvidence = evidence("openai", "integration-secret", randomUUID(), {
      candidateId,
      stageId: openAiStage.id,
      assignmentId: assignment.rows[0]!.id,
      assignmentGeneration: Number(assignment.rows[0]!.generation),
    });
    const openAiArtifactId = await storeClientArtifact(
      pendingArtifactFromEvidence("openai", openAiEvidence)
    );
    const claudeClientId = await registerPinnedClient("claude");
    // Deliberately the SAME configuration digest as the Claude client. Under the
    // old paired predicate this client matched cohort.openai_oauth_client_config_sha256;
    // it must now be refused, because its own platform has no live cohort.
    const openAiClientId = await registerPinnedClient("openai");

    const status = (await listExomemHostedRolloutStatus()).find(
      (entry) => entry.candidateId === candidateId
    );
    assert.ok(status?.routableSetDigest, "promotion needs the routable CAS digest");

    assert.equal(
      await promoteExomemHostedCohort({
        candidateId,
        claudeArtifactId,
        expectedLiveCandidateId: null,
        expectedRoutableCellDigest: status.routableSetDigest,
        claudeEvidence,
      }),
      "promoted"
    );

    assert.deepEqual(
      (
        await pool!.query<{ platform: string }>(
          "SELECT platform FROM exomem_hosted_alpha_platform_cohort ORDER BY platform"
        )
      ).rows,
      [{ platform: "claude" }],
      "exactly one platform cohort is live"
    );
    assert.equal(
      (await pool!.query("SELECT 1 FROM exomem_hosted_alpha_cohort")).rowCount,
      0,
      "the paired view stays empty: pairing was never proven"
    );
    assert.equal(await getLiveExomemHostedCohortCandidateId(), candidateId);

    assert.ok(
      await resolveApprovedOAuthClient(claudeClientId),
      "a Claude client is admitted on the strength of the Claude artifact"
    );
    assert.equal(
      await resolveApprovedOAuthClient(openAiClientId),
      null,
      "an OpenAI client is refused: a Claude cohort must never admit another platform"
    );

    // The host-allowlist branch is scoped to the client's own platform too.
    // Before this change it sat inside the whole-cohort EXISTS, so it inherited
    // whatever the paired view said rather than asking about its own platform.
    const claudeCimdClientId = await registerCimdClient("claude", "claude.ai");
    const openAiCimdClientId = await registerCimdClient("openai", "chatgpt.com");

    assert.ok(
      await resolveApprovedOAuthClient(claudeCimdClientId),
      "a host-allowlisted Claude client is admitted without matching any pinned digest"
    );
    assert.equal(
      await resolveApprovedOAuthClient(openAiCimdClientId),
      null,
      "a host-allowlisted ChatGPT connector is still refused while OpenAI has no cohort: " +
        "the allowlist widens which client, never which platform"
    );

    // ---- Later pairing -------------------------------------------------------
    // The alpha run sheet promotes Claude first and adds OpenAI in a separate
    // sitting, so this second half is not a variant -- it is the second half of
    // the only sequence anyone actually performs. Nothing proved it worked, and
    // discovering otherwise costs a promotion window.
    //
    // The OpenAI stage was created above, while the candidate was still pending,
    // and it had to be: both `attachOpenAiContractLocks` and
    // `createStagedClientRelease` require `state = 'pending'`, which a promoted
    // candidate no longer is. Everything OpenAI therefore has to be prepared
    // BEFORE the Claude-only promotion, even though it is used after it. Only
    // the promotion itself is genuinely deferrable.
    // Read the CAS digest again: the routable set is what it is *now*, and
    // pairing must compare against that rather than a value carried over.
    const pairingStatus = (await listExomemHostedRolloutStatus()).find(
      (entry) => entry.candidateId === candidateId
    );
    assert.ok(pairingStatus?.routableSetDigest);

    // Every OpenAI input is present and correct -- locks on the candidate, a
    // staged release, signed evidence, an imported artifact, and an enabled
    // pinned client carrying the artifact's own configuration digest. Pairing
    // still cannot happen, and the reason is structural rather than a missing
    // input: promotion RETIRES the rollout assignment, and the `cells` CTE that
    // every promotion's precondition rests on requires that same assignment to
    // be `active`. Once a candidate is live its own bound proof is gone.
    assert.equal(
      (
        await pool!.query<{ state: string }>(
          `SELECT state FROM exomem_agent_contract_rollout_assignments WHERE candidate_id = $1`,
          [candidateId]
        )
      ).rows[0]?.state,
      "retired",
      "promotion retires the assignment its own precondition needs"
    );

    assert.equal(
      await promoteExomemHostedCohort({
        candidateId,
        claudeArtifactId,
        openaiArtifactId: openAiArtifactId,
        expectedLiveCandidateId: candidateId,
        expectedRoutableCellDigest: pairingStatus.routableSetDigest,
        claudeEvidence,
        openaiEvidence: openAiEvidence,
      }),
      "precondition_failed",
      "a live candidate cannot have a second platform paired onto it afterwards"
    );

    // Nothing moved. The refusal is clean, not half-applied.
    assert.deepEqual(
      (
        await pool!.query<{ platform: string }>(
          "SELECT platform FROM exomem_hosted_alpha_platform_cohort ORDER BY platform"
        )
      ).rows,
      [{ platform: "claude" }],
      "the Claude cohort is untouched by the refused pairing"
    );
    assert.equal(
      (await pool!.query("SELECT 1 FROM exomem_hosted_alpha_cohort")).rowCount,
      0,
      "and the paired view stays empty"
    );
    assert.equal(
      await resolveApprovedOAuthClient(openAiCimdClientId),
      null,
      "so a ChatGPT connector is still refused, and there is no way to change that " +
        "on this candidate: enabling OpenAI needs a fresh candidate and a whole new " +
        "promotion window, including a fresh Claude evidence run"
    );
    assert.ok(await resolveApprovedOAuthClient(claudeClientId), "Claude admission is unaffected");
  });
});
