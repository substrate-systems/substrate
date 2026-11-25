// A stand-in for the Cloud gateway and the cell behind it, for Home's end-to-end
// tests. The web server calls it exactly as it calls the real gateway: one MCP
// `tools/call` POST with a short-lived bearer. Like the gateway, it resolves the
// bearer with the real token lookup against the database, so each call reaches only
// the token's own tenant. Behind that, each tenant gets a small in-memory cell with
// the levels and activity the tests set through /__control.

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer } from "node:https";
import { findCloudOAuthAccessToken } from "../../src/lib/exomem-hosted/cloud-oauth";
import { digestSecret } from "../../src/lib/exomem-hosted/security";
import { fakePaddle } from "./fake-paddle";

type Level = "off" | "light" | "balanced" | "maximal";
type ContextLevel = { level: Level; source: string };

export type FakeCellState = {
  revision: number;
  levels: { coding: ContextLevel; conversation: ContextLevel };
  /** An operator fixed the levels: every write is refused. */
  operator: boolean;
  noteCount: number | null;
  events: {
    app_id?: string | null;
    client: string | null;
    action: "recalled" | "saved";
    items: number | null;
    at: string;
  }[];
  since: string;
  /** What `bootstrap` answers for the `whats_new` section. */
  whatsNew: {
    version: string;
    releases: { version: string; released_on: string; notes: string[] }[];
  };
  viewerMap?: unknown;
  viewerSearch?: unknown;
  viewerNotes?: Record<string, unknown>;
  /**
   * The filing view's record per import ID. Unset, the stand-in is a cell without the
   * import filer, which refuses the view.
   */
  filing?: Record<string, unknown>;
};

