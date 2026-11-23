/**
 * Exomem Cloud service notices (`add-exomem-service-notices`).
 *
 * The operator declares planned maintenance or an incident; nothing creates a
 * notice automatically. This module holds the record and its rules (D1), the
 * one header the gateway sends a covered cell (D3) and the gateway's cached
 * lookup. It imports neither Next nor the email outbox, because the gateway
 * bundle includes it.
 *
 * A notice has no state column. Its state follows from its times:
 *
 *   maintenance: pending before announce_from, scheduled until starts_at,
 *                active until ends_at, over afterwards or once cancelled;
 *   incident:    active from starts_at until it is resolved.
 */

import { loggedOccurrence } from "./logged-occurrence";
import { executeExomemSql, withExomemTransaction, type ExomemSql } from "./db";
import { ExomemHostedError } from "./errors";
import { statusPageUrlOrDefault } from "./status-page-url";
import { emailDateTime, emailTimeSpan } from "../email-templates/exomem-email-time";

// Each kind sends different emails and follows different rules, so the set is
// fixed by the specification, not by data.
export const NOTICE_KINDS = ["maintenance", "incident"] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

export type NoticeState = "pending" | "scheduled" | "active" | "over";

export const SUMMARY_MAX_CHARS = 280;
export const SAY_MAX_CHARS = 400;
export const NOTICE_HEADER = "x-exomem-service-notice";
export const NOTICE_HEADER_MAX_BYTES = 1024;
// base64url writes three bytes as four characters, so the encoded value stays
// within the limit above when its JSON is at most this long.
const NOTICE_JSON_MAX_BYTES = (NOTICE_HEADER_MAX_BYTES / 4) * 3;

/** Maintenance is announced this long before it starts unless the operator sets another time. */
export const DEFAULT_ANNOUNCE_LEAD_MS = 48 * 60 * 60 * 1000;
/** The longest a gateway instance serves a notice without asking the database again. */
export const NOTICE_CACHE_TTL_MS = 30_000;

export type ServiceNotice = {
  id: string;
  kind: NoticeKind;
  summary: string;
  startsAt: Date;
  endsAt: Date | null;
  announceFrom: Date | null;
  cancelledAt: Date | null;
  resolvedAt: Date | null;
  /** The cells the notice names; empty covers the whole fleet. */
  cellIds: string[];
  createdAt: Date;
};

type StateFields = Pick<
  ServiceNotice,
  "kind" | "startsAt" | "endsAt" | "announceFrom" | "cancelledAt" | "resolvedAt"
>;

export function noticeState(notice: StateFields, at: Date): NoticeState {
  if (notice.cancelledAt || notice.resolvedAt) return "over";
  const time = at.getTime();
  if (notice.kind === "incident") return time >= notice.startsAt.getTime() ? "active" : "pending";
  if (notice.endsAt && time >= notice.endsAt.getTime()) return "over";
  if (time >= notice.startsAt.getTime()) return "active";
  if (notice.announceFrom && time < notice.announceFrom.getTime()) return "pending";
  return "scheduled";
}

// --- The sentence the assistant relays, and the header that carries it ---

function codePoints(text: string): string[] {
  return Array.from(text);
}

/** The longest start of `text` that stays within `limit` UTF-16 units, cut between characters. */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let kept = "";
  for (const point of codePoints(text)) {
    if (kept.length + point.length > limit - 1) break;
    kept += point;
  }
  return `${kept.trimEnd()}…`;
}

/**
 * The sentence for the assistant to relay. It says only what the operator
 * declared: the times, the operator's summary and where to read more. Times
 * are UTC because the assistant does not know the person's time zone.
 */
export function composeNoticeSay(
  notice: Pick<ServiceNotice, "kind" | "summary" | "startsAt" | "endsAt">,
  state: "scheduled" | "active",
  statusUrl: string,
  summaryLimit: number = SAY_MAX_CHARS
): string {
  let lead: string;
  if (notice.kind === "incident") {
    lead = `Exomem has a known problem that started ${emailDateTime(notice.startsAt, null)}.`;
  } else {
    const end = notice.endsAt as Date;
    lead =
      state === "scheduled"
        ? `Exomem maintenance is planned for ${emailTimeSpan(notice.startsAt, end, null)}.`
        : `Exomem maintenance is under way until ${emailDateTime(end, null)}.`;
  }
  const tail = `More at ${statusUrl}`;
  // The summary gives way first when the sentence is too long.
  const room = Math.max(0, Math.min(summaryLimit, SAY_MAX_CHARS - lead.length - tail.length - 2));
  const summary = clip(notice.summary, room);
  return [lead, summary, tail].filter(Boolean).join(" ");
}

