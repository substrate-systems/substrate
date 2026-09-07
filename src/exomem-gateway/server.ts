import { Readable } from "node:stream";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { handleHostedMcpRequest } from "../lib/exomem-hosted/mcp";
import { emitOperationalEvent } from "../lib/exomem-hosted/observability";

const MCP_PATH = "/api/exomem/mcp/v1";
const CACHE_HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  "x-vercel-enable-rewrite-caching": "0",
};
const REQUIRED_GATEWAY_ENV = [
  "DATABASE_URL",
  "EXOMEM_CONTROL_PLANE_KEY",
  "EXOMEM_PUBLIC_BASE_URL",
  "EXOMEM_CELL_PROTOCOL_VERSION",
  "EXOMEM_GATEWAY_CONTROL_HOSTNAME",
  "EXOMEM_GATEWAY_INTERNAL_ORIGIN",
  "EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_HEADER",
  "EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_VALUE",
] as const;

class InvalidNodeRequestError extends Error {}

export type GatewayServerOptions = {
  handleMcp?: typeof handleHostedMcpRequest;
  maxInflight?: number;
};

export function validateGatewayEnvironment(
  environment: Record<string, string | undefined> = process.env
): void {
  const missing = REQUIRED_GATEWAY_ENV.filter((name) => !environment[name]?.trim());
  if (missing.length)
    throw new Error(`Missing required gateway environment: ${missing.join(", ")}`);
}

type GatewayServerState = {
  draining: boolean;
  aborts: Set<AbortController>;
};

const gatewayStates = new WeakMap<Server, GatewayServerState>();

function responseHeaders(response: Response): Record<string, string> {
  return { ...Object.fromEntries(response.headers), ...CACHE_HEADERS };
}

function requestFromNode(request: IncomingMessage, signal: AbortSignal): Request {
  let url: URL;
  try {
    url = new URL(request.url ?? "/", `http://${request.headers.host ?? "gateway.invalid"}`);
  } catch {
    throw new InvalidNodeRequestError();
  }
  return new Request(url, {
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
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      body.removeListener("error", onError);
      target.removeListener("error", onError);
      target.removeListener("finish", onFinish);
      target.removeListener("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error) => settle(error);
    const onFinish = () => settle();
    const onClose = () => {
      body.destroy();
      settle();
    };
    body.once("error", onError);
    target.once("error", onError);
    target.once("finish", onFinish);
    target.once("close", onClose);
    body.pipe(target);
  });
}

export function createGatewayServer(options: GatewayServerOptions = {}): Server {
  const handleMcp =
    options.handleMcp ??
    ((request) => handleHostedMcpRequest(request, { telemetry: emitOperationalEvent }));
  const maxInflight = options.maxInflight ?? Number(process.env.EXOMEM_GATEWAY_MAX_INFLIGHT ?? 16);
  if (!Number.isInteger(maxInflight) || maxInflight < 1 || maxInflight > 128) {
    throw new Error("EXOMEM_GATEWAY_MAX_INFLIGHT must be an integer from 1 to 128");
  }
  let inflight = 0;
  const state: GatewayServerState = { draining: false, aborts: new Set() };
  const server = createServer(async (request, response) => {
    let counted = false;
    let abort: AbortController | undefined;
    try {
      const path = new URL(request.url ?? "/", "http://gateway.invalid").pathname;
      if (path === "/healthz") {
        response.writeHead(200, CACHE_HEADERS).end();
        return;
      }
      if (path === "/readyz") {
        response.writeHead(state.draining ? 503 : 200, CACHE_HEADERS).end();
        return;
      }
      if (path !== MCP_PATH || !["GET", "POST", "DELETE"].includes(request.method ?? "")) {
        response.writeHead(404, CACHE_HEADERS).end();
        return;
      }
      if (state.draining || inflight >= maxInflight) {
        response.writeHead(503, CACHE_HEADERS).end();
        return;
      }
      inflight += 1;
      counted = true;
      const controller = new AbortController();
      abort = controller;
      state.aborts.add(controller);
      const cancel = () => controller.abort();
      request.once("aborted", cancel);
      response.once("close", cancel);
      await writeResponse(await handleMcp(requestFromNode(request, controller.signal)), response);
    } catch (error) {
      if (!response.headersSent)
        response
          .writeHead(error instanceof InvalidNodeRequestError ? 400 : 503, CACHE_HEADERS)
          .end();
      else response.destroy();
    } finally {
      if (counted) inflight -= 1;
      if (abort) state.aborts.delete(abort);
    }
  });
  gatewayStates.set(server, state);
  return server;
}

export async function drainGatewayServer(server: Server, timeoutMs = 25_000): Promise<void> {
  const state = gatewayStates.get(server);
  if (state) state.draining = true;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      for (const abort of state?.aborts ?? []) abort.abort();
      server.closeAllConnections();
      finish();
    }, timeoutMs);
    server.close(() => {
      finish();
    });
  });
}
