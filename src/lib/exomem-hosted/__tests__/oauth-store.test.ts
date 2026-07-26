import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { __setExomemSqlForTests } from "../db";
import {
  findActiveOAuthAccessToken,
  issueOAuthTokensFromCodeAtomic,
  revokeOAuthTokenFamily,
  rotateOAuthRefreshTokenAtomic,
} from "../oauth-store";

afterEach(() => __setExomemSqlForTests(null));

describe("Exomem OAuth token store", () => {
  it("consumes a code and persists a new token family in one statement", async () => {
    let query = "";
    __setExomemSqlForTests(async (strings) => {
      query = strings.join("?");
      return {
        rows: [
          {
            grant_id: "grant-1",
            family_id: "family-1",
            client_id: "client-1",
            resource: "resource",
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
    });
    assert.match(query, /UPDATE exomem_oauth_authorization_codes/i);
    assert.match(query, /INSERT INTO exomem_oauth_token_families/i);
    assert.match(query, /INSERT INTO exomem_oauth_refresh_tokens/i);
    assert.match(query, /INSERT INTO exomem_oauth_access_tokens/i);
  });

  it("rotates atomically and revokes the family when the digest was already consumed", async () => {
    let query = "";
    __setExomemSqlForTests(async (strings) => {
      query = strings.join("?");
      return { rows: [] };
    });
    const result = await rotateOAuthRefreshTokenAtomic({
      refreshDigest: Buffer.alloc(32, 1),
      replacementRefreshDigest: Buffer.alloc(32, 2),
      accessDigest: Buffer.alloc(32, 3),
      accessExpiresAt: new Date("2026-07-26T01:00:00.000Z"),
    });
    assert.equal(result, null);
    assert.match(query, /UPDATE exomem_oauth_refresh_tokens/i);
    assert.match(query, /refresh_replayed/i);
    assert.match(query, /UPDATE exomem_oauth_token_families/i);
  });

  it("resolves only current entitled access and revokes one family without touching another", async () => {
    const queries: string[] = [];
    __setExomemSqlForTests(async (strings) => {
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
    await revokeOAuthTokenFamily("family-1");
    assert.match(queries[0], /exomem_entitlements/i);
    assert.match(queries[1], /WHERE id = \?::uuid/i);
  });
});
