import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { beforeEach, describe, it, mock } from "node:test";
import { deriveCloudCellBearer } from "../../lib/exomem-hosted/cloud-cell-bearer";
import {
  loadExomemCloudConfig,
  type ExomemCloudConfig,
} from "../../lib/exomem-hosted/cloud-config";
import type { ActiveCloudOAuthAccessToken } from "../../lib/exomem-hosted/cloud-oauth";
import {
  buildCloudProtectedResourceMetadata,
  cloudGatewayIpBucketSkips,
  handleCloudMcpRequest,
  resetCloudGatewayConcurrencyForTests,
  type CloudGatewayDependencies,
} from "../cloud-handler";

// Task 3.6: the gateway Cloud handler (design D3), against a small real HTTP
// stand-in cell process — the real cell image is being built in a parallel
// lane and is not yet available. This exercises every wire-level behaviour
// (headers, streaming, error mapping) the design specifies; the end-to-end
// rehearsal reruns it against the real cell.

const TEST_CELL_ID = "aaaaaaaaaaaaaaaa";
const TEST_TOKEN_KEY = Buffer.alloc(32, 7);
const TEST_CLOUD_RESOURCE = "https://cloud.example.test/mcp/v1";
const EXPECTED_CELL_BEARER = deriveCloudCellBearer(TEST_TOKEN_KEY, TEST_CELL_ID);

const TEST_CONFIG: ExomemCloudConfig = {
  mcpUrl: TEST_CLOUD_RESOURCE,
  mcpPath: "/api/exomem/cloud/mcp/v1",
  cellTokenKey: TEST_TOKEN_KEY,
};

const VALID_ACCESS: ActiveCloudOAuthAccessToken = {
  familyId: "family-1",
  grantId: "grant-1",
  userId: "user-1",
  tenantId: "tenant-1",
  clientId: "client-1",
  resource: TEST_CLOUD_RESOURCE,
  scopes: ["exomem.read", "exomem.write"],
  cellId: TEST_CELL_ID,
  cellDesiredState: "running",
};

type StandInCellBehavior =
  | { kind: "ok"; chunks: string[]; chunkDelayMs?: number }
  | { kind: "unauthorized" }
  | { kind: "header-mismatch" };

type StandInCell = {
  server: Server;
  port: number;
  requests: Array<{
    method: string | undefined;
    url: string | undefined;
    headers: IncomingMessage["headers"];
    body: string;
  }>;
  close: () => Promise<void>;
};

async function startStandInCell(behavior: StandInCellBehavior): Promise<StandInCell> {
  const requests: StandInCell["requests"] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    requests.push({ method: req.method, url: req.url, headers: { ...req.headers }, body });
    if (behavior.kind === "unauthorized") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (behavior.kind === "header-mismatch") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          error: { code: -32020, message: "Header mismatch" },
        })
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    let index = 0;
    const writeNext = () => {
      if (index >= behavior.chunks.length) {
        res.end();
        return;
      }
      res.write(behavior.chunks[index]);
      index += 1;
      setTimeout(writeNext, behavior.chunkDelayMs ?? 0);
    };
    writeNext();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    server,
    port: address.port,
    requests,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

function fetchCellAt(port: number): typeof fetch {
  return (input, init) => {
    const original = new URL(String(input));
    const redirected = new URL(`http://127.0.0.1:${port}${original.pathname}`);
    return fetch(redirected, init);
  };
}

function baseDeps(overrides: Partial<CloudGatewayDependencies> = {}): CloudGatewayDependencies {
  return {
    config: TEST_CONFIG,
    findAccessToken: async () => VALID_ACCESS,
    takeRateLimit: async () => true,
    ...overrides,
  };
}

function postRequest(input: {
  bearer?: string;
  headers?: Record<string, string>;
  body?: string;
  method?: string;
}): Request {
  const headers = new Headers(input.headers ?? {});
  if (input.bearer) headers.set("authorization", `Bearer ${input.bearer}`);
  return new Request("http://gateway.invalid/api/exomem/cloud/mcp/v1", {
    method: input.method ?? "POST",
    headers,
    body: input.body,
  });
}

const CLIENT_BEARER = "a".repeat(43);

