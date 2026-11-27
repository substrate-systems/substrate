import assert from "node:assert/strict";
import { test } from "node:test";
import { adoptSettingAliases } from "../env-aliases";
import { validateGatewayEnvironment } from "../server";

const REQUIRED_UNDER_PRODUCT_PREFIX = {
  DATABASE_URL: "postgres://gateway.invalid/db",
  EVERMATTER_CONTROL_PLANE_KEY: "key",
  EVERMATTER_PUBLIC_BASE_URL: "https://mcp.example.test",
  EVERMATTER_CELL_PROTOCOL_VERSION: "1",
  EVERMATTER_GATEWAY_CONTROL_HOSTNAME: "control.example.test",
  EVERMATTER_GATEWAY_INTERNAL_ORIGIN: "http://gateway.internal",
  EVERMATTER_GATEWAY_TRUSTED_INGRESS_SOURCE_HEADER: "x-ingress",
  EVERMATTER_GATEWAY_TRUSTED_INGRESS_SOURCE_VALUE: "edge",
  EVERMATTER_CLOUD_MCP_URL: "https://mcp.example.test/mcp",
  EVERMATTER_CLOUD_MCP_PATH: "/mcp",
  EVERMATTER_CLOUD_CELL_TOKEN_KEY: "cell-token-key",
};

test("a chart that names every required setting with the product prefix passes the gateway environment check", () => {
  const environment: Record<string, string | undefined> = { ...REQUIRED_UNDER_PRODUCT_PREFIX };
  adoptSettingAliases(environment, () => assert.fail("no conflict expected"));
  validateGatewayEnvironment(environment);
  assert.equal(environment.EXOMEM_PUBLIC_BASE_URL, "https://mcp.example.test");
  assert.equal(environment.EVERMATTER_PUBLIC_BASE_URL, undefined);
});

// Startup renames the setting before readiness pairs each MCP host with its issuer.
test("readiness pairs an MCP host under the product site only once the product site setting is set", () => {
  const withNewHost = {
    ...REQUIRED_UNDER_PRODUCT_PREFIX,
    EVERMATTER_CLOUD_MCP_URLS: "https://mcp.example.test/mcp,https://mcp.product.example.test/mcp",
  };
  const unset: Record<string, string | undefined> = { ...withNewHost };
  adoptSettingAliases(unset, () => assert.fail("no conflict expected"));
  assert.throws(
    () => validateGatewayEnvironment(unset),
    /mcp\.product\.example\.test\/mcp .*EVERMATTER_SITE_ORIGIN/
  );

  const set: Record<string, string | undefined> = {
    ...withNewHost,
    EVERMATTER_SITE_ORIGIN: "https://product.example.test",
  };
  adoptSettingAliases(set, () => assert.fail("no conflict expected"));
  validateGatewayEnvironment(set);
  set.EXOMEM_SITE_ORIGIN = "https://product.example.test/app";
  assert.throws(() => validateGatewayEnvironment(set), /EVERMATTER_SITE_ORIGIN/);
});

test("a set internal name wins over a different product-prefix value, and the conflict is named", () => {
  const warnings: Record<string, string>[] = [];
  const environment: Record<string, string | undefined> = {
    EXOMEM_GATEWAY_MAX_INFLIGHT: "16",
    EVERMATTER_GATEWAY_MAX_INFLIGHT: "64",
  };
  adoptSettingAliases(environment, (message) => warnings.push(message));
  assert.equal(environment.EXOMEM_GATEWAY_MAX_INFLIGHT, "16");
  assert.deepEqual(warnings, [
    {
      event: "exomem_setting_alias_conflict",
      alias: "EVERMATTER_GATEWAY_MAX_INFLIGHT",
      internal: "EXOMEM_GATEWAY_MAX_INFLIGHT",
    },
  ]);
});
