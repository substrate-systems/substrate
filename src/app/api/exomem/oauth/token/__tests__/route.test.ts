import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";

// A real authorization code and a real PKCE verifier in shape, so the route gets
// past its own field checks and the log assertions below are about a request that
// carried genuine secrets rather than obvious junk.
const CODE = Buffer.alloc(32, 9).toString("base64url");
const VERIFIER = "v".repeat(64);
const REFRESH = Buffer.alloc(32, 11).toString("base64url");
const RESOURCE = "https://substratesystems.io/api/exomem/mcp/v1";

let exchangeResult: unknown = null;
let rotateResult: unknown = null;

before(() => {
  mock.module("@/lib/exomem-hosted/public-origin", {
    namedExports: { exomemPublicBaseUrlFromEnv: () => "https://substratesystems.io" },
  });
  mock.module("@/lib/exomem-hosted/rate-limit", {
    namedExports: {
      takeExomemRateLimit: async () => true,
      clientAddressKey: () => "test-address",
      EXOMEM_RATE_LIMITS: { oauthTokenIp: { scope: "test", limit: 60, windowSeconds: 600 } },
    },
  });
  mock.module("@/lib/exomem-hosted/oauth-store", {
    namedExports: {
      issueOAuthTokensFromCodeAtomic: async () => exchangeResult,
      rotateOAuthRefreshTokenAtomic: async () => rotateResult,
    },
  });
});

after(() => mock.reset());

beforeEach(() => {
  exchangeResult = null;
  rotateResult = null;
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

async function capture(request: Request): Promise<{ response: Response; record: any }> {
  const errors: unknown[] = [];
  const restore = console.error;
  console.error = (value: unknown) => errors.push(value);
  try {
    const { POST } = await import("../route");
    const response = await POST(request);
    return { response, record: errors.at(-1) };
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