function isoSeconds(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}

/** Base64url of UTF-8 JSON, the header's one shape (D3). Carries no tenant data. */
export function encodeNoticeHeader(
  notice: ServiceNotice,
  state: "scheduled" | "active",
  statusUrl: string
): string {
  let summaryLimit = SAY_MAX_CHARS;
  for (;;) {
    const json = JSON.stringify({
      v: 1,
      kind: notice.kind,
      state,
      starts_at: isoSeconds(notice.startsAt),
      ends_at: notice.endsAt ? isoSeconds(notice.endsAt) : null,
      say: composeNoticeSay(notice, state, statusUrl, summaryLimit),
    });
    const bytes = Buffer.byteLength(json, "utf8");
    // A summary of wide characters or quotes outgrows the byte limit before the
    // character limit; shorten it by the excess, at least one character a pass.
    if (bytes <= NOTICE_JSON_MAX_BYTES || summaryLimit === 0) {
      return Buffer.from(json, "utf8").toString("base64url");
    }
    summaryLimit = Math.max(
      0,
      summaryLimit - Math.max(1, Math.ceil((bytes - NOTICE_JSON_MAX_BYTES) / 4))
    );
  }
}

const STATE_RANK: Record<string, number> = {
  "incident:active": 0,
  "maintenance:active": 1,
  "maintenance:scheduled": 2,
};

/**
 * The notice that matters most for one cell at one moment: an active incident,
 * then active maintenance, then the earliest scheduled maintenance (D3).
 */
export function pickCurrentNotice(
  notices: ServiceNotice[],
  cellId: string,
  at: Date
): { notice: ServiceNotice; state: "scheduled" | "active" } | null {
  let best: { notice: ServiceNotice; state: "scheduled" | "active"; rank: number } | null = null;
  for (const notice of notices) {
    if (notice.cellIds.length > 0 && !notice.cellIds.includes(cellId)) continue;
    const state = noticeState(notice, at);
    if (state !== "scheduled" && state !== "active") continue;
    const rank = STATE_RANK[`${notice.kind}:${state}`] as number;
    const wins =
      !best ||
      rank < best.rank ||
      (rank === best.rank &&
        (notice.startsAt.getTime() < best.notice.startsAt.getTime() ||
          (notice.startsAt.getTime() === best.notice.startsAt.getTime() &&
            notice.id < best.notice.id)));
    if (wins) best = { notice, state, rank };
  }
  return best ? { notice: best.notice, state: best.state } : null;
}

// --- Storage ---

type Row = Record<string, unknown>;

function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function asDateOrNull(value: unknown): Date | null {
  return value === null || value === undefined ? null : asDate(value);
}

function toNotice(row: Row): ServiceNotice {
  return {
    id: String(row.id),
    kind: row.kind as NoticeKind,
    summary: String(row.summary),
    startsAt: asDate(row.starts_at),
    endsAt: asDateOrNull(row.ends_at),
    announceFrom: asDateOrNull(row.announce_from),
    cancelledAt: asDateOrNull(row.cancelled_at),
    resolvedAt: asDateOrNull(row.resolved_at),
    cellIds: Array.isArray(row.cell_ids) ? (row.cell_ids as string[]) : [],
    createdAt: asDate(row.created_at),
  };
}

// The operator reads these messages, so they say what to fix. The envelope's
// codes belong to this feature and stay out of the shared registry.
function noticeError(code: string, status: number, message: string): ExomemHostedError {
  return new ExomemHostedError({ code, status, message });
}
const invalid = (message: string) => noticeError("SERVICE_NOTICE_INVALID", 400, message);

