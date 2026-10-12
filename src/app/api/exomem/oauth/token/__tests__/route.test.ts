import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";

// A real authorization code and a real PKCE verifier in shape, so the route gets
// past its own field checks and the log assertions below are about a request that
// carried genuine secrets rather than obvious junk.
const CODE = Buffer.alloc(32, 9).toString("base64url");
const VERIFIER = "v".repeat(64);
const REFRESH = Buffer.alloc(32, 11).toString("base64url");
const RESOURCE = "https://gateway.example.test/mcp";

let exchangeResult: unknown = null;
let rotateResult: unknown = null;
let clientRegistered = true;
// A connector's cached metadata, and whether fetching it again succeeds.
let metadataFresh = true;
let refetchSucceeds = false;
// Whether the presented refresh token is live, and whether a rotation spent it.
let refreshLive = true;
let refreshSpent = false;
// Runs when the route asks for the metadata state, after its rotation was refused.
let beforeMetadataState: (() => void) | null = null;
// Fetches of the connector's metadata, and the failures counted against its
// limit, which the rate-limit mock below keeps like one real bucket.
let refetches = 0;
let refetchFailures = 0;
const REFETCH_FAILURE_SCOPE = "test-connector-metadata-refetch-failure";
const REFETCH_FAILURE_LIMIT = 10;

before(() => {
  process.env.EXOMEM_CLOUD_MCP_URL = RESOURCE;
  process.env.EXOMEM_CLOUD_MCP_PATH = "/mcp";
  mock.module("@/lib/exomem-hosted/cloud-oauth", {
    namedExports: {
      assertGrantOwnsCloudCell: async () => undefined,
      CloudPrincipalHasNoCellError: class extends Error {},
    },
  });
  mock.module("@/lib/exomem-hosted/rate-limit", {
    namedExports: {
      takeExomemRateLimit: async (rule: { scope: string }) => {
        if (rule.scope !== REFETCH_FAILURE_SCOPE) return true;
        refetchFailures += 1;
        return refetchFailures <= REFETCH_FAILURE_LIMIT;
      },
      exomemRateLimitHasRoom: async () => refetchFailures < REFETCH_FAILURE_LIMIT,
      clientAddressKey: () => "test-address",
      EXOMEM_RATE_LIMITS: {
        oauthTokenIp: { scope: "test", limit: 60, windowSeconds: 600 },
        oauthConnectorMetadataRefetchFailureClient: {
          scope: REFETCH_FAILURE_SCOPE,
          limit: REFETCH_FAILURE_LIMIT,
          windowSeconds: 600,
        },
      },
    },
  });
  mock.module("@/lib/exomem-hosted/oauth-store", {
    namedExports: {
      issueOAuthTokensFromCodeAtomic: async () => exchangeResult,
      oauthClientIsRegistered: async () => clientRegistered,
      refreshCimdMetadataState: async () => {
        beforeMetadataState?.();
        if (!refreshLive || !clientRegistered) return "not_eligible";
        return metadataFresh ? "fresh" : "lapsed";
      },
      registerAdmittedCimdClient: async () => {
        refetches += 1;
        if (!refetchSucceeds) return null;
        metadataFresh = true;
        return { id: "client-row" };
      },
      // Rotation needs fresh metadata, as the store's admission predicate does,
      // and spends the refresh token only when it issues.
      rotateOAuthRefreshTokenAtomic: async () => {
        if (!metadataFresh || !refreshLive || refreshSpent || !rotateResult) return null;
        refreshSpent = true;
        return rotateResult;
      },
    },
  });
});

after(() => {
  delete process.env.EXOMEM_CLOUD_MCP_URL;
  delete process.env.EXOMEM_CLOUD_MCP_PATH;
  mock.reset();
});

beforeEach(() => {
  exchangeResult = null;
  rotateResult = null;
  clientRegistered = true;
  metadataFresh = true;
  refetchSucceeds = false;
  refreshLive = true;
  refreshSpent = false;
  beforeMetadataState = null;
  refetches = 0;
  refetchFailures = 0;
});

