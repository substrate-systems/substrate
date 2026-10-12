/**
 * Home's channel to the owner's cell (`launch-exomem-cloud-web`, task 5.2).
 *
 * Home reads and sets levels and reads recent activity through the cell's own
 * `/mcp`, behind the public gateway. For each call the web server mints an
 * access token for the first-party Home client, bound to the session's tenant,
 * valid for 120 seconds. The token stays in this process's memory and is never
 * logged. The gateway's own lookup re-checks revocation, account blocks and
 * deletion when the token arrives (`findCloudOAuthAccessToken`).
 *
 * Exactly two calls leave this module: `configure_memory` and `bootstrap` with
 * the `activity` section. It is not a proxy: no caller chooses a tool, an
 * argument outside those two shapes, a tenant or a cell.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { loadExomemCloudResource, type EnvironmentSource } from "./cloud-config";
import { assertPrincipalOwnsCloudCell } from "./cloud-oauth";
import { executeExomemSql, withExomemTransaction } from "./db";
import { ExomemHostedError, exomemErrors, safeErrorResponse } from "./errors";
import { readBoundedJsonRequest } from "./http";
import { digestSecret, generateExternalToken, SensitiveSecret } from "./security";
import {
  resolveExomemSession,
  validateMutationRequest,
  type ExomemSessionContext,
} from "./sessions";

export const CLOUD_HOME_TOKEN_TTL_SECONDS = 120;
const CELL_CALL_TIMEOUT_MS = 5_000;
const MAX_CELL_ANSWER_BYTES = 256 * 1024;
// MCP 2026-07-28 carries the protocol metadata in each request, so a stateless
// call needs no `initialize` round trip first.
const MCP_PROTOCOL_VERSION = "2026-07-28";
const HOME_CLIENT_INFO = { name: "exomem-cloud-home", version: "1" };
// D2's Cloud scope pair: the gateway refuses a token without both.
const HOME_SCOPES = ["exomem.read", "exomem.write"];

// The cell's closed enums for `configure_memory` (prominence levels, contexts
// and the precedence step that decided a level).
const Level = z.enum(["off", "light", "balanced", "maximal"]);
const Context = z.enum(["coding", "conversation"]);
const LevelSource = z.enum([
  "env",
  "preference:context",
  "preference",
  "config",
  "preference:unavailable",
  "default",
]);
const ContextLevel = z.object({ level: Level, source: LevelSource });
const ConfigureMemoryAnswer = z.object({
  revision: z.string().min(1).max(128),
  levels: z.object({ coding: ContextLevel, conversation: ContextLevel }),
});

/**
 * The client families an activity event can name. This is the cell's closed
 * set: `client_family` in its `privacy_log` maps every client name to one of
 * these, or to none when the name is empty. Home imports it to label events.
 */
export const ACTIVITY_CLIENT_FAMILIES = [
  "claude-ai",
  "chatgpt",
  "codex",
  "claude-code",
  "other",
] as const;
export type ActivityClientFamily = (typeof ACTIVITY_CLIENT_FAMILIES)[number];

const Timestamp = z.iso.datetime({ offset: true });
const ActivityPayload = z.object({
  since: Timestamp,
  as_of: Timestamp,
  note_count: z.number().int().nonnegative().nullable(),
  events: z
    .array(
      z.object({
        // Any other value could be text from the cell, so it reaches Home as
        // an unknown client, never as itself.
        client: z.enum(ACTIVITY_CLIENT_FAMILIES).nullable().catch(null),
        action: z.enum(["recalled", "saved"]),
        items: z.number().int().nonnegative().nullable(),
        at: Timestamp,
      })
    )
    .max(20),
});
// A bootstrap section nests its block under the section's own name; the
// contract states the bare payload. Both carry the same fields.
const ActivityAnswer = z.union([z.object({ activity: ActivityPayload }), ActivityPayload]);

