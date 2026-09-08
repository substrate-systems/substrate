import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DIRECT_V1_RESOURCE, resolveHostedIngress } from "../hosted-ingress";

describe("Hosted ingress selection", () => {
  it("keeps the website MCP resource when the profile is absent or legacy", () => {
    for (const profile of [undefined, "legacy"]) {
      assert.deepEqual(
        resolveHostedIngress(
          { EXOMEM_HOSTED_INGRESS_PROFILE: profile },
          "https://hosted.example.test"
        ),
        {
          profile: "legacy",
          resource: "https://hosted.example.test/api/exomem/mcp/v1",
        }
      );
    }
  });

  it("selects only the pinned direct resource", () => {
    assert.deepEqual(
      resolveHostedIngress(
        {
          EXOMEM_HOSTED_INGRESS_PROFILE: "direct-v1",
          EXOMEM_HOSTED_DIRECT_RESOURCE: DIRECT_V1_RESOURCE,
        },
        "https://hosted.example.test"
      ),
      { profile: "direct-v1", resource: DIRECT_V1_RESOURCE }
    );
  });

  it("fails closed for incomplete, unknown, or noncanonical direct configuration", () => {
    for (const environment of [
      { EXOMEM_HOSTED_INGRESS_PROFILE: "direct-v1" },
      {
        EXOMEM_HOSTED_INGRESS_PROFILE: "direct-v1",
        EXOMEM_HOSTED_DIRECT_RESOURCE:
          "https://exomem-direct.substratesystems.io:443/api/exomem/mcp/v1",
      },
      {
        EXOMEM_HOSTED_INGRESS_PROFILE: "direct-v1",
        EXOMEM_HOSTED_DIRECT_RESOURCE: "https://127.0.0.1/api/exomem/mcp/v1",
      },
      {
        EXOMEM_HOSTED_INGRESS_PROFILE: "other",
        EXOMEM_HOSTED_DIRECT_RESOURCE: DIRECT_V1_RESOURCE,
      },
    ]) {
      assert.throws(
        () => resolveHostedIngress(environment, "https://hosted.example.test"),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "HOSTED_INGRESS_INVALID"
      );
    }
  });
});
