/**
 * The Cloud transfer tools (`serve-cloud-transfer-tools`): `observe_transfer`
 * and `transfer_memory`. Exomem's registry declares them for a Cloud cell, but
 * the control plane owns the data they touch. The gateway answers a call by
 * asking the Substrate web API, with the caller's own bearer, and never lets a
 * file byte, an upload URL, a recipient or an export link into a tool result.
 *
 * This module has no Next.js import (scripts/verify-exomem-gateway-bundle.mjs).
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { cloudExportReply, type CloudExport } from "../lib/exomem/cloud-export-contract";
import {
  cloudImportFinished,
  cloudImportReply,
  stagedImportFolder,
  type CloudImport,
} from "../lib/exomem/cloud-import-contract";
import { HOME_YOUR_DATA_ANCHOR } from "../lib/exomem/home-anchors";
import { readBoundedJsonRequest } from "../lib/exomem-hosted/bounded-json";
import type { OAuthClientContext } from "../lib/exomem-hosted/oauth-client-identity";
import { exomemHomeUrl } from "../lib/exomem-hosted/public-origin";
import {
  CLOUD_ARTIFACT_MAX_BYTES,
  CLOUD_ARTIFACT_MAX_FILES,
  CLOUD_ARTIFACT_TOOLS,
} from "./cloud-artifacts";
import { CLOUD_TRANSFER_TOOLS } from "./cloud-transfer-tools.generated";

const CONTROL_PLANE_TIMEOUT_MS = 8_000;
// An import status carries one upload URL per part; the answer stays far below this.
const MAX_CONTROL_PLANE_ANSWER_BYTES = 1024 * 1024;
const IMPORTS_PATH = "/api/exomem/cloud/imports";
const EXPORTS_PATH = "/api/exomem/cloud/exports";
// The `exomem cloud` CLI's program name and subcommands, which the Exomem repo owns.
const CLI_PREFIX = ["uvx", "exomem", "cloud"] as const;

type ToolName = keyof typeof CLOUD_TRANSFER_TOOLS;
type JsonRpcId = string | number;
/** Fixed hints for an agent; the error `message` carries the detail. */
type Remediation = "retry" | "fix_arguments" | "confirm" | "reconnect" | "see_message";
type ToolError = { code: string; message: string; remediation: Remediation };
type Outcome<T> = { ok: true; value: T } | { ok: false; error: ToolError };

export type CloudTransferCall = { id: JsonRpcId; tool: ToolName; arguments: unknown };

export type CloudTransferEnvironment = {
  /** The caller's own access token: the only credential sent to the web API. */
  bearer: string;
  mcpUrl: string;
  /** Throws when the public base URL is not configured as an https origin. */
  publicBaseUrl: () => string;
  clientContext: OAuthClientContext;
  /** Whether the gateway signs artifact grants for the caller's cell. */
  attachmentsEnabled: boolean;
  fetchControlPlane: typeof fetch;
};

type CloudTransferContext = Omit<CloudTransferEnvironment, "publicBaseUrl"> & {
  publicBaseUrl: string;
};

/**
 * The call the gateway serves, or null when the cell must see the request
 * (a batch, a notification, another method, another tool, or a header that
 * disagrees with the body, which the cell refuses itself).
 */
export function parseCloudTransferCall(
  body: Uint8Array,
  headers: Headers
): CloudTransferCall | null {
  let message: unknown;
  try {
    message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return null;
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const { jsonrpc, id, method, params } = message as Record<string, unknown>;
  // Beyond 2^53 a JSON number no longer echoes exactly, so the cell answers that call.
  const echoable = typeof id === "string" || (typeof id === "number" && Number.isSafeInteger(id));
  if (jsonrpc !== "2.0" || method !== "tools/call" || !echoable) return null;
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const { name, arguments: args } = params as Record<string, unknown>;
  if (typeof name !== "string" || !Object.hasOwn(CLOUD_TRANSFER_TOOLS, name)) return null;
  const nameHeader = headers.get("mcp-name");
  const methodHeader = headers.get("mcp-method");
  if (nameHeader !== null && nameHeader !== name) return null;
  if (methodHeader !== null && methodHeader !== method) return null;
  return { id, tool: name as ToolName, arguments: args };
}

/** The JSON-RPC response for an intercepted call; it never throws. */
export async function answerCloudTransferCall(
  call: CloudTransferCall,
  environment: CloudTransferEnvironment
): Promise<unknown> {
  let structured: Record<string, unknown>;
  try {
    let publicBaseUrl: string;
    try {
      publicBaseUrl = environment.publicBaseUrl();
    } catch {
      return frame(call.id, failure(unavailable(call.tool, "public_base_url")));
    }
    structured = await dispatch(call, { ...environment, publicBaseUrl });
  } catch {
    structured = failure(unavailable(call.tool, "unexpected"));
  }
  return frame(call.id, structured);
}

function frame(id: JsonRpcId, structured: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(structured) }],
      structuredContent: structured,
      isError: false,
      resultType: "complete",
    },
  };
}

