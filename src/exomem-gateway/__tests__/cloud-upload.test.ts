import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import { jwtVerify } from "jose";
import { deriveCloudCellBearer } from "../../lib/exomem-hosted/cloud-cell-bearer";
import {
  loadExomemCloudConfig,
  type ExomemCloudConfig,
} from "../../lib/exomem-hosted/cloud-config";
import type { ActiveCloudOAuthLogin } from "../../lib/exomem-hosted/cloud-oauth";
import {
  handleCloudMcpRequest,
  handleCloudUploadRequest,
  resetCloudGatewayConcurrencyForTests,
  type CloudGatewayDependencies,
} from "../cloud-handler";
import { signCloudUploadRoute } from "../cloud-origin";

// bridge-cloud-agent-uploads: the gateway half of the Cloud upload handoff.
// The cell half, and the two together, are proved in the Exomem repository
// and in the sandbox workflow.

const CELL = "aaaaaaaaaaaaaaaa";
const RESOURCE = "https://cloud.example.test/mcp/v1";
const CELL_TOKEN_KEY = Buffer.alloc(32, 7);
const NONCE = "ab".repeat(32);
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const CONFIG: ExomemCloudConfig = {
  mcpUrl: RESOURCE,
  mcpPath: "/api/exomem/cloud/mcp/v1",
  cellTokenKey: CELL_TOKEN_KEY,
  artifactSigningKey: privateKey,
  uploadCells: new Set([CELL]),
};
const LOGIN: ActiveCloudOAuthLogin = {
  familyId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  grantId: "1d4f6a2e-5b3c-4e7d-8f9a-0b1c2d3e4f5a",
  userId: "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a",
  tenantId: "6f1c1b7e-2a4b-4c55-9d8e-0a1b2c3d4e5f",
  clientId: "https://client.example.test/oauth/metadata.json",
  resource: RESOURCE,
  cellId: CELL,
  cellDesiredState: "running",
  client: {
    clientName: null,
    admissionMode: "cimd",
    platform: "claude",
    redirectUris: ["https://client.example.test/callback"],
  },
  firstParty: false,
};

async function handoffToken(login = LOGIN, key = privateKey): Promise<string> {
  const capsule = await signCloudUploadRoute(login, key);
  return `exomem-cloud-upload:v1:${Buffer.from(capsule, "ascii").toString("hex")}:${NONCE}`;
}

/** An upload whose body records whether anything pulled it. */
function uploadRequest(token: string): { request: Request; bodyRead: () => boolean } {
  let pulled = false;
  // No queue to fill, so only a reader triggers pull.
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled = true;
        controller.enqueue(new TextEncoder().encode("--x\r\n...original bytes...\r\n--x--\r\n"));
        controller.close();
      },
    },
    { highWaterMark: 0 }
  );
  const request = new Request("http://gateway.invalid/upload", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "multipart/form-data; boundary=x",
    },
    body,
    duplex: "half",
  } as RequestInit);
  return { request, bodyRead: () => pulled };
}

function deps(overrides: Partial<CloudGatewayDependencies> = {}): CloudGatewayDependencies {
  return {
    config: CONFIG,
    findLogin: async () => LOGIN,
    takeRateLimit: async () => true,
    fetchCell: async () => assert.fail("the cell was contacted"),
    ...overrides,
  };
}

