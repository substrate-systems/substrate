import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  normalizeOperatorOAuthClientRegistration,
  isCimdNetworkAddressAllowed,
  isSameHostHttpsRedirect,
  oauthClientConfigSha256,
  operatorOAuthClientFingerprint,
  parseCimdDocument,
} from "../oauth-client-admission";

function isInvalidRequest(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "INVALID_REQUEST";
}

describe("operator OAuth client admission", () => {
  it("keeps a pinned registration bounded and preserves exact redirect values", () => {
    assert.deepEqual(
      normalizeOperatorOAuthClientRegistration({
        admissionMode: "pinned",
        platform: "claude",
        artifactId: "018f2d91-7c42-7000-8000-000000000001",
        clientId: "desktop-client",
        redirectUris: ["https://app.example.test/callback"],
        ttlSeconds: 86_400,
      }),
      {
        admissionMode: "pinned",
        platform: "claude",
        artifactId: "018f2d91-7c42-7000-8000-000000000001",
        clientId: "desktop-client",
        redirectUris: ["https://app.example.test/callback"],
        ttlSeconds: 86_400,
      }
    );
  });

  it("requires CIMD client identifiers to be exact HTTPS URLs on an allowlisted host", () => {
    assert.throws(
      () =>
        normalizeOperatorOAuthClientRegistration(
          {
            admissionMode: "cimd",
            platform: "openai",
            artifactId: "018f2d91-7c42-7000-8000-000000000001",
            clientId: "https://untrusted.example.test/client.json",
            redirectUris: ["https://app.example.test/callback"],
          },
          { cimdHosts: ["trusted.example.test"] }
        ),
      isInvalidRequest
    );
    assert.equal(
      normalizeOperatorOAuthClientRegistration(
        {
          admissionMode: "cimd",
          platform: "openai",
          artifactId: "018f2d91-7c42-7000-8000-000000000001",
          clientId: "https://trusted.example.test/client.json",
          redirectUris: ["https://app.example.test/callback"],
        },
        { cimdHosts: ["trusted.example.test"] }
      ).clientId,
      "https://trusted.example.test/client.json"
    );
    assert.equal(isCimdNetworkAddressAllowed("fec0::1"), false);
    assert.equal(isCimdNetworkAddressAllowed("2001:0::1"), false);
    assert.equal(isCimdNetworkAddressAllowed("64:ff9b:1::1"), false);
    assert.equal(isCimdNetworkAddressAllowed("2001:4860:4860::8888"), true);
  });

  it("rejects unsafe redirects and makes the client fingerprint non-reversible", () => {
    assert.throws(
      () =>
        normalizeOperatorOAuthClientRegistration({
          admissionMode: "pinned",
          platform: "claude",
          artifactId: "018f2d91-7c42-7000-8000-000000000001",
          clientId: "desktop-client",
          redirectUris: ["http://evil.example.test/callback"],
        }),
      isInvalidRequest
    );
    const fingerprint = operatorOAuthClientFingerprint("desktop-client", Buffer.alloc(32, 9));
    assert.match(fingerprint, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(fingerprint, /desktop-client/);
    assert.equal(
      oauthClientConfigSha256({
        platform: "claude",
        admissionMode: "pinned",
        clientId: "desktop-client",
        redirectUris: ["https://b.example.test/callback", "https://a.example.test/callback"],
      }),
      oauthClientConfigSha256({
        platform: "claude",
        admissionMode: "pinned",
        clientId: "desktop-client",
        redirectUris: ["https://a.example.test/callback", "https://b.example.test/callback"],
      })
    );
    assert.equal(
      oauthClientConfigSha256({
        platform: "claude",
        admissionMode: "cimd",
        clientId: "https://claude.example.com/oauth/client",
        redirectUris: [
          "https://claude.example.com/oauth/return",
          "https://claude.example.com/oauth/callback",
        ],
      }),
      "3c8bbd83906d29816f59d21b48a7e5a859379b124108b2abb1aa9a309ec3a339"
    );
  });

  it("admits a CIMD document that prefers private_key_jwt but also supports none", () => {
    // ChatGPT connector documents are exactly this shape. `token_endpoint_auth_method`
    // is the client's preference; our metadata advertises only `none`, so under RFC 8414
    // negotiation `none` is what it will actually use.
    const clientId = "https://chatgpt.example.test/oauth/AbCdEf/client.json";
    const raw = JSON.stringify({
      client_id: clientId,
      redirect_uris: ["https://chatgpt.example.test/connector/oauth/AbCdEf"],
      token_endpoint_auth_method: "private_key_jwt",
      token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      jwks_uri: "https://chatgpt.example.test/oauth/jwks.json",
    });
    assert.deepEqual(parseCimdDocument(raw, clientId).document, {
      client_id: clientId,
      redirect_uris: ["https://chatgpt.example.test/connector/oauth/AbCdEf"],
      token_endpoint_auth_method: "none",
    });
  });

  it("still refuses a CIMD document that cannot authenticate as a public client", () => {
    // No `none` anywhere: this server has no client-credential verification path, so an
    // authorization for such a client could never complete a token exchange.
    const clientId = "https://chatgpt.example.test/oauth/AbCdEf/client.json";
    assert.throws(
      () =>
        parseCimdDocument(
          JSON.stringify({
            client_id: clientId,
            redirect_uris: ["https://chatgpt.example.test/connector/oauth/AbCdEf"],
            token_endpoint_auth_method: "private_key_jwt",
            token_endpoint_auth_methods_supported: ["private_key_jwt", "client_secret_basic"],
          }),
          clientId
        ),
      isInvalidRequest
    );
  });

  it("keeps rejecting a CIMD document whose client_id does not match the fetched URL", () => {
    const clientId = "https://chatgpt.example.test/oauth/AbCdEf/client.json";
    assert.throws(
      () =>
        parseCimdDocument(
          JSON.stringify({
            client_id: "https://chatgpt.example.test/oauth/Other/client.json",
            redirect_uris: ["https://chatgpt.example.test/connector/oauth/AbCdEf"],
            token_endpoint_auth_method: "none",
          }),
          clientId
        ),
      isInvalidRequest
    );
  });

  it("keeps rejecting a CIMD document with no usable redirect list", () => {
    const clientId = "https://chatgpt.example.test/oauth/AbCdEf/client.json";
    for (const redirectUris of [[], ["a", "a"], "not-a-list", [1]]) {
      assert.throws(
        () =>
          parseCimdDocument(
            JSON.stringify({
              client_id: clientId,
              redirect_uris: redirectUris,
              token_endpoint_auth_method: "none",
            }),
            clientId
          ),
        isInvalidRequest
      );
    }
  });

  it("anchors initial CIMD expiry to the database clock rather than app-clock skew", () => {
    const source = readFileSync("src/lib/exomem-hosted/operator-controls.ts", "utf8");
    assert.match(source, /CASE WHEN \$\{fetched !== null\} THEN now\(\) ELSE NULL END/);
    assert.match(
      source,
      /now\(\) \+ \(\$\{fetched \? registration\.ttlSeconds : 0\} \* interval '1 second'\)/
    );
    assert.doesNotMatch(source, /new Date\(Date\.now\(\) \+ registration\.ttlSeconds/);
  });

  it("admits a self-registering client's redirect only on its own host over https", () => {
    // Both connectors this path exists for, taken from the real documents.
    assert.equal(
      isSameHostHttpsRedirect("https://chatgpt.com/connector/oauth/6UNqc_HaufBZ", "chatgpt.com"),
      true
    );
    assert.equal(
      isSameHostHttpsRedirect("https://claude.ai/api/mcp/auth_callback", "claude.ai"),
      true
    );
    assert.equal(isSameHostHttpsRedirect("https://ChatGPT.com/cb", "chatgpt.com"), true);

    for (const [uri, host] of [
      // A different host is the whole risk: whoever can place a document on an
      // admitted host would otherwise name any delivery address for the code.
      ["https://evil.example/callback", "chatgpt.com"],
      ["https://chatgpt.com.evil.example/callback", "chatgpt.com"],
      ["https://sub.chatgpt.com/callback", "chatgpt.com"],
      // Cleartext, even on the right host.
      ["http://chatgpt.com/callback", "chatgpt.com"],
      // Loopback is fine for an operator-vouched client, never for a self-registered one.
      ["http://127.0.0.1:8976/callback", "chatgpt.com"],
      ["https://user:pw@chatgpt.com/callback", "chatgpt.com"],
      ["https://chatgpt.com/callback#fragment", "chatgpt.com"],
      ["not a url", "chatgpt.com"],
      ["", "chatgpt.com"],
    ] as const) {
      assert.equal(isSameHostHttpsRedirect(uri, host), false, `${uri} must be refused`);
    }
  });
});
