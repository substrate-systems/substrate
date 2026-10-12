import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { oauthClientContext } from "../oauth-client-identity";

describe("oauthClientContext", () => {
  it("treats a client whose redirects all reach this machine as coding, over https as well as http", () => {
    // Admission accepts https loopback redirects; a desktop app registered that
    // way must not get conversation defaults.
    assert.equal(oauthClientContext(["https://localhost:43129/callback"]), "coding");
    assert.equal(oauthClientContext(["https://[::1]/callback", "http://127.0.0.1/callback"]), "coding");
  });

  it("treats a client with any redirect off this machine as conversation", () => {
    assert.equal(
      oauthClientContext(["http://127.0.0.1/callback", "https://agent.example.test/callback"]),
      "conversation"
    );
  });
});
