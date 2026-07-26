import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeOperatorOAuthClientRegistration,
  isCimdNetworkAddressAllowed,
  oauthClientConfigSha256,
  operatorOAuthClientFingerprint,
} from "../oauth-client-admission";

describe("operator OAuth client admission", () => {
  it("keeps a pinned registration bounded and preserves exact redirect values", () => {
    assert.deepEqual(
      normalizeOperatorOAuthClientRegistration({
        admissionMode: "pinned",
        platform: "claude",
        artifactId: "018f2d91-7c42-7000-8000-000000000001",
        clientId: "desktop-client",
        redirectUris: ["https://app.example.test/callback"],
      }),
      {
        admissionMode: "pinned",
        platform: "claude",
        artifactId: "018f2d91-7c42-7000-8000-000000000001",
        clientId: "desktop-client",
        redirectUris: ["https://app.example.test/callback"],
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
      /INVALID_REQUEST/
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
      /INVALID_REQUEST/
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
  });
});
