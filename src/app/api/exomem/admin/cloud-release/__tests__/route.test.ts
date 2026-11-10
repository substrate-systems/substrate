import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";

// Task 3.8: owner-only release route (design D5). Authorization behaviour
// (owner vs. non-owner) is exercised here against the real
// `requireRateLimitedExomemOperator` path, exactly as fleet/__tests__/route
// .test.ts does for the read-only fleet route; the underlying store module
// (cloud-release.ts) is mocked so this stays a route/auth test, not a
// second copy of the Postgres-backed coverage that module needs on its own.

const ADMIN_TOKEN = Buffer.alloc(32, 0x51).toString("base64url");
const DEPLOY_TOKEN = Buffer.alloc(32, 0x52).toString("base64url");

// Security review finding 10: cell_image/desired_image fixtures are the
// <configured repository>@sha256:<64 lowercase hex> shape the real
// cloud-release.ts now enforces -- this file mocks that module, so nothing
// here re-validates, but the fixtures still matter: a stale tag-based
// fixture would stop being representative of what the route actually sees.
const CELL_REPOSITORY = "registry.example.test/exomem-cell";
function digestImage(fill: string): string {
  return `${CELL_REPOSITORY}@sha256:${fill.repeat(64).slice(0, 64)}`;
}
const IMAGE_V0 = digestImage("0");
const IMAGE_V1 = digestImage("1");
const IMAGE_V2 = digestImage("2");
const IMAGE_CANARY = digestImage("c");