// --- Arguments ------------------------------------------------------------

const Uuid = z.uuid().transform((value) => value.toLowerCase());
const ObserveArguments = z.strictObject({
  action: z.enum(CLOUD_TRANSFER_TOOLS.observe_transfer).default("status"),
  import_id: Uuid.optional(),
});
const TransferArguments = z.strictObject({
  action: z.enum(CLOUD_TRANSFER_TOOLS.transfer_memory),
  import_id: Uuid.optional(),
  export_id: Uuid.optional(),
  confirm: z.boolean().default(false),
});

function parseArguments<S extends z.ZodType>(schema: S, value: unknown): Outcome<z.output<S>> {
  const parsed = schema.safeParse(value ?? {});
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  return invalid(`${issue?.path.join(".") || "arguments"}: ${issue?.message ?? "not valid"}`);
}

function invalid(message: string): { ok: false; error: ToolError } {
  return { ok: false, error: { code: "INVALID_ARGUMENTS", message, remediation: "fix_arguments" } };
}

// --- Results --------------------------------------------------------------

function failure(error: ToolError, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { success: false, error, ...extra };
}

function unavailable(tool: ToolName, reason: string): ToolError {
  // A reason code only: neither the bearer, a URL nor an answer body reaches the log.
  console.warn({ event: "exomem_cloud_transfer_tool_unavailable", tool, reason });
  return {
    code: "CONTROL_PLANE_UNAVAILABLE",
    message: "the Exomem control plane did not answer; no change was confirmed",
    remediation: "retry",
  };
}

async function dispatch(
  call: CloudTransferCall,
  context: CloudTransferContext
): Promise<Record<string, unknown>> {
  switch (call.tool) {
    case "observe_transfer": {
      const args = parseArguments(ObserveArguments, call.arguments);
      if (!args.ok) return failure(args.error);
      // The switch is exhaustive over the generated actions: Exomem adding one is a compile error here.
      switch (args.value.action) {
        case "status":
          return status(args.value.import_id, context);
        case "import_handoff":
          return importHandoff(context);
        default:
          return args.value.action satisfies never;
      }
    }
    case "transfer_memory": {
      const args = parseArguments(TransferArguments, call.arguments);
      if (!args.ok) return failure(args.error);
      const { action, import_id: importId, export_id: exportId, confirm } = args.value;
      switch (action) {
        case "import_cancel":
        case "import_discard":
          if (importId === undefined || exportId !== undefined) {
            return failure(invalid(`${action} takes import_id and no export_id`).error);
          }
          return action === "import_cancel"
            ? cancelImport(importId, context)
            : discardImport(importId, confirm, context);
        case "export_request":
          if (importId !== undefined) {
            return failure(invalid("export_request takes no import_id").error);
          }
          return requestExport(exportId, confirm, context);
        default:
          return action satisfies never;
      }
    }
    default:
      return call.tool satisfies never;
  }
}

// --- Views ----------------------------------------------------------------

function importView(operation: CloudImport) {
  const view = {
    import_id: operation.import_id,
    kind: operation.kind,
    declared_bytes: operation.declared_bytes,
    declared_files: operation.declared_files,
    requested_state: operation.requested_state,
    observed_state: operation.observed_state,
    error_code: operation.error_code,
    created_at: operation.created_at,
    updated_at: operation.updated_at,
  };
  // C5 stages an adopt import's files for review; "adopt" and Adoption Studio are its fixed names.
  if (
    operation.kind === "adopt" &&
    operation.observed_state === "done" &&
    operation.requested_state !== "discard_requested"
  ) {
    const folder = stagedImportFolder(operation.import_id);
    return {
      ...view,
      staged_folder: folder,
      next: { tool: "adoption_studio", arguments: { action: "start", path: folder } },
    };
  }
  return view;
}

function homeUrl(context: CloudTransferContext): string {
  return exomemHomeUrl(context.publicBaseUrl, HOME_YOUR_DATA_ANCHOR);
}

