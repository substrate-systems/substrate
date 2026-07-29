import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { __setExomemSqlForTests, __setExomemTransactionForTests } from "../db";
import {
  createCanaryAssignment,
  createStagedClientRelease,
  expireCanaryAuthority,
  revokeConflictingCanaryOAuthLineageInTransaction,
  resolveActiveCanaryAssignment,
  resolveReviewerCanaryAuthority,
  resolveStagedClientRelease,
} from "../agent-contract-canaries";

const tenantId = "018f2d91-7c42-7000-8000-000000000071";
const candidateId = "018f2d91-7c42-7000-8000-000000000072";
const assignmentId = "018f2d91-7c42-7000-8000-000000000073";
const declarationId = "018f2d91-7c42-7000-8000-000000000074";
const sha = (character: string) => character.repeat(64);

afterEach(() => {
  __setExomemSqlForTests(null);
  __setExomemTransactionForTests(null);
});

describe("Hosted canary assignments", () => {
  it("revokes only conflicting internal-canary lineage during exact activation", async () => {
    const queries: string[] = [];
    const sql = async (strings: TemplateStringsArray) => {
      queries.push(strings.join("?"));
      return { rows: [{ revoked_credentials: 1 }] };
    };

    const revoked = await revokeConflictingCanaryOAuthLineageInTransaction(sql, {
      tenantId,
      candidateId,
      assignmentId,
      assignmentGeneration: 2,
      stagedClientReleaseId: declarationId,
    });

    assert.equal(revoked, 1);
    const query = queries.join("\n");
    assert.match(query, /credential_kind = 'internal_canary'/i);
    assert.match(query, /assignment_generation IS DISTINCT FROM \?::bigint/i);
    assert.match(query, /reviewer_credential_id IN \(SELECT id FROM conflicting_credentials\)/i);
    assert.match(query, /UPDATE exomem_oauth_refresh_tokens/i);
    assert.match(query, /UPDATE exomem_oauth_access_tokens/i);
    assert.doesNotMatch(query, /credential_kind = 'provider_review'/i);
  });

  it("creates immutable assignment generations under the cohort lock", async () => {
    const queries: string[] = [];
    const sql = async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      queries.push(query);
      return {
        rows: query.includes("create-canary-assignment")
          ? [
              {
                id: assignmentId,
                generation: 2,
                version: 1,
                state: "preparing",
                expires_at: "2026-08-01T00:00:00.000Z",
              },
            ]
          : [],
      };
    };
    __setExomemTransactionForTests(async (work) => work(sql));

    const assignment = await createCanaryAssignment({
      tenantId,
      candidateId,
      expiresAt: new Date("2026-08-01T00:00:00.000Z"),
      operatorPrincipalDigest: sha("a"),
    });

    assert.deepEqual(assignment, {
      id: assignmentId,
      generation: 2,
      version: 1,
      state: "preparing",
      expiresAt: "2026-08-01T00:00:00.000Z",
    });
    assert.match(queries[0]!, /pg_advisory_xact_lock\(hashtext\('exomem-hosted-alpha-cohort'\)\)/i);
    assert.match(queries[1]!, /candidate\.state = 'pending'/i);
    assert.match(queries[1]!, /gateway_contract_digest/i);
    assert.match(queries[1]!, /prior\.generation \+ 1/i);
    assert.doesNotMatch(
      queries[1]!,
      /UPDATE exomem_agent_contract_rollout_assignments\s+SET[^;]*(?:candidate_id|source_release|protocol_version)/i
    );
  });

  it("resolves only one exact non-expired active assignment and fences reviewer authority", async () => {
    const queries: string[] = [];
    const sql = async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      queries.push(query);
      if (query.includes("resolve-active-canary-assignment")) {
        return {
          rows: [
            {
              id: assignmentId,
              tenant_id: tenantId,
              candidate_id: candidateId,
              generation: 2,
              source_release: "0.35.0",
              protocol_version: "2025-06-18",
              command_fingerprint: sha("b"),
              schema_digest: sha("c"),
              compatibility_digest: sha("d"),
              gateway_contract_digest: sha("e"),
              expires_at: "2026-08-01T00:00:00.000Z",
            },
          ],
        };
      }
      if (query.includes("resolve-reviewer-canary-authority")) return { rows: [] };
      return { rows: [{ id: assignmentId }] };
    };
    __setExomemSqlForTests(sql);
    __setExomemTransactionForTests(async (work) => work(sql));

    assert.equal((await resolveActiveCanaryAssignment(tenantId))?.candidateId, candidateId);
    assert.equal(await resolveReviewerCanaryAuthority({ tenantId, candidateId }), null);
    assert.match(queries[0]!, /state = 'active'/i);
    assert.match(queries[0]!, /expires_at > now\(\)/i);
    assert.match(queries[0]!, /LIMIT 2/i);
    assert.match(queries[1]!, /marketplace_reviewer_purpose = true/i);
  });

  it("expires authority before atomically revoking its exact internal credential lineage", async () => {
    const queries: string[] = [];
    const sql = async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      queries.push(query);
      if (query.includes("expire-canary-authority")) {
        return {
          rows: [
            {
              tenant_id: tenantId,
              candidate_id: candidateId,
              assignment_id: assignmentId,
              assignment_generation: 2,
              staged_client_release_id: declarationId,
            },
          ],
        };
      }
      return { rows: [{ revoked_credentials: 1 }] };
    };
    __setExomemTransactionForTests(async (work) => work(sql));

    assert.equal(await expireCanaryAuthority(), 1);
    const query = queries.join("\n");
    assert.match(query, /UPDATE exomem_agent_contract_rollout_assignments/i);
    assert.match(query, /UPDATE exomem_staged_client_releases/i);
    assert.match(query, /exomem:revoke-canary-oauth-lineage/i);
    assert.match(query, /credential_kind = 'internal_canary'/i);
  });
});

