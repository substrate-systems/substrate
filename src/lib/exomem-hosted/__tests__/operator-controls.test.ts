import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { __setExomemSqlForTests, __setExomemTransactionForTests } from "../db";
import {
  demoteOperatorClientArtifact,
  listOperatorClientArtifacts,
  listOperatorOAuthClients,
  revokeOperatorOAuthAccount,
  revokeOperatorOAuthFamily,
  setOperatorOAuthClientEnabled,
} from "../operator-controls";

afterEach(() => {
  __setExomemSqlForTests(null);
  __setExomemTransactionForTests(null);
});

describe("hosted operator controls", () => {
  it("lists approved clients without returning their raw client identity or redirects", async () => {
    __setExomemSqlForTests(async () => ({
      rows: [
        {
          id: "018f2d91-7c42-7000-8000-000000000001",
          client_id: "https://private.example/credential-sentinel",
          enabled: true,
          admission_mode: "pinned",
          redirect_count: 2,
        },
      ],
    }));

    assert.deepEqual(await listOperatorOAuthClients(), [
      {
        id: "018f2d91-7c42-7000-8000-000000000001",
        enabled: true,
        admissionMode: "pinned",
        redirectCount: 2,
      },
    ]);
  });

  it("changes exactly one opaque client record", async () => {
    let query = "";
    __setExomemSqlForTests(async (strings) => {
      query = strings.join("?");
      return { rows: [{ id: "018f2d91-7c42-7000-8000-000000000001" }] };
    });

    assert.equal(
      await setOperatorOAuthClientEnabled({
        clientRecordId: "018f2d91-7c42-7000-8000-000000000001",
        enabled: false,
      }),
      true
    );
    assert.match(query, /WHERE id = \?::uuid/i);
  });

  it("fences family and account revocation to the named owner and tenant", async () => {
    const queries: string[] = [];
    const sql = async (strings: TemplateStringsArray) => {
      queries.push(strings.join("?"));
      return { rows: [{ id: "018f2d91-7c42-7000-8000-000000000002" }] };
    };
    __setExomemSqlForTests(sql);
    __setExomemTransactionForTests(async (callback) => callback(sql));
    const ownerUserId = "018f2d91-7c42-7000-8000-000000000010";
    const tenantId = "018f2d91-7c42-7000-8000-000000000011";

    assert.equal(
      await revokeOperatorOAuthFamily({
        ownerUserId,
        tenantId,
        familyId: "018f2d91-7c42-7000-8000-000000000012",
      }),
      true
    );
    assert.equal(await revokeOperatorOAuthAccount({ ownerUserId, tenantId }), 1);
    assert.match(queries[0], /grant\.user_id = \?/i);
    assert.match(queries[0], /grant\.tenant_id = \?/i);
    assert.match(queries[1], /exomem_oauth_account_blocks/i);
    assert.match(queries[1], /FOR UPDATE/i);
  });

  it("reports artifact digests only and demotes live artifacts to retired", async () => {
    const queries: string[] = [];
    __setExomemSqlForTests(async (strings) => {
      const query = strings.join("?");
      queries.push(query);
      if (query.includes("SELECT id, platform")) {
        return {
          rows: [
            {
              id: "018f2d91-7c42-7000-8000-000000000020",
              platform: "claude",
              state: "live",
              package_sha256: "a".repeat(64),
              archive_sha256: "b".repeat(64),
              compatibility_sha256: "c".repeat(64),
              contract_sha256: "d".repeat(64),
            },
          ],
        };
      }
      return { rows: [{ id: "018f2d91-7c42-7000-8000-000000000020" }] };
    });

    const artifacts = await listOperatorClientArtifacts();
    assert.equal(artifacts[0]?.packageSha256, "a".repeat(64));
    assert.equal(JSON.stringify(artifacts).includes("install"), false);
    assert.equal(await demoteOperatorClientArtifact("018f2d91-7c42-7000-8000-000000000020"), true);
    assert.match(queries[1], /SET state = 'retired', retired_at = now\(\)/i);
    assert.match(queries[1], /state = 'live'/i);
  });
});
