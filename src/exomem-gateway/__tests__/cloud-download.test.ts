import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { connect } from "node:net";
import { beforeEach, describe, it } from "node:test";
import { jwtVerify } from "jose";
import { deriveCloudCellBearer } from "../../lib/exomem-hosted/cloud-cell-bearer";
import type { ExomemCloudConfig } from "../../lib/exomem-hosted/cloud-config";
import type { ActiveCloudOAuthAccessToken } from "../../lib/exomem-hosted/cloud-oauth";
import {
  signDownloadTicket,
  DOWNLOAD_TICKET_MAX_LIFETIME_SECONDS,
} from "../../lib/exomem-hosted/cloud-download-ticket";
import {
  handleCloudDownloadRequest,
  handleCloudMcpRequest,
  handleCloudUploadRequest,
  resetCloudGatewayConcurrencyForTests,
  type CloudGatewayDependencies,
} from "../cloud-handler";
import { createGatewayServer } from "../server";
import { testUpstream } from "./upstream-fixture";

// add-cloud-media-store: the gateway half of the exact-original download.
// The cell half is proved in the Exomem repository.

const CELL = "aaaaaaaaaaaaaaaa";
const RESOURCE = "https://cloud.example.test/mcp/v1";
const CELL_TOKEN_KEY = Buffer.alloc(32, 7);
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const CONFIG: ExomemCloudConfig = {
  mcpUrl: RESOURCE,
  acceptedResources: [RESOURCE],
  mcpPath: "/api/exomem/cloud/mcp/v1",
  cellTokenKey: CELL_TOKEN_KEY,
  artifactSigningKey: privateKey,
  uploadCells: new Set([CELL]),
};
const ACCESS: ActiveCloudOAuthAccessToken = {
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
    cimdHost: "claude.ai",
    clientContext: "conversation",
    redirectUris: ["https://client.example.test/callback"],
  },
  firstParty: false,
  scopes: ["exomem.read", "exomem.write"],
};
const PATH = "Knowledge Base/Sources/café report.pdf";

function downloadRequest(
  headers: Record<string, string> = { authorization: `Bearer ${"a".repeat(43)}` },
  path = PATH
): Request {
  return new Request(`http://gateway.invalid/download?path=${encodeURIComponent(path)}`, {
    headers,
  });
}

function deps(overrides: Partial<CloudGatewayDependencies> = {}): CloudGatewayDependencies {
  return {
    upstream: testUpstream(),
    config: CONFIG,
    findAccessToken: async () => ACCESS,
    findLogin: async () => ACCESS,
    takeRateLimit: async () => true,
    fetchCell: async () => assert.fail("the cell was contacted"),
    ...overrides,
  };
}

