import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cloudResourceForHost, loadExomemCloudResource } from "../cloud-config";
import { cloudResourceListProblem } from "../cloud-resource-list";
import { validateGatewayEnvironment } from "../../../exomem-gateway/server";

const OLD = "https://old.example.test/mcp/v1";
const NEW = "https://new.example.test/mcp/v1";
const BASE = { EXOMEM_CLOUD_MCP_URL: OLD, EXOMEM_CLOUD_MCP_PATH: "/mcp/v1" };

describe("Cloud accepted resources", () => {
  it("accepts only the single resource while no list is set", () => {
    const config = loadExomemCloudResource(BASE);
    assert.equal(config.mcpUrl, OLD);
    assert.deepEqual(config.acceptedResources, [OLD]);
  });

  it("offers the first listed resource to new connections and keeps accepting the old one", () => {
    const config = loadExomemCloudResource({ ...BASE, EXOMEM_CLOUD_MCP_URLS: `${NEW}, ${OLD}` });
    assert.equal(config.mcpUrl, NEW);
    assert.deepEqual(config.acceptedResources, [NEW, OLD]);
  });

  // A list that would strand existing tokens, or that is malformed, must not take effect: the
  // gateway loads this on every request, so a throw would fail every connection instead.
  it("ignores a list that drops the configured resource or is malformed", () => {
    for (const list of [
      NEW,
      `${NEW},http://old.example.test/mcp/v1`,
      `https://new.example.test/other,${OLD}`,
    ]) {
      const config = loadExomemCloudResource({ ...BASE, EXOMEM_CLOUD_MCP_URLS: list });
      assert.deepEqual(config.acceptedResources, [OLD], list);
      assert.equal(config.mcpUrl, OLD, list);
    }
  });

  // The build and the gateway readiness check use this, so a bad list stops a deploy.
  it("names the problem with each list that would strand tokens or is not canonical", () => {
    for (const list of [
      NEW,
      `${NEW}/,${OLD}`,
      `${NEW},http://old.example.test/mcp/v1`,
      `https://NEW.example.test/mcp/v1,${OLD}`,
      `https://new.example.test:443/mcp/v1,${OLD}`,
      `${NEW},${NEW},${OLD}`,
    ]) {
      assert.notEqual(
        cloudResourceListProblem({ ...BASE, EXOMEM_CLOUD_MCP_URLS: list }),
        null,
        list
      );
    }
    assert.equal(
      cloudResourceListProblem({ ...BASE, EXOMEM_CLOUD_MCP_URLS: `${NEW},${OLD}` }),
      null
    );
    assert.equal(cloudResourceListProblem(BASE), null);
  });

  it("keeps the gateway from reporting ready with a list that would strand tokens", () => {
    const env = {
      DATABASE_URL: "postgres://example.test/db",
      EXOMEM_CONTROL_PLANE_KEY: "k",
      EXOMEM_PUBLIC_BASE_URL: "https://example.test",
      EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_HEADER: "x-source",
      EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_VALUE: "v",
      EXOMEM_CLOUD_CELL_TOKEN_KEY: "c",
      ...BASE,
    };
    assert.doesNotThrow(() =>
      validateGatewayEnvironment({ ...env, EXOMEM_CLOUD_MCP_URLS: `${NEW},${OLD}` })
    );
    assert.throws(
      () => validateGatewayEnvironment({ ...env, EXOMEM_CLOUD_MCP_URLS: NEW }),
      /must include/
    );
  });

  it("matches a Host header carrying the default port or a trailing dot", () => {
    const config = loadExomemCloudResource({ ...BASE, EXOMEM_CLOUD_MCP_URLS: `${NEW},${OLD}` });
    assert.equal(cloudResourceForHost(config, "old.example.test:443"), OLD);
    assert.equal(cloudResourceForHost(config, "OLD.example.test."), OLD);
    assert.equal(cloudResourceForHost(config, "unknown.example.test"), NEW);
  });
});
