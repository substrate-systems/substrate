import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertExomemPaddlePurpose,
  ExomemPaddleConfigurationError,
  loadExomemPaddleConfig,
} from "../paddle-config";

function sandboxEnv(): Record<string, string> {
  return {
    PADDLE_ENVIRONMENT: "sandbox",
    PADDLE_API_KEY: "pdl_sdbx_apikey_example",
    PADDLE_WEBHOOK_SECRET: "pdl_ntfset_example",
    NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "test_client_token",
    EXOMEM_PADDLE_PRODUCT_ID: "pro_exomem_sandbox",
    EXOMEM_PADDLE_PRICE_ID: "pri_exomem_sandbox",
    EXOMEM_PADDLE_CATALOG_ENVIRONMENT: "sandbox",
  };
}

describe("Exomem Paddle configuration", () => {
  it("binds a sandbox catalog and credentials to the shared sandbox client", () => {
    const config = loadExomemPaddleConfig(sandboxEnv());

    assert.equal(config.environment, "sandbox");
    assert.equal(config.apiBaseUrl, "https://sandbox-api.paddle.com");
    assert.equal(config.productKey, "exomem-hosted");
    assert.equal(config.productId, "pro_exomem_sandbox");
    assert.equal(config.priceId, "pri_exomem_sandbox");
    assert.equal(config.paidCheckoutEnabled, true);
    assert.doesNotThrow(() => assertExomemPaddlePurpose(config, "checkout"));
    assert.doesNotThrow(() => assertExomemPaddlePurpose(config, "webhook"));
  });

  it("uses production as the explicit live selector", () => {
    const env = {
      ...sandboxEnv(),
      PADDLE_ENVIRONMENT: "production",
      PADDLE_API_KEY: "pdl_live_apikey_example",
      NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "live_client_token",
      EXOMEM_PADDLE_PRODUCT_ID: "pro_exomem_live",
      EXOMEM_PADDLE_PRICE_ID: "pri_exomem_live",
      EXOMEM_PADDLE_CATALOG_ENVIRONMENT: "production",
    };
    const config = loadExomemPaddleConfig(env);

    assert.equal(config.environment, "production");
    assert.equal(config.apiBaseUrl, "https://api.paddle.com");
    assert.equal(config.productId, "pro_exomem_live");
  });

  it("keeps complimentary alpha usable when no paid price is configured", () => {
    const env = sandboxEnv();
    delete env.EXOMEM_PADDLE_PRICE_ID;
    const config = loadExomemPaddleConfig(env);

    assert.equal(config.paidCheckoutEnabled, false);
    assert.throws(
      () => assertExomemPaddlePurpose(config, "checkout"),
      (error: unknown) =>
        error instanceof ExomemPaddleConfigurationError &&
        error.code === "EXOMEM_PAID_CHECKOUT_DISABLED"
    );
  });

  it("fails closed when the Paddle environment is absent or ambiguous", () => {
    const missing = sandboxEnv();
    delete missing.PADDLE_ENVIRONMENT;
    const liveAlias = { ...sandboxEnv(), PADDLE_ENVIRONMENT: "live" };

    for (const env of [missing, liveAlias]) {
      assert.throws(
        () => loadExomemPaddleConfig(env),
        (error: unknown) =>
          error instanceof ExomemPaddleConfigurationError &&
          error.code === "EXOMEM_PADDLE_CONFIGURATION_INVALID"
      );
    }
  });

  it("rejects detectably mixed sandbox/live credentials and catalog bindings", () => {
    const mixedKey = {
      ...sandboxEnv(),
      PADDLE_API_KEY: "pdl_live_apikey_wrong_environment",
    };
    const mixedCatalog = {
      ...sandboxEnv(),
      EXOMEM_PADDLE_CATALOG_ENVIRONMENT: "production",
    };

    for (const env of [mixedKey, mixedCatalog]) {
      assert.throws(
        () => loadExomemPaddleConfig(env),
        (error: unknown) =>
          error instanceof ExomemPaddleConfigurationError &&
          error.code === "EXOMEM_PADDLE_ENVIRONMENT_MISMATCH"
      );
    }
  });

  it("rejects a configured price without a configured Exomem product", () => {
    const env = sandboxEnv();
    delete env.EXOMEM_PADDLE_PRODUCT_ID;

    assert.throws(
      () => loadExomemPaddleConfig(env),
      (error: unknown) =>
        error instanceof ExomemPaddleConfigurationError &&
        error.code === "EXOMEM_PADDLE_CONFIGURATION_INVALID"
    );
  });
});
