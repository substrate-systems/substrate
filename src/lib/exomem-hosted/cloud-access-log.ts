import { NextResponse } from "next/server";
import { resolveCloudOwnerPrincipal } from "./cloud-owner-principal";
import { executeExomemSql as sql, withExomemTransaction } from "./db";
import { exomemErrors } from "./errors";
import { accessErrorResponse, newRequestId, readBoundedJsonRequest } from "./http";
import { clientAddressKey, EXOMEM_RATE_LIMITS, takeExomemRateLimit } from "./rate-limit";
import { constantTimeSecretEqual, generateExternalToken, tokenDigest } from "./security";
import {
  cookieValue,
  mintMagicLinkChallenge,
  mintSessionMaterial,
  validatePublicAccessRequest,
} from "./sessions";

export const ACCESS_LOG_COOKIE = "exomem_access_log_session";
const CHALLENGE_COOKIE = "exomem_access_log_challenge";
const LOG_API = "/api/exomem/cloud/access-log";

export function accessLogEnabled(): boolean {
  return process.env.EXOMEM_CLOUD_ACCESS_LOG_ENABLED === "true";
}
function positiveConfig(name: string): number {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} is required`);
  return value;
}
function expiry(): Date {
  return new Date(Date.now() + positiveConfig("EXOMEM_ACCESS_LOG_RETENTION_DAYS") * 86400_000);
}
async function rateLimit(request: Request): Promise<void> {
  if (
    !(await takeExomemRateLimit(
      EXOMEM_RATE_LIMITS.adminPreAuthMutationIp,
      clientAddressKey(request) ?? "unknown"
    ))
  )
    throw exomemErrors.rateLimited();
}
export async function pruneAccessLogAuth() {
  const challenges = await sql`DELETE FROM exomem_cloud_access_challenges WHERE challenge_digest IN
    (SELECT challenge_digest FROM exomem_cloud_access_challenges WHERE expires_at<=now() LIMIT 100)`;
  const sessions = await sql`DELETE FROM exomem_cloud_access_sessions WHERE id IN
    (SELECT id FROM exomem_cloud_access_sessions WHERE expires_at<=now() OR revoked_at IS NOT NULL LIMIT 100)`;
  const grants = await sql`DELETE FROM exomem_cloud_access_grants WHERE id IN
    (SELECT id FROM exomem_cloud_access_grants WHERE expires_at<=now() OR revoked_at IS NOT NULL LIMIT 100)`;
  return {
    challenges: challenges.rowCount ?? 0,
    sessions: sessions.rowCount ?? 0,
    grants: grants.rowCount ?? 0,
  };
}

/** Mint while ordinary owner authority exists; deletion never depends on saving this code. */
export async function issueLogRecovery(userId: string, tenantId: string, cellId: string) {
  const code = generateExternalToken();
  const expiresAt = expiry();
  const { rows } = await sql`
    INSERT INTO exomem_cloud_access_grants(owner_user_id,tenant_id,cell_id,code_digest,expires_at)
    SELECT tenant.owner_user_id,tenant.id,cell.cell_id,${tokenDigest(code)},${expiresAt.toISOString()}::timestamptz
    FROM exomem_tenants tenant JOIN exomem_cloud_cells cell ON cell.tenant_id=tenant.id
    WHERE tenant.id=${tenantId}::uuid AND tenant.owner_user_id=${userId}::uuid
      AND tenant.deleted_at IS NULL AND tenant.desired_state<>'deleted'
      AND cell.cell_id=${cellId} AND cell.desired_state<>'deleted'
    RETURNING cell_id
  `;
  if (!rows.length) throw exomemErrors.sessionInvalid();
  return { code, expiresAt: expiresAt.toISOString() };
}

async function exchangeLogRecovery(code: string, challenge: string) {
  const codeDigest = tokenDigest(code);
  const challengeDigest = tokenDigest(challenge);
  if (!codeDigest || !challengeDigest) throw exomemErrors.sessionInvalid();
  const material = mintSessionMaterial();
  const { rows } = await withExomemTransaction(async (tx) => {
    const challengeRow = await tx`DELETE FROM exomem_cloud_access_challenges
      WHERE challenge_digest=${challengeDigest} AND expires_at>now() RETURNING challenge_digest`;
    if (!challengeRow.rows.length) throw exomemErrors.sessionInvalid();
    return tx`
      INSERT INTO exomem_cloud_access_sessions(grant_id,session_digest,expires_at)
      SELECT id,${material.sessionDigest},LEAST(expires_at,${material.expiresAt.toISOString()}::timestamptz)
      FROM exomem_cloud_access_grants WHERE code_digest=${codeDigest} AND revoked_at IS NULL AND expires_at>now()
      RETURNING expires_at
    `;
  });
  if (!rows.length) throw exomemErrors.sessionInvalid();
  return { sessionToken: material.sessionToken, expiresAt: new Date(String(rows[0].expires_at)) };
}

async function logScope(
  request: Request
): Promise<{ cellId: string; tenantId: string; restricted: boolean }> {
  const restricted = cookieValue(request, ACCESS_LOG_COOKIE);
  if (restricted && !request.headers.has("authorization")) {
    const digest = tokenDigest(restricted);
    if (!digest) throw exomemErrors.sessionInvalid();
    const { rows } = await sql`
      SELECT grant_row.cell_id,grant_row.tenant_id FROM exomem_cloud_access_sessions session
      JOIN exomem_cloud_access_grants grant_row ON grant_row.id=session.grant_id
      WHERE session.session_digest=${digest} AND session.revoked_at IS NULL AND session.expires_at>now()
        AND grant_row.revoked_at IS NULL AND grant_row.expires_at>now()
    `;
    if (!rows.length) throw exomemErrors.sessionInvalid();
    const requestedCell = new URL(request.url).searchParams.get("cellId");
    if (requestedCell !== null && requestedCell !== rows[0].cell_id)
      throw exomemErrors.sessionInvalid();
    return {
      cellId: String(rows[0].cell_id),
      tenantId: String(rows[0].tenant_id),
      restricted: true,
    };
  }
  const principal = await resolveCloudOwnerPrincipal(request);
  const requestedCell = new URL(request.url).searchParams.get("cellId");
  const { rows } = await sql`
    SELECT cell.cell_id FROM exomem_cloud_cells cell JOIN exomem_tenants tenant ON tenant.id=cell.tenant_id
    WHERE tenant.id=${principal.tenantId}::uuid AND tenant.owner_user_id=${principal.userId}::uuid
      AND cell.desired_state<>'deleted' AND (${requestedCell}::text IS NULL OR cell.cell_id=${requestedCell})
    ORDER BY cell.created_at DESC LIMIT 1
  `;
  if (!rows.length) throw exomemErrors.sessionInvalid();
  return { cellId: String(rows[0].cell_id), tenantId: principal.tenantId, restricted: false };
}

export async function readAccessLog(request: Request) {
  const scope = await logScope(request);
  const before = new URL(request.url).searchParams.get("before");
  // A decimal database key is a format check, never a classification of human text.
  if (
    before !== null &&
    (!/^[0-9]{1,19}$/.test(before) || BigInt(before) > BigInt("9223372036854775807"))
  )
    throw exomemErrors.invalidRequest();
  const windowEnd = new Date();
  const windowStart = new Date(
    windowEnd.getTime() - positiveConfig("EXOMEM_ACCESS_LOG_RETENTION_DAYS") * 86400_000
  );
  const { rows } = await sql`
    SELECT entry.id::text,record.kind,record.source_at,record.provider_at,receipt.received_at,
      record.identity,record.identity_tier,record.action,record.target,record.node,
      record.authentication_method,record.fingerprint,record.fingerprint_kind,record.source_address,record.result,
      CASE WHEN record.kind='node_session' AND record.action='open_session' AND record.session_id IS NOT NULL
        THEN (SELECT min(ending.source_at) FROM exomem_cloud_access_records ending
          WHERE ending.kind='node_session' AND ending.action='close_session'
            AND ending.node=record.node AND ending.boot_id=record.boot_id AND ending.session_id=record.session_id
            AND ending.source_at>=record.source_at) END AS session_end_at
    FROM exomem_cloud_access_entries entry JOIN exomem_cloud_access_records record ON record.id=entry.record_id
    JOIN exomem_cloud_access_receipts receipt ON receipt.id=record.receipt_id
    WHERE entry.cell_id=${scope.cellId} AND record.provider_at>=${windowStart.toISOString()}::timestamptz
      AND (${before}::bigint IS NULL OR entry.id<${before}::bigint)
    ORDER BY entry.id DESC LIMIT 51
  `;
  const placements = await sql`
    SELECT placement.*,to_jsonb(heartbeat) AS heartbeat FROM exomem_cloud_placements placement
    LEFT JOIN LATERAL (
      SELECT record.source_at,record.provider_at,receipt.received_at
      FROM exomem_cloud_access_records record
      JOIN exomem_cloud_access_receipts receipt ON receipt.id=record.receipt_id
      WHERE record.kind='heartbeat' AND record.node=placement.node
        AND record.source_at<=placement.last_observed_at
      ORDER BY record.source_at DESC LIMIT 1
    ) heartbeat ON true
    WHERE placement.cell_id=${scope.cellId} AND placement.last_observed_at>=${windowStart.toISOString()}::timestamptz
    ORDER BY placement.first_observed_at
  `;
  const placementGaps = await sql`
    WITH observed AS (
      SELECT first_observed_at,
        max(last_observed_at) OVER(ORDER BY first_observed_at,last_observed_at
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS previous_end
      FROM exomem_cloud_placements WHERE cell_id=${scope.cellId}
        AND last_observed_at>=${windowStart.toISOString()}::timestamptz
    )
    SELECT previous_end AS start,first_observed_at AS end FROM observed
    WHERE previous_end IS NOT NULL AND first_observed_at>previous_end ORDER BY first_observed_at DESC LIMIT 100
  `;
  const metrics = await sql`
    SELECT DISTINCT ON (record.node,record.target) record.node,record.target,record.result,record.source_at,record.provider_at
    FROM exomem_cloud_access_records record WHERE record.kind='shipper_metric'
      AND EXISTS(SELECT 1 FROM exomem_cloud_placements placement WHERE placement.cell_id=${scope.cellId} AND placement.node=record.node)
    ORDER BY record.node,record.target,record.source_at DESC
  `;
  const pending =
    await sql`SELECT EXISTS(SELECT 1 FROM exomem_cloud_access_receipts WHERE processed_at IS NULL) AS delayed,
      EXISTS(SELECT 1 FROM exomem_cloud_access_receipts WHERE processed_at IS NULL AND error_code='ACCESS_RECORD_INVALID') AS failed`;
  const maxAge = positiveConfig("EXOMEM_ACCESS_RECORD_HEARTBEAT_MAX_AGE_SECONDS");
  const gaps = await sql`
    WITH beats AS (
      SELECT node,source_at,provider_at,lag(source_at) OVER(PARTITION BY node ORDER BY source_at) AS previous
      FROM exomem_cloud_access_records record WHERE kind='heartbeat' AND source_at>=${windowStart.toISOString()}::timestamptz
        AND EXISTS(SELECT 1 FROM exomem_cloud_placements placement WHERE placement.cell_id=${scope.cellId} AND placement.node=record.node)
    )
    SELECT node,previous AS start,source_at AS end,provider_at FROM beats
    WHERE previous IS NOT NULL AND source_at-previous > ${maxAge} * interval '1 second'
      AND EXISTS(SELECT 1 FROM exomem_cloud_placements placement WHERE placement.cell_id=${scope.cellId}
        AND placement.node=beats.node AND placement.first_observed_at<=beats.source_at AND placement.last_observed_at>=beats.previous)
    ORDER BY source_at DESC LIMIT 100
  `;
  const delayed = pending.rows[0]?.delayed === true;
  const nodes = placements.rows.map(
    (
      placement
    ): Record<string, unknown> & { heartbeat: Record<string, unknown> | null; gap: boolean } => {
      const last = placement.heartbeat as Record<string, unknown> | null;
      return {
        ...placement,
        heartbeat: last ?? null,
        gap:
          !last ||
          new Date(String(last.source_at)).getTime() + maxAge * 1000 <
            new Date(String(placement.last_observed_at)).getTime(),
      };
    }
  );
  return {
    cellId: scope.cellId,
    restricted: scope.restricted,
    window: {
      start: windowStart.toISOString(),
      end: windowEnd.toISOString(),
      source: "received_access_record",
    },
    coverage:
      pending.rows[0]?.failed === true
        ? "failed"
        : delayed
          ? "delayed"
          : nodes.some((node) => node.heartbeat)
            ? "partial"
            : "unknown",
    placements: nodes,
    placementGaps: placementGaps.rows,
    shipperMetrics: metrics.rows,
    gaps: gaps.rows,
    entries: rows
      .slice(0, 50)
      .map((row): Record<string, unknown> & { reason: null } => ({ ...row, reason: null })),
    next: rows.length > 50 ? String(rows[49].id) : null,
  };
}

export async function handleAccessLogRequest(
  request: Request,
  action: "read" | "issue" | "challenge" | "recover"
): Promise<Response> {
  if (!accessLogEnabled()) return new Response(null, { status: 404 });
  try {
    if (action === "read")
      return NextResponse.json(await readAccessLog(request), {
        headers: { "cache-control": "no-store" },
      });
    await rateLimit(request);
    await pruneAccessLogAuth();
    if (action === "issue") {
      const principal = await resolveCloudOwnerPrincipal(request);
      const body = (await readBoundedJsonRequest(request, 2048)) as { cellId?: unknown };
      if (typeof body?.cellId !== "string") throw exomemErrors.invalidRequest();
      return NextResponse.json(
        await issueLogRecovery(principal.userId, principal.tenantId, body.cellId),
        { headers: { "cache-control": "no-store" } }
      );
    }
    if (action === "challenge") {
      validatePublicAccessRequest(request);
      const challenge = mintMagicLinkChallenge();
      await sql`INSERT INTO exomem_cloud_access_challenges(challenge_digest,expires_at) VALUES(${challenge.challengeDigest},${challenge.expiresAt.toISOString()}::timestamptz)`;
      const response = NextResponse.json(
        { challenge: challenge.challengeToken },
        { headers: { "cache-control": "no-store" } }
      );
      response.cookies.set(CHALLENGE_COOKIE, challenge.challengeToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        path: LOG_API,
        expires: challenge.expiresAt,
      });
      return response;
    }
    validatePublicAccessRequest(request);
    const body = (await readBoundedJsonRequest(request, 2048)) as {
      code?: unknown;
      challenge?: unknown;
    };
    const challenge = cookieValue(request, CHALLENGE_COOKIE);
    if (
      !challenge ||
      typeof body?.challenge !== "string" ||
      !constantTimeSecretEqual(body.challenge, challenge) ||
      typeof body.code !== "string"
    )
      throw exomemErrors.sessionInvalid();
    const session = await exchangeLogRecovery(body.code, challenge);
    const response = NextResponse.json(
      { success: true },
      { headers: { "cache-control": "no-store" } }
    );
    response.cookies.set(ACCESS_LOG_COOKIE, session.sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: LOG_API,
      expires: session.expiresAt,
    });
    response.cookies.set(CHALLENGE_COOKIE, "", { httpOnly: true, path: LOG_API, maxAge: 0 });
    return response;
  } catch (error) {
    return accessErrorResponse({
      error,
      event: "access.request.denied",
      requestId: newRequestId(),
    });
  }
}
