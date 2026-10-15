import { z } from "zod";
import { safeErrorResponse, exomemErrors, ExomemHostedError } from "./errors";
import { PRIVATE_NO_STORE_HEADERS, readBoundedJsonRequest } from "./http";
import { resolveExomemSession, validateMutationRequest } from "./sessions";
import {
  callCloudViewerTool,
  type CloudHomeDependencies,
  type CloudViewerToolCall,
} from "./cloud-home-mcp";
import type { EnvironmentSource } from "./cloud-config";

const HEADERS = { ...PRIVATE_NO_STORE_HEADERS, "referrer-policy": "no-referrer" };
const Timestamp = z.iso.datetime({ offset: true });
const Count = z.number().int().nonnegative();
const Identity = z
  .object({ instance: z.string(), definition_key: z.string() })
  .catchall(z.unknown());

// The bounded cell map fixes these coverage states and transport ceilings.
const ViewerMap = z
  .object({
    state: z.enum(["complete", "partial", "unavailable"]),
    available: z.boolean(),
    reason: z.string().nullable(),
    snapshot: z.record(z.string(), z.string()).nullable(),
    observed_at: Timestamp,
    nodes: z
      .array(
        z.object({
          node_key: z.string().min(1),
          kind: z.literal("file"),
          path: z.string().min(1),
          title: z.string(),
          source_hash: z.string().nullable(),
          incoming_edges: Count.nullable(),
          memory_ref: z.string().nullable(),
          page_type: z.string().nullable().optional(),
          origin_date: z.string().nullable().optional(),
          updated_date: z.string().nullable().optional(),
        })
      )
      .max(200),
    edges: z
      .array(
        z.object({
          edge_key: z.string(),
          src_key: z.string(),
          dst_key: z.string(),
          relation_type: z.string(),
          source_path: z.string(),
          relation_identity: Identity,
        })
      )
      .max(400),
    vocabulary: z
      .array(
        Identity.extend({
          description: z.string(),
          family: z.string(),
          direction: z.string(),
          presentation_role: z.string().nullable().optional(),
        })
      )
      .max(400),
    counts: z.object({
      eligible_nodes: Count.nullable(),
      eligible_edges: Count.nullable(),
      observed_nodes: Count,
      observed_edges: Count,
      drawn_nodes: Count,
      drawn_edges: Count,
    }),
    ranking_complete: z.boolean(),
    truncation: z.array(
      z.object({ stage: z.string(), reason: z.string(), limit: z.number().nullable() })
    ),
  })
  .superRefine((map, context) => {
    if (map.counts.drawn_nodes !== map.nodes.length || map.counts.drawn_edges !== map.edges.length)
      context.addIssue({ code: "custom", message: "drawing counts differ from returned items" });
    // Invalid drawing identities would crash placement or join unrelated notes; return unavailable instead.
    const keys = new Set(map.nodes.map((node) => node.node_key));
    if (
      keys.size !== map.nodes.length ||
      map.edges.some((edge) => !keys.has(edge.src_key) || !keys.has(edge.dst_key))
    )
      context.addIssue({ code: "custom", message: "drawing identities do not form one graph" });
    if (
      map.state === "partial" &&
      (map.counts.eligible_nodes !== null || map.counts.eligible_edges !== null)
    )
      context.addIssue({ code: "custom", message: "partial coverage cannot claim exact totals" });
  });
export type ViewerMapView = z.infer<typeof ViewerMap>;

const PageHit = z.object({
  path: z.string().min(1),
  title: z.string().nullable().optional(),
  ref: z.string().nullable().optional(),
  excerpt: z.string().optional(),
});
const UnitHit = z
  .object({
    result_type: z.literal("semantic_unit"),
    parent_path: z.string().min(1),
    parent_title: z.string().nullable().optional(),
    parent_ref: z.string().nullable().optional(),
    excerpt: z.string(),
  })
  .transform((hit) => ({
    path: hit.parent_path,
    title: hit.parent_title,
    ref: hit.parent_ref,
    excerpt: hit.excerpt,
  }));
