import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { __setExomemSqlForTests, __setExomemTransactionForTests } from "../db";
import {
  listOperatorOAuthClients,
  preflightReusablePinnedOAuthClient,
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

  it("preflights only one disabled exact pinned client with no reviewer history", async () => {
    let query = "";
    const sql = async (strings: TemplateStringsArray) => {
      query = strings.join("?");
      return { rows: [{ id: "018f2d91-7c42-7000-8000-000000000091" }] };
    };
    __setExomemSqlForTests(sql);
    __setExomemTransactionForTests(async (work) => work(sql));

    assert.deepEqual(
      await preflightReusablePinnedOAuthClient({
        platform: "claude",
        clientId: "exomem-reviewer-bootstrap-018f2d91-7c42-7000-8000-000000000090",
        redirectUris: ["http://localhost:47831/callback"],
      }),
      { eligible: true, clientRecordId: "018f2d91-7c42-7000-8000-000000000091" }
    );
    assert.match(query, /admission_mode = 'pinned'/i);
    assert.match(query, /enabled = false/i);
    assert.match(query, /reviewer_bootstrap_ever_authorized = false/i);
    assert.match(query, /oauth_client_config_sha256 = /i);
    assert.match(query, /metadata_provenance->>'mode' = 'pinned'/i);
    assert.doesNotMatch(query, /\b(?:INSERT|UPDATE|DELETE)\b/i);
  });

  it("reuses only the explicitly named eligible record without inserting a client", async () => {
    const queries: string[] = [];
    const sql = async (strings: TemplateStringsArray) => {
      queries.push(strings.join("?"));
      return { rows: [{ id: "018f2d91-7c42-7000-8000-000000000091", enabled: false }] };
    };
    __setExomemSqlForTests(sql);
    __setExomemTransactionForTests(async (work) => work(sql));

    assert.deepEqual(
      await registerOperatorOAuthClient({
        admissionMode: "pinned",
        platform: "claude",
        clientId: "exomem-reviewer-bootstrap-018f2d91-7c42-7000-8000-000000000090",
        redirectUris: ["http://localhost:47831/callback"],
        stagedClientReleaseId: "018f2d91-7c42-7000-8000-000000000092",
        existingClientRecordId: "018f2d91-7c42-7000-8000-000000000091",
      }),
      { id: "018f2d91-7c42-7000-8000-000000000091", enabled: false }
    );
    assert.match(queries[1]!, /id = \?::uuid/i);
    assert.match(queries[1]!, /exomem_staged_client_releases/i);
    assert.match(queries[1]!, /reviewer_bootstrap_ever_authorized = false/i);
    assert.match(queries[1]!, /enabled = false/i);
    assert.doesNotMatch(queries[1]!, /INSERT INTO exomem_oauth_clients/i);
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

  it("does not enable a client from staged authority alone", async () => {
    let query = "";
    const sql = async (strings: TemplateStringsArray) => {
      query = strings.join("?");
      return { rows: [] };
    };
    __setExomemSqlForTests(sql);
    __setExomemTransactionForTests(async (work) => work(sql));

    assert.equal(
      await setOperatorOAuthClientEnabled({
        clientRecordId: "018f2d91-7c42-7000-8000-000000000001",
        enabled: true,
      }),
      false
    );
    assert.doesNotMatch(query, /exomem_staged_client_releases/i);
    assert.match(query, /exomem_client_artifacts/i);
    assert.match(query, /client\.reviewer_bootstrap_ever_authorized = false/i);
  });

  it("never re-enables a client with bootstrap history, including a null legacy config", async () => {
    let query = "";
    const sql = async (strings: TemplateStringsArray) => {
      query = strings.join("?");
      return { rows: [] };
    };
    __setExomemSqlForTests(sql);
    __setExomemTransactionForTests(async (work) => work(sql));

    assert.equal(
      await setOperatorOAuthClientEnabled({
        clientRecordId: "018f2d91-7c42-7000-8000-000000000001",
        enabled: true,
      }),
      false
    );
    assert.match(
      query,
      /\(\? = false\) OR \(\s*client\.reviewer_bootstrap_ever_authorized = false AND EXISTS/i
    );
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
});
