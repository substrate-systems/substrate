import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadExomemCloudResource } from "../cloud-config";

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
});
