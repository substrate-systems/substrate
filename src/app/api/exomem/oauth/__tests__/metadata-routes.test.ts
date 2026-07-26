import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const previousBaseUrl = process.env.EXOMEM_PUBLIC_BASE_URL;

before(() => {
  process.env.EXOMEM_PUBLIC_BASE_URL = "https://hosted.example.test";
});

after(() => {
  if (previousBaseUrl === undefined) delete process.env.EXOMEM_PUBLIC_BASE_URL;
  else process.env.EXOMEM_PUBLIC_BASE_URL = previousBaseUrl;
});

describe("Exomem OAuth metadata routes", () => {
  it("returns the versioned protected resource metadata without account state", async () => {
    const { GET } = await import("../../mcp/v1/.well-known/oauth-protected-resource/route");
    const response = await GET();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
    assert.deepEqual(await response.json(), {
      resource: "https://hosted.example.test/api/exomem/mcp/v1",
      authorization_servers: ["https://hosted.example.test/api/exomem/oauth"],
      bearer_methods_supported: ["header"],
      scopes_supported: ["exomem.read", "exomem.write"],
    });
  });

  it("returns authorization-server metadata with PKCE S256 only", async () => {
    const { GET } = await import("../.well-known/oauth-authorization-server/route");
    const response = await GET();
    assert.equal(response.status, 200);
    const body = (await response.json()) as { code_challenge_methods_supported: string[] };
    assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
  });
});
