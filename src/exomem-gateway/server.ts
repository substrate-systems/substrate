import { Readable } from "node:stream";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { handleHostedMcpRequest } from "../lib/exomem-hosted/mcp";

const MCP_PATH = "/api/exomem/mcp/v1";
const CACHE_HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  "x-vercel-enable-rewrite-caching": "0",
};

export type GatewayServerOptions = {
  handleMcp?: typeof handleHostedMcpRequest;
  maxInflight?: number;
};

function responseHeaders(response: Response): Record<string, string> {
  return { ...Object.fromEntries(response.headers), ...CACHE_HEADERS };
}

function requestFromNode(request: IncomingMessage, signal: AbortSignal): Request {
  const origin = `http://${request.headers.host ?? "gateway.invalid"}`;
  return new Request(new URL(request.url ?? "/", origin), {
    method: request.method,
    headers: request.headers as HeadersInit,
    body:
      request.method === "GET" || request.method === "HEAD" ? undefined : Readable.toWeb(request),
    duplex: "half",
    signal,
  } as RequestInit);
}

async function writeResponse(response: Response, target: ServerResponse): Promise<void> {
  target.writeHead(response.status, responseHeaders(response));
  if (!response.body) {
    target.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const body = Readable.fromWeb(response.body as never);
    body.on("error", reject);
    target.on("error", reject);
    target.on("finish", resolve);
    body.pipe(target);
  });
}

export function createGatewayServer(options: GatewayServerOptions = {}): Server {
  const handleMcp = options.handleMcp ?? handleHostedMcpRequest;
  const maxInflight = options.maxInflight ?? Number(process.env.EXOMEM_GATEWAY_MAX_INFLIGHT ?? 16);
  if (!Number.isInteger(maxInflight) || maxInflight < 1 || maxInflight > 128) {
    throw new Error("EXOMEM_GATEWAY_MAX_INFLIGHT must be an integer from 1 to 128");
  }
  let draining = false;
  let inflight = 0;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://gateway.invalid").pathname;
    if (path === "/healthz" || path === "/readyz") {
      response.writeHead(200, CACHE_HEADERS).end();
      return;
    }
    if (path !== MCP_PATH || !["GET", "POST", "DELETE"].includes(request.method ?? "")) {
      response.writeHead(404, CACHE_HEADERS).end();
      return;
    }
    if (draining || inflight >= maxInflight) {
      response.writeHead(503, CACHE_HEADERS).end();
      return;
    }
    inflight += 1;
    const abort = new AbortController();
    const cancel = () => abort.abort();
    request.once("aborted", cancel);
    response.once("close", cancel);
    try {
      await writeResponse(await handleMcp(requestFromNode(request, abort.signal)), response);
    } catch {
      if (!response.headersSent) response.writeHead(503, CACHE_HEADERS).end();
      else response.destroy();
    } finally {
      inflight -= 1;
      request.removeListener("aborted", cancel);
      response.removeListener("close", cancel);
    }
  });
  server.on("close", () => {
    draining = true;
  });
  return server;
}

export async function drainGatewayServer(server: Server, timeoutMs = 25_000): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    server.close(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