const CELL_ID = /^[a-z2-7]{16}$/;
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
  // The summary is one line in an email, a sentence and a status issue title.
  if (/\p{Cc}/u.test(summary)) throw invalid("summary must be a single line of plain text");

  let cellIds: string[] = [];
  if (body.cellIds !== undefined) {
    if (
      !Array.isArray(body.cellIds) ||
      !body.cellIds.every((id) => typeof id === "string" && CELL_ID.test(id))
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

// A handful of notices are open at a time because the operator declares each
// one; the cap keeps a forgotten backlog from growing a response or a cache.
const OPEN_NOTICE_LIMIT = 100;
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

// --- The gateway's lookup ---

/**
 * Every notice a request could need within the next cache lifetime: open ones
 * that are announced now or will be before the cache asks again. State is
 * worked out per request in memory, so a notice that starts or ends between
 * two loads changes on time. One query serves every request of the instance.
 */
export async function loadOpenServiceNotices(): Promise<ServiceNotice[]> {
  const result = await executeExomemSql`
    /* exomem-cloud:service-notices */
    SELECT n.*, ARRAY(SELECT c.cell_id FROM exomem_service_notice_cells AS c
                      WHERE c.notice_id = n.id ORDER BY c.cell_id) AS cell_ids
    FROM exomem_service_notices AS n
    WHERE n.cancelled_at IS NULL AND n.resolved_at IS NULL
      AND (n.ends_at IS NULL OR n.ends_at > now())
      AND coalesce(n.announce_from, n.starts_at) <= now() + make_interval(secs => ${NOTICE_CACHE_TTL_MS / 1000})
    ORDER BY n.starts_at
    LIMIT ${OPEN_NOTICE_LIMIT}
  `;
  return result.rows.map(toNotice);
}

export type NoticeCache = {
  /** The header value for a request to this cell, or null when no current notice covers it. */
  headerFor(cellId: string): Promise<string | null>;
};

export type NoticeCacheOptions = {
  load: () => Promise<ServiceNotice[]>;
  now?: () => number;
  statusUrl?: () => string;
  ttlMs?: number;
  /** How long the first request after start waits for the first load. */
  coldWaitMs?: number;
  /** A load that takes longer counts as failed, so a hung query cannot stop later loads. */
  loadTimeoutMs?: number;
  /** Past this age without a successful load the cache says nothing: it can no longer vouch for a notice. */
  maxStaleMs?: number;
};

let noticeLoadFailures = 0;

/**
 * A process-local copy of the open notices, refreshed at most once per
 * `ttlMs` by one load, whatever the request rate (D3). A request never waits
 * for a refresh except the first one after start, and then only briefly. A
 * failed refresh keeps the last copy until it is too old to trust.
 */
export function createNoticeCache(options: NoticeCacheOptions): NoticeCache {
  const now = options.now ?? (() => Date.now());
  const statusUrl = options.statusUrl ?? (() => statusPageUrlOrDefault());
  const ttlMs = options.ttlMs ?? NOTICE_CACHE_TTL_MS;
  const coldWaitMs = options.coldWaitMs ?? 250;
  const loadTimeoutMs = options.loadTimeoutMs ?? 5_000;
  const maxStaleMs = options.maxStaleMs ?? 10 * ttlMs;

  let notices: ServiceNotice[] | null = null;
  // Encoding costs milliseconds for a long summary, which no request may pay (the 1 ms budget
  // of D3). A header depends only on the notice, its state and the address, so each is encoded
  // once per load: at most two states for each of the 100 open notices.
  let encoded = new Map<string, string>();
  let loadedAt = 0;
  let attemptedAt = -Infinity;
  let attempt = 0;
  let inflight: Promise<void> | null = null;

  function refresh(): Promise<void> {
    if (inflight) return inflight;
    attemptedAt = now();
    const mine = ++attempt;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("service notice load timed out")), loadTimeoutMs);
    });
    inflight = Promise.race([options.load(), timedOut])
      .then(
        (loaded) => {
          // A load that timed out and finishes later must not replace newer data.
          if (mine !== attempt) return;
          notices = loaded;
          encoded = new Map();
          loadedAt = now();
        },
        (error: unknown) => {
          noticeLoadFailures += 1;
          if (loggedOccurrence(noticeLoadFailures)) {
            const code = (error as { code?: unknown } | null)?.code;
            console.warn({
              event: "exomem_cloud_gateway_service_notices_unavailable",
              count: noticeLoadFailures,
              code: typeof code === "string" ? code : null,
            });
          }
        }
      )
      .finally(() => {
        clearTimeout(timer);
        inflight = null;
      });
    return inflight;
  }

  async function waitBriefly(pending: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gone = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, coldWaitMs);
    });
    try {
      await Promise.race([pending, gone]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async headerFor(cellId) {
      const at = now();
      if (at - attemptedAt >= ttlMs) {
        const started = refresh();
        if (!notices) await waitBriefly(started);
      } else if (!notices && inflight) {
        await waitBriefly(inflight);
      }
      if (!notices || at - loadedAt > maxStaleMs) return null;
      const current = pickCurrentNotice(notices, cellId, new Date(at));
      if (!current) return null;
      const url = statusUrl();
      const key = `${current.notice.id} ${current.state} ${url}`;
      let header = encoded.get(key);
      if (header === undefined) {
        header = encodeNoticeHeader(current.notice, current.state, url);
        encoded.set(key, header);
      }
      return header;
    },
  };
}

let gatewayNoticeCache: NoticeCache | null = null;

/** The gateway's cache, bound to the database. */
export function currentNoticeHeader(cellId: string): Promise<string | null> {
  gatewayNoticeCache ??= createNoticeCache({ load: loadOpenServiceNotices });
  return gatewayNoticeCache.headerFor(cellId);
}