const JsonRpcAnswer = z.union([
  z.object({
    jsonrpc: z.literal("2.0"),
    id: z.string(),
    result: z.object({ isError: z.boolean().optional(), structuredContent: z.unknown() }),
  }),
  z.object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number(), z.null()]),
    error: z.object({ code: z.number().int() }),
  }),
]);
// The cell's structured refusal: a successful tool call whose payload says no.
const CellRefusal = z.object({ success: z.literal(false), error: z.object({ code: z.string() }) });
// Only a code of this shape reaches a log line.
const ERROR_CODE_FORMAT = /^[A-Z][A-Z0-9_]{0,63}$/;

export type CloudHomeLevel = z.infer<typeof Level>;
export type CloudHomeContext = z.infer<typeof Context>;
export type CloudHomeUnavailableReason =
  | "CELL_STOPPED"
  | "CELL_NOT_READY"
  | "CELL_UNREACHABLE"
  | "CELL_OUTDATED";
export type CloudHomeUnavailable = { state: "unavailable"; reason: CloudHomeUnavailableReason };
export type CloudHomeLiveLevels = {
  state: "live";
  revision: string;
  writable: boolean;
  locked_by: null | "read_only" | "operator";
  levels: z.infer<typeof ConfigureMemoryAnswer>["levels"];
};
export type CloudHomeLevelsView = CloudHomeLiveLevels | CloudHomeUnavailable;
export type CloudHomeActivityView =
  | ({ state: "live" } & z.infer<typeof ActivityPayload>)
  | CloudHomeUnavailable;

/** The levels refusals the cell reports and Home answers with 409. */
const LEVEL_REFUSALS = new Set([
  "PREFERENCE_CONFLICT",
  "CLOUD_CELL_READ_ONLY",
  "PREFERENCE_OPERATOR_OVERRIDE",
] as const);
type LevelRefusal = typeof LEVEL_REFUSALS extends Set<infer Code> ? Code : never;

export type CloudHomeLevelWrite =
  | { kind: "written"; view: CloudHomeLiveLevels }
  | { kind: "refused"; code: LevelRefusal; current: CloudHomeLevelsView }
  | { kind: "unavailable"; view: CloudHomeUnavailable };

export type CloudHomePrincipal = Pick<
  ExomemSessionContext,
  "userId" | "tenantId" | "reviewerCredentialId"
>;

export type CloudHomeDependencies = {
  /** The HTTP boundary to the gateway; tests substitute the cell's answer here. */
  fetchCell?: typeof fetch;
  env?: EnvironmentSource;
};

type HomeToolCall =
  | {
      name: "configure_memory";
      arguments:
        | { action: "inspect" }
        | {
            action: "set";
            prominence: CloudHomeLevel;
            expected_revision: string;
            context: CloudHomeContext;
          }
        | { action: "clear"; context: CloudHomeContext; expected_revision: string };
    }
  | { name: "bootstrap"; arguments: { profile: "compact"; section: "activity" } };

type CellAnswer =
  | { kind: "result"; value: unknown }
  | { kind: "refused"; code: string }
  | { kind: "unavailable"; view: CloudHomeUnavailable };

type ServingCell = { state: "serving"; desiredState: "running" | "read_only" };

/** Release flag: off until the cell rollout that answers these calls is done. */
export function cloudHomeChannelEnabled(env: EnvironmentSource = process.env): boolean {
  return env.EXOMEM_CLOUD_HOME_CHANNEL_ENABLED?.trim().toLowerCase() === "true";
}

function unavailable(reason: CloudHomeUnavailableReason): CloudHomeUnavailable {
  return { state: "unavailable", reason };
}

function logUnavailable(tool: HomeToolCall["name"], reason: string, detail?: string): void {
  console.warn({ event: "exomem_cloud_home_call_unavailable", tool, reason, detail });
}

/**
 * The cell state Home may call, from the database only. A stopped or
 * not-ready cell answers no request, so this saves the mint and the network.
 */
