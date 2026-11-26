import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ExomemCloudConfigurationError, loadCloudCellImageRepositories } from "../cloud-config";
import { assertValidCloudCellImage, InvalidCloudCellImageError } from "../cloud-release";

const CURRENT = "registry.example.test/new-name";
const PREVIOUS = "registry.example.test/old-name";
const DIGEST = `@sha256:${"a".repeat(64)}`;

function accepts(image: string, env: Record<string, string>): boolean {
  try {
    assertValidCloudCellImage(image, {
      loadRepositories: () => loadCloudCellImageRepositories(env),
    });
    return true;
  } catch (error) {
    if (error instanceof InvalidCloudCellImageError) return false;
    throw error;
  }
}

// Catches a release refused after the image repository moves, which stops
// every rollout, and a rollback to a release published under the old name.
describe("Cloud cell image repository", () => {
  it("accepts the current repository and, once configured, the previous one", () => {
    const env = {
      EXOMEM_CLOUD_CELL_IMAGE_REPOSITORY: CURRENT,
      EXOMEM_CLOUD_CELL_IMAGE_REPOSITORY_PREVIOUS: PREVIOUS,
    };
    assert.equal(accepts(`${CURRENT}${DIGEST}`, env), true);
    assert.equal(accepts(`${PREVIOUS}${DIGEST}`, env), true);
    assert.equal(accepts(`registry.example.test/other${DIGEST}`, env), false);
  });

  it("accepts only the current repository while no previous one is set", () => {
    const env = { EXOMEM_CLOUD_CELL_IMAGE_REPOSITORY: CURRENT };
    assert.equal(accepts(`${CURRENT}${DIGEST}`, env), true);
    assert.equal(accepts(`${PREVIOUS}${DIGEST}`, env), false);
  });

  it("refuses a malformed repository instead of silently refusing every image", () => {
    for (const malformed of [
      "Registry.Example.Test/Old-Name",
      "registry.example.test/old-name:v1",
    ]) {
      assert.throws(
        () =>
          loadCloudCellImageRepositories({
            EXOMEM_CLOUD_CELL_IMAGE_REPOSITORY: CURRENT,
            EXOMEM_CLOUD_CELL_IMAGE_REPOSITORY_PREVIOUS: malformed,
          }),
        ExomemCloudConfigurationError
      );
      assert.throws(
        () => loadCloudCellImageRepositories({ EXOMEM_CLOUD_CELL_IMAGE_REPOSITORY: malformed }),
        ExomemCloudConfigurationError
      );
    }
    assert.deepEqual(
      loadCloudCellImageRepositories({
        EXOMEM_CLOUD_CELL_IMAGE_REPOSITORY: CURRENT,
        EXOMEM_CLOUD_CELL_IMAGE_REPOSITORY_PREVIOUS: "registry.example.test:5000/old_name",
      }),
      [CURRENT, "registry.example.test:5000/old_name"]
    );
  });
});
