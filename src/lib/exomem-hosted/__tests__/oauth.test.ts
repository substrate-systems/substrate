import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  bearerChallenge,
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
  exchangeAuthorizationCode,
  mintAuthorizationCode,
  parseAuthorizeParameters,
  parseBearerAuthorization,
  pkceS256,
  rotateRefreshToken,
  validateCimdMetadata,
  validateAuthorizationRequest,
} from "../oauth";
import { DIRECT_V1_RESOURCE } from "../hosted-ingress";

const baseUrl = "https://hosted.example.test";
const resource = `${baseUrl}/api/exomem/mcp/v1`;
const client = {
  clientId: "https://client.example.test/client.json",
  redirectUris: ["https://client.example.test/oauth/callback"],
};

describe("Exomem Hosted OAuth protocol", () => {
  it("publishes canonical protected-resource and authorization-server metadata", () => {
    assert.deepEqual(buildProtectedResourceMetadata(baseUrl), {
      resource,
      authorization_servers: [`${baseUrl}/api/exomem/oauth`],
      bearer_methods_supported: ["header"],
      scopes_supported: ["exomem.read", "exomem.write", "offline_access"],
    });
    assert.deepEqual(buildAuthorizationServerMetadata(baseUrl), {
      issuer: `${baseUrl}/api/exomem/oauth`,
      authorization_endpoint: `${baseUrl}/api/exomem/oauth/authorize`,
      token_endpoint: `${baseUrl}/api/exomem/oauth/token`,
      revocation_endpoint: `${baseUrl}/api/exomem/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["exomem.read", "exomem.write", "offline_access"],
    });
    assert.equal(
      bearerChallenge(baseUrl),
      `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/api/exomem/mcp/v1", ` +
        `scope="exomem.read exomem.write offline_access"`
    );
  });

  it("keeps the issuer on the website while advertising the selected direct resource", () => {
    assert.deepEqual(buildProtectedResourceMetadata(baseUrl, DIRECT_V1_RESOURCE), {
      resource: DIRECT_V1_RESOURCE,
      authorization_servers: [`${baseUrl}/api/exomem/oauth`],
      bearer_methods_supported: ["header"],
      scopes_supported: ["exomem.read", "exomem.write", "offline_access"],
    });
    assert.equal(
      bearerChallenge(baseUrl, DIRECT_V1_RESOURCE),
      `Bearer resource_metadata="https://exomem-direct.substratesystems.io/.well-known/oauth-protected-resource/api/exomem/mcp/v1", ` +
        `scope="exomem.read exomem.write offline_access"`
    );
  });

  // The three surfaces a client can read a scope list from must agree. They did
  // not: the resource document omitted `offline_access` while the authorization
  // server advertised it, and because `refresh_allowed` is derived from the
  // requested scope, that disagreement decided which connectors survived past
  // their fifteen-minute access token. A client is entitled to build its
  // authorize request from any one of them and get a working grant.
  it("advertises the same scopes on the resource, the server and the challenge", () => {
    const expected = ["exomem.read", "exomem.write", "offline_access"];
    const resourceScopes = (
      buildProtectedResourceMetadata(baseUrl) as { scopes_supported: string[] }
    ).scopes_supported;
    const serverScopes = (
      buildAuthorizationServerMetadata(baseUrl) as { scopes_supported: string[] }
    ).scopes_supported;
    const challengeScopes = /scope="([^"]+)"/.exec(bearerChallenge(baseUrl))?.[1].split(" ");

    assert.deepEqual(resourceScopes, expected);
    assert.deepEqual(serverScopes, expected);
    assert.deepEqual(challengeScopes, expected);
    assert.ok(
      resourceScopes.includes("offline_access"),
      "a client that reads only the resource document must still learn it may ask for a refresh token"
    );
  });

  // Guards the derivation, not the constant: a grant is only refreshable when
  // the client asked for `offline_access`, so advertising it and honouring it
  // have to stay two halves of one decision.
  it("derives refresh eligibility from the advertised offline_access scope", () => {
    const request = {
      client,
      redirectUri: client.redirectUris[0],
      resource,
      requestedResource: resource,
      state: "state-value",
      codeChallenge: pkceS256("v".repeat(64)),
      codeChallengeMethod: "S256" as const,
    };
    assert.equal(
      validateAuthorizationRequest({ ...request, scope: "exomem.read exomem.write offline_access" })
        .offlineAccess,
      true
    );
    // Exactly what the ChatGPT connector sent when the resource document
    // listed only two scopes, down to the order.
    assert.equal(
      validateAuthorizationRequest({ ...request, scope: "exomem.write exomem.read" }).offlineAccess,
      false
    );
  });

  it("accepts authority only from one bearer Authorization header", () => {
    const token = "a".repeat(43);
    assert.equal(parseBearerAuthorization(`Bearer ${token}`), token);
    assert.equal(parseBearerAuthorization(`bearer ${token}`), token);
    assert.equal(parseBearerAuthorization(`Basic ${token}`), null);
    assert.equal(parseBearerAuthorization(`Bearer ${token} second`), null);
    assert.equal(parseBearerAuthorization(null), null);
  });

  it("requires exact client redirect, resource, scopes, and S256 PKCE", () => {
    const verifier = "a".repeat(43);
    const request = validateAuthorizationRequest({
      client,
      resource,
      requestedResource: resource,
      redirectUri: client.redirectUris[0],
      scope: "exomem.read offline_access",
      state: "opaque-client-state",
      codeChallenge: pkceS256(verifier),
      codeChallengeMethod: "S256",
    });
    assert.deepEqual(request.scopes, ["exomem.read"]);
    assert.throws(
      () =>
        validateAuthorizationRequest({
          client,
          resource,
          requestedResource: `${resource}/other`,
          redirectUri: "https://client.example.test/other",
          scope: "exomem.read exomem.admin",
          state: "opaque-client-state",
          codeChallenge: "plain",
          codeChallengeMethod: "plain",
        }),
      /OAUTH_INVALID_REQUEST/
    );
  });

  it("rejects duplicate OAuth security parameters and preserves offline continuity", () => {
    assert.throws(
      () =>
        parseAuthorizeParameters(
          new URLSearchParams(
            "response_type=code&client_id=client-a&client_id=client-b&resource=https%3A%2F%2Fhosted.example.test%2Fapi%2Fexomem%2Fmcp%2Fv1"
          )
        ),
      /OAUTH_INVALID_REQUEST/
    );
    const request = validateAuthorizationRequest({
      client,
      resource,
      requestedResource: resource,
      redirectUri: client.redirectUris[0],
      scope: "exomem.read offline_access",
      state: "opaque-client-state",
      codeChallenge: pkceS256("d".repeat(43)),
      codeChallengeMethod: "S256",
    });
    assert.equal(request.offlineAccess, true);
  });

  it("ignores unrecognized authorize parameters so real clients can authorize", () => {
    // The exact shape ChatGPT sends for a connector authorization. `ui_locales`
    // is an OpenID Connect hint we have no use for; rejecting the request over
    // it made every ChatGPT connector fail before client resolution ran.
    const parsed = parseAuthorizeParameters(
      new URLSearchParams(
        "response_type=code&client_id=https%3A%2F%2Fchatgpt.example.test%2Foauth%2FAbCdEf%2Fclient.json" +
          "&redirect_uri=https%3A%2F%2Fchatgpt.example.test%2Fconnector%2Foauth%2FAbCdEf" +
          "&scope=exomem.read+exomem.write&code_challenge=" +
          "L5XfmKp2ZvLU82AqsU-Ssq28mQhQm4iUogPLGBgh_n4&code_challenge_method=S256" +
          "&resource=https%3A%2F%2Fhosted.example.test%2Fapi%2Fexomem%2Fmcp%2Fv1" +
          "&state=oauth_s_6a80db778bfc8191a9d862f42d497e75&ui_locales=en-US"
      )
    );
    assert.equal(parsed.ui_locales, undefined);
    assert.equal(parsed.code_challenge_method, "S256");
    assert.equal(parsed.scope, "exomem.read exomem.write");
    assert.equal(parsed.state, "oauth_s_6a80db778bfc8191a9d862f42d497e75");
    assert.equal(parsed.resource, "https://hosted.example.test/api/exomem/mcp/v1");
  });

  it("still rejects a duplicated recognized parameter hidden among ignored ones", () => {
    // Dropping unknown names must not become a way to smuggle a second value
    // for a name that IS read.
    assert.throws(
      () =>
        parseAuthorizeParameters(
          new URLSearchParams(
            "ui_locales=en-US&redirect_uri=https%3A%2F%2Fa.test%2Fx&redirect_uri=https%3A%2F%2Fevil.test%2Fx"
          )
        ),
      /OAUTH_INVALID_REQUEST/
    );
  });

  it("refuses an absurd number of authorize parameters", () => {
    const many = new URLSearchParams();
    for (let index = 0; index < 65; index += 1) many.append(`pad_${index}`, "x");
    assert.throws(() => parseAuthorizeParameters(many), /OAUTH_INVALID_REQUEST/);
  });

  it("keeps the authorization envelope bound to every authorization input", () => {
    const source = readFileSync("src/lib/exomem-hosted/oauth-continuity.ts", "utf8");
    for (const field of [
      "version",
      "clientId",
      "redirectUri",
      "resource",
      "stateDigest",
      "codeChallenge",
    ]) {
      assert.match(source, new RegExp(field));
    }
  });

  it("accepts CIMD only for an operator-allowlisted HTTPS host with exact identity", () => {
    assert.deepEqual(
      validateCimdMetadata(
        {
          clientId: client.clientId,
          allowedHosts: ["client.example.test"],
          metadata: {
            client_id: client.clientId,
            redirect_uris: [...client.redirectUris],
            token_endpoint_auth_method: "none",
          },
        },
        client.redirectUris
      ),
      client
    );
    assert.throws(
      () =>
        validateCimdMetadata(
          {
            clientId: "https://client.example.test/client.json",
            allowedHosts: ["client.example.test"],
            metadata: {
              client_id: "https://attacker.example.test/client.json",
              redirect_uris: ["https://attacker.example.test/callback"],
              token_endpoint_auth_method: "none",
            },
          },
          client.redirectUris
        ),
      /OAUTH_INVALID_REQUEST/
    );
  });

  it("exchanges an opaque authorization code once with exact PKCE binding", async () => {
    const verifier = "b".repeat(43);
    const issued = mintAuthorizationCode({
      clientId: client.clientId,
      redirectUri: client.redirectUris[0],
      resource,
      scopes: ["exomem.read"],
      codeChallenge: pkceS256(verifier),
      now: new Date("2026-07-26T12:00:00.000Z"),
      randomBytes: (size) => Buffer.alloc(size, 7),
    });
    let consumed = false;
    let exchangeInput: Record<string, unknown> | undefined;
    const exchange = async (input: { codeDigest: Buffer }) => {
      exchangeInput = input;
      if (consumed || !input.codeDigest.equals(issued.codeDigest)) return null;
      consumed = true;
      return issued.record;
    };

    const token = await exchangeAuthorizationCode(
      {
        code: issued.code,
        clientId: client.clientId,
        redirectUri: client.redirectUris[0],
        resource,
        codeVerifier: verifier,
      },
      { consumeAuthorizationCode: exchange, now: () => new Date("2026-07-26T12:01:00.000Z") }
    );
    assert.equal(token.clientId, client.clientId);
    assert.equal(token.resource, resource);
    assert.equal(exchangeInput?.clientId, client.clientId);
    assert.equal(exchangeInput?.redirectUri, client.redirectUris[0]);
    assert.equal(exchangeInput?.resource, resource);
    assert.equal(exchangeInput?.pkceChallenge, pkceS256(verifier));
    assert.ok(Buffer.isBuffer(token.accessTokenDigest));
    assert.equal(JSON.stringify(token).includes(issued.code), false);
    await assert.rejects(
      () =>
        exchangeAuthorizationCode(
          {
            code: issued.code,
            clientId: client.clientId,
            redirectUri: client.redirectUris[0],
            resource,
            codeVerifier: verifier,
          },
          { consumeAuthorizationCode: exchange }
        ),
      /OAUTH_INVALID_GRANT/
    );
  });

  it("rotates a refresh token once and treats replay as a family-revoking failure", async () => {
    const refreshToken = Buffer.alloc(32, 8).toString("base64url");
    let rotateInput: Record<string, unknown> | undefined;
    const rotated = await rotateRefreshToken(
      { refreshToken, clientId: client.clientId, resource },
      {
        rotate: async (input) => {
          rotateInput = input;
          return { clientId: client.clientId, resource, scopes: ["exomem.read"] };
        },
        randomBytes: (size) => Buffer.alloc(size, 9),
      }
    );
    assert.equal(rotated.clientId, client.clientId);
    assert.ok(Buffer.isBuffer(rotateInput?.refreshDigest));
    assert.equal(rotateInput?.clientId, client.clientId);
    assert.equal(rotateInput?.resource, resource);
    assert.equal(JSON.stringify(rotateInput).includes(refreshToken), false);
    await assert.rejects(
      () =>
        rotateRefreshToken(
          { refreshToken, clientId: client.clientId, resource },
          { rotate: async () => null }
        ),
      /OAUTH_INVALID_GRANT/
    );
  });

  it("does not mint refresh material when offline_access was not granted", async () => {
    const material = mintAuthorizationCode({
      clientId: client.clientId,
      redirectUri: client.redirectUris[0],
      resource,
      scopes: ["exomem.read"],
      offlineAccess: false,
      codeChallenge: pkceS256("c".repeat(43)),
    });
    const token = await exchangeAuthorizationCode(
      {
        code: material.code,
        clientId: client.clientId,
        redirectUri: client.redirectUris[0],
        resource,
        codeVerifier: "c".repeat(43),
      },
      { consumeAuthorizationCode: async () => material.record }
    );
    assert.equal(token.refreshToken, undefined);
    assert.equal(token.refreshTokenDigest, undefined);
  });
});
