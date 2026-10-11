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
  it("returns authorization-server metadata with PKCE S256 only", async () => {
    const { GET } =
      await import("../../../../.well-known/oauth-authorization-server/api/exomem/oauth/route");
    const response = await GET();
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      code_challenge_methods_supported: string[];
      client_id_metadata_document_supported: boolean;
      token_endpoint_auth_methods_supported: string[];
    };
    assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
    assert.equal(body.client_id_metadata_document_supported, true);
    assert.deepEqual(body.token_endpoint_auth_methods_supported, ["none"]);
  });

  it("serves the metadata document without database or control-plane configuration", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousControlPlaneKey = process.env.EXOMEM_CONTROL_PLANE_KEY;
    delete process.env.DATABASE_URL;
    delete process.env.EXOMEM_CONTROL_PLANE_KEY;
    try {
      const { GET: authorizationServer } =
        await import("../../../../.well-known/oauth-authorization-server/api/exomem/oauth/route");
      assert.equal((await authorizationServer()).status, 200);
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousControlPlaneKey === undefined) delete process.env.EXOMEM_CONTROL_PLANE_KEY;
      else process.env.EXOMEM_CONTROL_PLANE_KEY = previousControlPlaneKey;
    }
  });
});
