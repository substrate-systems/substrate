import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bearerChallenge,
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
  exchangeAuthorizationCode,
  mintAuthorizationCode,
  parseBearerAuthorization,
  pkceS256,
  rotateRefreshToken,
  validateCimdMetadata,
  validateAuthorizationRequest,
} from "../oauth";

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
      scopes_supported: ["exomem.read", "exomem.write"],
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
      `Bearer resource_metadata="${resource}/.well-known/oauth-protected-resource"`
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
});
