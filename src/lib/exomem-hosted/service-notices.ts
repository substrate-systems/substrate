/**
 * Exomem Cloud service notices (`add-exomem-service-notices`).
 *
 * The operator declares planned maintenance or an incident; nothing creates a
 * notice automatically. This module holds the record's rules and the operator's
 * operations: reading a request (D1), recording, cancelling and resolving a
 * notice, and describing one for the operator. The notice's shape and state are
 * in service-notice-model.ts; what the gateway sends a cell is in
 * service-notice-header.ts.
 */

import { executeExomemSql, withExomemTransaction, type ExomemSql } from "./db";
import { CLOUD_CELL_ID_PATTERN } from "./cloud-config";
import { ExomemHostedError } from "./errors";
import {
  NOTICE_KINDS,
  noticeState,
  OPEN_NOTICE_LIMIT,
  toNotice,
  type NoticeKind,
  type ServiceNotice,
} from "./service-notice-model";
import { codePoints, composeNoticeSay } from "./service-notice-header";
import { statusPageUrlOrDefault } from "./status-page-url";

export const SUMMARY_MAX_CHARS = 280;

/** Maintenance is announced this long before it starts unless the operator sets another time. */
export const DEFAULT_ANNOUNCE_LEAD_MS = 48 * 60 * 60 * 1000;

// The operator reads these messages, so they say what to fix. The envelope's
// codes belong to this feature and stay out of the shared registry.
function noticeError(code: string, status: number, message: string): ExomemHostedError {
  return new ExomemHostedError({ code, status, message });
}
const invalid = (message: string) => noticeError("SERVICE_NOTICE_INVALID", 400, message);

// An instant must name its zone: a bare local time would mean the server's zone.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function readInstant(value: unknown, name: string): Date {
  if (typeof value !== "string" || !INSTANT.test(value) || !Number.isFinite(Date.parse(value))) {
    throw invalid(`${name} must be an ISO 8601 time with a zone, such as 2026-11-25T02:00:00Z`);
  }
  return new Date(value);
}

export type NewNotice = {
  kind: NoticeKind;
  summary: string;
  startsAt: Date;
  endsAt: Date | null;
  announceFrom: Date | null;
  cellIds: string[];
};

const NEW_NOTICE_FIELDS = new Set([
  "action",
  "kind",
  "summary",
  "startsAt",
  "endsAt",
  "announceFrom",
  "cellIds",
]);

/**
 * Reads and checks the operator's request for a new notice. Every rule of the
 * specification that needs no database lives here. The route's body limit
 * bounds `cellIds`.
 */
