/**
 * Owner exports (`launch-exomem-cloud-web`, task 5.6; shared contract C6).
 *
 * Substrate writes only the request columns of `exomem_cloud_exports`:
 * `export_id`, `cell_id`, `requested_state` and `link_requested_at`. The cell
 * controller packs the ZIP, records what it observes and presigns each link.
 * Every read and write here joins the export to the session's own tenant, so
 * an export id from another tenant is simply not found.
 *
 * A download link is returned to the owner's browser and nowhere else: this
 * module never logs it, sends it or stores it outside the export row.
 */

import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { validate as validUuid } from "uuid";
import { z } from "zod";
import type { EnvironmentSource } from "./cloud-config";
import { executeExomemSql, withExomemTransaction, type ExomemSql } from "./db";
import { ExomemHostedError, exomemErrors, safeErrorResponse } from "./errors";
import { readBoundedJsonRequest } from "./http";
import {
  resolveExomemSession,
  validateMutationRequest,
  type ExomemSessionContext,
} from "./sessions";

/** Exports one tenant may start in a rolling 24 hours; each one pauses a serving cell. */
const CLOUD_EXPORTS_PER_DAY = 3;
const LINK_WAIT_MS = 8_000;
const LINK_POLL_MS = 250;

export type CloudExportRow = {
  export_id: string;
  requested_state: "requested" | "superseded";
  observed_state: "packing" | "ready" | "failed" | "expired" | null;
  error_code: string | null;
  archive_bytes: string | null;
  ready_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
};

type CellDesiredState = "running" | "read_only" | "stopped" | "deleted";

export type CloudExportDisplay =
  | { state: "none" }
  | { state: "packing"; export_id: string; requested_at: string }
  | {
      state: "ready";
      export_id: string;
      requested_at: string;
      ready_at: string;
      expires_at: string;
      archive_bytes: number | null;
    }
  // `expires_at` is when the export expired; null when a newer export replaced it.
  | { state: "expired"; export_id: string; requested_at: string; expires_at: string | null }
  | { state: "failed"; export_id: string; requested_at: string; error_code: string };

/**
 * The export row on Home. `pauses_assistants` says whether an export stops a
 * cell that serves assistants. It keys on the desired state, because the
 * export hold itself moves the observed state to `stopping` and `stopped`.
 */
export type CloudExportSummary = CloudExportDisplay & { pauses_assistants: boolean };

export type CloudExportPrincipal = Pick<ExomemSessionContext, "userId" | "tenantId">;

export type CloudExportDependencies = {
  env?: EnvironmentSource;
  /** How long the link request waits for the cell controller. */
  linkWaitMs?: number;
};

/** Release flag: off until the cell controller that packs exports is live. */
export function cloudExportsEnabled(env: EnvironmentSource = process.env): boolean {
  return env.EXOMEM_CLOUD_EXPORTS_ENABLED?.trim().toLowerCase() === "true";
}

/** The one display rule for an export row. */
function cloudExportDisplay(row: CloudExportRow | null, now: Date): CloudExportDisplay {
  if (!row) return { state: "none" };
  const base = { export_id: row.export_id, requested_at: row.created_at.toISOString() };
  if (row.requested_state === "superseded") return { state: "expired", ...base, expires_at: null };
  if (row.observed_state === "expired") {
    return { state: "expired", ...base, expires_at: row.expires_at?.toISOString() ?? null };
  }
  if (row.observed_state === "failed") {
    // C6 requires an error code on a failed row.
    return { state: "failed", ...base, error_code: row.error_code as string };
  }
  if (row.observed_state === "ready") {
    // C6 requires ready_at and expires_at on a ready row.
    if (!row.expires_at || !row.ready_at || now >= row.expires_at) {
      return { state: "expired", ...base, expires_at: row.expires_at?.toISOString() ?? null };
    }
    const bytes = row.archive_bytes === null ? null : Number(row.archive_bytes);
    return {
      state: "ready",
      ...base,
      ready_at: row.ready_at.toISOString(),
      expires_at: row.expires_at.toISOString(),
      archive_bytes: bytes !== null && Number.isSafeInteger(bytes) ? bytes : null,
    };
  }
  return { state: "packing", ...base };
}