async function servingCell(
  principal: CloudHomePrincipal
): Promise<ServingCell | CloudHomeUnavailable> {
  const { rows } = await executeExomemSql`
    /* exomem-cloud:home-serving-cell */
    SELECT cell.desired_state, cell.ready
    FROM exomem_cloud_cells AS cell
    JOIN exomem_tenants AS tenant ON tenant.id = cell.tenant_id
    WHERE cell.tenant_id = ${principal.tenantId}::uuid
      AND tenant.owner_user_id = ${principal.userId}::uuid
      AND tenant.status NOT IN ('deletion_pending', 'deleted')
      AND cell.desired_state <> 'deleted'
    LIMIT 1
  `;
  const row = rows[0] as { desired_state: string; ready: boolean } | undefined;
  if (!row) return unavailable("CELL_NOT_READY");
  if (row.desired_state !== "running" && row.desired_state !== "read_only") {
    return unavailable("CELL_STOPPED");
  }
  if (!row.ready) return unavailable("CELL_NOT_READY");
  return { state: "serving", desiredState: row.desired_state };
}

/**
 * Mints one Home access token in one transaction: upsert the tenant's Home
 * grant, reuse or open its token family, and store the token's digest with a
 * 120-second expiry. The raw token exists only in the returned wrapper.
 */
async function mintHomeAccessToken(
  principal: CloudHomePrincipal,
  resource: string
): Promise<SensitiveSecret> {
  await assertPrincipalOwnsCloudCell(principal.tenantId);
  const token = new SensitiveSecret(generateExternalToken());
  const reviewerCredentialId = principal.reviewerCredentialId ?? null;
  await withExomemTransaction(async (tx) => {
    // One active grant per owner, client and resource, so the mint reuses
    // only a grant that it could have written itself. It retires first a
    // Home grant from a reviewer credential that this session no longer
    // carries, which the upsert below would otherwise refuse on every call.
    // It also retires a grant that an interactive authorization wrote: one
    // that allows refresh, or holds a live access token issued for longer
    // than this mint issues. The check reads each token's own lifetime, so a
    // concurrent mint's fresh token never retires the grant. Revoking the
    // grant ends its families and tokens at the gateway's lookup.
    await tx`
      UPDATE exomem_oauth_grants AS oauth_grant
      SET revoked_at = now(), updated_at = now()
      FROM exomem_oauth_clients AS home_client
      WHERE home_client.id = oauth_grant.client_id
        AND home_client.admission_mode = 'first_party'
        AND oauth_grant.user_id = ${principal.userId}::uuid
        AND oauth_grant.tenant_id = ${principal.tenantId}::uuid
        AND oauth_grant.resource = ${resource}
        AND oauth_grant.revoked_at IS NULL
        AND (
          oauth_grant.reviewer_credential_id IS DISTINCT FROM ${reviewerCredentialId}::uuid
          OR oauth_grant.refresh_allowed
          OR EXISTS (
            SELECT 1 FROM exomem_oauth_access_tokens AS token
            WHERE token.grant_id = oauth_grant.id AND token.expires_at > now()
              AND token.expires_at - token.created_at
                > make_interval(secs => ${CLOUD_HOME_TOKEN_TTL_SECONDS})
          )
        )
    `;
    // The grant upsert locks the grant row, so concurrent mints for one
    // tenant reuse one family instead of racing to open two.
    const granted = await tx`
      /* exomem-cloud:home-grant */
      WITH principal AS (
        SELECT tenant.id AS tenant_id, tenant.owner_user_id AS user_id
        FROM exomem_tenants AS tenant
        WHERE tenant.id = ${principal.tenantId}::uuid
          AND tenant.owner_user_id = ${principal.userId}::uuid
          AND tenant.status NOT IN ('deletion_pending', 'deleted')
          AND NOT EXISTS (
            SELECT 1 FROM exomem_oauth_account_blocks AS block
            WHERE block.tenant_id = tenant.id AND block.owner_user_id = tenant.owner_user_id
          )
      ), home_client AS (
        SELECT id FROM exomem_oauth_clients WHERE admission_mode = 'first_party' AND enabled
      )
      INSERT INTO exomem_oauth_grants (
        user_id, tenant_id, client_id, resource, scopes, refresh_allowed, reviewer_credential_id
      )
      SELECT principal.user_id, principal.tenant_id, home_client.id, ${resource},
             ${HOME_SCOPES}::text[], false, ${reviewerCredentialId}::uuid
      FROM principal CROSS JOIN home_client
      ON CONFLICT (user_id, tenant_id, client_id, resource) WHERE revoked_at IS NULL
      DO UPDATE SET updated_at = now()
      RETURNING id, client_id
    `;
    const grant = granted.rows[0] as { id: string; client_id: string } | undefined;
    if (!grant) throw new Error("the Home grant could not be written");
    const reused = await tx`
      /* exomem-cloud:home-family */
      SELECT id FROM exomem_oauth_token_families
      WHERE grant_id = ${grant.id}::uuid AND client_id = ${grant.client_id}::uuid
        AND revoked_at IS NULL AND candidate_id IS NULL
        AND reviewer_credential_id IS NOT DISTINCT FROM ${reviewerCredentialId}::uuid
        AND expires_at > now() + make_interval(secs => ${CLOUD_HOME_TOKEN_TTL_SECONDS})
      ORDER BY expires_at DESC
      LIMIT 1
    `;
    let familyId = (reused.rows[0] as { id: string } | undefined)?.id;
    if (!familyId) {
      const opened = await tx`
        INSERT INTO exomem_oauth_token_families (grant_id, client_id, expires_at, reviewer_credential_id)
        VALUES (${grant.id}::uuid, ${grant.client_id}::uuid, now() + interval '30 days',
                ${reviewerCredentialId}::uuid)
        RETURNING id
      `;
      familyId = (opened.rows[0] as { id: string }).id;
    }
    // Home mints one token per call and nothing in production prunes expired
    // access tokens, so each mint removes its own grant's expired ones.
    await tx`
      DELETE FROM exomem_oauth_access_tokens
      WHERE grant_id = ${grant.id}::uuid AND expires_at <= now()
    `;
    await tx`
      /* exomem-cloud:home-access-token */
      INSERT INTO exomem_oauth_access_tokens (
        access_digest, grant_id, family_id, client_id, resource, scopes, expires_at,
        reviewer_credential_id
      ) VALUES (
        ${digestSecret(token.reveal())}, ${grant.id}::uuid, ${familyId}::uuid,
        ${grant.client_id}::uuid, ${resource}, ${HOME_SCOPES}::text[],
        now() + make_interval(secs => ${CLOUD_HOME_TOKEN_TTL_SECONDS}), ${reviewerCredentialId}::uuid
      )
    `;
  });
  return token;
}

