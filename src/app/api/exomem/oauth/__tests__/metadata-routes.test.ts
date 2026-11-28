import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const previousBaseUrl = process.env.EXOMEM_PUBLIC_BASE_URL;
const METADATA_PATH = "/.well-known/oauth-authorization-server/api/exomem/oauth";
const metadataRequest = (host: string) =>
  new Request(`https://${host}${METADATA_PATH}`, { headers: { host } });

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
    const response = await GET(metadataRequest("hosted.example.test"));
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

  // Sign-in moves from the company site to the product site, and the web app and the gateway
  // switch in separate deploys; a client must find the issuer it was given on its own host.
  it("names the issuer of the app host it is fetched on, before and after sign-in moves", async () => {
    const { GET } =
      await import("../../../../.well-known/oauth-authorization-server/api/exomem/oauth/route");
    const issuerOn = async (host: string) => {
      const body = (await (await GET(metadataRequest(host))).json()) as Record<string, string>;
      return [body.issuer, body.token_endpoint];
    };
    const previousSite = process.env.EVERMATTER_SITE_ORIGIN;
    process.env.EVERMATTER_SITE_ORIGIN = "https://evermatter.ai";
    try {
      for (const base of ["https://substratesystems.io", "https://evermatter.ai"]) {
        process.env.EXOMEM_PUBLIC_BASE_URL = base;
        for (const origin of ["https://substratesystems.io", "https://evermatter.ai"]) {
          assert.deepEqual(
            await issuerOn(new URL(origin).host),
            [`${origin}/api/exomem/oauth`, `${origin}/api/exomem/oauth/token`],
            `${origin} while sign-in is on ${base}`
          );
        }
        // Any other host gets the configured issuer.
        assert.deepEqual(await issuerOn("preview.example.test"), [
          `${base}/api/exomem/oauth`,
          `${base}/api/exomem/oauth/token`,
        ]);
      }
    } finally {
      process.env.EXOMEM_PUBLIC_BASE_URL = "https://hosted.example.test";
      if (previousSite === undefined) delete process.env.EVERMATTER_SITE_ORIGIN;
      else process.env.EVERMATTER_SITE_ORIGIN = previousSite;
    }
  });

  it("serves the metadata document without database or control-plane configuration", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousControlPlaneKey = process.env.EXOMEM_CONTROL_PLANE_KEY;
    delete process.env.DATABASE_URL;
    delete process.env.EXOMEM_CONTROL_PLANE_KEY;
    try {
      const { GET: authorizationServer } =
        await import("../../../../.well-known/oauth-authorization-server/api/exomem/oauth/route");
      assert.equal((await authorizationServer(metadataRequest("hosted.example.test"))).status, 200);
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousControlPlaneKey === undefined) delete process.env.EXOMEM_CONTROL_PLANE_KEY;
      else process.env.EXOMEM_CONTROL_PLANE_KEY = previousControlPlaneKey;
    }
  });
});