describe("Exomem Cloud gateway handler", () => {
  beforeEach(() => {
    resetCloudGatewayConcurrencyForTests();
  });

  it("answers GET with 405 without contacting any cell or looking up a token", async () => {
    let tokenLookups = 0;
    const response = await handleCloudMcpRequest(
      new Request("http://gateway.invalid/api/exomem/cloud/mcp/v1", { method: "GET" }),
      baseDeps({
        findAccessToken: async () => {
          tokenLookups += 1;
          return VALID_ACCESS;
        },
      })
    );
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(tokenLookups, 0);
  });

  it("rejects a request that names a tenant or cell selector before touching the token", async () => {
    let tokenLookups = 0;
    const response = await handleCloudMcpRequest(
      postRequest({ bearer: CLIENT_BEARER, headers: { "x-cell-id": "someone-elses-cell" } }),
      baseDeps({
        findAccessToken: async () => {
          tokenLookups += 1;
          return VALID_ACCESS;
        },
      })
    );
    assert.equal(response.status, 400);
    assert.equal(tokenLookups, 0);
  });

  it("answers 401 without a bearer, and refuses an unknown or cross-resource token", async () => {
    const noBearer = await handleCloudMcpRequest(postRequest({}), baseDeps());
    assert.equal(noBearer.status, 401);

    const unknownToken = await handleCloudMcpRequest(
      postRequest({ bearer: CLIENT_BEARER }),
      baseDeps({ findAccessToken: async () => null })
    );
    assert.equal(unknownToken.status, 401);
  });

  // RFC 9728 section 5.1 / MCP authorization: the 401 names the Cloud
  // resource's own metadata, so a client finds the authorization server
  // without probing well-known paths.
  it("challenges a 401 with the Cloud resource metadata and scopes", async () => {
    const expected =
      'Bearer resource_metadata="https://cloud.example.test/.well-known/oauth-protected-resource/api/exomem/cloud/mcp/v1", ' +
      'scope="exomem.read exomem.write offline_access"';
    const noBearer = await handleCloudMcpRequest(postRequest({}), baseDeps());
    assert.equal(noBearer.headers.get("www-authenticate"), expected);
    const unknownToken = await handleCloudMcpRequest(
      postRequest({ bearer: CLIENT_BEARER }),
      baseDeps({ findAccessToken: async () => null })
    );
    assert.equal(unknownToken.headers.get("www-authenticate"), expected);
  });

  // Item 4 / task 3.5 (design D2): explicit evidence that the handler asks
  // findCloudOAuthAccessToken (D2's exact-resource lookup) for the
  // configured Cloud resource specifically, never the hosted one. This is
  // confirmatory, not red-first: handleCloudMcpRequest already passed
  // config.mcpUrl as the expected resource from task 3.6 -- the fake below
  // mirrors findCloudOAuthAccessToken's own `token.resource = expectedResource`
  // SQL filter, so a token minted for the hosted resource is correctly
  // invisible at this exact-match lookup, exactly as it would be against the
  // real query.
  it("refuses a token bound to the hosted resource even though its digest is otherwise valid", async () => {
    const HOSTED_RESOURCE = "https://hosted.example.test/api/exomem/mcp/v1";
    const tokensByResource = new Map([[HOSTED_RESOURCE, VALID_ACCESS]]);
    let receivedResource: string | undefined;
    let fetchCalls = 0;
    const response = await handleCloudMcpRequest(
      postRequest({ bearer: CLIENT_BEARER }),
      baseDeps({
        findAccessToken: async (_digest, expectedResource) => {
          receivedResource = expectedResource;
          return tokensByResource.get(expectedResource) ?? null;
        },
        fetchCell: (async () => {
          fetchCalls += 1;
          return new Response("unreachable");
        }) as typeof fetch,
      })
    );
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "ACCESS_TOKEN_INVALID" });
    assert.equal(receivedResource, TEST_CLOUD_RESOURCE);
    assert.equal(fetchCalls, 0);
  });

  it("applies the IP rate limit before the identity rate limit when a trusted client address is present, and both before any cell contact", async () => {
    const previousHeader = process.env.EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_HEADER;
    const previousValue = process.env.EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_VALUE;
    process.env.EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_HEADER = "x-ingress-trusted";
    process.env.EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_VALUE = "traefik";
    try {
      const trustedHeaders = { "x-ingress-trusted": "traefik", "x-real-ip": "203.0.113.9" };
      let fetchCalls = 0;
      const ipLimited = await handleCloudMcpRequest(
        postRequest({ bearer: CLIENT_BEARER, headers: trustedHeaders }),
        baseDeps({
          takeRateLimit: async () => false,
          fetchCell: (async () => {
            fetchCalls += 1;
            return new Response("unreachable");
          }) as typeof fetch,
        })
      );
      assert.equal(ipLimited.status, 429);
      assert.equal(fetchCalls, 0);

      let rateLimitCalls = 0;
      const identityLimited = await handleCloudMcpRequest(
        postRequest({ bearer: CLIENT_BEARER, headers: trustedHeaders }),
        baseDeps({
          takeRateLimit: async () => {
            rateLimitCalls += 1;
            // First call is the IP limit, second is the identity limit.
            return rateLimitCalls === 1;
          },
          fetchCell: (async () => {
            fetchCalls += 1;
            return new Response("unreachable");
          }) as typeof fetch,
        })
      );
      assert.equal(identityLimited.status, 429);
      assert.equal(rateLimitCalls, 2);
      assert.equal(fetchCalls, 0);
    } finally {
      if (previousHeader === undefined)
        delete process.env.EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_HEADER;
      else process.env.EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_HEADER = previousHeader;
      if (previousValue === undefined)
        delete process.env.EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_VALUE;
      else process.env.EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_VALUE = previousValue;
    }
  });

  // Security review finding 6: the IP bucket used to fall back to one shared
  // "aggregate" key whenever the request was untrusted or carried no client
  // address, so one sender could rate-limit every user through it. It must
  // now be skipped entirely instead — proven here by the identity limit
  // being the ONLY rate-limit call made, regardless of whether the
  // ingress-trust config is absent or the trusted header is present without
  // an x-real-ip value.
  it("skips the IP bucket entirely, never a shared one, when there is no trusted client address", async () => {
    resetCloudGatewayConcurrencyForTests();
    const warn = mock.method(console, "warn", () => undefined);
    for (const headers of [
      undefined,
      { "x-ingress-trusted": "traefik" }, // trust header configured below but request omits x-real-ip
    ] as const) {
      const previousHeader = process.env.EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_HEADER;
      const previousValue = process.env.EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_VALUE;
      process.env.EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_HEADER = "x-ingress-trusted";
      process.env.EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_VALUE = "traefik";
      try {
        let rateLimitCalls = 0;
        let fetchCalls = 0;
        const response = await handleCloudMcpRequest(
          postRequest({ bearer: CLIENT_BEARER, headers }),
          baseDeps({
            takeRateLimit: async () => {
              rateLimitCalls += 1;
              return false; // the one call made must be the identity limit
            },
            fetchCell: (async () => {
              fetchCalls += 1;
              return new Response("unreachable");
            }) as typeof fetch,
          })
        );
        assert.equal(response.status, 429);
        assert.equal(rateLimitCalls, 1, "only the identity limit should have been consulted");
        assert.equal(fetchCalls, 0);
      } finally {
        if (previousHeader === undefined)
          delete process.env.EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_HEADER;
        else process.env.EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_HEADER = previousHeader;
        if (previousValue === undefined)
          delete process.env.EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_VALUE;
        else process.env.EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_VALUE = previousValue;
      }
    }
    // Cloud design D3 step 3: a skip is counted and logged, content-free, so
    // an ingress that blanks the header is visible rather than silent.
    try {
      assert.equal(cloudGatewayIpBucketSkips(), 2);
      const logged = warn.mock.calls.map((call) => JSON.stringify(call.arguments));
      assert.ok(
        logged.some((line) => line.includes("exomem_cloud_gateway_ip_bucket_skipped")),
        "the skip must be logged"
      );
      for (const line of logged) {
        assert.equal(line.includes(CLIENT_BEARER), false);
        assert.equal(line.includes("traefik"), false);
      }
    } finally {
      warn.mock.restore();
    }
  });

  // Security review finding 2: a cell exposes one fixed non-owner principal
  // and cannot itself enforce a read-only grant, so a token carrying only
  // one of the two scopes must be refused before any cell contact.
  it("refuses a token missing either exomem.read or exomem.write with 403 INSUFFICIENT_SCOPE", async () => {
    for (const scopes of [["exomem.read"], ["exomem.write"], []]) {
      let fetchCalls = 0;
      const response = await handleCloudMcpRequest(
        postRequest({ bearer: CLIENT_BEARER, body: "{}" }),
        baseDeps({
          findAccessToken: async () => ({ ...VALID_ACCESS, scopes }),
          fetchCell: (async () => {
            fetchCalls += 1;
            return new Response("unreachable");
          }) as typeof fetch,
        })
      );
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "INSUFFICIENT_SCOPE" });
      assert.equal(fetchCalls, 0);
    }
  });

  // Security review finding 15: migration 0056's CHECK constraint already
  // guarantees this shape for every row this join can return, but the
  // handler must refuse to build a URL or an HMAC from anything else.
  it("refuses a malformed cell_id before it reaches a URL or the cell-bearer HMAC", async () => {
    let fetchCalls = 0;
    const response = await handleCloudMcpRequest(
      postRequest({ bearer: CLIENT_BEARER, body: "{}" }),
      baseDeps({
        findAccessToken: async () => ({ ...VALID_ACCESS, cellId: "../../etc/passwd" }),
        fetchCell: (async () => {
          fetchCalls += 1;
          return new Response("unreachable");
        }) as typeof fetch,
      })
    );
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "CELL_ID_INVALID" });
    assert.equal(fetchCalls, 0);
  });

  it("answers CELL_NOT_READY for a stopped cell without contacting it", async () => {
    let fetchCalls = 0;
    const response = await handleCloudMcpRequest(
      postRequest({ bearer: CLIENT_BEARER }),
      baseDeps({
        findAccessToken: async () => ({ ...VALID_ACCESS, cellDesiredState: "stopped" }),
        fetchCell: (async () => {
          fetchCalls += 1;
          return new Response("unreachable");
        }) as typeof fetch,
      })
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "CELL_NOT_READY" });
    assert.equal(fetchCalls, 0);
  });

  it("answers CELL_NOT_READY when the cell cannot be reached", async () => {
    const response = await handleCloudMcpRequest(
      postRequest({ bearer: CLIENT_BEARER }),
      baseDeps({
        fetchCell: (async () => {
          throw new Error("ECONNREFUSED");
        }) as typeof fetch,
      })
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "CELL_NOT_READY" });
  });

  describe("against a real stand-in cell process", () => {
    for (const method of ["server/discover", "tools/call"] as const) {
      it(`preserves modern ${method} metadata and the body without forwarding client credentials`, async () => {
        const cell = await startStandInCell({ kind: "ok", chunks: ['{"ok":true}'] });
        const metadata = {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "qa-client", version: "1" },
        };
        const params =
          method === "tools/call"
            ? { name: "bootstrap", arguments: { marker: "hello", region: "qa" }, _meta: metadata }
            : { _meta: metadata };
        const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
        const headers: Record<string, string> = {
          "content-type": "application/json",
          accept: "application/json",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": method,
          cookie: "session=do-not-forward",
          "x-forwarded-for": "203.0.113.9",
          "x-arbitrary": "do-not-forward",
          "mcp-param-": "empty-suffix-is-not-metadata",
        };
        if (method === "tools/call") {
          headers["Mcp-Name"] = "bootstrap";
          headers["Mcp-Param-Marker"] = "=?base64?aGVsbG8=?=";
          headers["mcp-param-region"] = "qa";
        }
        try {
          const response = await handleCloudMcpRequest(
            postRequest({ bearer: CLIENT_BEARER, headers, body }),
            baseDeps({ fetchCell: fetchCellAt(cell.port) })
          );
          assert.equal(response.status, 200);
          await response.text();
          const received = cell.requests[0]!;
          assert.equal(received.headers["mcp-method"], method);
          assert.equal(
            received.headers["mcp-name"],
            method === "tools/call" ? "bootstrap" : undefined
          );
          assert.equal(received.headers["mcp-param-marker"], headers["Mcp-Param-Marker"]);
          assert.equal(received.headers["mcp-param-region"], headers["mcp-param-region"]);
          assert.equal(received.body, body);
          assert.equal(received.headers.authorization, `Bearer ${EXPECTED_CELL_BEARER}`);
          for (const name of ["cookie", "x-forwarded-for", "x-arbitrary", "mcp-param-"]) {
            assert.equal(received.headers[name], undefined, name);
          }
        } finally {
          await cell.close();
        }
      });
    }

    it("preserves encoded names and mismatched metadata for validation by the cell", async () => {
      const cell = await startStandInCell({ kind: "ok", chunks: ['{"ok":true}'] });
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "different" },
      });
      try {
        const response = await handleCloudMcpRequest(
          postRequest({
            bearer: CLIENT_BEARER,
            headers: {
              "mcp-protocol-version": "2026-07-28",
              "mcp-method": "server/discover",
              "mcp-name": "=?base64?SGVsbG8sIOS4lueVjA==?=",
              "mcp-param-marker": "=?base64?IHBhZGRlZCA=?=",
            },
            body,
          }),
          baseDeps({ fetchCell: fetchCellAt(cell.port) })
        );
        await response.text();
        const received = cell.requests[0]!;
        assert.equal(received.headers["mcp-method"], "server/discover");
        assert.equal(received.headers["mcp-name"], "=?base64?SGVsbG8sIOS4lueVjA==?=");
        assert.equal(received.headers["mcp-param-marker"], "=?base64?IHBhZGRlZCA=?=");
        assert.equal(received.body, body);
      } finally {
        await cell.close();
      }
    });

    it("relays a cell's metadata refusal without synthesizing the missing method header", async () => {
      const cell = await startStandInCell({ kind: "header-mismatch" });
      const body = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "server/discover", params: {} });
      try {
        const response = await handleCloudMcpRequest(
          postRequest({
            bearer: CLIENT_BEARER,
            headers: { "mcp-protocol-version": "2026-07-28" },
            body,
          }),
          baseDeps({ fetchCell: fetchCellAt(cell.port) })
        );
        assert.equal(response.status, 400);
        assert.equal(response.headers.get("cache-control"), "private, no-store");
        assert.deepEqual(await response.json(), {
          jsonrpc: "2.0",
          id: 7,
          error: { code: -32020, message: "Header mismatch" },
        });
        assert.equal(cell.requests[0]!.headers["mcp-method"], undefined);
        assert.equal(cell.requests[0]!.headers["mcp-name"], undefined);
        assert.equal(cell.requests[0]!.body, body);
      } finally {
        await cell.close();
      }
    });

    it("forwards only the allowlisted headers, the derived C4 bearer, and x-request-id — never the client's own", async () => {
      const cell = await startStandInCell({ kind: "ok", chunks: ['{"ok":true}'] });
      try {
        const response = await handleCloudMcpRequest(
          postRequest({
            bearer: CLIENT_BEARER,
            headers: {
              "content-type": "application/json",
              accept: "application/json",
              "mcp-session-id": "session-42",
              "mcp-protocol-version": "2025-06-18",
              cookie: "session=leak-me-not",
              "x-forwarded-for": "203.0.113.9",
            },
            body: "{}",
          }),
          baseDeps({ fetchCell: fetchCellAt(cell.port) })
        );
        assert.equal(response.status, 200);
        assert.equal(await response.text(), '{"ok":true}');
        assert.equal(response.headers.get("cache-control"), "private, no-store");

        assert.equal(cell.requests.length, 1);
        const received = cell.requests[0]!.headers;
        assert.equal(received["content-type"], "application/json");
        assert.equal(received["accept"], "application/json");
        assert.equal(received["mcp-session-id"], "session-42");
        assert.equal(received["mcp-protocol-version"], "2025-06-18");
        for (const name of ["mcp-method", "mcp-name", "mcp-param-marker"]) {
          assert.equal(received[name], undefined);
        }
        assert.equal(received["authorization"], `Bearer ${EXPECTED_CELL_BEARER}`);
        assert.ok(
          typeof received["x-request-id"] === "string" && received["x-request-id"]!.length > 0
        );
        // The client's own bearer and cookie must never reach the cell.
        assert.notEqual(received["authorization"], `Bearer ${CLIENT_BEARER}`);
        assert.equal(received["cookie"], undefined);
        assert.equal(received["x-forwarded-for"], undefined);
        // Security review finding 12: always sent upstream as identity,
        // regardless of what the caller sent — the gateway never decodes a
        // compressed cell response.
        assert.equal(received["accept-encoding"], "identity");
      } finally {
        await cell.close();
      }
    });

    // Security review finding 12: the cell's own headers (anything beyond
    // the three allowlisted ones) must never reach the caller, and the
    // gateway's own cache-control always wins over the cell's.
    it("relays only content-type, mcp-session-id and mcp-protocol-version from the cell, dropping everything else", async () => {
      const server = createServer((_req, res) => {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "session-99",
          "mcp-protocol-version": "2025-06-18",
          "cache-control": "public, max-age=3600",
          "set-cookie": "leak=me",
          "x-cell-debug": "internal-detail",
        });
        res.end('{"ok":true}');
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      try {
        const response = await handleCloudMcpRequest(
          postRequest({ bearer: CLIENT_BEARER, body: "{}" }),
          baseDeps({ fetchCell: fetchCellAt(address.port) })
        );
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "application/json");
        assert.equal(response.headers.get("mcp-session-id"), "session-99");
        assert.equal(response.headers.get("mcp-protocol-version"), "2025-06-18");
        assert.equal(response.headers.get("cache-control"), "private, no-store");
        assert.equal(response.headers.get("set-cookie"), null);
        assert.equal(response.headers.get("x-cell-debug"), null);
      } finally {
        server.close();
        await once(server, "close");
      }
    });

    it("streams the response body rather than buffering it", async () => {
      const cell = await startStandInCell({
        kind: "ok",
        chunks: ["first-chunk", "second-chunk"],
        chunkDelayMs: 60,
      });
      try {
        const response = await handleCloudMcpRequest(
          postRequest({ bearer: CLIENT_BEARER, body: "{}" }),
          baseDeps({ fetchCell: fetchCellAt(cell.port) })
        );
        assert.equal(response.status, 200);
        assert.ok(response.body, "response must carry a readable body stream");
        const reader = response.body!.getReader();
        const started = Date.now();
        const { value: firstValue, done: firstDone } = await reader.read();
        assert.equal(firstDone, false);
        assert.equal(new TextDecoder().decode(firstValue), "first-chunk");
        // The first chunk must arrive well before the stand-in even sends
        // its second, deliberately delayed one — proof this is a live pipe,
        // not a response built after buffering the whole upstream body.
        assert.ok(Date.now() - started < 50, "first chunk should not wait for the second");
        const { value: secondValue } = await reader.read();
        assert.equal(new TextDecoder().decode(secondValue), "second-chunk");
        const { done: finalDone } = await reader.read();
        assert.equal(finalDone, true);
      } finally {
        await cell.close();
      }
    });

    // Security review finding 5: the concurrency slot used to release as
    // soon as `proxyToCell` returned a Response — while its body, the actual
    // relayed stream, was still open. A slow or large in-flight body must
    // still hold the slot.
    it("holds the per-identity concurrency slot until the relayed body actually ends", async () => {
      let releaseUpstreamChunks: (() => void) | undefined;
      const bodyGate = new Promise<void>((resolve) => {
        releaseUpstreamChunks = resolve;
      });
      const makeGatedStream = () =>
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("chunk"));
            await bodyGate;
            controller.close();
          },
        });
      const deps = baseDeps({
        fetchCell: (async () =>
          new Response(makeGatedStream(), {
            status: 200,
            headers: { "content-type": "text/plain" },
          })) as typeof fetch,
      });

      // Saturate this identity's four per-tenant concurrency slots. Each call
      // returns as soon as headers arrive — the bodies stay open.
      const inFlight = await Promise.all(
        Array.from({ length: 4 }, () =>
          handleCloudMcpRequest(postRequest({ bearer: CLIENT_BEARER, body: "{}" }), deps)
        )
      );
      for (const response of inFlight) assert.equal(response.status, 200);

      const fifth = await handleCloudMcpRequest(
        postRequest({ bearer: CLIENT_BEARER, body: "{}" }),
        deps
      );
      assert.equal(
        fifth.status,
        429,
        "a 5th concurrent call for the same identity must be rejected while the first four's bodies are still open"
      );

      releaseUpstreamChunks!();
      for (const response of inFlight) {
        const reader = response.body!.getReader();
        while (!(await reader.read()).done) {
          /* drain to completion, which is what actually releases the slot */
        }
      }

      const sixth = await handleCloudMcpRequest(
        postRequest({ bearer: CLIENT_BEARER, body: "{}" }),
        deps
      );
      assert.equal(sixth.status, 200, "slots must be free again once the bodies actually ended");
      await sixth.body?.cancel();
    });

    it("answers CELL_AUTH_MISMATCH on a cell 401 and never relays its body", async () => {
      const cell = await startStandInCell({ kind: "unauthorized" });
      try {
        const response = await handleCloudMcpRequest(
          postRequest({ bearer: CLIENT_BEARER, body: "{}" }),
          baseDeps({ fetchCell: fetchCellAt(cell.port) })
        );
        assert.equal(response.status, 502);
        assert.deepEqual(await response.json(), { error: "CELL_AUTH_MISMATCH" });
      } finally {
        await cell.close();
      }
    });

    it("proxies a read_only cell too, and DELETE alongside POST", async () => {
      const cell = await startStandInCell({ kind: "ok", chunks: ["ok"] });
      try {
        const response = await handleCloudMcpRequest(
          postRequest({ bearer: CLIENT_BEARER, method: "DELETE" }),
          baseDeps({
            findAccessToken: async () => ({ ...VALID_ACCESS, cellDesiredState: "read_only" }),
            fetchCell: fetchCellAt(cell.port),
          })
        );
        assert.equal(response.status, 200);
        assert.equal(cell.requests[0]!.method, "DELETE");
      } finally {
        await cell.close();
      }
    });
  });
});