export function parseNewNotice(body: Record<string, unknown>, now: Date): NewNotice {
  for (const key of Object.keys(body)) {
    if (!NEW_NOTICE_FIELDS.has(key)) throw invalid(`${key} is not a notice field`);
  }
  const kind = (NOTICE_KINDS as readonly unknown[]).includes(body.kind)
    ? (body.kind as NoticeKind)
    : null;
  if (!kind) throw invalid(`kind must be one of ${NOTICE_KINDS.join(", ")}`);

  if (typeof body.summary !== "string") throw invalid("summary is required");
  const summary = body.summary.trim();
  const length = codePoints(summary).length;
  if (length < 1 || length > SUMMARY_MAX_CHARS) {
    throw invalid(`summary must be 1 to ${SUMMARY_MAX_CHARS} characters`);
  }
  // The summary is one line in an email, a sentence and a status issue title. This is a closed
  // set the Unicode standard fixes: control characters, the line and paragraph separators, and
  // the bidi embedding, override and isolate controls that split or reorder what a reader sees.
  if (/[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u.test(summary)) {
    throw invalid("summary must be a single line of plain text");
  }

  let cellIds: string[] = [];
  if (body.cellIds !== undefined) {
    if (
      !Array.isArray(body.cellIds) ||
      !body.cellIds.every((id) => typeof id === "string" && CLOUD_CELL_ID_PATTERN.test(id))
    ) {
      throw invalid("cellIds must be a list of cell ids");
    }
    cellIds = [...new Set(body.cellIds as string[])].sort();
  }

  if (kind === "incident") {
    if (body.endsAt !== undefined || body.announceFrom !== undefined) {
      throw invalid("an incident has no end or announce time; resolve it when it is over");
    }
    const startsAt = body.startsAt === undefined ? now : readInstant(body.startsAt, "startsAt");
    if (startsAt.getTime() > now.getTime())
      throw invalid("an incident must start no later than now");
    return { kind, summary, startsAt, endsAt: null, announceFrom: null, cellIds };
  }

  const startsAt = readInstant(body.startsAt, "startsAt");
  const endsAt = readInstant(body.endsAt, "endsAt");
  if (startsAt.getTime() <= now.getTime()) throw invalid("maintenance must start in the future");
  if (endsAt.getTime() <= startsAt.getTime()) throw invalid("maintenance must end after it starts");
  const announceFrom =
    body.announceFrom === undefined
      ? new Date(startsAt.getTime() - DEFAULT_ANNOUNCE_LEAD_MS)
      : readInstant(body.announceFrom, "announceFrom");
  if (announceFrom.getTime() > startsAt.getTime()) {
    throw invalid("announceFrom must not be after the start");
  }
  return { kind, summary, startsAt, endsAt, announceFrom, cellIds };
}

async function readNotice(run: ExomemSql, id: string): Promise<ServiceNotice | null> {
  const result = await run`
    SELECT n.*, ARRAY(SELECT c.cell_id FROM exomem_service_notice_cells AS c
                      WHERE c.notice_id = n.id ORDER BY c.cell_id) AS cell_ids
    FROM exomem_service_notices AS n
    WHERE n.id = ${id}::uuid
  `;
  return result.rows[0] ? toNotice(result.rows[0]) : null;
}

/** Refuses a cell id that names no live cell: a notice must name cells that exist. */
async function assertCellsLive(run: ExomemSql, cellIds: string[]): Promise<void> {
  if (cellIds.length === 0) return;
  const found = await run`
    SELECT cell_id FROM exomem_cloud_cells
    WHERE cell_id = ANY (${cellIds}::text[]) AND desired_state <> 'deleted'
  `;
  const live = new Set(found.rows.map((row) => String(row.cell_id)));
  const missing = cellIds.filter((id) => !live.has(id));
  if (missing.length > 0) {
    throw noticeError(
      "SERVICE_NOTICE_CELL_UNKNOWN",
      400,
      `no live cell has the id ${missing.join(", ")}`
    );
  }
}

/** Creates a notice. */
export async function createServiceNotice(input: NewNotice): Promise<ServiceNotice> {
  return withExomemTransaction(async (tx) => {
    await assertCellsLive(tx, input.cellIds);
    const inserted = await tx`
      INSERT INTO exomem_service_notices (kind, summary, starts_at, ends_at, announce_from)
      VALUES (${input.kind}, ${input.summary}, ${input.startsAt.toISOString()}::timestamptz,
              ${input.endsAt?.toISOString() ?? null}::timestamptz,
              ${input.announceFrom?.toISOString() ?? null}::timestamptz)
      RETURNING id
    `;
    const id = String(inserted.rows[0]?.id);
    if (input.cellIds.length > 0) {
      await tx`
        INSERT INTO exomem_service_notice_cells (notice_id, cell_id)
        SELECT ${id}::uuid, unnest(${input.cellIds}::text[])
      `;
    }
    return (await readNotice(tx, id)) as ServiceNotice;
  });
}

/** Why a notice could not change: the operator reads it, so it names the reason. */
async function refuseChange(id: string, verb: "cancel" | "resolve"): Promise<never> {
  const notice = await readNotice(executeExomemSql, id);
  if (!notice) throw noticeError("SERVICE_NOTICE_NOT_FOUND", 404, "no notice has this id");
  const wanted: NoticeKind = verb === "cancel" ? "maintenance" : "incident";
  if (notice.kind !== wanted) {
    throw invalid(`only ${wanted} can be ${verb === "cancel" ? "cancelled" : "resolved"}`);
  }
  const reason = notice.cancelledAt
    ? "it is already cancelled"
    : notice.resolvedAt
      ? "it is already resolved"
      : "the maintenance has ended";
  throw noticeError("SERVICE_NOTICE_FINAL", 409, `the notice cannot change: ${reason}`);
}

/** Cancels maintenance that has not ended. A cancelled notice never changes again. */
export async function cancelServiceNotice(id: string): Promise<ServiceNotice> {
  const updated = await executeExomemSql`
    UPDATE exomem_service_notices SET cancelled_at = now(), updated_at = now()
    WHERE id = ${id}::uuid AND kind = 'maintenance' AND cancelled_at IS NULL AND ends_at > now()
    RETURNING id
  `;
  if (updated.rows.length === 0) return refuseChange(id, "cancel");
  return (await readNotice(executeExomemSql, id)) as ServiceNotice;
}

/** Resolves an incident. A resolved notice never changes again. */
export async function resolveServiceNotice(id: string): Promise<ServiceNotice> {
  // GREATEST keeps resolved_at from falling before starts_at when two clocks disagree by a moment.
  const updated = await executeExomemSql`
    UPDATE exomem_service_notices SET resolved_at = GREATEST(now(), starts_at), updated_at = now()
    WHERE id = ${id}::uuid AND kind = 'incident' AND resolved_at IS NULL
    RETURNING id
  `;
  if (updated.rows.length === 0) return refuseChange(id, "resolve");
  return (await readNotice(executeExomemSql, id)) as ServiceNotice;
}

const RECENT_NOTICE_LIMIT = 50;

/** Open notices (not cancelled, resolved or ended) first, then the newest others. */
export async function listServiceNotices(): Promise<ServiceNotice[]> {
  const open = await executeExomemSql`
    SELECT n.*, ARRAY(SELECT c.cell_id FROM exomem_service_notice_cells AS c
                      WHERE c.notice_id = n.id ORDER BY c.cell_id) AS cell_ids
    FROM exomem_service_notices AS n
    WHERE n.cancelled_at IS NULL AND n.resolved_at IS NULL AND (n.ends_at IS NULL OR n.ends_at > now())
    ORDER BY n.starts_at
    LIMIT ${OPEN_NOTICE_LIMIT}
  `;
  const recent = await executeExomemSql`
    SELECT n.*, ARRAY(SELECT c.cell_id FROM exomem_service_notice_cells AS c
                      WHERE c.notice_id = n.id ORDER BY c.cell_id) AS cell_ids
    FROM exomem_service_notices AS n
    WHERE NOT (n.cancelled_at IS NULL AND n.resolved_at IS NULL AND (n.ends_at IS NULL OR n.ends_at > now()))
    ORDER BY n.starts_at DESC
    LIMIT ${RECENT_NOTICE_LIMIT}
  `;
  return [...open.rows, ...recent.rows].map(toNotice);
}

export type NoticePreview = {
  /** Tenants whose owner the emails will reach. */
  coveredTenants: number;
  /** What the assistant will relay once the notice is current. */
  say: string;
};

/** What creating this notice would reach, before anything is recorded. */
export async function previewServiceNotice(input: NewNotice): Promise<NoticePreview> {
  await assertCellsLive(executeExomemSql, input.cellIds);
  const covered = await executeExomemSql`
    SELECT count(*)::int AS tenants FROM exomem_service_notice_covered_tenants(${input.cellIds}::text[])
  `;
  return {
    coveredTenants: Number(covered.rows[0]?.tenants ?? 0),
    say: composeNoticeSay(
      input,
      input.kind === "incident" ? "active" : "scheduled",
      statusPageUrlOrDefault()
    ),
  };
}

/** The operator's view of one notice: every value says what it is. */
export function describeNotice(notice: ServiceNotice, at: Date) {
  const state = noticeState(notice, at);
  // Only a current notice has words for the assistant to relay.
  const say =
    state === "scheduled" || state === "active"
      ? composeNoticeSay(notice, state, statusPageUrlOrDefault())
      : null;
  const iso = (value: Date | null) => (value ? value.toISOString() : null);
  return {
    id: notice.id,
    kind: notice.kind,
    summary: notice.summary,
    state,
    say,
    startsAt: iso(notice.startsAt),
    endsAt: iso(notice.endsAt),
    announceFrom: iso(notice.announceFrom),
    cancelledAt: iso(notice.cancelledAt),
    resolvedAt: iso(notice.resolvedAt),
    cellIds: notice.cellIds,
    createdAt: iso(notice.createdAt),
  };
}