function cloudExportSummary(
  row: CloudExportRow | null,
  desiredState: CellDesiredState | null,
  now: Date
): CloudExportSummary {
  return {
    ...cloudExportDisplay(row, now),
    pauses_assistants: desiredState === "running" || desiredState === "read_only",
  };
}

function exportError(code: string, status: number, message: string): ExomemHostedError {
  return new ExomemHostedError({ code, status, message });
}
const notFound = () => exportError("NOT_FOUND", 404, "the export is unavailable");
const unavailable = () => exportError("EXPORT_UNAVAILABLE", 403, "this account cannot export now");
const inProgress = () =>
  exportError("EXPORT_IN_PROGRESS", 409, "an export is already being packed");
const noData = () => exportError("EXPORT_NO_DATA", 409, "this account has never held data");
const conflict = () => exportError("EXPORT_CONFLICT", 409, "that export id is in use");
const notReady = () => exportError("EXPORT_NOT_READY", 409, "the export has no download");
const expired = () => exportError("EXPORT_EXPIRED", 410, "the export has expired");
const linkInvalid = () =>
  exportError("EXPORT_LINK_INVALID", 502, "the export link could not be issued");

type LiveCell = { cell_id: string; desired_state: CellDesiredState; observed_image: string | null };

async function lockLiveCell(
  tx: ExomemSql,
  principal: CloudExportPrincipal
): Promise<LiveCell | null> {
  const { rows } = await tx`
    /* exomem-cloud:export-lock-cell */
    SELECT cell.cell_id, cell.desired_state, cell.observed_image
    FROM exomem_cloud_cells AS cell
    JOIN exomem_tenants AS tenant ON tenant.id = cell.tenant_id
    WHERE cell.tenant_id = ${principal.tenantId}::uuid
      AND tenant.owner_user_id = ${principal.userId}::uuid
      AND tenant.status NOT IN ('deletion_pending', 'deleted')
      AND cell.desired_state <> 'deleted'
    FOR UPDATE OF cell
  `;
  return (rows[0] as LiveCell | undefined) ?? null;
}

/** The newest export of the tenant's live cell, with that cell's desired state. */
export async function readCloudExport(
  principal: CloudExportPrincipal,
  now: Date = new Date()
): Promise<CloudExportSummary> {
  const { rows } = await executeExomemSql`
    /* exomem-cloud:export-read */
    SELECT cell.desired_state, newest.*
    FROM exomem_cloud_cells AS cell
    JOIN exomem_tenants AS tenant ON tenant.id = cell.tenant_id
    LEFT JOIN LATERAL (
      SELECT export_id, requested_state, observed_state, error_code, archive_bytes,
             ready_at, expires_at, created_at
      FROM exomem_cloud_exports
      WHERE cell_id = cell.cell_id
      ORDER BY created_at DESC, export_id DESC
      LIMIT 1
    ) AS newest ON true
    WHERE cell.tenant_id = ${principal.tenantId}::uuid
      AND tenant.owner_user_id = ${principal.userId}::uuid
      AND tenant.status NOT IN ('deletion_pending', 'deleted')
      AND cell.desired_state <> 'deleted'
    LIMIT 1
  `;
  const row = rows[0] as (CloudExportRow & { desired_state: CellDesiredState }) | undefined;
  if (!row) return cloudExportSummary(null, null, now);
  return cloudExportSummary(row.export_id ? row : null, row.desired_state, now);
}

/**
 * Starts an export, or answers a retry of the same `export_id`. A ready
 * export of the cell is superseded in the same transaction, so the cell
 * controller deletes its archive.
 */
