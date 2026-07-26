import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
import {
  findActiveOAuthAccessToken,
  findMcpOAuthAccessToken,
  issueOAuthTokensFromCodeAtomic,
  pruneExpiredOAuthState,
  resolveApprovedOAuthClient,
  revokeOAuthTokenForClient,
  revokeOAuthTokenFamilyForOwner,
  rotateOAuthRefreshTokenAtomic,
} from "../oauth-store";

afterEach(() => {
  __setExomemSqlForTests(null);
  __setExomemTransactionForTests(null);
});

let transactionSql: ExomemSql | null = null;

beforeEach(() => {
  __setExomemTransactionForTests(async (callback) => callback(transactionSql!));
});

function setSqlForTests(sql: ExomemSql): void {
  transactionSql = sql;
  __setExomemSqlForTests(sql);
}

describe("Exomem OAuth token store", () => {
  it("fences MCP access under the shared cohort lock and accepts non-ready token context", async () => {
    const queries: string[] = [];
    setSqlForTests(async (strings) => {
      const query = strings.join("?");
      queries.push(query);
      return query.includes("find-mcp-oauth-access-token")
        ? {
            rows: [
              {
                family_id: "family-1",
                grant_id: "grant-1",
                user_id: "user-1",
                tenant_id: "tenant-1",
                client_id: "client-1",
                resource: "https://substratesystems.io/api/exomem/mcp/v1",
                scopes: ["exomem.read"],
              },
            ],
          }
        : { rows: [] };
    });

    assert.equal((await findMcpOAuthAccessToken(Buffer.alloc(32, 1)))?.tenantId, "tenant-1");
    assert.match(queries[0] ?? "", /pg_advisory_xact_lock_shared/i);
    assert.match(queries[1] ?? "", /exomem_hosted_alpha_cohort/i);
    assert.match(queries[1] ?? "", /exomem_oauth_account_blocks/i);
    assert.match(queries[1] ?? "", /tenant\.status <> 'deleted'/i);
    assert.doesNotMatch(queries[1] ?? "", /tenant\.status IN \('provisioning', 'active'\)/i);
    assert.match(queries[1] ?? "", /family\.grant_id = token\.grant_id/i);
    assert.match(queries[1] ?? "", /family\.client_id = token\.client_id/i);
    assert.doesNotMatch(queries[1] ?? "", /family\.resource = token\.resource/i);
    assert.match(queries[1] ?? "", /grant\.client_id = token\.client_id/i);
    assert.match(queries[1] ?? "", /grant\.resource = token\.resource/i);
    assert.match(queries[1] ?? "", /token\.scopes <@ grant\.scopes/i);
  });

  it("consumes a code and persists a new token family in one statement", async () => {
    let query = "";
    setSqlForTests(async (strings) => {
      query = strings.join("?");
      return {
        rows: [
          {
            grant_id: "grant-1",
            family_id: "family-1",
            client_id: "client-1",
            resource: "resource",
            scopes: ["exomem.read"],
            refresh_allowed: true,
            refresh_inserted: true,
          },
        ],
      };
    });
    const result = await issueOAuthTokensFromCodeAtomic({
      codeDigest: Buffer.alloc(32, 1),
      clientId: "client-1",
      redirectUri: "https://client.example/callback",
      resource: "resource",
      pkceChallenge: "challenge",
      refreshDigest: Buffer.alloc(32, 2),
      refreshExpiresAt: new Date("2026-08-01T00:00:00.000Z"),
      accessDigest: Buffer.alloc(32, 3),
      accessExpiresAt: new Date("2026-07-26T01:00:00.000Z"),
    });
    assert.deepEqual(result, {
      grantId: "grant-1",
      familyId: "family-1",
      clientId: "client-1",
      resource: "resource",
      scopes: ["exomem.read"],
      refreshAllowed: true,
      refreshInserted: true,
    });
    assert.match(query, /UPDATE exomem_oauth_authorization_codes/i);
    assert.match(query, /INSERT INTO exomem_oauth_token_families/i);
    assert.match(query, /INSERT INTO exomem_oauth_refresh_tokens/i);
    assert.match(query, /INSERT INTO exomem_oauth_access_tokens/i);
    assert.match(query, /JOIN exomem_tenants AS tenant/i);
    assert.match(query, /JOIN exomem_entitlements AS entitlement/i);
  });

  it("rotates atomically and revokes the family when the digest was already consumed", async () => {
    let query = "";
    setSqlForTests(async (strings) => {
      query = strings.join("?");
      if (query.includes("SELECT tenant.id")) return { rows: [{ id: "tenant-1" }] };
      return { rows: [] };
    });
    const result = await rotateOAuthRefreshTokenAtomic({
      refreshDigest: Buffer.alloc(32, 1),
      replacementRefreshDigest: Buffer.alloc(32, 2),
      accessDigest: Buffer.alloc(32, 3),
      accessExpiresAt: new Date("2026-07-26T01:00:00.000Z"),
      clientId: "client-1",
      resource: "resource",
    });
    assert.equal(result, null);
    assert.match(query, /UPDATE exomem_oauth_refresh_tokens/i);
    assert.match(query, /refresh_replayed/i);
    assert.match(query, /UPDATE exomem_oauth_token_families/i);
    assert.match(query, /JOIN exomem_tenants AS tenant/i);
    assert.match(query, /JOIN exomem_entitlements AS entitlement/i);
  });

  it("keeps replay lookup independent of current entitlement policy", async () => {
    let query = "";
    setSqlForTests(async (strings) => {
      query = strings.join("?");
      if (query.includes("SELECT tenant.id")) return { rows: [{ id: "tenant-1" }] };
      return { rows: [] };
    });
    await rotateOAuthRefreshTokenAtomic({
      refreshDigest: Buffer.alloc(32, 5),
      replacementRefreshDigest: Buffer.alloc(32, 6),
      accessDigest: Buffer.alloc(32, 7),
      accessExpiresAt: new Date("2026-07-26T01:00:00.000Z"),
      clientId: "client-1",
      resource: "resource",
    });
    assert.match(query, /credential AS/i);
    assert.match(query, /current_policy AS/i);
    assert.match(query, /token\.consumed_at IS NOT NULL/i);
    assert.doesNotMatch(
      query.slice(query.indexOf("WITH credential"), query.indexOf("current_policy")),
      /JOIN exomem_entitlements/i
    );
  });

  it("retains refresh lineage and replay evidence until its family expires", async () => {
    let query = "";
    setSqlForTests(async (strings) => {
      query = strings.join("?");
      return { rows: [] };
    });

    await pruneExpiredOAuthState();

    assert.match(query, /NOT EXISTS\s*\(\s*SELECT 1 FROM exomem_oauth_refresh_tokens AS child/i);
    assert.match(query, /family\.expires_at <= now\(\)/i);
    assert.doesNotMatch(query, /family\.revoked_at < now\(\) - interval '1 day'/i);
  });

  it("takes the exclusive cohort lock before disabling expired CIMD clients", async () => {
    const queries: string[] = [];
    setSqlForTests(async (strings) => {
      queries.push(strings.join("?"));
      return { rows: [] };
    });

    await pruneExpiredOAuthState();

    assert.match(queries[0] ?? "", /pg_advisory_xact_lock\(/i);
    assert.doesNotMatch(queries[0] ?? "", /pg_advisory_xact_lock_shared/i);
    assert.match(queries[1] ?? "", /UPDATE exomem_oauth_clients/i);
    assert.match(queries[1] ?? "", /admission_mode = 'cimd'/i);
  });

  it("resolves only current entitled access and revokes one family without touching another", async () => {
    const queries: string[] = [];
    setSqlForTests(async (strings) => {
      const query = strings.join("?");
      queries.push(query);
      if (query.includes("SELECT token.family_id")) {
        return {
          rows: [
            {
              family_id: "family-1",
              grant_id: "grant-1",
              user_id: "user-1",
              tenant_id: "tenant-1",
              client_id: "client-1",
              resource: "resource",
              scopes: ["exomem.read"],
            },
          ],
        };
      }
      return { rows: [] };
    });
    const access = await findActiveOAuthAccessToken(Buffer.alloc(32, 4));
    assert.equal(access?.tenantId, "tenant-1");
    await revokeOAuthTokenFamilyForOwner({
      familyId: "family-1",
      ownerUserId: "user-1",
      tenantId: "tenant-1",
    });
    const accessQuery = queries.find((query) => query.includes("SELECT token.family_id"));
    const revokeQuery = queries.find((query) => query.includes("revoke-oauth-token-family"));
    assert.match(accessQuery ?? "", /exomem_entitlements/i);
    assert.match(revokeQuery ?? "", /WHERE id = \?::uuid/i);
    assert.match(revokeQuery ?? "", /grant\.user_id = \?::uuid/i);
    assert.match(revokeQuery ?? "", /grant\.tenant_id = \?::uuid/i);
  });

  it("revokes a disabled client's exact token without making it eligible for authorization", async () => {
    let query = "";
    setSqlForTests(async (strings) => {
      query = strings.join("?");
      return { rows: [] };
    });

    await revokeOAuthTokenForClient({ tokenDigest: Buffer.alloc(32, 9), clientId: "client-1" });

    assert.match(query, /client\.client_id = \?/i);
    assert.doesNotMatch(query, /client\.enabled = true/i);
  });

  it("requires the live hosted cohort before resolving an authorization client", async () => {
    let query = "";
    setSqlForTests(async (strings) => {
      query = strings.join("?");
      return { rows: [] };
    });

    assert.equal(await resolveApprovedOAuthClient("client-1"), null);
    assert.match(query, /exomem_hosted_alpha_cohort/i);
    assert.match(
      query,
      /redirect_uris_digest = digest\(convert_to\(redirect_uris::text, 'utf8'\), 'sha256'\)/i
    );
  });

  it("locks the cohort before taking the authorization snapshot", async () => {
    let transactionQueries = 0;
    let firstQuery = "";
    __setExomemSqlForTests(async () => ({ rows: [] }));
    __setExomemTransactionForTests(async (callback) =>
      callback(async (strings) => {
        transactionQueries += 1;
        if (transactionQueries === 1) firstQuery = strings.join("?");
        return { rows: [] };
      })
    );

    assert.equal(await resolveApprovedOAuthClient("client-1"), null);
    assert.equal(transactionQueries, 2);
    assert.match(firstQuery, /pg_advisory_xact_lock_shared/i);
  });

  it("locks the tenant before checking its durable block during code exchange", async () => {
    const queries: string[] = [];
    setSqlForTests(async (strings) => {
      const query = strings.join("?");
      queries.push(query);
      return query.includes("SELECT tenant.id") ? { rows: [{ id: "tenant-1" }] } : { rows: [] };
    });

    assert.equal(
      await issueOAuthTokensFromCodeAtomic({
        codeDigest: Buffer.alloc(32, 1),
        clientId: "client-1",
        redirectUri: "https://client.example/callback",
        resource: "resource",
        pkceChallenge: "challenge",
        refreshDigest: Buffer.alloc(32, 2),
        refreshExpiresAt: new Date("2026-08-01T00:00:00.000Z"),
        accessDigest: Buffer.alloc(32, 3),
        accessExpiresAt: new Date("2026-07-26T01:00:00.000Z"),
      }),
      null
    );
    assert.match(queries[0] ?? "", /pg_advisory_xact_lock_shared/i);
    assert.match(queries[1] ?? "", /FOR UPDATE OF tenant/i);
    assert.match(queries[2] ?? "", /exomem_oauth_account_blocks/i);
  });
});