describe("Cloud upload handoff at the gateway", () => {
  beforeEach(() => resetCloudGatewayConcurrencyForTests());

  it("gives a selected cell this login's origin and route capsule, and an unselected cell neither", async () => {
    const forwarded: Headers[] = [];
    const proxy = (config: ExomemCloudConfig) =>
      handleCloudMcpRequest(
        new Request("http://gateway.invalid/api/exomem/cloud/mcp/v1", {
          method: "POST",
          headers: { authorization: `Bearer ${"a".repeat(43)}` },
          body: "{}",
        }),
        {
          config,
          findAccessToken: async () => ({ ...LOGIN, scopes: ["exomem.read", "exomem.write"] }),
          recordAppUse: async () => undefined,
          takeRateLimit: async () => true,
          fetchCell: async (_url, init) => {
            forwarded.push(new Headers(init?.headers));
            return new Response("ok");
          },
        }
      );
    await proxy(CONFIG);
    await proxy({ ...CONFIG, uploadCells: new Set(["bbbbbbbbbbbbbbbb"]) });
    const [selected, unselected] = forwarded;

    const origin = await jwtVerify(selected!.get("x-exomem-cloud-origin")!, publicKey, {
      issuer: RESOURCE,
      audience: "exomem-cloud-origin",
    });
    assert.deepEqual(
      [origin.payload.tenant_id, origin.payload.cell_id, origin.payload.client_id],
      [LOGIN.tenantId, CELL, LOGIN.clientId]
    );
    assert.deepEqual(
      [origin.payload.grant_id, origin.payload.family_id, origin.payload.purpose],
      [LOGIN.grantId, LOGIN.familyId, "mcp"]
    );
    const route = await jwtVerify(selected!.get("x-exomem-cloud-upload-route")!, publicKey, {
      issuer: RESOURCE,
      audience: "exomem-cloud-upload-route",
    });
    assert.equal(route.payload.upload_url, "https://cloud.example.test/upload");
    assert.equal(route.payload.family_id, LOGIN.familyId);
    assert.ok(route.payload.exp! - route.payload.iat! <= 900);
    // A route capsule never verifies as origin, so a leaked handoff cannot impersonate a request.
    await assert.rejects(
      jwtVerify(selected!.get("x-exomem-cloud-upload-route")!, publicKey, {
        audience: "exomem-cloud-origin",
      })
    );
    assert.equal(unselected!.get("x-exomem-cloud-origin"), null);
    assert.equal(unselected!.get("x-exomem-cloud-upload-route"), null);
  });

  it("refuses an identity too long for the agent's handoff instead of truncating it", async () => {
    await assert.rejects(
      signCloudUploadRoute({ ...LOGIN, clientId: "x".repeat(4096) }, privateKey)
    );
  });

  it("refuses before reading the body or contacting a cell when the handoff's login is not current", async () => {
    const { privateKey: otherKey } = generateKeyPairSync("ed25519");
    const cases: Array<[string, () => Promise<string>, Partial<CloudGatewayDependencies>, number]> =
      [
        ["revoked or blocked login", () => handoffToken(), { findLogin: async () => null }, 401],
        [
          "another tenant's login",
          () => handoffToken(),
          {
            findLogin: async () => ({ ...LOGIN, tenantId: "7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d" }),
          },
          401,
        ],
        [
          "a moved cell",
          () => handoffToken(),
          { findLogin: async () => ({ ...LOGIN, cellId: "bbbbbbbbbbbbbbbb" }) },
          401,
        ],
        [
          "a deselected cell",
          () => handoffToken(),
          { config: { ...CONFIG, uploadCells: new Set(["bbbbbbbbbbbbbbbb"]) } },
          401,
        ],
        ["a capsule from another signer", () => handoffToken(LOGIN, otherKey), {}, 401],
        [
          "an altered capsule encoding",
          async () =>
            (await handoffToken()).replace(
              /:([0-9a-f]+):/,
              (_m, hex: string) => `:${hex.toUpperCase()}:`
            ),
          {},
          401,
        ],
        [
          "a stopped cell",
          () => handoffToken(),
          { findLogin: async () => ({ ...LOGIN, cellDesiredState: "stopped" }) },
          503,
        ],
        [
          "a read-only cell",
          () => handoffToken(),
          { findLogin: async () => ({ ...LOGIN, cellDesiredState: "read_only" }) },
          503,
        ],
      ];
    for (const [name, token, overrides, status] of cases) {
      const { request, bodyRead } = uploadRequest(await token());
      const response = await handleCloudUploadRequest(request, deps(overrides));
      assert.equal(response.status, status, name);
      assert.equal(bodyRead(), false, name);
    }
  });

  it("streams the body to the cell's fixed receiver with fresh origin bound to the exact ticket", async () => {
    const held = { state: "held", file: { download_url: "exomem-held:synthetic" } };
    let url = "";
    let headers = new Headers();
    let body = "";
    const { request } = uploadRequest(await handoffToken());
    const response = await handleCloudUploadRequest(
      request,
      deps({
        fetchCell: async (input, init) => {
          url = String(input);
          headers = new Headers(init?.headers);
          body = await new Response(init?.body).text();
          return Response.json(held, { status: 201 });
        },
      })
    );
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), held);
    assert.equal(url, `http://cell.exo-cell-${CELL}.svc.cluster.local:8765/upload`);
    assert.equal(
      headers.get("authorization"),
      `Bearer ${deriveCloudCellBearer(CELL_TOKEN_KEY, CELL)}`
    );
    assert.equal(headers.get("x-exomem-cloud-upload-ticket"), `exomem-upload:${NONCE}`);
    assert.equal(headers.get("content-type"), "multipart/form-data; boundary=x");
    assert.equal(body, "--x\r\n...original bytes...\r\n--x--\r\n");
    const proof = await jwtVerify(headers.get("x-exomem-cloud-origin")!, publicKey, {
      issuer: RESOURCE,
      audience: "exomem-cloud-origin",
    });
    assert.equal(proof.payload.purpose, "upload");
    assert.equal(
      proof.payload.ticket_sha256,
      createHash("sha256").update(`exomem-upload:${NONCE}`).digest("hex")
    );
    assert.ok(proof.payload.exp! - proof.payload.iat! <= 60);
  });

  it("withholds the held handle when the login is revoked while the bytes stream", async () => {
    let lookups = 0;
    const { request } = uploadRequest(await handoffToken());
    const response = await handleCloudUploadRequest(
      request,
      deps({
        findLogin: async () => (lookups++ === 0 ? LOGIN : null),
        fetchCell: async (_input, init) => {
          await new Response(init?.body).arrayBuffer();
          return Response.json(
            { state: "held", file: { download_url: "exomem-held:x" } },
            { status: 201 }
          );
        },
      })
    );
    assert.equal(response.status, 401);
    assert.equal(JSON.stringify(await response.json()).includes("exomem-held"), false);
  });

  it("relays the cell's ticket refusal but reports its bearer refusal as a gateway fault", async () => {
    const answers: Array<[object, number]> = [
      [{ code: "UPLOAD_HANDOFF_UNAVAILABLE", reason: "no usable upload handoff" }, 401],
      [{ code: "UNAUTHORIZED", reason: "missing or invalid cell credential" }, 502],
    ];
    for (const [answer, status] of answers) {
      const { request } = uploadRequest(await handoffToken());
      const response = await handleCloudUploadRequest(
        request,
        deps({ fetchCell: async () => Response.json(answer, { status: 401 }) })
      );
      assert.equal(response.status, status);
    }
  });

  it("does not exist until a cell is selected", async () => {
    const { request, bodyRead } = uploadRequest(await handoffToken());
    const response = await handleCloudUploadRequest(
      request,
      deps({ config: { ...CONFIG, uploadCells: undefined } })
    );
    assert.equal(response.status, 404);
    assert.equal(bodyRead(), false);
  });

  it("selects upload cells and artifact cells independently", () => {
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const env = {
      EXOMEM_CLOUD_MCP_URL: RESOURCE,
      EXOMEM_CLOUD_MCP_PATH: CONFIG.mcpPath,
      EXOMEM_CLOUD_CELL_TOKEN_KEY: CELL_TOKEN_KEY.toString("hex"),
      EXOMEM_CLOUD_ARTIFACT_SIGNING_KEY: pem,
    };
    const transport = loadExomemCloudConfig({
      ...env,
      EXOMEM_CLOUD_ARTIFACT_TRANSPORT_ENABLED: "true",
      EXOMEM_CLOUD_ARTIFACT_CELL_IDS: JSON.stringify([CELL]),
      EXOMEM_CLOUD_UPLOAD_CELL_IDS: JSON.stringify([CELL]),
    });
    assert.equal(
      transport.uploadCells,
      undefined,
      "artifact transport alone never enables uploads"
    );
    const uploads = loadExomemCloudConfig({
      ...env,
      EXOMEM_CLOUD_UPLOAD_ENABLED: "true",
      EXOMEM_CLOUD_UPLOAD_CELL_IDS: JSON.stringify([CELL]),
    });
    assert.equal(uploads.uploadCells?.has(CELL), true);
    assert.equal(uploads.artifactCells, undefined);
    assert.throws(
      () => loadExomemCloudConfig({ ...env, EXOMEM_CLOUD_UPLOAD_ENABLED: "true" }),
      /EXOMEM_CLOUD_UPLOAD_CELL_IDS/
    );
  });
});