/** One stateless `tools/call` through the gateway, read through a schema. */
async function callHomeTool(
  principal: CloudHomePrincipal,
  call: HomeToolCall,
  dependencies: CloudHomeDependencies
): Promise<CellAnswer> {
  const { mcpUrl } = loadExomemCloudResource(dependencies.env);
  const token = await mintHomeAccessToken(principal, mcpUrl);
  const requestId = randomUUID();
  let response: Response;
  try {
    response = await (dependencies.fetchCell ?? fetch)(mcpUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.reveal()}`,
        "content-type": "application/json",
        accept: "application/json",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        "mcp-method": "tools/call",
        "mcp-name": call.name,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: "tools/call",
        params: {
          name: call.name,
          arguments: call.arguments,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": HOME_CLIENT_INFO,
          },
        },
      }),
      signal: AbortSignal.timeout(CELL_CALL_TIMEOUT_MS),
      // The bearer goes to the configured gateway and nowhere a redirect points.
      redirect: "error",
    });
  } catch {
    logUnavailable(call.name, "CELL_UNREACHABLE", "transport");
    return { kind: "unavailable", view: unavailable("CELL_UNREACHABLE") };
  }

  let body: unknown;
  try {
    body = await readBoundedJsonRequest(response, MAX_CELL_ANSWER_BYTES);
  } catch {
    body = undefined;
  }
  if (response.status !== 200) {
    // The gateway's own refusal when the cell is stopped or does not answer.
    const notReady =
      response.status === 503 &&
      (body as { error?: unknown } | undefined)?.error === "CELL_NOT_READY";
    const reason = notReady ? "CELL_NOT_READY" : "CELL_UNREACHABLE";
    logUnavailable(call.name, reason, `http_${response.status}`);
    return { kind: "unavailable", view: unavailable(reason) };
  }
  const answer = JsonRpcAnswer.safeParse(body);
  if (!answer.success || ("result" in answer.data && answer.data.id !== requestId)) {
    logUnavailable(call.name, "CELL_OUTDATED", "answer_shape");
    return { kind: "unavailable", view: unavailable("CELL_OUTDATED") };
  }
  if ("error" in answer.data) {
    // JSON-RPC's fixed codes: an unknown method or argument is an older image.
    const outdated = answer.data.error.code === -32601 || answer.data.error.code === -32602;
    const reason = outdated ? "CELL_OUTDATED" : "CELL_UNREACHABLE";
    logUnavailable(call.name, reason, `jsonrpc_${answer.data.error.code}`);
    return { kind: "unavailable", view: unavailable(reason) };
  }
  if (answer.data.result.isError) {
    // A tool that raised instead of answering. The one the contract expects is
    // an older image refusing the unknown `activity` section.
    logUnavailable(call.name, "CELL_OUTDATED", "tool_error");
    return { kind: "unavailable", view: unavailable("CELL_OUTDATED") };
  }
  const value = answer.data.result.structuredContent;
  const refusal = CellRefusal.safeParse(value);
  if (refusal.success) return { kind: "refused", code: refusal.data.error.code };
  return { kind: "result", value };
}

function liveLevels(
  value: unknown,
  desiredState: ServingCell["desiredState"]
): CloudHomeLiveLevels | null {
  const parsed = ConfigureMemoryAnswer.safeParse(value);
  if (!parsed.success) return null;
  const { revision, levels } = parsed.data;
  // `env` is the cell's operator override, which refuses every other value.
  const lockedBy =
    desiredState === "read_only"
      ? "read_only"
      : levels.coding.source === "env" || levels.conversation.source === "env"
        ? "operator"
        : null;
  return { state: "live", revision, writable: lockedBy === null, locked_by: lockedBy, levels };
}

function levelsFromAnswer(
  answer: CellAnswer,
  desiredState: ServingCell["desiredState"]
): CloudHomeLevelsView {
  if (answer.kind === "result") {
    const view = liveLevels(answer.value, desiredState);
    if (view) return view;
    logUnavailable("configure_memory", "CELL_OUTDATED", "levels_shape");
    return unavailable("CELL_OUTDATED");
  }
  if (answer.kind === "refused") {
    logUnavailable(
      "configure_memory",
      "CELL_UNREACHABLE",
      ERROR_CODE_FORMAT.test(answer.code) ? answer.code : "refused"
    );
    return unavailable("CELL_UNREACHABLE");
  }
  return answer.view;
}

export async function readCloudHomeLevels(
  principal: CloudHomePrincipal,
  dependencies: CloudHomeDependencies = {}
): Promise<CloudHomeLevelsView> {
  const cell = await servingCell(principal);
  if (cell.state !== "serving") return cell;
  const answer = await callHomeTool(
    principal,
    { name: "configure_memory", arguments: { action: "inspect" } },
    dependencies
  );
  return levelsFromAnswer(answer, cell.desiredState);
}

/** Sets (`level`) or clears (`null`) one context's level, compare-and-set on `expectedRevision`. */
export async function writeCloudHomeLevel(
  principal: CloudHomePrincipal,
  change: { context: CloudHomeContext; level: CloudHomeLevel | null; expectedRevision: string },
  dependencies: CloudHomeDependencies = {}
): Promise<CloudHomeLevelWrite> {
  const cell = await servingCell(principal);
  if (cell.state !== "serving") return { kind: "unavailable", view: cell };
  if (cell.desiredState === "read_only") {
    // The cell refuses every writer while read-only; asking would only spend a call.
    return {
      kind: "refused",
      code: "CLOUD_CELL_READ_ONLY",
      current: await readCloudHomeLevels(principal, dependencies),
    };
  }
  const answer = await callHomeTool(
    principal,
    {
      name: "configure_memory",
      arguments:
        change.level === null
          ? { action: "clear", context: change.context, expected_revision: change.expectedRevision }
          : {
              action: "set",
              prominence: change.level,
              expected_revision: change.expectedRevision,
              context: change.context,
            },
    },
    dependencies
  );
  if (answer.kind === "refused" && LEVEL_REFUSALS.has(answer.code as LevelRefusal)) {
    return {
      kind: "refused",
      code: answer.code as LevelRefusal,
      current: await readCloudHomeLevels(principal, dependencies),
    };
  }
  const view = levelsFromAnswer(answer, cell.desiredState);
  return view.state === "live" ? { kind: "written", view } : { kind: "unavailable", view };
}

export async function readCloudHomeActivity(
  principal: CloudHomePrincipal,
  dependencies: CloudHomeDependencies = {}
): Promise<CloudHomeActivityView> {
  const cell = await servingCell(principal);
  if (cell.state !== "serving") return cell;
  const answer = await callHomeTool(
    principal,
    { name: "bootstrap", arguments: { profile: "compact", section: "activity" } },
    dependencies
  );
  if (answer.kind === "refused") {
    logUnavailable(
      "bootstrap",
      "CELL_UNREACHABLE",
      ERROR_CODE_FORMAT.test(answer.code) ? answer.code : "refused"
    );
    return unavailable("CELL_UNREACHABLE");
  }
  if (answer.kind === "unavailable") return answer.view;
  const parsed = ActivityAnswer.safeParse(answer.value);
  if (!parsed.success) {
    logUnavailable("bootstrap", "CELL_OUTDATED", "activity_shape");
    return unavailable("CELL_OUTDATED");
  }
  const activity = "activity" in parsed.data ? parsed.data.activity : parsed.data;
  return { state: "live", ...activity };
}

const HOME_HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  "referrer-policy": "no-referrer",
};

const LevelChangeBody = z.strictObject({
  context: Context,
  level: Level.nullable(),
  expected_revision: z.string().min(1).max(128),
});

function respond(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: HOME_HEADERS });
}

function errorResponse(error: unknown): Response {
  const response = safeErrorResponse(error);
  for (const [name, value] of Object.entries(HOME_HEADERS)) response.headers.set(name, value);
  return response;
}

const homeChannelOff = () =>
  new ExomemHostedError({ code: "NOT_FOUND", status: 404, message: "not found" });

const levelRefusalMessages: Record<LevelRefusal, string> = {
  PREFERENCE_CONFLICT: "the levels changed since they were read",
  CLOUD_CELL_READ_ONLY: "the account is read-only",
  PREFERENCE_OPERATOR_OVERRIDE: "an operator setting fixes the level",
};

/** `GET` and `PUT /api/exomem/cloud/home/levels`. */
export async function handleCloudHomeLevelsRequest(
  request: Request,
  dependencies: CloudHomeDependencies = {}
): Promise<Response> {
  try {
    if (!cloudHomeChannelEnabled(dependencies.env)) throw homeChannelOff();
    const session = await resolveExomemSession(request);
    if (request.method === "GET") return respond(await readCloudHomeLevels(session, dependencies));
    validateMutationRequest(request, session);
    const parsed = LevelChangeBody.safeParse(await readBoundedJsonRequest(request, 4 * 1024));
    if (!parsed.success) throw exomemErrors.invalidRequest();
    const outcome = await writeCloudHomeLevel(
      session,
      {
        context: parsed.data.context,
        level: parsed.data.level,
        expectedRevision: parsed.data.expected_revision,
      },
      dependencies
    );
    if (outcome.kind === "written") return respond(outcome.view);
    if (outcome.kind === "refused") {
      return respond(
        {
          success: false,
          error: {
            code: outcome.code,
            message: levelRefusalMessages[outcome.code],
            retryable: false,
          },
          current: outcome.current,
        },
        409
      );
    }
    return respond(outcome.view, 503);
  } catch (error) {
    return errorResponse(error);
  }
}

/** `GET /api/exomem/cloud/home/live`: recent activity and the note count. */
export async function handleCloudHomeLiveRequest(
  request: Request,
  dependencies: CloudHomeDependencies = {}
): Promise<Response> {
  try {
    if (!cloudHomeChannelEnabled(dependencies.env)) throw homeChannelOff();
    const session = await resolveExomemSession(request);
    return respond(await readCloudHomeActivity(session, dependencies));
  } catch (error) {
    return errorResponse(error);
  }
}
