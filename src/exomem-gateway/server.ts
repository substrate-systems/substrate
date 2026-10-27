import { Readable } from "node:stream";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  buildCloudProtectedResourceMetadata,
  handleCloudDownloadRequest,
  handleCloudMcpRequest,
  handleCloudUploadRequest,
} from "./cloud-handler";
import { CLOUD_DOWNLOAD_PATH, CLOUD_UPLOAD_PATH } from "./cloud-origin";
import { functionalHealthResponse } from "../lib/exomem-hosted/functional-health";
import { loadExomemCloudConfig } from "../lib/exomem-hosted/cloud-config";

const CACHE_HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  "x-vercel-enable-rewrite-caching": "0",
};
const REQUIRED_GATEWAY_ENV = [
  "DATABASE_URL",
  "EXOMEM_CONTROL_PLANE_KEY",
  "EXOMEM_PUBLIC_BASE_URL",
  "EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_HEADER",
  "EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_VALUE",
  // The gateway serves only the Cloud resource, so without these it would
  // report ready and answer every request with 404 or 503.
  "EXOMEM_CLOUD_MCP_URL",
  "EXOMEM_CLOUD_MCP_PATH",
  "EXOMEM_CLOUD_CELL_TOKEN_KEY",
] as const;

class InvalidNodeRequestError extends Error {}

export type GatewayServerOptions = {
  handleCloudMcp?: typeof handleCloudMcpRequest;
  handleCloudUpload?: typeof handleCloudUploadRequest;
  handleCloudDownload?: typeof handleCloudDownloadRequest;
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

const UPLOAD_REQUEST_TIMEOUT_MS = 900_000;

export function createGatewayServer(options: GatewayServerOptions = {}): Server {
  const handleCloudMcp = options.handleCloudMcp ?? handleCloudMcpRequest;
  const handleCloudUpload = options.handleCloudUpload ?? handleCloudUploadRequest;
  const handleCloudDownload = options.handleCloudDownload ?? handleCloudDownloadRequest;
  // validateGatewayEnvironment requires this at startup; without it the
  // server answers only its probes.
  const cloudMcpPath = process.env.EXOMEM_CLOUD_MCP_PATH?.trim() || null;
  const cloudMetadataPath = cloudMcpPath
    ? `/.well-known/oauth-protected-resource${cloudMcpPath}`
    : null;
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
      if (path === "/healthz/canary" && request.method === "GET") {
        await writeResponse(await functionalHealthResponse("memory"), response);
        return;
      }
      if (path === "/healthz") {
        response.writeHead(200, CACHE_HEADERS).end();
        return;
      }
      if (path === "/readyz") {
        response.writeHead(state.draining ? 503 : 200, CACHE_HEADERS).end();
        return;
      }
      if (cloudMetadataPath && path === cloudMetadataPath) {
        if (request.method !== "GET") {
          response.writeHead(404, CACHE_HEADERS).end();
          return;
        }
        const body = JSON.stringify(buildCloudProtectedResourceMetadata(loadExomemCloudConfig()));
        response.writeHead(200, { ...CACHE_HEADERS, "content-type": "application/json" }).end(body);
        return;
      }
      // The upload and download handlers answer 404 themselves unless a cell is selected.
      const handle =
        cloudMcpPath &&
        path === cloudMcpPath &&
        ["GET", "POST", "DELETE"].includes(request.method ?? "")
          ? handleCloudMcp
          : cloudMcpPath && path === CLOUD_UPLOAD_PATH && request.method === "POST"
            ? handleCloudUpload
            : cloudMcpPath && path === CLOUD_DOWNLOAD_PATH && request.method === "GET"
              ? handleCloudDownload
              : null;
      if (!handle) {
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
      await writeResponse(await handle(requestFromNode(request, controller.signal)), response);
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
  // Node's 300 s default would cut a 100 MiB upload slower than about 2.8 Mbit/s.
  // 900 s matches the read timeout the platform chart requires on the Cloud ingress.
  server.requestTimeout = UPLOAD_REQUEST_TIMEOUT_MS;
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