describe("Cloud exact-original download at the gateway", () => {
  beforeEach(() => resetCloudGatewayConcurrencyForTests());

  it("answers 401 without contacting the cell when the token is missing, unknown, revoked or expired", async () => {
    // The token lookup returns null for an unknown, revoked or expired token alike.
    const cases: Array<[string, Record<string, string>]> = [
      ["no token", {}],
      ["a malformed header", { authorization: "Basic abc" }],
      ["a bad, revoked or expired token", { authorization: `Bearer ${"b".repeat(43)}` }],
    ];
    for (const [name, headers] of cases) {
      const response = await handleCloudDownloadRequest(
        downloadRequest(headers),
        deps({ findAccessToken: async () => null })
      );
      assert.equal(response.status, 401, name);
      assert.match(response.headers.get("www-authenticate") ?? "", /^Bearer /, name);
    }
  });

  it("refuses an `exs_` bearer outright — the download route is OAuth-only (review B4)", async () => {
    // Before the shared admission helper, this route never learned the prefix
    // dispatch: an OAuth token whose bytes collided with `exs_` — or a service
    // secret — could reach a cell here. Neither lookup may even be asked now.
    const response = await handleCloudDownloadRequest(
      downloadRequest({ authorization: `Bearer exs_${"b".repeat(43)}` }),
      deps({
        findAccessToken: async () => assert.fail("the OAuth lookup never sees an `exs_` bearer"),
        findServiceCredential: async () =>
          assert.fail("the download route never resolves a service credential"),
      })
    );
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "ACCESS_TOKEN_INVALID" });
  });

  it("answers 401 without contacting the cell when the login was revoked since the token was issued", async () => {
    const response = await handleCloudDownloadRequest(
      downloadRequest(),
      deps({ findLogin: async () => null })
    );
    assert.equal(response.status, 401);
  });

  it("forwards with a fresh download proof bound to the path and no caller credential", async () => {
    let url = "";
    let headers = new Headers();
    const response = await handleCloudDownloadRequest(
      downloadRequest({ authorization: `Bearer ${"a".repeat(43)}`, cookie: "session=1" }),
      deps({
        fetchCell: async (input, init) => {
          url = String(input);
          headers = new Headers(init?.headers);
          return new Response("original", { status: 200 });
        },
      })
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "original");
    assert.equal(
      url.startsWith(`http://cell.exo-cell-${CELL}.svc.cluster.local:8765/download?`),
      true
    );
    assert.equal(new URL(url).searchParams.get("path"), PATH);
    assert.equal(
      headers.get("authorization"),
      `Bearer ${deriveCloudCellBearer(CELL_TOKEN_KEY, CELL)}`
    );
    assert.equal(headers.get("cookie"), null);
    const proof = await jwtVerify(headers.get("x-exomem-cloud-origin")!, publicKey, {
      issuer: RESOURCE,
      audience: "exomem-cloud-origin",
    });
    assert.equal(proof.payload.purpose, "download");
    assert.equal(
      proof.payload.target_sha256,
      createHash("sha256").update(PATH, "utf8").digest("hex")
    );
    assert.equal(proof.payload.cell_id, CELL);
    assert.ok(proof.payload.exp! - proof.payload.iat! <= 60);
  });

  it("passes Range through and relays the 206 with its headers, dropping the cell's others", async () => {
    let range: string | null = null;
    const response = await handleCloudDownloadRequest(
      downloadRequest({ authorization: `Bearer ${"a".repeat(43)}`, range: "bytes=2-5" }),
      deps({
        fetchCell: async (_input, init) => {
          range = new Headers(init?.headers).get("range");
          return new Response("cdef", {
            status: 206,
            headers: {
              "content-length": "4",
              "content-range": "bytes 2-5/10",
              "accept-ranges": "bytes",
              "content-type": "application/pdf",
              "content-disposition": 'attachment; filename="report.pdf"',
              "x-exomem-sha256": "ab".repeat(32),
              "x-exomem-size": "10",
              "cache-control": "public, max-age=999",
              "set-cookie": "cell=1",
            },
          });
        },
      })
    );
    assert.equal(range, "bytes=2-5");
    assert.equal(response.status, 206);
    assert.equal(await response.text(), "cdef");
    assert.equal(response.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.equal(response.headers.get("content-disposition"), 'attachment; filename="report.pdf"');
    assert.equal(response.headers.get("x-exomem-sha256"), "ab".repeat(32));
    assert.equal(response.headers.get("x-exomem-size"), "10");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("set-cookie"), null);
  });

  it("does not follow a redirect from the cell", async () => {
    let calls = 0;
    let redirect: RequestRedirect | undefined;
    const response = await handleCloudDownloadRequest(
      downloadRequest(),
      deps({
        fetchCell: async (_input, init) => {
          calls += 1;
          redirect = init?.redirect;
          return new Response(null, { status: 302, headers: { location: "https://evil.test/x" } });
        },
      })
    );
    assert.equal(calls, 1);
    assert.equal(redirect, "manual");
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("location"), null);
  });

  it("reports the cell's bearer or proof refusal as a gateway fault, not as the caller's token", async () => {
    const response = await handleCloudDownloadRequest(
      downloadRequest(),
      deps({
        fetchCell: async () => Response.json({ code: "DOWNLOAD_UNAVAILABLE" }, { status: 401 }),
      })
    );
    assert.equal(response.status, 502);
  });

  it("does not exist until a cell is selected, and refuses a cell that is not", async () => {
    const unselected = await handleCloudDownloadRequest(
      downloadRequest(),
      deps({ config: { ...CONFIG, uploadCells: undefined } })
    );
    assert.equal(unselected.status, 404);
    const other = await handleCloudDownloadRequest(
      downloadRequest(),
      deps({ config: { ...CONFIG, uploadCells: new Set(["bbbbbbbbbbbbbbbb"]) } })
    );
    assert.equal(other.status, 404);
  });

  it("destroys a download whose reader stops reading and returns its slots", async () => {
    const previousPath = process.env.EXOMEM_CLOUD_MCP_PATH;
    process.env.EXOMEM_CLOUD_MCP_PATH = "/mcp";
    const server = createGatewayServer({
      downloadIdleMs: 150,
      handleCloudDownload: (request) =>
        handleCloudDownloadRequest(
          request,
          deps({
            // An endless original: only backpressure from the client stops it.
            fetchCell: async () =>
              new Response(
                new ReadableStream({
                  pull: (controller) => controller.enqueue(new Uint8Array(64 * 1024)),
                })
              ),
          })
        ),
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const open = async () => {
      const socket = connect(address.port, "127.0.0.1");
      await once(socket, "connect");
      socket.write(
        `GET /download?path=${encodeURIComponent(PATH)} HTTP/1.1\r\nhost: gateway.invalid\r\nauthorization: Bearer ${"a".repeat(43)}\r\n\r\n`
      );
      // The reader never reads past the first chunk, so the stream stalls on backpressure.
      socket.pause();
      return socket;
    };
    const sockets = [];
    try {
      for (let index = 0; index < 4; index += 1) sockets.push(await open());
      await new Promise((resolve) => setTimeout(resolve, 50));
      const refused = await open();
      sockets.push(refused);
      refused.resume();
      let refusal = "";
      refused.on("data", (chunk) => (refusal += chunk.toString()));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.match(refusal, /^HTTP\/1\.1 429/, "the stalled readers hold every per-owner slot");

      // A paused socket never sees the close, so wait out the idle bound instead.
      await new Promise((resolve) => setTimeout(resolve, 400));
      const admitted = await open();
      sockets.push(admitted);
      admitted.resume();
      let answer = "";
      admitted.on("data", (chunk) => (answer += chunk.toString()));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.match(answer, /^HTTP\/1\.1 200/, "the destroyed readers returned their slots");
    } finally {
      for (const socket of sockets) socket.destroy();
      server.close();
      server.closeAllConnections();
      if (previousPath === undefined) delete process.env.EXOMEM_CLOUD_MCP_PATH;
      else process.env.EXOMEM_CLOUD_MCP_PATH = previousPath;
    }
  });
});