async function createCloudExport(
  principal: CloudExportPrincipal,
  requestedId: string | undefined,
  now: Date = new Date()
): Promise<{ export: CloudExportSummary; created: boolean }> {
  const exportId = requestedId ?? randomUUID();
  try {
    return await withExomemTransaction(async (tx) => {
      const cell = await lockLiveCell(tx, principal);
      if (!cell) throw unavailable();
      const retried = await exportRow(tx, cell.cell_id, exportId);
      if (retried) {
        return { export: cloudExportSummary(retried, cell.desired_state, now), created: false };
      }
      if (!cell.observed_image) {
        // cellctl records an image only once a pod of the cell was ready, so a
        // cell without one never served and holds no vault to pack.
        throw noData();
      }
      const open = await tx`
        SELECT 1 FROM exomem_cloud_exports
        WHERE cell_id = ${cell.cell_id} AND (observed_state IS NULL OR observed_state = 'packing')
        LIMIT 1
      `;
      if (open.rows[0]) throw inProgress();
      // Counted over the tenant's cells, so a re-admitted account keeps its window.
      const recent = await tx`
        SELECT count(*)::integer AS started,
               min(export.created_at) AS oldest
        FROM exomem_cloud_exports AS export
        JOIN exomem_cloud_cells AS any_cell ON any_cell.cell_id = export.cell_id
        WHERE any_cell.tenant_id = ${principal.tenantId}::uuid
          AND export.created_at > now() - interval '24 hours'
      `;
      const window = recent.rows[0] as { started: number; oldest: Date | null };
      if (window.started >= CLOUD_EXPORTS_PER_DAY) {
        const retryAfterMs = window.oldest
          ? Math.max(1_000, window.oldest.getTime() + 24 * 60 * 60 * 1000 - now.getTime())
          : undefined;
        throw new ExomemHostedError({
          code: "RATE_LIMITED",
          status: 429,
          message: "too many exports in 24 hours",
          retryable: true,
          retryAfterMs,
        });
      }
      await tx`
        UPDATE exomem_cloud_exports SET requested_state = 'superseded'
        WHERE cell_id = ${cell.cell_id} AND requested_state = 'requested' AND observed_state = 'ready'
      `;
      await tx`
        INSERT INTO exomem_cloud_exports (export_id, cell_id)
        VALUES (${exportId}::uuid, ${cell.cell_id})
      `;
      const row = await exportRow(tx, cell.cell_id, exportId);
      return { export: cloudExportSummary(row, cell.desired_state, now), created: true };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw (error as { constraint?: string }).constraint === "exomem_cloud_exports_open_cell_idx"
        ? inProgress()
        : conflict();
    }
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "23505";
}

async function exportRow(
  tx: ExomemSql,
  cellId: string,
  exportId: string
): Promise<CloudExportRow | null> {
  const { rows } = await tx`
    SELECT export_id, requested_state, observed_state, error_code, archive_bytes,
           ready_at, expires_at, created_at
    FROM exomem_cloud_exports WHERE export_id = ${exportId}::uuid AND cell_id = ${cellId}
  `;
  return (rows[0] as CloudExportRow | undefined) ?? null;
}

type LinkRow = CloudExportRow & {
  download_url: string | null;
  download_url_expires_at: Date | null;
  // Compared in SQL: the driver's Date drops the microseconds both times carry.
  link_answered: boolean;
};

async function readLinkRow(
  principal: CloudExportPrincipal,
  exportId: string
): Promise<LinkRow | null> {
  const { rows } = await executeExomemSql`
    /* exomem-cloud:export-link-read */
    SELECT export.export_id, export.requested_state, export.observed_state, export.error_code,
           export.archive_bytes, export.ready_at, export.expires_at, export.created_at,
           export.download_url, export.download_url_expires_at,
           COALESCE(export.link_issued_at >= export.link_requested_at, false) AS link_answered
    FROM exomem_cloud_exports AS export
    JOIN exomem_cloud_cells AS cell ON cell.cell_id = export.cell_id
    JOIN exomem_tenants AS tenant ON tenant.id = cell.tenant_id
    WHERE export.export_id = ${exportId}::uuid
      AND cell.tenant_id = ${principal.tenantId}::uuid
      AND tenant.owner_user_id = ${principal.userId}::uuid
      AND tenant.status NOT IN ('deletion_pending', 'deleted')
      AND cell.desired_state <> 'deleted'
  `;
  return (rows[0] as LinkRow | undefined) ?? null;
}

/**
 * The one decision on whether an export may hand out a link, for the request
 * and for each poll while it waits: only a ready export does. The display rule
 * decides, so a link and the export row on Home never disagree.
 */
function assertLinkable(row: LinkRow, now: Date): void {
  const { state } = cloudExportDisplay(row, now);
  if (state === "expired") throw expired();
  if (state !== "ready") throw notReady();
}

/** The link the controller issued, if it is an https URL; a log line never carries it. */
function httpsLink(url: string): string {
  if (URL.canParse(url) && new URL(url).protocol === "https:") return url;
  console.warn({ event: "exomem_cloud_export_link_invalid", reason: "not_https" });
  throw linkInvalid();
}

export type CloudExportLink =
  | { state: "issued"; url: string; url_expires_at: string }
  | { state: "pending" };

/**
 * Asks the cell controller for a fresh 5-minute link and waits for it at most
 * `linkWaitMs`. A link counts only when the controller issued it at or after
 * the row's newest link request, which is this one or a later one, so a link
 * handed out earlier is never returned again.
 */
async function requestCloudExportLink(
  principal: CloudExportPrincipal,
  exportId: string,
  dependencies: CloudExportDependencies = {}
): Promise<CloudExportLink> {
  if (!validUuid(exportId)) throw notFound();
  const { rows } = await executeExomemSql`
    /* exomem-cloud:export-link-request */
    UPDATE exomem_cloud_exports AS export
    SET link_requested_at = now()
    FROM exomem_cloud_cells AS cell, exomem_tenants AS tenant
    WHERE export.export_id = ${exportId}::uuid
      AND cell.cell_id = export.cell_id
      AND tenant.id = cell.tenant_id
      AND cell.tenant_id = ${principal.tenantId}::uuid
      AND tenant.owner_user_id = ${principal.userId}::uuid
      AND tenant.status NOT IN ('deletion_pending', 'deleted')
      AND cell.desired_state <> 'deleted'
      AND export.requested_state = 'requested'
      AND export.observed_state = 'ready'
      AND export.expires_at > now()
    RETURNING export.export_id
  `;
  if (!rows[0]) {
    const row = await readLinkRow(principal, exportId);
    if (!row) throw notFound();
    assertLinkable(row, new Date());
    throw notReady();
  }
  const deadline = Date.now() + (dependencies.linkWaitMs ?? LINK_WAIT_MS);
  while (true) {
    const row = await readLinkRow(principal, exportId);
    if (!row) throw notFound();
    const now = new Date();
    assertLinkable(row, now);
    if (
      row.download_url &&
      row.download_url_expires_at &&
      row.download_url_expires_at > now &&
      row.link_answered
    ) {
      return {
        state: "issued",
        url: httpsLink(row.download_url),
        url_expires_at: row.download_url_expires_at.toISOString(),
      };
    }
    if (Date.now() + LINK_POLL_MS > deadline) return { state: "pending" };
    await sleep(LINK_POLL_MS);
  }
}

const CreateExportBody = z.strictObject({ export_id: z.uuid().optional() });

const EXPORT_HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  "referrer-policy": "no-referrer",
};

function respond(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: EXPORT_HEADERS });
}

