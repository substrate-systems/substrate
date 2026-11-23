/**
 * What the gateway tells a covered cell about the operator's notices
 * (`add-exomem-service-notices`, D3): the sentence the assistant relays, the one
 * header that carries it and the gateway's cached lookup. It imports neither
 * Next nor the email outbox, because the gateway bundle includes it.
 */

import { loggedOccurrence } from "./logged-occurrence";
import { executeExomemSql } from "./db";
import {
  noticeState,
  OPEN_NOTICE_LIMIT,
  toNotice,
  type ServiceNotice,
} from "./service-notice-model";
import { statusPageUrlOrDefault } from "./status-page-url";
import { emailDateTime, emailTimeSpan } from "../email-templates/exomem-email-time";

export const SAY_MAX_CHARS = 400;
export const NOTICE_HEADER = "x-exomem-service-notice";
export const NOTICE_HEADER_MAX_BYTES = 1024;
// base64url writes three bytes as four characters, so the encoded value stays
// within the limit above when its JSON is at most this long.
const NOTICE_JSON_MAX_BYTES = (NOTICE_HEADER_MAX_BYTES / 4) * 3;

/** The longest a gateway instance serves a notice without asking the database again. */
export const NOTICE_CACHE_TTL_MS = 30_000;

export function codePoints(text: string): string[] {
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
