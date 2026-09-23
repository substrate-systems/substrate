import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { beforeEach, describe, it, mock } from "node:test";
import { deriveCloudCellBearer } from "../../lib/exomem-hosted/cloud-cell-bearer";
import type { ExomemCloudConfig } from "../../lib/exomem-hosted/cloud-config";
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
  | { kind: "unauthorized" };

type StandInCell = {
  server: Server;
  port: number;
  requests: Array<{ method: string | undefined; url: string | undefined; headers: IncomingMessage["headers"] }>;
  close: () => Promise<void>;
};

async function startStandInCell(behavior: StandInCellBehavior): Promise<StandInCell> {
  const requests: StandInCell["requests"] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: { ...req.headers } });
    if (behavior.kind === "unauthorized") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
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
      if (previousHeader === undefined) delete process.env.EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_HEADER;
      else process.env.EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_HEADER = previousHeader;
      if (previousValue === undefined) delete process.env.EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_VALUE;
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
        assert.equal(received["authorization"], `Bearer ${EXPECTED_CELL_BEARER}`);
        assert.ok(typeof received["x-request-id"] === "string" && received["x-request-id"]!.length > 0);
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
          new Response(makeGatedStream(), { status: 200, headers: { "content-type": "text/plain" } })) as typeof fetch,
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

describe("Exomem Cloud protected-resource metadata", () => {
  it("names the Cloud resource and an authorization server, not the hosted one", () => {
    const previous = process.env.EXOMEM_PUBLIC_BASE_URL;
    process.env.EXOMEM_PUBLIC_BASE_URL = "https://substratesystems.io";
    try {
      const metadata = buildCloudProtectedResourceMetadata(TEST_CONFIG);
      assert.equal(metadata.resource, TEST_CLOUD_RESOURCE);
      assert.deepEqual(metadata.authorization_servers, ["https://substratesystems.io/api/exomem/oauth"]);
      // Security review finding 2: a client that discovers the resource
      // before the authorization server must still learn it needs both
      // scopes from this document.
      assert.deepEqual(metadata.scopes_supported, ["exomem.read", "exomem.write", "offline_access"]);
    } finally {
      if (previous === undefined) delete process.env.EXOMEM_PUBLIC_BASE_URL;
      else process.env.EXOMEM_PUBLIC_BASE_URL = previous;
    }
  });
});
