import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";
import { storeRetainedExomemAgentContractCandidate } from "../agent-contract-store";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
import {
  admitFirstOAuthInviteAtomic,
  createAuthorizationTransaction,
  findPendingOAuthAuthorization,
} from "../oauth-store";
import { oauthClientConfigSha256 } from "../oauth-client-admission";
import { createReviewerOAuthBootstrapAuthority } from "../operator-controls";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
const clientId = "bootstrap-reviewer-client";
const redirectUri = "http://127.0.0.1:47831/callback";
const resource = "https://substratesystems.io/api/exomem/mcp/v1";
let pool: Pool | undefined;
let schema: string | undefined;

function digest(value: number): Buffer {
  const result = Buffer.alloc(32);
  result.writeUInt32BE(value, 28);
  return result;
}

function taggedSql(client: Pool | PoolClient): ExomemSql {
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
    const result = await work(taggedSql(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe("reviewer OAuth bootstrap PostgreSQL integration", { skip: !databaseUrl }, () => {
  before(async () => {
    schema = `oauth_bootstrap_${randomUUID().replaceAll("-", "")}`;
    await ensureExomemPostgresTestExtensions(databaseUrl!);
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);
    await applyMigrations({ databaseUrl: scoped.toString() });
    await admin.end();
    pool = new Pool({ connectionString: scoped.toString() });
    __setExomemSqlForTests(taggedSql(pool));
    __setExomemTransactionForTests(transaction);
  });

  after(async () => {
    __setExomemSqlForTests(null);
    __setExomemTransactionForTests(null);
    if (pool) await pool.end();
    if (schema) {
      const admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it("redeems one bounded authority into a complete nonlegacy reviewer graph", async () => {
    const candidateId = await storeRetainedExomemAgentContractCandidate("0.39.2");
    const config = oauthClientConfigSha256({
      platform: "claude",
      admissionMode: "pinned",
      clientId,
      redirectUris: [redirectUri],
    });
    const stage = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_staged_client_releases (
         candidate_id, platform, state, package_sha256, archive_sha256, compatibility_sha256,
         contract_sha256, plugin_version, oauth_client_config_sha256, created_by_principal_digest, expires_at
       ) VALUES ($1, 'claude', 'staged', $2, $3, $4, $5, '0.39.2', $6, $7, now() + interval '20 minutes')
       RETURNING id`,
      [
        candidateId,
        "a".repeat(64),
        "b".repeat(64),
        "c".repeat(64),
        "d".repeat(64),
        config,
        "e".repeat(64),
      ]
    );
    const client = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_oauth_clients (
         client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest, client_platform, oauth_client_config_sha256
       ) VALUES ($1, 'pinned', false, $2::jsonb, digest(convert_to($2::jsonb::text, 'utf8'), 'sha256'), 'claude', $3)
       RETURNING id`,
      [clientId, JSON.stringify([redirectUri]), config]
    );
    const invite = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_invites (
         token_digest, email_normalized, entitlement_source, entitlement_capabilities, entitlement_limits,
         marketplace_reviewer_purpose, created_by_principal_digest, delivery_state, delivered_at, expires_at
       ) VALUES ($1, 'bootstrap-reviewer@example.test', 'complimentary', '[]'::jsonb, '{}'::jsonb,
         true, $2, 'sent', now(), now() + interval '20 minutes') RETURNING id`,
      [digest(1), digest(2)]
    );
    await pool!.query(
      `UPDATE exomem_capacity_pools
       SET storage_capacity_bytes = 10737418240, runtime_capacity_slots = 2,
           provision_reservation_capacity = 2, provision_claim_capacity = 1, configured_at = now()`
    );

    const authority = await createReviewerOAuthBootstrapAuthority({
      inviteId: invite.rows[0]!.id,
      stagedClientReleaseId: stage.rows[0]!.id,
      oauthClientId: client.rows[0]!.id,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      operatorPrincipalDigest: digest(3),
    });
    assert.ok(authority);
    assert.ok(
      await createAuthorizationTransaction({
        transactionDigest: digest(4),
        stateDigest: digest(5),
        stateEnvelope: {
          version: 1,
          algorithm: "A256GCM",
          iv: "iv",
          ciphertext: "cipher",
          tag: "tag",
        },
        formNonceDigest: digest(6),
        continuationBinding: digest(7),
        clientId,
        redirectUri,
        resource,
        scopes: ["exomem.read", "offline_access"],
        pkceChallenge: "bootstrap-challenge",
        expiresAt: new Date(Date.now() + 10 * 60_000),
      })
    );
    assert.equal((await findPendingOAuthAuthorization(digest(4)))?.clientId, clientId);
    const redeemed = await admitFirstOAuthInviteAtomic({
      inviteDigest: digest(1),
      transactionDigest: digest(4),
      sessionDigest: digest(8),
      csrfDigest: digest(9),
      sessionExpiresAt: new Date(Date.now() + 10 * 60_000),
      codeDigest: digest(10),
      codeExpiresAt: new Date(Date.now() + 10 * 60_000),
    });
    assert.ok(redeemed);
    const graph = await pool!.query<{
      legacy_unmetered: boolean;
      assignment_state: string;
      operation_type: string;
      target_matches: boolean;
      provisioner_wire_protocol: string;
      authority_state: string;
      allocation_state: string;
      token_count: string;
    }>(
      `SELECT tenant.legacy_unmetered, assignment.state AS assignment_state, operation.operation_type,
              operation.target_candidate_id = $1::uuid AND operation.target_assignment_id = assignment.id
                AND operation.target_assignment_generation = assignment.generation AS target_matches,
              operation.provisioner_wire_protocol, authority.state AS authority_state, allocation.state AS allocation_state,
              (SELECT count(*) FROM exomem_oauth_access_tokens)::text AS token_count
       FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities AS authority
       JOIN exomem_tenants AS tenant ON tenant.id = authority.outcome_tenant_id
       JOIN exomem_agent_contract_rollout_assignments AS assignment ON assignment.id = authority.outcome_assignment_id
       JOIN exomem_lifecycle_operations AS operation ON operation.id = authority.outcome_operation_id
       JOIN exomem_capacity_allocations AS allocation ON allocation.operation_id = operation.id
       WHERE authority.id = $2::uuid`,
      [candidateId, authority!.id]
    );
    assert.deepEqual(graph.rows, [
      {
        legacy_unmetered: false,
        assignment_state: "preparing",
        operation_type: "provision",
        target_matches: true,
        provisioner_wire_protocol: "exomem-cell-provisioner.v1",
        authority_state: "consumed",
        allocation_state: "reserved",
        token_count: "0",
      },
    ]);
  });
});
