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

type ContextRow = {
  owner_email: string;
  time_zone: string | null;
  email_scheme: ExomemEmailScheme | null;
  theme_choice: ExomemThemeChoice | null;
  summary: string;
  starts_at: Date | string;
  ends_at: Date | string | null;
  resolved_at: Date | string | null;
};

function contextOf(row: ContextRow): ServiceNoticeEmailContext {
  return {
    owner: {
      email: row.owner_email,
      timeZone: row.time_zone,
      emailScheme: row.email_scheme,
      themeChoice: row.theme_choice,
    },
    summary: row.summary,
    startsAt: new Date(row.starts_at),
    endsAt: row.ends_at ? new Date(row.ends_at) : null,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null,
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
    SELECT owner.email::text AS owner_email, tenant.time_zone, tenant.email_scheme, tenant.theme_choice,
           notice.summary, notice.starts_at, notice.ends_at, notice.resolved_at
    FROM exomem_service_notices AS notice
    JOIN LATERAL exomem_service_notice_covered_tenants(
           ARRAY(SELECT c.cell_id FROM exomem_service_notice_cells AS c WHERE c.notice_id = notice.id)
         ) AS covered ON covered.tenant_id = ${payload.tenantId}::uuid
    JOIN exomem_tenants AS tenant ON tenant.id = covered.tenant_id
    JOIN exomem_users AS owner ON owner.id = tenant.owner_user_id
    WHERE notice.id = ${payload.noticeId}::uuid
      AND notice.kind = 'maintenance'
      AND notice.cancelled_at IS NULL
      AND notice.starts_at > now()
  `;
  return rows[0] ? contextOf(rows[0] as ContextRow) : null;
}

/** The incident is resolved, and the tenant is still one the notice covers. */
export async function incidentStillResolved(
  tx: ExomemSql,
  payload: ServiceNoticeEmailPayload
): Promise<ServiceNoticeEmailContext | null> {
  const { rows } = await tx`
    /* exomem:email-incident-still-resolved */
    SELECT owner.email::text AS owner_email, tenant.time_zone, tenant.email_scheme, tenant.theme_choice,
           notice.summary, notice.starts_at, notice.ends_at, notice.resolved_at
    FROM exomem_service_notices AS notice
    JOIN LATERAL exomem_service_notice_covered_tenants(
           ARRAY(SELECT c.cell_id FROM exomem_service_notice_cells AS c WHERE c.notice_id = notice.id)
         ) AS covered ON covered.tenant_id = ${payload.tenantId}::uuid
    JOIN exomem_tenants AS tenant ON tenant.id = covered.tenant_id
    JOIN exomem_users AS owner ON owner.id = tenant.owner_user_id
    WHERE notice.id = ${payload.noticeId}::uuid
      AND notice.kind = 'incident'
      AND notice.resolved_at IS NOT NULL
  `;
  return rows[0] ? contextOf(rows[0] as ContextRow) : null;
}