function errorResponse(error: unknown): Response {
  const response = safeErrorResponse(error);
  for (const [name, value] of Object.entries(EXPORT_HEADERS)) response.headers.set(name, value);
  return response;
}

/** `GET` and `POST /api/exomem/cloud/exports`. */
export async function handleCloudExportsRequest(
  request: Request,
  dependencies: CloudExportDependencies = {}
): Promise<Response> {
  try {
    if (!cloudExportsEnabled(dependencies.env)) throw notFound();
    const session = await resolveExomemSession(request);
    if (request.method === "GET") return respond({ export: await readCloudExport(session) });
    validateMutationRequest(request, session);
    const body = CreateExportBody.safeParse(
      request.body ? await readBoundedJsonRequest(request, 1024) : {}
    );
    if (!body.success) throw exomemErrors.invalidRequest();
    const result = await createCloudExport(session, body.data.export_id?.toLowerCase());
    return respond({ export: result.export }, result.created ? 201 : 200);
  } catch (error) {
    return errorResponse(error);
  }
}

/** `POST /api/exomem/cloud/exports/{exportId}/link`. */
export async function handleCloudExportLinkRequest(
  request: Request,
  exportId: string,
  dependencies: CloudExportDependencies = {}
): Promise<Response> {
  try {
    if (!cloudExportsEnabled(dependencies.env)) throw notFound();
    const session = await resolveExomemSession(request);
    validateMutationRequest(request, session);
    const link = await requestCloudExportLink(session, exportId.toLowerCase(), dependencies);
    return link.state === "issued"
      ? respond({ url: link.url, url_expires_at: link.url_expires_at })
      : respond({ state: "pending" }, 202);
  } catch (error) {
    return errorResponse(error);
  }
}