describe("Cloud artifact fetch authority", () => {
  beforeEach(() => resetCloudGatewayConcurrencyForTests());
  it("binds a signed grant to the authenticated cell and exact files, preserving the MCP body", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const file = {
      file_id: " \u0085synthetic-file\u001c ",
      download_url: "https://files.example.test/proof?handle=synthetic",
      file_name: "proof.bin",
      client_only_metadata: "ignored by the public file schema",
    };
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "preserve_artifacts",
        arguments: { scope: "sample", category: "review", files: [file] },
      },
    });
    let forwarded: RequestInit | undefined;
    const response = await handleCloudMcpRequest(
      postRequest({ bearer: CLIENT_BEARER, body, headers: { "content-type": "application/json" } }),
      baseDeps({
        config: {
          ...TEST_CONFIG,
          artifactSigningKey: privateKey,
          artifactCells: new Set([TEST_CELL_ID]),
        },
        fetchCell: async (_url, init) => {
          forwarded = init;
          return new Response("ok");
        },
      })
    );
    assert.equal(await response.text(), "ok");
    const grant = new Headers(forwarded!.headers).get("x-exomem-artifact-grant");
    assert.ok(grant, "authenticated file calls need internal fetch authority");
    const [header, payload, signature] = grant.split(".");
    assert.equal(
      verify(
        null,
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature!, "base64url")
      ),
      true
    );
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    assert.equal(claims.sub, TEST_CELL_ID);
    assert.equal(claims.op, "preserve_artifacts");
    assert.deepEqual(claims.handles, [
      createHash("sha256")
        .update(JSON.stringify(["synthetic-file", file.download_url, null, file.file_name]))
        .digest("hex"),
    ]);
    assert.equal(claims.max_bytes, 100 * 1024 * 1024);
    assert.equal(claims.max_files, 8);
    assert.ok(claims.exp * 1000 - claims.issued_ms <= 60000);
    assert.equal(JSON.stringify(claims).includes(file.download_url), false);
    assert.equal(await new Response(forwarded!.body).text(), body);
  });

  it("does not trust a forged private header or MCP operation header", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const config = {
      ...TEST_CONFIG,
      artifactSigningKey: privateKey,
      artifactCells: new Set([TEST_CELL_ID]),
    };
    let calls = 0;
    let grant: string | null = null;
    const deps = baseDeps({
      config,
      fetchCell: async (_url, init) => {
        calls += 1;
        grant = new Headers(init!.headers).get("x-exomem-artifact-grant");
        return new Response("ok");
      },
    });
    const forged = await handleCloudMcpRequest(
      postRequest({
        bearer: CLIENT_BEARER,
        body: "{}",
        headers: { "x-exomem-artifact-grant": "forged" },
      }),
      deps
    );
    assert.equal(forged.status, 400);
    assert.equal(calls, 0);
    const ordinary = await handleCloudMcpRequest(
      postRequest({
        bearer: CLIENT_BEARER,
        body: JSON.stringify({
          method: "tools/call",
          params: {
            name: "ask_memory",
            arguments: {
              files: [{ file_id: "file", download_url: "https://files.example.test/file" }],
            },
          },
        }),
        headers: { "mcp-name": "preserve_artifacts" },
      }),
      deps
    );
    assert.equal(await ordinary.text(), "ok");
    assert.equal(grant, null);
  });

  it("leaves unselected accounts on their existing streaming path", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const body = "ordinary account's unchanged request";
    let received = "";
    let grant: string | null = null;
    const response = await handleCloudMcpRequest(
      postRequest({ bearer: CLIENT_BEARER, body }),
      baseDeps({
        config: { ...TEST_CONFIG, artifactSigningKey: privateKey, artifactCells: new Set() },
        fetchCell: async (_url, init) => {
          grant = new Headers(init!.headers).get("x-exomem-artifact-grant");
          received = await new Response(init!.body).text();
          return new Response("ok");
        },
      })
    );
    assert.equal(await response.text(), "ok");
    assert.equal(received, body);
    assert.equal(grant, null);
  });

  it("releases admission after an interrupted selected request read", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    let calls = 0;
    const deps = baseDeps({
      config: {
        ...TEST_CONFIG,
        artifactSigningKey: privateKey,
        artifactCells: new Set([TEST_CELL_ID]),
      },
      fetchCell: async () => {
        calls += 1;
        return new Response("ok");
      },
    });
    const abort = new AbortController();
    const slow = new Request("http://gateway.invalid/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${CLIENT_BEARER}` },
      body: new ReadableStream({ start() {} }),
      signal: abort.signal,
      duplex: "half",
    } as RequestInit);
    const pending = handleCloudMcpRequest(slow, deps);
    abort.abort();
    assert.equal((await pending).status, 408);
    assert.equal(calls, 0);
    const after = await handleCloudMcpRequest(
      postRequest({ bearer: CLIENT_BEARER, body: "{}" }),
      deps
    );
    assert.equal(await after.text(), "ok");
  });

  it("preserves large ordinary saves without granting incomplete inspected calls", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const body = JSON.stringify({
      method: "tools/call",
      params: { name: "capture_source", arguments: { content: "x".repeat(1024 * 1024 + 1) } },
    });
    const variants: Record<string, string>[] = [
      {},
      { "content-length": String(Buffer.byteLength(body)) },
    ];
    for (const headers of variants) {
      let received = "";
      let grant: string | null = null;
      const response = await handleCloudMcpRequest(
        postRequest({ bearer: CLIENT_BEARER, body, headers }),
        baseDeps({
          config: {
            ...TEST_CONFIG,
            artifactSigningKey: privateKey,
            artifactCells: new Set([TEST_CELL_ID]),
          },
          fetchCell: async (_url, init) => {
            grant = new Headers(init!.headers).get("x-exomem-artifact-grant");
            received = await new Response(init!.body).text();
            return new Response("ok");
          },
        })
      );
      assert.equal(await response.text(), "ok");
      assert.equal(received, body);
      assert.equal(grant, null);
    }
  });

  it("loads a separate signer only for enabled, explicitly selected cells", () => {
    const env = {
      EXOMEM_CLOUD_MCP_URL: TEST_CONFIG.mcpUrl,
      EXOMEM_CLOUD_MCP_PATH: TEST_CONFIG.mcpPath,
      EXOMEM_CLOUD_CELL_TOKEN_KEY: TEST_TOKEN_KEY.toString("hex"),
    };
    assert.equal(loadExomemCloudConfig(env).artifactSigningKey, undefined);
    const enabled = {
      ...env,
      EXOMEM_CLOUD_ARTIFACT_TRANSPORT_ENABLED: "true",
      EXOMEM_CLOUD_ARTIFACT_CELL_IDS: JSON.stringify([TEST_CELL_ID]),
    };
    assert.throws(() => loadExomemCloudConfig(enabled), /EXOMEM_CLOUD_ARTIFACT_SIGNING_KEY/);
    const { privateKey } = generateKeyPairSync("ed25519");
    const configured = {
      ...enabled,
      EXOMEM_CLOUD_ARTIFACT_SIGNING_KEY: privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
    };
    assert.equal(loadExomemCloudConfig(configured).artifactCells?.has(TEST_CELL_ID), true);
    assert.throws(
      () =>
        loadExomemCloudConfig({ ...configured, EXOMEM_CLOUD_ARTIFACT_CELL_IDS: '["not-a-cell"]' }),
      /EXOMEM_CLOUD_ARTIFACT_CELL_IDS/
    );
    const invalidKey = "invalid-private-material";
    try {
      loadExomemCloudConfig({ ...configured, EXOMEM_CLOUD_ARTIFACT_SIGNING_KEY: invalidKey });
      assert.fail("invalid key accepted");
    } catch (error) {
      assert.equal(String(error).includes(invalidKey), false);
    }
  });

  it("passes a slow request through once without losing its outstanding read", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const { privateKey } = generateKeyPairSync("ed25519");
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
      },
    });
    source.enqueue(new TextEncoder().encode("prefix-"));
    const request = new Request("http://gateway.invalid/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${CLIENT_BEARER}` },
      body: stream,
      duplex: "half",
    } as RequestInit);
    let received = "";
    let grant: string | null = null;
    const pending = handleCloudMcpRequest(
      request,
      baseDeps({
        config: {
          ...TEST_CONFIG,
          artifactSigningKey: privateKey,
          artifactCells: new Set([TEST_CELL_ID]),
        },
        fetchCell: async (_url, init) => {
          grant = new Headers(init!.headers).get("x-exomem-artifact-grant");
          received = await new Response(init!.body).text();
          return new Response("ok");
        },
      })
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    context.mock.timers.tick(5001);
    source.enqueue(new TextEncoder().encode("tail"));
    source.close();
    assert.equal(await (await pending).text(), "ok");
    assert.equal(received, "prefix-tail");
    assert.equal(grant, null);
  });
});

describe("Exomem Cloud protected-resource metadata", () => {
  it("names the Cloud resource and an authorization server, not the hosted one", () => {
    const previous = process.env.EXOMEM_PUBLIC_BASE_URL;
    process.env.EXOMEM_PUBLIC_BASE_URL = "https://substratesystems.io";
    try {
      const metadata = buildCloudProtectedResourceMetadata(TEST_CONFIG);
      assert.equal(metadata.resource, TEST_CLOUD_RESOURCE);
      assert.deepEqual(metadata.authorization_servers, [
        "https://substratesystems.io/api/exomem/oauth",
      ]);
      // Security review finding 2: a client that discovers the resource
      // before the authorization server must still learn it needs both
      // scopes from this document.
      assert.deepEqual(metadata.scopes_supported, [
        "exomem.read",
        "exomem.write",
        "offline_access",
      ]);
    } finally {
      if (previous === undefined) delete process.env.EXOMEM_PUBLIC_BASE_URL;
      else process.env.EXOMEM_PUBLIC_BASE_URL = previous;
    }
  });
});
