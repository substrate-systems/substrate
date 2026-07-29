import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { __setExomemSqlForTests, __setExomemTransactionForTests } from "../db";
import {
  demoteOperatorClientArtifact,
  listOperatorClientArtifacts,
  listOperatorOAuthClients,
  registerOperatorOAuthClient,
  revokeOperatorOAuthAccount,
  revokeOperatorOAuthFamily,
  setOperatorOAuthClientEnabled,
} from "../operator-controls";
import { operatorOAuthClientFingerprint } from "../oauth-client-admission";

const originalControlPlaneKey = process.env.EXOMEM_CONTROL_PLANE_KEY;

afterEach(() => {
  __setExomemSqlForTests(null);
  __setExomemTransactionForTests(null);
  if (originalControlPlaneKey === undefined) delete process.env.EXOMEM_CONTROL_PLANE_KEY;
  else process.env.EXOMEM_CONTROL_PLANE_KEY = originalControlPlaneKey;
});

describe("hosted operator controls", () => {
  it("permits pending client registration only through an exact current staged declaration", async () => {
    const queries: string[] = [];
    const sql = async (strings: TemplateStringsArray) => {
      queries.push(strings.join("?"));
      return { rows: [{ id: "018f2d91-7c42-7000-8000-000000000091", enabled: false }] };
    };
    __setExomemSqlForTests(sql);
    __setExomemTransactionForTests(async (work) => work(sql));

    await registerOperatorOAuthClient({
      admissionMode: "pinned",
      platform: "claude",
      clientId: "desktop-client",
      redirectUris: ["https://app.example.test/callback"],
      stagedClientReleaseId: "018f2d91-7c42-7000-8000-000000000090",
    });

    assert.match(queries[1]!, /exomem_staged_client_releases/i);
    assert.match(queries[1]!, /state IN \('staged', 'evidenced'\)/i);
    assert.match(queries[1]!, /expires_at > now\(\)/i);
    assert.match(queries[1]!, /oauth_client_config_sha256/i);
  });

  it("lists approved clients without returning their raw client identity or redirects", async () => {
    const controlPlaneKey = Buffer.alloc(32, 0x51);
    process.env.EXOMEM_CONTROL_PLANE_KEY = controlPlaneKey.toString("base64url");
    __setExomemSqlForTests(async () => ({
      rows: [
        {
          id: "018f2d91-7c42-7000-8000-000000000001",
          client_id: "https://private.example/credential-sentinel",
          enabled: true,
          admission_mode: "pinned",
          redirect_uris_digest: Buffer.alloc(32, 0x22),
          redirect_count: 2,
          metadata_expires_at: null,
        },
      ],
    }));

    assert.deepEqual(await listOperatorOAuthClients(), [
      {
        id: "018f2d91-7c42-7000-8000-000000000001",
        enabled: true,
        admissionMode: "pinned",
        clientFingerprint: operatorOAuthClientFingerprint(
          "https://private.example/credential-sentinel",
          controlPlaneKey
        ),
        redirectDigest: Buffer.alloc(32, 0x22).toString("hex"),
        redirectCount: 2,
        metadataExpiresAt: null,
      },
    ]);
  });

  it("changes exactly one opaque client record", async () => {
    let query = "";
    const sql = async (strings: TemplateStringsArray) => {
      query = strings.join("?");
      return { rows: [{ id: "018f2d91-7c42-7000-8000-000000000001" }] };
    };
    __setExomemSqlForTests(sql);
    __setExomemTransactionForTests(async (callback) => callback(sql));

    assert.equal(
      await setOperatorOAuthClientEnabled({
        clientRecordId: "018f2d91-7c42-7000-8000-000000000001",
        enabled: false,
      }),
      true
    );
    assert.match(query, /WHERE client\.id = \?::uuid/i);
  });

  it("fences family and account revocation to the named owner and tenant", async () => {
    const queries: string[] = [];
    const sql = async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      queries.push(query);
      return query.includes("revoke-oauth-account-for-owner-tenant")
        ? { rows: [{ revoked_families: 1 }] }
        : { rows: [{ id: "018f2d91-7c42-7000-8000-000000000002" }] };
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
    assert.match(queries[0], /oauth_grant\.user_id = \?/i);
    assert.match(queries[0], /oauth_grant\.tenant_id = \?/i);
    assert.match(queries[1], /exomem_oauth_account_blocks/i);
    assert.match(queries[1], /FOR UPDATE/i);
  });

  it("reports artifact digests only and demotes live artifacts to retired", async () => {
    const queries: string[] = [];
    const sql = async (strings: TemplateStringsArray) => {
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
    };
    __setExomemSqlForTests(sql);
    __setExomemTransactionForTests(async (callback) => callback(sql));

    const artifacts = await listOperatorClientArtifacts();
    assert.equal(artifacts[0]?.packageSha256, "a".repeat(64));
    assert.equal(JSON.stringify(artifacts).includes("install"), false);
    assert.equal(await demoteOperatorClientArtifact("018f2d91-7c42-7000-8000-000000000020"), true);
    assert.match(queries[1], /pg_advisory_xact_lock\(/i);
    assert.doesNotMatch(queries[1], /pg_advisory_xact_lock_shared/i);
    assert.match(queries[2], /SET state = 'retired', retired_at = now\(\)/i);
    assert.match(queries[2], /state = 'live'/i);
  });
});
