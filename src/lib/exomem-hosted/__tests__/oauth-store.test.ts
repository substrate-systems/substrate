import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
import {
  attachExistingOwnerAuthorizationAtomic,
  issueOAuthTokensFromCodeAtomic,
  pruneExpiredOAuthState,
  revokeOAuthTokenForClient,
  revokeOAuthTokenFamilyForOwner,
  rotateOAuthRefreshTokenAtomic,
} from "../oauth-store";

afterEach(() => {
  __setExomemSqlForTests(null);
  __setExomemTransactionForTests(null);
});

let transactionSql: ExomemSql | null = null;

// The token store binds Cloud reviewer authority to the configured Cloud resource.
before(() => {
  process.env.EXOMEM_CLOUD_MCP_URL = "https://gateway.example.test/mcp";
  process.env.EXOMEM_CLOUD_MCP_PATH = "/mcp";
});

after(() => {
  delete process.env.EXOMEM_CLOUD_MCP_URL;
  delete process.env.EXOMEM_CLOUD_MCP_PATH;
});

beforeEach(() => {
  __setExomemTransactionForTests(async (callback) => callback(transactionSql!));
});

function setSqlForTests(sql: ExomemSql): void {
  transactionSql = sql;
  __setExomemSqlForTests(sql);
}

describe("Exomem OAuth token store", () => {
  it("carries only a matching active reviewer credential from session and transaction into the grant", async () => {
    const queries: string[] = [];
    setSqlForTests(async (strings) => {
      const query = strings.join("?");
      queries.push(query);
      if (query.includes("SELECT tenant.id")) return { rows: [{ id: "tenant-1" }] };
      return { rows: [{ grant_id: "grant-1", tenant_id: "tenant-1" }] };
    });

    await attachExistingOwnerAuthorizationAtomic({
      sessionId: "session-1",
      transactionDigest: Buffer.alloc(32, 1),
      codeDigest: Buffer.alloc(32, 2),
      codeExpiresAt: new Date("2026-08-01T00:00:00.000Z"),
    });

    const query = queries.join("\n");
    assert.match(query, /session\.reviewer_credential_id/i);
    assert.match(query, /transaction\.reviewer_credential_id/i);
    assert.match(query, /INSERT INTO exomem_oauth_grants \([\s\S]*reviewer_credential_id/i);
    assert.match(
      query,
      /exomem_oauth_grants\.reviewer_credential_id\s+IS NOT DISTINCT FROM EXCLUDED\.reviewer_credential_id/i
    );
    assert.doesNotMatch(query, /reviewer_credential_id = EXCLUDED\.reviewer_credential_id/i);
    assert.match(query, /credential\.revoked_at IS NULL/i);
    assert.match(query, /credential\.expires_at > now\(\)/i);
    assert.match(
      query,
      /credential\.provider = 'anthropic' AND client\.client_platform = 'claude'[\s\S]*credential\.provider = 'openai' AND client\.client_platform = 'openai'/i
    );
    assert.match(query, /LEAST\(\?, credential\.expires_at\)/i);
  });

  it("caps reviewer-derived token families and rejects expired reviewer grants on code and refresh", async () => {
    const source = await import("node:fs").then(({ readFileSync }) =>
      readFileSync("src/lib/exomem-hosted/oauth-store.ts", "utf8")
    );
    assert.match(
      source,
      /oauth_grant\.reviewer_credential_id IS NULL[\s\S]*credential\.expires_at > now\(\)/i
    );
    assert.match(source, /INSERT INTO exomem_oauth_token_families[\s\S]*LEAST\(/i);
    assert.match(source, /INSERT INTO exomem_oauth_refresh_tokens[\s\S]*LEAST\(/i);
    assert.match(source, /INSERT INTO exomem_oauth_access_tokens[\s\S]*LEAST\(/i);
  });

  it("returns CTE fields consumed by reviewer authorization and code exchange", async () => {
    const source = await import("node:fs").then(({ readFileSync }) =>
      readFileSync("src/lib/exomem-hosted/oauth-store.ts", "utf8")
    );
    const attach = source.slice(
      source.indexOf("exomem:attach-existing-owner-oauth"),
      source.indexOf("exomem:prune-unlink-expired-transactions")
    );
    const codeExchange = source.slice(
      source.indexOf("exomem:oauth-code-exchange"),
      source.indexOf("exomem:oauth-refresh-rotate")
    );

    assert.match(attach, /RETURNING id, tenant_id, reviewer_credential_id/i);
    assert.match(codeExchange, /RETURNING id, grant_id, client_id, expires_at/i);
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
    const clientJoin =
      query.match(
        /JOIN exomem_oauth_clients AS client\s+ON([\s\S]*?)JOIN exomem_tenants AS tenant/i
      )?.[1] ?? "";
    assert.doesNotMatch(clientJoin, /\bcode\./i);
    assert.match(query, /AND code\.client_id = client\.id/i);
    assert.match(
      query,
      /SELECT consumed_code\.grant_id[\s\S]*?FROM consumed_code\s+JOIN family[\s\S]*?JOIN exomem_oauth_clients AS client[\s\S]*?JOIN exomem_oauth_grants AS oauth_grant ON oauth_grant\.id = consumed_code\.grant_id[\s\S]*?LEFT JOIN refresh/i
    );
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
    assert.match(query, /credential\.consumed_at IS NOT NULL/i);
    assert.doesNotMatch(
      query.slice(query.indexOf("WITH credential"), query.indexOf("current_policy")),
      /JOIN exomem_entitlements/i
    );
  });

  it("retains refresh lineage and replay evidence until its family expires", async () => {
    const queries: string[] = [];
    setSqlForTests(async (strings) => {
      queries.push(strings.join("?"));
      return { rows: [] };
    });

    await pruneExpiredOAuthState();
    const query =
      queries.find((text) => text.includes("exomem:prune-expired-refresh-tokens")) ?? "";

    assert.match(query, /NOT EXISTS\s*\(\s*SELECT 1 FROM exomem_oauth_refresh_tokens AS child/i);
    assert.match(query, /family\.expires_at <= now\(\)/i);
    assert.doesNotMatch(query, /family\.revoked_at < now\(\) - interval '1 day'/i);
  });

  // Every authorization and refresh waits on the cohort lock while the sweep
  // holds it exclusively. Deletes under it held that wait for seconds.
  it("deletes expired credentials outside the cohort lock, and disables clients under it", async () => {
    const outside: string[] = [];
    const locked: string[] = [];
    __setExomemSqlForTests(async (strings) => {
      outside.push(strings.join("?"));
      return { rows: [] };
    });
    __setExomemTransactionForTests(async (callback) =>
      callback(async (strings) => {
        locked.push(strings.join("?"));
        return { rows: [] };
      })
    );

    await pruneExpiredOAuthState();

    assert.ok(outside.some((query) => /DELETE FROM exomem_oauth_refresh_tokens/i.test(query)));
    assert.ok(
      locked.every((query) => !/DELETE FROM/i.test(query)),
      "no delete holds the lock"
    );
    assert.match(locked[0] ?? "", /pg_advisory_xact_lock\(/i);
    assert.doesNotMatch(locked[0] ?? "", /pg_advisory_xact_lock_shared/i);
    assert.match(locked[1] ?? "", /UPDATE exomem_oauth_clients/i);
    assert.match(locked[1] ?? "", /admission_mode = 'cimd'/i);
  });

  it("revokes one family only for its owner and tenant", async () => {
    const queries: string[] = [];
    setSqlForTests(async (strings) => {
      queries.push(strings.join("?"));
      return { rows: [] };
    });
    await revokeOAuthTokenFamilyForOwner({
      familyId: "family-1",
      ownerUserId: "user-1",
      tenantId: "tenant-1",
    });
    const revokeQuery = queries.find((query) =>
      query.includes("exomem:revoke-oauth-token-family-for-owner")
    );
    assert.match(revokeQuery ?? "", /WHERE family\.id = \?::uuid/i);
    assert.match(revokeQuery ?? "", /oauth_grant\.user_id = \?::uuid/i);
    assert.match(revokeQuery ?? "", /oauth_grant\.tenant_id = \?::uuid/i);
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