// add-cloud-media-access: the same route for a signed-in browser. The app mints the ticket;
// the gateway holds the other half of the shared key and the per-request authority.
describe("Cloud download ticket at the gateway", () => {
  beforeEach(() => resetCloudGatewayConcurrencyForTests());

  const MAC_KEY = Buffer.alloc(32, 11);
  // The owner's Home login: first-party, with the tenant and cell the ticket names.
  const HOME_LOGIN: ActiveCloudOAuthAccessToken = {
    ...ACCESS,
    clientId: "exomem-home",
    firstParty: true,
    client: { ...ACCESS.client, admissionMode: "first_party" },
  };
  const CLAIMS = {
    tenantId: HOME_LOGIN.tenantId,
    cellId: CELL,
    familyId: HOME_LOGIN.familyId,
    grantId: HOME_LOGIN.grantId,
  };

  function ticket(options: Parameters<typeof signDownloadTicket>[2] = {}, path = PATH): string {
    return signDownloadTicket({ ...CLAIMS, path }, MAC_KEY, options);
  }

  function ticketRequest(
    token: string,
    options: { path?: string; headers?: Record<string, string> } = {}
  ): Request {
    const query = new URLSearchParams({ path: options.path ?? PATH, ticket: token });
    return new Request(`http://gateway.invalid/download?${query}`, { headers: options.headers });
  }

  function ticketDeps(overrides: Partial<CloudGatewayDependencies> = {}) {
    return deps({
      controlPlaneKey: MAC_KEY,
      findAccessToken: async () => assert.fail("a ticket never reaches the bearer lookup"),
      findLogin: async () => HOME_LOGIN,
      ...overrides,
    });
  }

  it("serves a 206 for a Range request and the same ticket again for the next seek", async () => {
    const token = ticket();
    const ranges: Array<string | null> = [];
    let proofHeader: string | null = null;
    let url = "";
    const fetchCell = async (input: string | URL | Request, init?: RequestInit) => {
      url = String(input);
      const headers = new Headers(init?.headers);
      ranges.push(headers.get("range"));
      proofHeader = headers.get("x-exomem-cloud-origin");
      assert.equal(
        headers.get("authorization"),
        `Bearer ${deriveCloudCellBearer(CELL_TOKEN_KEY, CELL)}`
      );
      return new Response("cdef", {
        status: 206,
        headers: { "content-range": "bytes 2-5/10", "content-type": "video/mp4" },
      });
    };
    for (const range of ["bytes=2-5", "bytes=6-9"]) {
      const response = await handleCloudDownloadRequest(
        ticketRequest(token, { headers: { range } }),
        ticketDeps({ fetchCell })
      );
      assert.equal(response.status, 206);
      assert.equal(response.headers.get("content-range"), "bytes 2-5/10");
      assert.equal(response.headers.get("content-type"), "video/mp4");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(await response.text(), "cdef");
    }
    assert.deepEqual(ranges, ["bytes=2-5", "bytes=6-9"]);
    assert.equal(new URL(url).searchParams.get("ticket"), null, "the ticket stays at the gateway");
    const proof = await jwtVerify(proofHeader!, publicKey, {
      issuer: RESOURCE,
      audience: "exomem-cloud-origin",
    });
    assert.equal(proof.payload.purpose, "download");
    assert.equal(
      proof.payload.target_sha256,
      createHash("sha256").update(PATH, "utf8").digest("hex")
    );
  });

  it("refuses a ticket that is expired, for another path, forged or the wrong shape before any lookup or cell contact", async () => {
    const issuedLongAgo = Math.floor(Date.now() / 1000) - DOWNLOAD_TICKET_MAX_LIFETIME_SECONDS - 5;
    const cases: Array<[string, Request]> = [
      ["expired", ticketRequest(ticket({ now: issuedLongAgo }))],
      ["another path", ticketRequest(ticket({}, "Recordings/other.mp4"))],
      [
        "wrong key",
        ticketRequest(signDownloadTicket({ ...CLAIMS, path: PATH }, Buffer.alloc(32, 12))),
      ],
      ["tampered", ticketRequest(`${ticket().slice(0, -2)}AA`)],
      ["not a ticket", ticketRequest("x")],
    ];
    for (const [name, request] of cases) {
      const response = await handleCloudDownloadRequest(
        request,
        ticketDeps({
          findLogin: async () => assert.fail(`${name}: the login was looked up`),
        })
      );
      assert.equal(response.status, 401, name);
      assert.deepEqual(await response.json(), { error: "DOWNLOAD_TICKET_INVALID" }, name);
    }
  });

  it("needs exactly one ticket, one path and no bearer beside it", async () => {
    const token = ticket();
    const twoTickets = new Request(
      `http://gateway.invalid/download?${new URLSearchParams([
        ["path", PATH],
        ["ticket", token],
        ["ticket", token],
      ])}`
    );
    const noPath = new Request(`http://gateway.invalid/download?ticket=${token}`);
    assert.equal((await handleCloudDownloadRequest(twoTickets, ticketDeps())).status, 400);
    assert.equal((await handleCloudDownloadRequest(noPath, ticketDeps())).status, 400);
    const withBearer = await handleCloudDownloadRequest(
      ticketRequest(token, { headers: { authorization: `Bearer ${"a".repeat(43)}` } }),
      ticketDeps()
    );
    assert.equal(withBearer.status, 400);
    assert.deepEqual(await withBearer.json(), { error: "AMBIGUOUS_CREDENTIAL" });
  });

  it("stops at the login: revoked, not first-party, or another tenant or cell", async () => {
    const cases: Array<
      [string, Awaited<ReturnType<NonNullable<CloudGatewayDependencies["findLogin"]>>>]
    > = [
      ["revoked, blocked or deleting", null],
      ["a third-party login", { ...HOME_LOGIN, firstParty: false }],
      ["another tenant", { ...HOME_LOGIN, tenantId: "7a1c1b7e-2a4b-4c55-9d8e-0a1b2c3d4e5f" }],
      ["another cell", { ...HOME_LOGIN, cellId: "bbbbbbbbbbbbbbbb" }],
    ];
    for (const [name, login] of cases) {
      const response = await handleCloudDownloadRequest(
        ticketRequest(ticket()),
        ticketDeps({ findLogin: async () => login })
      );
      assert.equal(response.status, 401, name);
    }
  });

  it("refuses a cell that is stopped, held for deletion or not selected, without contacting it", async () => {
    const stopped = await handleCloudDownloadRequest(
      ticketRequest(ticket()),
      ticketDeps({ findLogin: async () => ({ ...HOME_LOGIN, cellDesiredState: "stopped" }) })
    );
    assert.equal(stopped.status, 503);
    const unselected = await handleCloudDownloadRequest(
      ticketRequest(ticket()),
      ticketDeps({ config: { ...CONFIG, uploadCells: new Set(["bbbbbbbbbbbbbbbb"]) } })
    );
    assert.equal(unselected.status, 404);
    const readOnly = await handleCloudDownloadRequest(
      ticketRequest(ticket()),
      ticketDeps({
        findLogin: async () => ({ ...HOME_LOGIN, cellDesiredState: "read_only" }),
        fetchCell: async () => new Response("kept", { status: 200 }),
      })
    );
    assert.equal(readOnly.status, 200, "a read-only account can still play its recordings");
  });

  it("applies the identity rate limit to a ticket and returns the slot when the body ends", async () => {
    const limited = await handleCloudDownloadRequest(
      ticketRequest(ticket()),
      ticketDeps({ takeRateLimit: async () => false })
    );
    assert.equal(limited.status, 429);
    const bodies = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await handleCloudDownloadRequest(
        ticketRequest(ticket()),
        ticketDeps({ fetchCell: async () => new Response("ok", { status: 200 }) })
      );
      assert.equal(response.status, 200, `attempt ${attempt}`);
      bodies.push(await response.text());
    }
    assert.equal(bodies.length, 6, "sequential downloads never exhaust the per-owner slots");
  });

  it("is useless at /mcp and /upload", async () => {
    const token = ticket();
    const calls: string[] = [];
    const guarded = ticketDeps({
      findAccessToken: async () => null,
      fetchCell: async () => {
        calls.push("cell");
        return new Response("no", { status: 200 });
      },
    });
    const mcp = await handleCloudMcpRequest(
      new Request(`http://gateway.invalid/mcp?ticket=${token}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      guarded
    );
    assert.equal(mcp.status, 401);
    const upload = await handleCloudUploadRequest(
      new Request(`http://gateway.invalid/upload?ticket=${token}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "bytes",
      }),
      guarded
    );
    assert.notEqual(upload.status, 200);
    assert.deepEqual(calls, []);
  });

  it("never writes the ticket to a log", async () => {
    const token = ticket();
    const lines: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((name) => console[name]);
    for (const name of methods) {
      console[name] = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    }
    try {
      await handleCloudDownloadRequest(
        ticketRequest(token),
        ticketDeps({ findLogin: async () => null })
      );
      await handleCloudDownloadRequest(
        ticketRequest(token),
        ticketDeps({
          fetchCell: async () => {
            throw new Error(`connect refused for ${token}`);
          },
        })
      );
    } finally {
      methods.forEach((name, index) => (console[name] = originals[index]));
    }
    assert.equal(lines.filter((line) => line.includes(token)).length, 0);
  });
});
