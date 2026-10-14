import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { runFunctionalHealthCheck } from "../lib/exomem-hosted/functional-health";

// The pinned edit/read protocol fixes these result fields and the replace_body operation.
const Preview = z.object({
  path: z.string().min(1),
  validate_only: z.literal(true),
  semantic: z
    .object({
      transition_token: z.string().min(1),
      relation_review_hash: z.string().min(1),
    })
    .nullable()
    .optional(),
});
const Written = z.object({ path: z.string().min(1) });
const Read = z.object({ body: z.string() });

export type MemoryHealthConfig = {
  url: string;
  bearer: string;
  page: string;
  bodyTemplate: string;
  timeoutMs: number;
};

export function loadMemoryHealthConfig(): MemoryHealthConfig {
  const config = z
    .object({
      url: z.url(),
      bearer: z.string().min(1),
      page: z.string().min(1),
      bodyTemplate: z.string().min(1).max(32_000),
      timeoutMs: z.coerce.number().int().min(100).max(20_000),
    })
    .parse({
      url: process.env.EXOMEM_HEALTH_MEMORY_MCP_URL,
      bearer: process.env.EXOMEM_HEALTH_MEMORY_BEARER,
      page: process.env.EXOMEM_HEALTH_MEMORY_PAGE,
      bodyTemplate: process.env.EXOMEM_HEALTH_MEMORY_BODY_TEMPLATE,
      timeoutMs: process.env.EXOMEM_HEALTH_MEMORY_TIMEOUT_MS ?? 15_000,
    });
  // The nonce placeholder is a fixed synthetic protocol token; the page vocabulary stays configuration.
  if (!config.bodyTemplate.includes("{{nonce}}"))
    throw new Error("HEALTH_NONCE_PLACEHOLDER_REQUIRED");
  return config;
}

export async function proveMemoryRoundTrip(config: MemoryHealthConfig): Promise<boolean> {
  const nonce = randomUUID();
  const body = config.bodyTemplate.split("{{nonce}}").join(nonce);
  const deadline = AbortSignal.timeout(config.timeoutMs);
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: { authorization: `Bearer ${config.bearer}` } },
    fetch: async (url, init) => {
      const response = await fetch(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.any([deadline, ...(init?.signal ? [init.signal] : [])]),
      });
      if (!response.body) return response;
      let bytes = 0;
      const boundedBody = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            bytes += chunk.byteLength;
            if (bytes > 256 * 1024) throw new Error("HEALTH_MEMORY_RESPONSE_TOO_LARGE");
            controller.enqueue(chunk);
          },
        })
      );
      return new Response(boundedBody, { status: response.status, headers: response.headers });
    },
    reconnectionOptions: {
      maxRetries: 0,
      maxReconnectionDelay: 0,
      initialReconnectionDelay: 0,
      reconnectionDelayGrowFactor: 1,
    },
  });
  const client = new Client({ name: "exomem-functional-health", version: "1" });
  const requestOptions = { signal: deadline, timeout: config.timeoutMs };
  async function call(name: string, arguments_: Record<string, unknown>): Promise<unknown> {
    const result = await client.callTool(
      { name, arguments: arguments_ },
      undefined,
      requestOptions
    );
    if (result.isError) throw new Error("HEALTH_MEMORY_TOOL_FAILED");
    // The kernel's registered edit/read tools publish their data directly as structuredContent.
    return result.structuredContent;
  }
  try {
    await client.connect(transport, requestOptions);
    const operation = { kind: "replace_body", new_body: body };
    const arguments_ = {
      path: config.page,
      why: "Refresh the isolated functional health nonce.",
      operation,
    };
    const preview = Preview.parse(
      await call("edit_memory", {
        ...arguments_,
        operation: { ...operation, validate_only: true },
      })
    );
    // These reviewed_none fields are the kernel's closed edit transition protocol.
    const review = preview.semantic
      ? {
          transition_token: preview.semantic.transition_token,
          relation_disposition: "reviewed_none",
          relation_review_hash: preview.semantic.relation_review_hash,
          relation_review_reason: "The isolated synthetic nonce adds no relation to other memory.",
        }
      : {};
    Written.parse(
      await call("edit_memory", { ...arguments_, operation: { ...operation, ...review } })
    );
    const read = Read.parse(await call("read_memory", { path: config.page }));
    return read.body.trim() === body.trim();
  } finally {
    await client.close();
  }
}

export function runMemoryHealthCheck(): Promise<boolean> {
  return runFunctionalHealthCheck("memory", () => proveMemoryRoundTrip(loadMemoryHealthConfig()));
}