const Hits = z.array(z.union([PageHit, UnitHit])).max(20);
const SearchEnvelope = z.object({
  hits: Hits,
  continuation: z.string().nullable().optional(),
  warming: z
    .object({ components: z.array(z.string()) })
    .nullable()
    .optional(),
  degraded: z.array(z.string()).nullable().optional(),
  budget: z
    .object({ skipped: z.array(z.string()), truncated: z.array(z.string()) })
    .nullable()
    .optional(),
});
// FastMCP wraps ask_memory's array-or-envelope return annotation under `result`.
const SearchAnswer = z
  .object({
    result: z.preprocess(
      (value) => (Array.isArray(value) ? { hits: value } : value),
      SearchEnvelope
    ),
  })
  .transform(({ result: answer }) => ({
    hits: answer.hits,
    continuation: answer.continuation ?? null,
    partial: Boolean(
      answer.warming?.components.length ||
      answer.degraded?.length ||
      answer.budget?.skipped.length ||
      answer.budget?.truncated.length
    ),
  }));
export type ViewerSearch = z.infer<typeof SearchAnswer>;
const NoteAnswer = z.object({
  path: z.string(),
  body: z.string(),
  ref: z.string().nullable().optional(),
  frontmatter: z.record(z.string(), z.unknown()),
  content_hash: z.string(),
  mtime: z.number().optional(),
  links: z.unknown().optional(),
});
export type ViewerNote = z.infer<typeof NoteAnswer>;

const MapBody = z.strictObject({ tenantId: z.uuid().optional() });
const SearchBody = z.strictObject({
  tenantId: z.uuid(),
  query: z.string().trim().min(1).max(2048),
  continuation: z.string().max(16_384).optional(),
});
const ReadBody = z.strictObject({ tenantId: z.uuid(), ref: z.string().min(1).max(4096) });
type ViewerOperation = "map" | "search" | "read";

/** This flag hides the new viewer until its cell command is available. */
export function cloudViewerEnabled(env: EnvironmentSource = process.env): boolean {
  return env.EXOMEM_CLOUD_VIEWER_ENABLED?.trim().toLowerCase() === "true";
}

function respond(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: HEADERS });
}

/** Three server-selected reads; no browser field can select a cell operation. */
export async function handleCloudViewerRequest(
  request: Request,
  operation: ViewerOperation,
  dependencies: CloudHomeDependencies = {}
): Promise<Response> {
  try {
    if (!cloudViewerEnabled(dependencies.env))
      throw new ExomemHostedError({ code: "NOT_FOUND", status: 404, message: "not found" });
    const session = await resolveExomemSession(request);
    validateMutationRequest(request, session);
    const body = await readBoundedJsonRequest(request, 24 * 1024);
    const parsed =
      operation === "map"
        ? MapBody.safeParse(body)
        : operation === "search"
          ? SearchBody.safeParse(body)
          : ReadBody.safeParse(body);
    if (!parsed.success) throw exomemErrors.invalidRequest();
    // This value only detects an account change; the session always supplies authority.
    if (parsed.data.tenantId !== undefined && parsed.data.tenantId !== session.tenantId)
      throw new ExomemHostedError({
        code: "VIEWER_ACCOUNT_CHANGED",
        status: 403,
        message: "the account changed",
      });

    let call: CloudViewerToolCall;
    if (operation === "map")
      call = { name: "viewer_map", arguments: { max_nodes: 200, max_edges: 400 } };
    else if (operation === "search") {
      const input = SearchBody.parse(parsed.data);
      call = {
        name: "ask_memory",
        arguments: {
          query: input.query,
          limit: 20,
          detail: "compact",
          deep: false,
          graph_enrich: false,
          ...(input.continuation ? { continuation: input.continuation } : {}),
        },
      };
    } else
      call = {
        name: "read_memory",
        arguments: { path: ReadBody.parse(parsed.data).ref, links: true, include_raw: false },
      };

    const answer = await callCloudViewerTool(session, call, dependencies);
    if (answer.kind !== "result")
      return respond({ tenantId: session.tenantId, state: "unavailable" }, 503);
    const value =
      operation === "map"
        ? ViewerMap.safeParse(answer.value)
        : operation === "search"
          ? SearchAnswer.safeParse(answer.value)
          : NoteAnswer.safeParse(answer.value);
    if (!value.success) return respond({ tenantId: session.tenantId, state: "unavailable" }, 503);
    if (operation === "map" && "available" in value.data && !value.data.available)
      return respond({ tenantId: session.tenantId, state: "unavailable" }, 503);
    return respond({ tenantId: session.tenantId, state: "live", value: value.data });
  } catch (error) {
    const response = safeErrorResponse(error);
    for (const [key, value] of Object.entries(HEADERS)) response.headers.set(key, value);
    return response;
  }
}
