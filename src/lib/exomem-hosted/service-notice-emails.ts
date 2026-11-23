/**
 * What the two service-notice emails re-check at send (`add-exomem-service-notices`,
 * D2), and the one dedupe key that makes each owner's email once per notice.
 * The outbox registry (email-outbox.ts) wires these in; the fan-out
 * (service-notice-fanout.ts) queues the rows. This module imports nothing at
 * run time from either, so the registry can load it first.
 */

import type { ExomemThemeChoice } from "@/lib/exomem/theme";
import type { ExomemEmailScheme } from "@/lib/email-templates/exomem-email";
import type { ExomemEmailAddressee } from "./email-outbox";
import type { ExomemSql } from "./db";

/** Every email of one notice starts with this; the tenant's id follows. */
export function serviceNoticeDedupePrefix(noticeId: string): string {
  return `service-notice:${noticeId}:`;
}

/** The outbox row's dedupe key: one email per notice and tenant, whichever kind it is. */
export function serviceNoticeDedupeKey(noticeId: string, tenantId: string): string {
  return `${serviceNoticeDedupePrefix(noticeId)}${tenantId}`;
}

export type ServiceNoticeEmailPayload = { version: 1; noticeId: string; tenantId: string };

export type ServiceNoticeEmailContext = {
  /** The owner's address, zone and scheme as the database holds them now. */
  owner: ExomemEmailAddressee;
  summary: string;
  startsAt: Date;
  endsAt: Date | null;
  resolvedAt: Date | null;
};

type NoticeRow = {
  summary: string;
  starts_at: Date | string;
  ends_at: Date | string | null;
  resolved_at: Date | string | null;
  cell_ids: string[];
};

type OwnerRow = {
  owner_email: string;
  time_zone: string | null;
  email_scheme: ExomemEmailScheme | null;
  theme_choice: ExomemThemeChoice | null;
};

/**
 * The latest creation time of a cell the notice's email covers, as a timestamptz
 * literal. A cell that began after an incident was resolved never had it, so
 * its owner gets no resolution email; maintenance covers every cell.
 */
export function serviceNoticeCoverageEnd(kind: string, resolvedAt: Date | string | null): string {
  return kind === "incident" && resolvedAt ? new Date(resolvedAt).toISOString() : "infinity";
}

/**
 * The owner as the database holds them now, when the tenant is still one the
 * notice covers. The cell ids go in as one bound array, which lets PostgreSQL
 * inline the covered-tenants function and look up this one tenant's cell.
 */
async function coveredOwner(
  tx: ExomemSql,
  payload: ServiceNoticeEmailPayload,
  notice: NoticeRow,
  kind: string
): Promise<ServiceNoticeEmailContext | null> {
  const { rows } = await tx`
    /* exomem:email-service-notice-owner */
    SELECT covered.owner_email, covered.time_zone, covered.email_scheme, covered.theme_choice
    FROM exomem_service_notice_covered_tenants(
           ${notice.cell_ids}::text[],
           ${serviceNoticeCoverageEnd(kind, notice.resolved_at)}::timestamptz
         ) AS covered
    WHERE covered.tenant_id = ${payload.tenantId}::uuid
  `;
  const owner = rows[0] as OwnerRow | undefined;
  if (!owner) return null;
  return {
    owner: {
      email: owner.owner_email,
      timeZone: owner.time_zone,
      emailScheme: owner.email_scheme,
      themeChoice: owner.theme_choice,
    },
    summary: notice.summary,
    startsAt: new Date(notice.starts_at),
    endsAt: notice.ends_at ? new Date(notice.ends_at) : null,
    resolvedAt: notice.resolved_at ? new Date(notice.resolved_at) : null,
  };
}

/**
 * The maintenance is still ahead and not cancelled, and the tenant is still
 * one the notice covers: its cell is not deleted and its owner has an address.
 * A cancelled or started maintenance sends nothing (the specification's
 * "Maintenance is cancelled before its email is sent").
 */
export async function maintenanceStillScheduled(
  tx: ExomemSql,
  payload: ServiceNoticeEmailPayload
): Promise<ServiceNoticeEmailContext | null> {
  const { rows } = await tx`
    /* exomem:email-maintenance-still-scheduled */
    SELECT notice.summary, notice.starts_at, notice.ends_at, notice.resolved_at,
           ARRAY(SELECT c.cell_id FROM exomem_service_notice_cells AS c
                 WHERE c.notice_id = notice.id ORDER BY c.cell_id) AS cell_ids
    FROM exomem_service_notices AS notice
    WHERE notice.id = ${payload.noticeId}::uuid
      AND notice.kind = 'maintenance'
      AND notice.cancelled_at IS NULL
      AND notice.starts_at > now()
  `;
  return rows[0] ? coveredOwner(tx, payload, rows[0] as NoticeRow, "maintenance") : null;
}

/** The incident is resolved, and the tenant is still one the notice covers. */
export async function incidentStillResolved(
  tx: ExomemSql,
  payload: ServiceNoticeEmailPayload
): Promise<ServiceNoticeEmailContext | null> {
  const { rows } = await tx`
    /* exomem:email-incident-still-resolved */
    SELECT notice.summary, notice.starts_at, notice.ends_at, notice.resolved_at,
           ARRAY(SELECT c.cell_id FROM exomem_service_notice_cells AS c
                 WHERE c.notice_id = notice.id ORDER BY c.cell_id) AS cell_ids
    FROM exomem_service_notices AS notice
    WHERE notice.id = ${payload.noticeId}::uuid
      AND notice.kind = 'incident'
      AND notice.resolved_at IS NOT NULL
  `;
  return rows[0] ? coveredOwner(tx, payload, rows[0] as NoticeRow, "incident") : null;
}
