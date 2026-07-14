import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CloudflareAccessConfigurationError,
  cloudflareAccessConfigFromEnv,
  cloudflareAccessHeaders,
} from "../cloudflare-access";

function productionEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    EXOMEM_CF_ACCESS_CLIENT_ID: "active-client-id.access",
    EXOMEM_CF_ACCESS_CLIENT_SECRET: "active-client-secret-value",
  };
  return Object.assign(env, overrides);
}

describe("Cloudflare Access service-token configuration", () => {
  it("emits only the server-selected active pair", () => {
    const config = cloudflareAccessConfigFromEnv(productionEnv());
    assert.ok(config);
    assert.deepEqual(cloudflareAccessHeaders(config), {
      "CF-Access-Client-Id": "active-client-id.access",
      "CF-Access-Client-Secret": "active-client-secret-value",
    });
    assert.equal(JSON.stringify(config).includes("active-client-secret-value"), false);
  });

  it("supports an explicit previous sender only during a complete overlap", () => {
    const config = cloudflareAccessConfigFromEnv(
      productionEnv({
        EXOMEM_CF_ACCESS_CLIENT_ID_PREVIOUS: "previous-client-id.access",
        EXOMEM_CF_ACCESS_CLIENT_SECRET_PREVIOUS: "previous-client-secret-value",
        EXOMEM_CF_ACCESS_SEND_VERSION: "previous",
      })
    );
    assert.ok(config);
    assert.deepEqual(cloudflareAccessHeaders(config), {
      "CF-Access-Client-Id": "previous-client-id.access",
      "CF-Access-Client-Secret": "previous-client-secret-value",
    });
  });

  it("rejects partial pairs, unknown selectors, and production omission", () => {
    for (const env of [
      productionEnv({ EXOMEM_CF_ACCESS_CLIENT_SECRET: undefined }),
      productionEnv({ EXOMEM_CF_ACCESS_CLIENT_ID_PREVIOUS: "previous-client-id.access" }),
      productionEnv({ EXOMEM_CF_ACCESS_SEND_VERSION: "previous" }),
      productionEnv({ EXOMEM_CF_ACCESS_SEND_VERSION: "unknown" }),
      productionEnv({
        EXOMEM_CF_ACCESS_CLIENT_ID: undefined,
        EXOMEM_CF_ACCESS_CLIENT_SECRET: undefined,
      }),
    ]) {
      assert.throws(
        () => cloudflareAccessConfigFromEnv(env),
        (error) => error instanceof CloudflareAccessConfigurationError
      );
    }
  });

  it("allows an explicitly unconfigured local test process", () => {
    assert.equal(cloudflareAccessConfigFromEnv({ NODE_ENV: "test" }), null);
  });
});