function post(fields: Record<string, string>): Request {
  return new Request("https://substratesystems.io/api/exomem/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

// The route runs `digestSecret`, which needs a control-plane key. Supplied here
// rather than read from the environment so this passes in CI, which sets none.
async function withControlPlaneKey<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.EXOMEM_CONTROL_PLANE_KEY;
  process.env.EXOMEM_CONTROL_PLANE_KEY = Buffer.alloc(32, 7).toString("base64url");
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.EXOMEM_CONTROL_PLANE_KEY;
    else process.env.EXOMEM_CONTROL_PLANE_KEY = previous;
  }
}

interface OAuthTokenLogRecord {
  event?: string;
  stage?: string;
  client_id?: string;
  redirect_uri?: string;
  resource_matches?: boolean;
  field_names?: string[];
  code_wellformed?: boolean;
  verifier_wellformed?: boolean;
  grant_type?: string;
  [key: string]: unknown;
}

async function capture(
  request: Request
): Promise<{ response: Response; record: OAuthTokenLogRecord | undefined }> {
  const errors: unknown[] = [];
  const restore = console.error;
  console.error = (value: unknown) => errors.push(value);
  try {
    const { POST } = await import("../route");
    const response = await POST(request);
    return { response, record: errors.at(-1) as OAuthTokenLogRecord | undefined };
  } finally {
    console.error = restore;
  }
}

