import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { GET } from "../.well-known/openai-apps-challenge/route";

const originalChallenge = process.env.OPENAI_APPS_CHALLENGE;

afterEach(() => {
  if (originalChallenge === undefined) delete process.env.OPENAI_APPS_CHALLENGE;
  else process.env.OPENAI_APPS_CHALLENGE = originalChallenge;
});

describe("GET /.well-known/openai-apps-challenge", () => {
  it("returns the configured value exactly as no-store plain text", async () => {
    process.env.OPENAI_APPS_CHALLENGE = "domain-proof-test-value";

    const response = await GET(
      new Request("https://example.test/.well-known/openai-apps-challenge")
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await response.text(), "domain-proof-test-value");
  });

  it("ignores caller input and uses only the configured challenge", async () => {
    process.env.OPENAI_APPS_CHALLENGE = "deployment-value";

    const response = await GET(
      new Request(
        "https://example.test/.well-known/openai-apps-challenge?challenge=attacker-value",
        {
          headers: { "x-openai-apps-challenge": "attacker-value" },
        }
      )
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "deployment-value");
  });

  for (const value of [undefined, "", "   ", "line\nbreak", "tab\tbreak", "a".repeat(513)]) {
    it(`fails closed for ${value === undefined ? "missing" : "unsafe"} configuration`, async () => {
      if (value === undefined) delete process.env.OPENAI_APPS_CHALLENGE;
      else process.env.OPENAI_APPS_CHALLENGE = value;

      const response = await GET(
        new Request("https://example.test/.well-known/openai-apps-challenge")
      );

      assert.equal(response.status, 404);
      assert.equal(await response.text(), "");
    });
  }
});