function initialState(): FakeCellState {
  return {
    revision: 1,
    // The cell's defaults: chat apps maximal, coding agents balanced.
    levels: {
      coding: { level: "balanced", source: "default" },
      conversation: { level: "maximal", source: "default" },
    },
    operator: false,
    noteCount: 0,
    events: [],
    since: new Date(Date.now() - 3_600_000).toISOString(),
    whatsNew: { version: "1.0.0", releases: [] },
  };
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

export function startFakeCell(options: {
  port: number;
  /** Plain HTTP, loopback only: the tests read and set each tenant's cell here. */
  controlPort: number;
  key: string;
  cert: string;
  resource: string;
}): Promise<{ close: () => Promise<void> }> {
  const cells = new Map<string, FakeCellState>();
  const cell = (tenantId: string) => {
    let state = cells.get(tenantId);
    if (!state) {
      state = initialState();
      cells.set(tenantId, state);
    }
    return state;
  };

  // The tools a current cell serves (evermatter's public surface since its #2677): the typed
  // tools, the two doors and the three that keep their own spelling. A cell refuses any other
  // name as an unknown tool, so a Home call by an internal command name fails here as it does live.
  const PUBLIC_TOOLS = new Set([
    "add_observation",
    "add_plan_item",
    "add_record",
    "cancel_uploads",
    "create_note",
    "decide_review_item",
    "download_files",
    "edit_note",
    "edit_plan_item",
    "edit_record",
    "list_review_items",
    "query_plan_items",
    "query_records",
    "read_instructions",
    "read_page",
    "save_episode",
    "save_evidence",
    "save_source",
    "search_memory",
    "supersede_note",
    "upload_files",
    "inspect_memory",
    "manage_memory",
    "activate_context",
    "observe_transfer",
    "transfer_memory",
  ]);
  // Home's level, activity, what's-new and viewer calls still use internal command names, which
  // a current cell also refuses. They pass here only until those calls move to the doors; that
  // move deletes this list.
  const NOT_YET_ON_THE_DOORS = new Set([
    "configure_memory",
    "bootstrap",
    "viewer_map",
    "ask_memory",
    "read_memory",
  ]);

  function call(state: FakeCellState, name: string, args: Record<string, unknown>): unknown {
    if (name === "viewer_map") return state.viewerMap ?? { available: false };
    if (name === "ask_memory") return { result: state.viewerSearch ?? [] };
    if (name === "read_memory") return state.viewerNotes?.[String(args.path)] ?? {};
    // The filing view's read and the wake both answer the stage's record; a stage without
    // one is refused as a cell without the filer refuses the view.
    const operation = `${name} ${String(args.operation)}`;
    if (
      operation === "inspect_memory imports.status" ||
      operation === "manage_memory imports.file"
    ) {
      const fields = (args.arguments ?? {}) as Record<string, unknown>;
      const importId = String(fields.path).split("/")[1];
      // A door answers under `result` and refuses with `{error: {code}}`, as a current cell does.
      const record = state.filing?.[importId];
      return record ? { result: record } : { error: { code: "IMPORT_REQUEST_INVALID" } };
    }
    const inspect = () => ({ revision: String(state.revision), levels: state.levels });
    if (name === "bootstrap" && args.section === "whats_new") {
      return { contract_version: "1", section: "whats_new", whats_new: state.whatsNew };
    }
    if (name === "bootstrap") {
      return {
        since: state.since,
        as_of: new Date().toISOString(),
        note_count: state.noteCount,
        events: state.events,
      };
    }
    if (args.action === "inspect") return inspect();
    if (state.operator) {
      return { success: false, error: { code: "PREFERENCE_OPERATOR_OVERRIDE" } };
    }
    if (args.expected_revision !== String(state.revision)) {
      return { success: false, error: { code: "PREFERENCE_CONFLICT" } };
    }
    const context = args.context as "coding" | "conversation";
    state.levels[context] =
      args.action === "clear"
        ? { level: context === "coding" ? "balanced" : "maximal", source: "default" }
        : { level: args.prominence as Level, source: "preference:context" };
    state.revision += 1;
    return inspect();
  }

  // Test control: GET or POST /__control/<tenant id> reads or patches that tenant's cell.
  const paddle = fakePaddle();
  const control = createHttpServer(async (request, response) => {
    if (await paddle(request, response)) return;
    const url = new URL(request.url ?? "/", "http://control.invalid");
    if (!url.pathname.startsWith("/__control/")) return json(response, 404, { error: "NOT_FOUND" });
    const state = cell(decodeURIComponent(url.pathname.slice("/__control/".length)));
    if (request.method === "POST") Object.assign(state, JSON.parse(await body(request)));
    return json(response, 200, state);
  });

  const server = createServer(
    { key: options.key, cert: options.cert },
    async (request, response) => {
      try {
        const url = new URL(request.url ?? "/", "https://fake.invalid");
        if (request.method !== "POST" || url.pathname !== new URL(options.resource).pathname) {
          return json(response, 404, { error: "NOT_FOUND" });
        }
        const bearer = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
        const access = await findCloudOAuthAccessToken(digestSecret(bearer), [options.resource]);
        if (!access) return json(response, 401, { error: "ACCESS_TOKEN_INVALID" });
        const rpc = JSON.parse(await body(request));
        const name = String(rpc.params.name);
        if (!PUBLIC_TOOLS.has(name) && !NOT_YET_ON_THE_DOORS.has(name)) {
          return json(response, 200, {
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              isError: true,
              content: [{ type: "text", text: `Unknown tool: '${name}'.` }],
            },
          });
        }
        const result = call(cell(access.tenantId), name, rpc.params.arguments ?? {});
        return json(response, 200, {
          jsonrpc: "2.0",
          id: rpc.id,
          result: { isError: false, structuredContent: result, content: [] },
        });
      } catch (error) {
        console.error("[fake-cell]", error);
        return json(response, 500, { error: "FAKE_CELL_ERROR" });
      }
    }
  );

  const listen = (target: Server, port: number) =>
    new Promise<void>((resolve) => target.listen(port, "127.0.0.1", () => resolve()));
  return Promise.all([listen(server, options.port), listen(control, options.controlPort)]).then(
    () => ({
      close: async () => {
        await Promise.all([
          new Promise<void>((done) => server.close(() => done())),
          new Promise<void>((done) => control.close(() => done())),
        ]);
      },
    })
  );
}