function exportView(summary: CloudExport, context: CloudTransferContext) {
  const view = {
    state: summary.state,
    export_id: summary.export_id ?? null,
    requested_at: summary.requested_at ?? null,
    ready_at: summary.ready_at ?? null,
    expires_at: summary.expires_at ?? null,
    archive_bytes: summary.archive_bytes ?? null,
    error_code: summary.error_code ?? null,
    pauses_assistants: summary.pauses_assistants,
  };
  if (summary.state !== "ready") return view;
  return {
    ...view,
    // The link itself is never in a tool result: the owner's CLI asks the web API for it.
    download: {
      home_url: homeUrl(context),
      cli_argv: [
        ...CLI_PREFIX,
        "export",
        "--out",
        "<directory>",
        "--export-id",
        summary.export_id,
        "--mcp-url",
        context.mcpUrl,
        "--api-base-url",
        context.publicBaseUrl,
      ],
    },
  };
}

function importRoutes(context: CloudTransferContext) {
  const connection = ["--mcp-url", context.mcpUrl, "--api-base-url", context.publicBaseUrl];
  const cli = {
    kind: "cli",
    argv_folder: [...CLI_PREFIX, "import", "<folder>", ...connection],
    argv_zip: [
      ...CLI_PREFIX,
      "import",
      "<file.zip>",
      "--scope",
      "<scope>",
      "--category",
      "<category>",
      ...connection,
    ],
  };
  const browser = { kind: "browser", home_url: homeUrl(context) };
  // A coding client runs the CLI on the owner's machine; a conversational one sends the owner to Home.
  const routes: object[] = context.clientContext === "coding" ? [cli, browser] : [browser, cli];
  if (context.attachmentsEnabled) {
    routes.push({
      kind: "attachments",
      tools: [...CLOUD_ARTIFACT_TOOLS],
      max_files: CLOUD_ARTIFACT_MAX_FILES,
      max_bytes: CLOUD_ARTIFACT_MAX_BYTES,
    });
  }
  return routes;
}

// --- Control plane --------------------------------------------------------

type WebReply = { status: number; body: unknown };

const WebError = z.object({
  error: z.object({
    code: z.string().min(1).max(64),
    message: z.string().max(300),
    remediation: z.string().max(64).optional(),
    retryable: z.boolean().optional(),
  }),
});

