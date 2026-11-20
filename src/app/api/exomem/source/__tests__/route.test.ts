import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";

let rollout: () => Promise<{ release: string | null }>;

before(() => {
  mock.module("@/lib/exomem-hosted/cloud-release", {
    namedExports: { getCloudRolloutView: () => rollout() },
  });
});
after(() => mock.reset());

async function get() {
  const { GET } = await import("../route");
  return GET();
}

describe("GET /api/exomem/source", () => {
  it("names the release the service runs and lets the CDN share it", async () => {
    rollout = async () => ({ release: "v1.2.3" });
    const response = await get();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { state: "known", release: "v1.2.3" });
    assert.match(response.headers.get("cache-control") ?? "", /s-maxage=60/);
  });

  it("says the release is not recorded when the image history maps to none", async () => {
    rollout = async () => ({ release: null });
    const response = await get();
    assert.deepEqual(await response.json(), { state: "unknown" });
  });

  it("reports a failed read as unavailable and never caches it", async () => {
    rollout = async () => {
      throw new Error("database down");
    };
    const response = await get();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { state: "unavailable" });
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});
