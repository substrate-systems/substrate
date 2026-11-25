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

test("a chart that names every setting with the product prefix starts the gateway", () => {
  const environment: Record<string, string | undefined> = { ...REQUIRED_UNDER_PRODUCT_PREFIX };
  adoptSettingAliases(environment, () => assert.fail("no conflict expected"));
  validateGatewayEnvironment(environment);
  assert.equal(environment.EXOMEM_PUBLIC_BASE_URL, "https://mcp.example.test");
});

test("a set internal name wins over a different product-prefix value, and the conflict is named", () => {
  const warnings: string[] = [];
  const environment: Record<string, string | undefined> = {
    EXOMEM_GATEWAY_MAX_INFLIGHT: "16",
    EVERMATTER_GATEWAY_MAX_INFLIGHT: "64",
  };
  adoptSettingAliases(environment, (message) => warnings.push(message));
  assert.equal(environment.EXOMEM_GATEWAY_MAX_INFLIGHT, "16");
  assert.deepEqual(warnings, [
    "EVERMATTER_GATEWAY_MAX_INFLIGHT and EXOMEM_GATEWAY_MAX_INFLIGHT are both set to different values; using EXOMEM_GATEWAY_MAX_INFLIGHT",
  ]);
});