/** One call to the web API with the caller's bearer; null when no usable answer came back. */
async function callWeb(
  tool: ToolName,
  context: CloudTransferContext,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<WebReply | null> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${context.bearer}`,
    accept: "application/json",
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await context.fetchControlPlane(new URL(path, context.publicBaseUrl), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(CONTROL_PLANE_TIMEOUT_MS),
      // The bearer goes to the configured web origin and nowhere a redirect points.
      redirect: "error",
    });
  } catch {
    unavailable(tool, "transport");
    return null;
  }
  if (response.status >= 500) {
    // Not awaited: the answer is already known and an unread body must not delay it.
    void response.body?.cancel().catch(() => undefined);
    unavailable(tool, `http_${response.status}`);
    return null;
  }
  try {
    return {
      status: response.status,
      body: await readBoundedJsonRequest(response, MAX_CONTROL_PLANE_ANSWER_BYTES),
    };
  } catch {
    // A 404 may carry no JSON at all; the caller reads the status first.
    return response.status === 404 ? { status: 404, body: undefined } : null;
  }
}

/** The web API's own refusal, with its code and message, as a tool error. */
function relayedError(reply: WebReply): ToolError {
  const refusal = WebError.safeParse(reply.body);
  if (!refusal.success) {
    return {
      code: "CONTROL_PLANE_REFUSED",
      message: `the Exomem control plane refused the request (HTTP ${reply.status})`,
      remediation: "see_message",
    };
  }
  const { code, message, remediation, retryable } = refusal.data.error;
  const hint: Remediation =
    remediation === "retry_later" || retryable
      ? "retry"
      : reply.status === 401 || reply.status === 403
        ? "reconnect"
        : "see_message";
  return { code, message, remediation: hint };
}

/** A successful answer read through its schema, or the tool error that replaces it. */
function readOutcome<S extends z.ZodType>(
  tool: ToolName,
  reply: WebReply | null,
  schema: S
): Outcome<z.output<S>> {
  if (reply === null) return { ok: false, error: unavailable(tool, "no_answer") };
  if (reply.status < 200 || reply.status >= 300) return { ok: false, error: relayedError(reply) };
  const parsed = schema.safeParse(reply.body);
  if (!parsed.success) return { ok: false, error: unavailable(tool, "answer_shape") };
  return { ok: true, value: parsed.data };
}

const exportsNotOffered: ToolError = {
  code: "EXPORTS_NOT_OFFERED",
  message: "exports are not offered on this account yet",
  remediation: "see_message",
};

async function readImport(tool: ToolName, context: CloudTransferContext, importId?: string) {
  const reply = await callWeb(
    tool,
    context,
    "GET",
    importId ? `${IMPORTS_PATH}/${importId}` : IMPORTS_PATH
  );
  return readOutcome(tool, reply, cloudImportReply);
}

async function readExport(tool: ToolName, context: CloudTransferContext) {
  const reply = await callWeb(tool, context, "GET", EXPORTS_PATH);
  if (reply?.status === 404) return { ok: false, error: exportsNotOffered } as const;
  return readOutcome(tool, reply, cloudExportReply);
}

// --- observe_transfer -----------------------------------------------------

async function status(importId: string | undefined, context: CloudTransferContext) {
  const tool = "observe_transfer";
  // The import half and the export half fail independently.
  const [operation, exported] = await Promise.all([
    readImport(tool, context, importId),
    readExport(tool, context),
  ]);
  return {
    success: true,
    action: "status",
    as_of: new Date().toISOString(),
    import: !operation.ok
      ? { error: operation.error }
      : operation.value.import
        ? importView(operation.value.import)
        : null,
    export: exported.ok
      ? exportView(exported.value.export, context)
      : exported.error === exportsNotOffered
        ? { state: "unavailable", code: exportsNotOffered.code }
        : { error: exported.error },
  };
}

async function importHandoff(context: CloudTransferContext) {
  const operation = await readImport("observe_transfer", context);
  if (!operation.ok) return failure(operation.error);
  // The newest-first status prefers unfinished work, so an import that is finished means none is open.
  const latest = operation.value.import;
  return {
    success: true,
    action: "import_handoff",
    open_import: latest && !cloudImportFinished(latest) ? importView(latest) : null,
    routes: importRoutes(context),
  };
}

// --- transfer_memory ------------------------------------------------------

async function cancelImport(importId: string, context: CloudTransferContext) {
  const reply = await callWeb(
    "transfer_memory",
    context,
    "POST",
    `${IMPORTS_PATH}/${importId}/cancel`
  );
  const operation = readOutcome("transfer_memory", reply, cloudImportReply);
  if (!operation.ok) return failure(operation.error);
  if (!operation.value.import) return failure(unavailable("transfer_memory", "answer_shape"));
  return { success: true, action: "import_cancel", import: importView(operation.value.import) };
}

async function discardImport(importId: string, confirm: boolean, context: CloudTransferContext) {
  const tool = "transfer_memory";
  if (!confirm) {
    const operation = await readImport(tool, context, importId);
    if (!operation.ok) return failure(operation.error);
    if (!operation.value.import) return failure(unavailable(tool, "answer_shape"));
    return failure(
      {
        code: "UNCONFIRMED",
        message:
          "discarding permanently deletes the staged originals of this import; " +
          "call again with confirm true once the user agrees",
        remediation: "confirm",
      },
      { import: importView(operation.value.import) }
    );
  }
  const reply = await callWeb(tool, context, "POST", `${IMPORTS_PATH}/${importId}/discard`);
  const operation = readOutcome(tool, reply, cloudImportReply);
  if (!operation.ok) return failure(operation.error);
  if (!operation.value.import) return failure(unavailable(tool, "answer_shape"));
  return { success: true, action: "import_discard", import: importView(operation.value.import) };
}

async function requestExport(
  requestedId: string | undefined,
  confirm: boolean,
  context: CloudTransferContext
) {
  const tool = "transfer_memory";
  const exportId = requestedId ?? randomUUID();
  if (!confirm) {
    const current = await readExport(tool, context);
    if (!current.ok) return failure(current.error);
    const { state, export_id: currentId, pauses_assistants: pauses } = current.value.export;
    return failure(
      {
        code: "UNCONFIRMED",
        message:
          "an export pauses the assistants of this account while it packs and replaces a ready " +
          "export; call again with confirm true and this export_id once the user agrees",
        remediation: "confirm",
      },
      {
        effects: {
          pauses_assistants: pauses,
          supersedes_export_id: state === "ready" ? (currentId ?? null) : null,
        },
        export_id: exportId,
      }
    );
  }
  const reply = await callWeb(tool, context, "POST", EXPORTS_PATH, { export_id: exportId });
  if (reply?.status === 404) return failure(exportsNotOffered);
  const started = readOutcome(tool, reply, cloudExportReply);
  if (!started.ok) return failure(started.error);
  return {
    success: true,
    action: "export_request",
    export: exportView(started.value.export, context),
  };
}
