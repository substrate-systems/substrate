/**
 * The shape of an Exomem Cloud service notice (`add-exomem-service-notices`, D1)
 * and the rule that turns its times into a state. The operator's record
 * (service-notices.ts) and the gateway's header (service-notice-header.ts) both
 * build on it, so neither imports the other's job.
 *
 * A notice has no state column. Its state follows from its times:
 *
 *   maintenance: pending before announce_from, scheduled until starts_at,
 *                active until ends_at, over afterwards or once cancelled;
 *   incident:    active from starts_at until it is resolved.
 */

// Each kind sends different emails and follows different rules, so the set is
// fixed by the specification, not by data.
export const NOTICE_KINDS = ["maintenance", "incident"] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

export type NoticeState = "pending" | "scheduled" | "active" | "over";

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

// A handful of notices are open at a time because the operator declares each
// one; the cap keeps a forgotten backlog from growing a response or a cache.
export const OPEN_NOTICE_LIMIT = 100;

type Row = Record<string, unknown>;

function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function asDateOrNull(value: unknown): Date | null {
  return value === null || value === undefined ? null : asDate(value);
}

export function toNotice(row: Row): ServiceNotice {
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