const view = {
  cellImage: IMAGE_V1,
  rollout: {
    paused: false,
    errorCode: null,
    heldCellId: null,
    lastGoodImage: IMAGE_V0,
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
  cells: [],
  capacity: [],
};

const rolloutView = {
  cell_image: IMAGE_V1,
  release: "v1.0.0",
  paused: false,
  error_code: null,
  canary_on_target: true,
  cells: { on_target: 1, behind_target: 0, held: 0 },
};

let setCloudReleaseImageCalls: string[] = [];
let clearPausedCloudRolloutCalls = 0;
let setCloudCellDesiredImageCalls: Array<{ cellId: string; image: string | null }> = [];
let principals: string[] = [];
let releaseRefusal: "seen" | "older" | null = null;

const MISSING_CELL_ID = "zzzzzzzzzzzzzzzz";

class MockCloudReleaseCellNotFoundError extends Error {
  constructor() {
    super("cell not found");
    this.name = "CloudReleaseCellNotFoundError";
  }
}

class MockInvalidCloudCellImageError extends Error {
  constructor(readonly image: string) {
    super("invalid cell image");
    this.name = "InvalidCloudCellImageError";
  }
}

class MockInvalidCloudReleaseTagError extends Error {}

class MockCloudImageSeenError extends Error {
  readonly code = "CELL_IMAGE_SEEN";
}

class MockCloudReleaseOlderError extends Error {
  readonly code = "CELL_RELEASE_OLDER";
}

before(() => {
  process.env.EXOMEM_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.EXOMEM_DEPLOY_TOKEN = DEPLOY_TOKEN;
  mock.module("@/lib/exomem-hosted/cloud-release", {
    namedExports: {
      getCloudOperatorView: async () => view,
      getCloudRolloutView: async () => rolloutView,
      // Mirrors the real assertValidCloudCellImage just enough for the
      // "invalid image becomes a 400" test below to exercise the route's
      // actual error-mapping branch, not a route-side re-implementation.
      // Mirrors the real applyCloudReleaseChanges: every image is validated
      // before any change is recorded, so a partly invalid request records
      // nothing -- the route's own error mapping is what is under test.
      applyCloudReleaseChanges: async (
        changes: {
          cellImage?: string;
          release?: string;
          clearRolloutPause?: true;
          cellDesiredImage?: { cellId: string; image: string | null };
        },
        principal: string
      ) => {
        principals.push(principal);
        if (releaseRefusal === "seen") throw new MockCloudImageSeenError("seen");
        if (releaseRefusal === "older") throw new MockCloudReleaseOlderError("older");
        const prefix = `${CELL_REPOSITORY}@sha256:`;
        for (const image of [changes.cellImage, changes.cellDesiredImage?.image]) {
          if (image === undefined || image === null) continue;
          if (!image.startsWith(prefix) || !/^[0-9a-f]{64}$/.test(image.slice(prefix.length))) {
            throw new MockInvalidCloudCellImageError(image);
          }
        }
        if (changes.cellDesiredImage?.cellId === MISSING_CELL_ID) {
          throw new MockCloudReleaseCellNotFoundError();
        }
        if (changes.cellImage !== undefined) setCloudReleaseImageCalls.push(changes.cellImage);
        if (changes.clearRolloutPause) clearPausedCloudRolloutCalls += 1;
        if (changes.cellDesiredImage) setCloudCellDesiredImageCalls.push(changes.cellDesiredImage);
      },
      InvalidCloudCellImageError: MockInvalidCloudCellImageError,
      InvalidCloudReleaseTagError: MockInvalidCloudReleaseTagError,
      CloudImageSeenError: MockCloudImageSeenError,
      CloudReleaseOlderError: MockCloudReleaseOlderError,
      CloudReleaseCellNotFoundError: MockCloudReleaseCellNotFoundError,
    },
  });
  mock.module("@/lib/exomem-hosted/rate-limit", {
    namedExports: {
      EXOMEM_RATE_LIMITS: {
        adminPreAuthReadIp: { scope: "read-ip", limit: 1, windowSeconds: 60 },
        adminPreAuthMutationIp: { scope: "mutation-ip", limit: 1, windowSeconds: 60 },
        adminAuthenticatedRead: { scope: "read", limit: 1, windowSeconds: 60 },
        adminAuthenticatedMutation: { scope: "mutation", limit: 1, windowSeconds: 60 },
      },
      clientAddressKey: () => "test-ip",
      takeExomemRateLimit: async () => true,
    },
  });
});

after(() => {
  delete process.env.EXOMEM_ADMIN_TOKEN;
  delete process.env.EXOMEM_DEPLOY_TOKEN;
  mock.reset();
});

function getRequest(authorization?: string, path = "") {
  return new Request(`https://substratesystems.io/api/exomem/admin/cloud-release${path}`, {
    headers: authorization ? { authorization } : {},
  }) as unknown as import("next/server").NextRequest;
}

function putRequest(authorization: string | undefined, body: unknown) {
  return new Request("https://substratesystems.io/api/exomem/admin/cloud-release", {
    method: "PUT",
    headers: {
      ...(authorization ? { authorization } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

describe("Exomem Cloud owner release route", () => {
  it("refuses an unauthenticated read", async () => {
    const { GET } = await import("../route");
    assert.equal((await GET(getRequest())).status, 401);
  });

  it("refuses a non-owner bearer token", async () => {
    const { GET } = await import("../route");
    assert.equal((await GET(getRequest("Bearer not-the-admin-token"))).status, 401);
  });

  it("refuses an unauthenticated mutation without applying it", async () => {
    setCloudReleaseImageCalls = [];
    const { PUT } = await import("../route");
    const response = await PUT(putRequest(undefined, { cellImage: IMAGE_V2 }));
    assert.equal(response.status, 401);
    assert.deepEqual(setCloudReleaseImageCalls, []);
  });

  it("refuses a non-owner mutation without applying it", async () => {
    setCloudReleaseImageCalls = [];
    const { PUT } = await import("../route");
    const response = await PUT(putRequest("Bearer not-the-admin-token", { cellImage: IMAGE_V2 }));
    assert.equal(response.status, 401);
    assert.deepEqual(setCloudReleaseImageCalls, []);
  });

  it("returns the operator view for the owner", async () => {
    const { GET } = await import("../route");
    const response = await GET(getRequest(`Bearer ${ADMIN_TOKEN}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.deepEqual(body.view, view);
  });

  it("sets the fleet release image for the owner", async () => {
    setCloudReleaseImageCalls = [];
    const { PUT } = await import("../route");
    const response = await PUT(putRequest(`Bearer ${ADMIN_TOKEN}`, { cellImage: IMAGE_V2 }));
    assert.equal(response.status, 200);
    assert.deepEqual(setCloudReleaseImageCalls, [IMAGE_V2]);
  });

  // Security review finding 10: the route maps the underlying module's
  // InvalidCloudCellImageError to a 400 invalid_request, not a 500 internal
  // error, and applies nothing.
  it("rejects a tag-based cellImage as a 400, applying nothing", async () => {
    setCloudReleaseImageCalls = [];
    const { PUT } = await import("../route");
    const response = await PUT(
      putRequest(`Bearer ${ADMIN_TOKEN}`, { cellImage: "registry.example.test/exomem-cell:v2" })
    );
    assert.equal(response.status, 400);
    assert.deepEqual(setCloudReleaseImageCalls, []);
  });

  it("clears a paused rollout for the owner", async () => {
    clearPausedCloudRolloutCalls = 0;
    const { PUT } = await import("../route");
    const response = await PUT(putRequest(`Bearer ${ADMIN_TOKEN}`, { clearRolloutPause: true }));
    assert.equal(response.status, 200);
    assert.equal(clearPausedCloudRolloutCalls, 1);
  });

  it("sets a cell's desired_image override for the owner", async () => {
    setCloudCellDesiredImageCalls = [];
    const { PUT } = await import("../route");
    const response = await PUT(
      putRequest(`Bearer ${ADMIN_TOKEN}`, {
        cellId: "abcdefghijklmnop",
        cellDesiredImage: IMAGE_CANARY,
      })
    );
    assert.equal(response.status, 200);
    assert.deepEqual(setCloudCellDesiredImageCalls, [
      { cellId: "abcdefghijklmnop", image: IMAGE_CANARY },
    ]);
  });

  it("clears a cell's desired_image override when cellDesiredImage is null", async () => {
    setCloudCellDesiredImageCalls = [];
    const { PUT } = await import("../route");
    const response = await PUT(
      putRequest(`Bearer ${ADMIN_TOKEN}`, { cellId: "abcdefghijklmnop", cellDesiredImage: null })
    );
    assert.equal(response.status, 200);
    assert.deepEqual(setCloudCellDesiredImageCalls, [{ cellId: "abcdefghijklmnop", image: null }]);
  });

  it("applies nothing from a mixed request whose cell override is invalid", async () => {
    setCloudReleaseImageCalls = [];
    clearPausedCloudRolloutCalls = 0;
    setCloudCellDesiredImageCalls = [];
    const { PUT } = await import("../route");
    for (const body of [
      { cellImage: IMAGE_V2, clearRolloutPause: true, cellId: "abcdefghijklmnop", cellDesiredImage: "x:tag" },
      { cellImage: IMAGE_V2, cellId: MISSING_CELL_ID, cellDesiredImage: null },
      { cellImage: IMAGE_V2, clearRolloutPause: "yes" },
    ]) {
      const response = await PUT(putRequest(`Bearer ${ADMIN_TOKEN}`, body));
      assert.equal(response.status, 400);
    }
    assert.deepEqual(setCloudReleaseImageCalls, []);
    assert.equal(clearPausedCloudRolloutCalls, 0);
    assert.deepEqual(setCloudCellDesiredImageCalls, []);
  });

  it("rejects an empty mutation body", async () => {
    const { PUT } = await import("../route");
    const response = await PUT(putRequest(`Bearer ${ADMIN_TOKEN}`, {}));
    assert.equal(response.status, 400);
  });
  // automate-cloud-releases D1: the deploy token sets the release image with
  // its tag and reads the bounded rollout view, and nothing else.
  describe("deploy token", () => {
    const deploy = `Bearer ${DEPLOY_TOKEN}`;

    function resetCalls() {
      setCloudReleaseImageCalls = [];
      clearPausedCloudRolloutCalls = 0;
      setCloudCellDesiredImageCalls = [];
      principals = [];
      releaseRefusal = null;
    }

    it("sets the release image with its tag, and answers with the rollout view only", async () => {
      resetCalls();
      const { PUT } = await import("../route");
      const response = await PUT(putRequest(deploy, { cellImage: IMAGE_V2, release: "v2.0.0" }));
      assert.equal(response.status, 200);
      assert.deepEqual(setCloudReleaseImageCalls, [IMAGE_V2]);
      assert.deepEqual(principals, ["deploy"]);
      assert.deepEqual((await response.json()).view, rolloutView);
    });

    it("cannot clear a rollout pause", async () => {
      resetCalls();
      const { PUT } = await import("../route");
      for (const body of [
        { clearRolloutPause: true },
        { cellImage: IMAGE_V2, release: "v2.0.0", clearRolloutPause: true },
      ]) {
        const response = await PUT(putRequest(deploy, body));
        assert.equal(response.status, 403);
        assert.equal((await response.json()).error.code, "OPERATOR_SCOPE_DENIED");
      }
      assert.equal(clearPausedCloudRolloutCalls, 0);
      assert.deepEqual(principals, []);
    });

    it("cannot set one cell's image", async () => {
      resetCalls();
      const { PUT } = await import("../route");
      const response = await PUT(
        putRequest(deploy, { cellId: "abcdefghijklmnop", cellDesiredImage: IMAGE_CANARY })
      );
      assert.equal(response.status, 403);
      assert.deepEqual(setCloudCellDesiredImageCalls, []);
      assert.deepEqual(principals, []);
    });

    it("cannot set the release image without its tag", async () => {
      resetCalls();
      const { PUT } = await import("../route");
      const response = await PUT(putRequest(deploy, { cellImage: IMAGE_V2 }));
      assert.equal(response.status, 403);
      assert.deepEqual(setCloudReleaseImageCalls, []);
    });

    it("cannot read the full release view, which names every cell and tenant", async () => {
      const { GET } = await import("../route");
      const response = await GET(getRequest(deploy));
      assert.equal(response.status, 401);
      assert.equal((await response.json()).view, undefined);
    });

    it("reads the rollout view, as the admin token does", async () => {
      const { GET } = await import("../rollout/route");
      for (const token of [DEPLOY_TOKEN, ADMIN_TOKEN]) {
        const response = await GET(getRequest(`Bearer ${token}`, "/rollout"));
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).view, rolloutView);
      }
      assert.equal((await GET(getRequest("Bearer not-a-token", "/rollout"))).status, 401);
    });

    it("answers a refused image with the history's code and 409", async () => {
      const { PUT } = await import("../route");
      for (const [refusal, code] of [
        ["seen", "CELL_IMAGE_SEEN"],
        ["older", "CELL_RELEASE_OLDER"],
      ] as const) {
        resetCalls();
        releaseRefusal = refusal;
        const response = await PUT(putRequest(deploy, { cellImage: IMAGE_V2, release: "v2.0.0" }));
        assert.equal(response.status, 409);
        assert.equal((await response.json()).error.code, code);
      }
      releaseRefusal = null;
    });
  });
});