describe("staged client releases", () => {
  it("stores an immutable non-promotable exact declaration and resolves only current stage authority", async () => {
    const queries: string[] = [];
    const sql = async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      queries.push(query);
      if (query.includes("create-staged-client-release"))
        return { rows: [{ id: declarationId, version: 1, state: "staged" }] };
      if (query.includes("resolve-staged-client-release"))
        return {
          rows: [
            {
              id: declarationId,
              candidate_id: candidateId,
              platform: "openai",
              package_sha256: sha("a"),
              archive_sha256: sha("b"),
              compatibility_sha256: sha("c"),
              contract_sha256: sha("d"),
              plugin_version: "0.35.0",
              oauth_client_config_sha256: sha("e"),
              registered_app_id_sha256: sha("f"),
              expires_at: "2026-08-01T00:00:00.000Z",
              state: "staged",
            },
          ],
        };
      return { rows: [] };
    };
    __setExomemSqlForTests(sql);
    __setExomemTransactionForTests(async (work) => work(sql));

    assert.deepEqual(
      await createStagedClientRelease({
        candidateId,
        platform: "openai",
        packageSha256: sha("a"),
        archiveSha256: sha("b"),
        compatibilitySha256: sha("c"),
        contractSha256: sha("d"),
        pluginVersion: "0.35.0",
        oauthClientConfigSha256: sha("e"),
        registeredAppIdSha256: sha("f"),
        operatorPrincipalDigest: sha("1"),
        expiresAt: new Date("2026-08-01T00:00:00.000Z"),
      }),
      { id: declarationId, version: 1, state: "staged" }
    );
    assert.equal((await resolveStagedClientRelease("openai", candidateId))?.id, declarationId);
    assert.match(queries[1]!, /state = 'pending'/i);
    assert.match(queries[1]!, /registered_app_id_sha256/i);
    assert.doesNotMatch(queries[1]!, /exomem_client_artifacts/i);
    assert.match(queries[2]!, /state IN \('staged', 'evidenced'\)/i);
    assert.match(queries[2]!, /expires_at > now\(\)/i);
  });
});