describe("POST /api/exomem/oauth/token", () => {
  // On 2026-08-22 a real connector's exchange failed here and the route logged
  // nothing at all, so a fail-closed contract-state refusal was indistinguishable
  // from a consumed code, an expired code, a PKCE mismatch or a redirect_uri
  // mismatch. Attributing it meant reading a seventy-line SQL predicate and
  // querying rows by hand. The response must stay a bare `invalid_grant`; the log
  // must not.
  it("names the gate that refused a code exchange, without logging the code", async () => {
    const { response, record } = await withControlPlaneKey(() =>
      capture(
        post({
          grant_type: "authorization_code",
          code: CODE,
          client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata",
          redirect_uri: "https://claude.ai/api/mcp/auth_callback",
          code_verifier: VERIFIER,
          resource: RESOURCE,
        })
      )
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_grant" });
    assert.equal(record?.event, "exomem_oauth_token_rejection");
    assert.equal(record?.stage, "code_exchange");
    // The client and redirect are what let an operator find the code row by hand.
    assert.equal(record?.client_id, "https://claude.ai/oauth/mcp-oauth-client-metadata");
    assert.equal(record?.redirect_uri, "https://claude.ai/api/mcp/auth_callback");

    const serialized = JSON.stringify(record);
    assert.ok(!serialized.includes(CODE), "the authorization code must never reach the log");
    assert.ok(!serialized.includes(VERIFIER), "the PKCE verifier must never reach the log");
  });

  // A `resource` the client got wrong is answered identically to a missing field,
  // and it is the one an MCP client is most likely to get wrong by itself.
  it("distinguishes a wrong resource from a malformed field set", async () => {
    const { response, record } = await capture(
      post({
        grant_type: "authorization_code",
        code: CODE,
        client_id: "client-1",
        redirect_uri: "https://client.example/callback",
        code_verifier: VERIFIER,
        resource: "https://substratesystems.io/api/exomem/mcp/v2",
      })
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_request" });
    assert.equal(record?.stage, "code_fields");
    assert.equal(record?.resource_matches, false);
    assert.ok(record?.field_names?.includes("code_verifier"), "field names locate the caller's bug");
    assert.ok(
      !JSON.stringify(record).includes(VERIFIER),
      "naming a field must not record its value"
    );
  });

  it("separates a malformed code from a malformed verifier", async () => {
    const { record } = await withControlPlaneKey(() =>
      capture(
        post({
          grant_type: "authorization_code",
          code: CODE,
          client_id: "client-1",
          redirect_uri: "https://client.example/callback",
          code_verifier: "short",
          resource: RESOURCE,
        })
      )
    );

    assert.equal(record?.stage, "code_shape");
    assert.equal(record?.code_wellformed, true);
    assert.equal(record?.verifier_wellformed, false);
  });

  // Rotation answers null for a replayed refresh token, which revokes the whole
  // family. Without this line a replay is invisible to the operator.
  it("names a refused refresh rotation without logging the refresh token", async () => {
    const { response, record } = await withControlPlaneKey(() =>
      capture(
        post({
          grant_type: "refresh_token",
          refresh_token: REFRESH,
          client_id: "client-1",
          resource: RESOURCE,
        })
      )
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_grant" });
    assert.equal(record?.stage, "refresh_rotation");
    assert.ok(
      !JSON.stringify(record).includes(REFRESH),
      "the refresh token must never reach the log"
    );
  });

  // A retired generic client's app keeps sending its old client ID. MCP SDK
  // clients register again only on invalid_client; on invalid_grant they retry
  // the dead ID at /authorize, which refuses it without a redirect.
  const refusedGrants: Array<{ kind: string; fields: Record<string, string> }> = [
    {
      kind: "code exchange",
      fields: {
        grant_type: "authorization_code",
        code: CODE,
        client_id: "retired-client",
        redirect_uri: "http://127.0.0.1:43123/callback",
        code_verifier: VERIFIER,
        resource: RESOURCE,
      },
    },
    {
      kind: "refresh",
      fields: {
        grant_type: "refresh_token",
        refresh_token: REFRESH,
        client_id: "retired-client",
        resource: RESOURCE,
      },
    },
  ];
  for (const grant of refusedGrants) {
    it(`answers invalid_client to a ${grant.kind} from a client that holds no registration`, async () => {
      clientRegistered = false;
      const { response, record } = await withControlPlaneKey(() => capture(post(grant.fields)));

      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "invalid_client" });
      assert.equal(record?.client_registered, false);
    });
  }

  // A connector's metadata document is cached for a day, and refresh needs it
  // fresh. Before the re-fetch, every ChatGPT connector had to be connected
  // again a day after its last authorization.
  it("fetches a connector's expired metadata again at refresh, then rotates", async () => {
    metadataFresh = false;
    refetchSucceeds = true;
    rotateResult = {
      grantId: "grant-1",
      familyId: "family-1",
      clientId: "c",
      resource: RESOURCE,
      scopes: ["exomem.read"],
    };
    const { response } = await withControlPlaneKey(() =>
      capture(
        post({
          grant_type: "refresh_token",
          refresh_token: REFRESH,
          client_id: "https://chatgpt.example.test/client.json",
          resource: RESOURCE,
        })
      )
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as { access_token?: string; refresh_token?: string };
    assert.ok(body.access_token && body.refresh_token);
  });

  // In a herd, another request's fetch can commit after this request's rotation
  // was refused. invalid_grant here would make a live token's client drop it.
  it("rotates again when another request's fetch made the metadata fresh in between", async () => {
    metadataFresh = false;
    refetchSucceeds = false;
    beforeMetadataState = () => {
      metadataFresh = true;
    };
    rotateResult = {
      grantId: "grant-1",
      familyId: "family-1",
      clientId: "c",
      resource: RESOURCE,
      scopes: ["exomem.read"],
    };
    const { response } = await withControlPlaneKey(() =>
      capture(
        post({
          grant_type: "refresh_token",
          refresh_token: REFRESH,
          client_id: "https://claude.example.test/client.json",
          resource: RESOURCE,
        })
      )
    );

    assert.equal(response.status, 200);
    assert.equal(refetches, 0);
  });

  // Many clients drop their tokens on invalid_grant. A failed fetch at a shared
  // client's expiry must leave every user's refresh token working.
  it("answers a retryable server error when the metadata cannot be fetched, and keeps the refresh token", async () => {
    metadataFresh = false;
    refetchSucceeds = false;
    rotateResult = {
      grantId: "grant-1",
      familyId: "family-1",
      clientId: "c",
      resource: RESOURCE,
      scopes: ["exomem.read"],
    };
    const refresh = () =>
      withControlPlaneKey(() =>
        capture(
          post({
            grant_type: "refresh_token",
            refresh_token: REFRESH,
            client_id: "https://chatgpt.example.test/client.json",
            resource: RESOURCE,
          })
        )
      );

    const { response, record } = await refresh();
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { error?: string }).error, "server_error");
    assert.equal(record?.stage, "refresh_metadata_unavailable");
    assert.equal(refreshSpent, false);

    refetchSucceeds = true;
    assert.equal((await refresh()).response.status, 200);
  });

  it("keeps invalid_grant for a refresh token that is not live while the metadata lapsed", async () => {
    metadataFresh = false;
    refreshLive = false;
    const { response } = await withControlPlaneKey(() =>
      capture(
        post({
          grant_type: "refresh_token",
          refresh_token: REFRESH,
          client_id: "https://chatgpt.example.test/client.json",
          resource: RESOURCE,
        })
      )
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_grant" });
    assert.equal(refetches, 0);
  });

  // One claude.ai client ID serves every Claude user. When its metadata lapses,
  // each refresh that arrives while the first fetch runs fetches too, and none
  // of them may be refused for it.
  it("never refuses a herd of refreshes whose re-fetches succeed", async () => {
    refetchSucceeds = true;
    rotateResult = {
      grantId: "grant-1",
      familyId: "family-1",
      clientId: "c",
      resource: RESOURCE,
      scopes: ["exomem.read"],
    };
    const herd = REFETCH_FAILURE_LIMIT * 3;
    for (let refresh = 0; refresh < herd; refresh += 1) {
      // Each refresh is another user's token, arriving while the metadata lapsed.
      metadataFresh = false;
      refreshSpent = false;
      const { response } = await withControlPlaneKey(() =>
        capture(
          post({
            grant_type: "refresh_token",
            refresh_token: REFRESH,
            client_id: "https://claude.example.test/client.json",
            resource: RESOURCE,
          })
        )
      );
      assert.equal(response.status, 200);
    }
    assert.equal(refetches, herd);
  });

  // A document that keeps failing must not be fetched on every refresh.
  it("answers without a fetch once repeated failures spend the limit", async () => {
    metadataFresh = false;
    refetchSucceeds = false;
    for (let refresh = 0; refresh <= REFETCH_FAILURE_LIMIT; refresh += 1) {
      const { response } = await withControlPlaneKey(() =>
        capture(
          post({
            grant_type: "refresh_token",
            refresh_token: REFRESH,
            client_id: "https://chatgpt.example.test/client.json",
            resource: RESOURCE,
          })
        )
      );
      assert.equal(response.status, 503);
    }
    assert.equal(refetches, REFETCH_FAILURE_LIMIT);
  });

  it("names an unsupported grant type", async () => {
    const { record } = await capture(post({ grant_type: "client_credentials" }));
    assert.equal(record?.stage, "grant_type");
    assert.equal(record?.grant_type, "client_credentials");
  });

  it("still issues a token when the store admits the exchange", async () => {
    exchangeResult = { scopes: ["exomem.read", "exomem.write"], refreshInserted: true };
    const { response } = await withControlPlaneKey(() =>
      capture(
        post({
          grant_type: "authorization_code",
          code: CODE,
          client_id: "client-1",
          redirect_uri: "https://client.example/callback",
          code_verifier: VERIFIER,
          resource: RESOURCE,
        })
      )
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.token_type, "Bearer");
    assert.equal(body.scope, "exomem.read exomem.write");
    assert.ok(body.access_token, "an admitted exchange must return an access token");
    assert.ok(body.refresh_token, "an admitted exchange must return a refresh token");
  });
});
