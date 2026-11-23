/**
 * Queues the service-notice emails (`add-exomem-service-notices`, D2). It runs
 * in the delivery job, never in the operator's request. Each pass queues, for
 * every notice that is due an email, one bounded batch of owners who have no
 * outbox row for it yet. The pass uses a fixed number of statements per
 * notice, whatever the batch holds, and a repeat adds nothing: the dedupe key
 * is unique and the insert ignores a key it already has.
 */

import { executeExomemSql } from "./db";
import { enqueueExomemEmails, type EnqueueExomemEmailInput } from "./email-outbox";
import { serviceNoticeDedupeKey, serviceNoticeDedupePrefix } from "./service-notice-emails";
import type { ExomemEmailScheme } from "@/lib/email-templates/exomem-email";
import type { ExomemThemeChoice } from "@/lib/exomem/theme";

// 10,000 tenants queue in 50 ticks of this size (design D2). One statement
// inserts the batch, so a larger batch costs payload size, not round trips.
export const SERVICE_NOTICE_FANOUT_BATCH = 200;
// A handful of notices are due an email at once, because the operator declares
// each one; the cap keeps a forgotten backlog from lengthening the pass.
const NOTICES_PER_PASS = 20;
// An owner learns an incident is over within a day of its resolution; later the
// news is stale. This also ends the pass's repeated scan of a finished notice.
const RESOLVED_EMAIL_WINDOW_HOURS = 24;

export type ServiceNoticeFanOutResult = { enqueued: number };

type Candidate = {
  tenant_id: string;
  owner_email: string;
  time_zone: string | null;
  email_scheme: ExomemEmailScheme | null;
  theme_choice: ExomemThemeChoice | null;
};

export async function fanOutServiceNoticeEmails(): Promise<ServiceNoticeFanOutResult> {
  // One statement finds the notices that are due an email: maintenance that is
  // announced and has not started or been cancelled, and an incident resolved
  // within the window. Cancelled maintenance and an unresolved incident send none.
  const due = await executeExomemSql`
    /* exomem:service-notice-fanout-due */
    SELECT notice.id, notice.kind, notice.starts_at, notice.resolved_at,
           ARRAY(SELECT c.cell_id FROM exomem_service_notice_cells AS c
                 WHERE c.notice_id = notice.id ORDER BY c.cell_id) AS cell_ids
    FROM exomem_service_notices AS notice
    WHERE (notice.kind = 'maintenance' AND notice.cancelled_at IS NULL
           AND notice.announce_from <= now() AND notice.starts_at > now())
       OR (notice.kind = 'incident' AND notice.resolved_at IS NOT NULL
           AND notice.resolved_at > now() - make_interval(hours => ${RESOLVED_EMAIL_WINDOW_HOURS}))
    ORDER BY notice.created_at
    LIMIT ${NOTICES_PER_PASS}
  `;
  let enqueued = 0;
  for (const notice of due.rows) {
    const noticeId = String(notice.id);
    const maintenance = notice.kind === "maintenance";
    // The covered tenants are the migration's one definition, the same one the
    // operator's preview counts and the send-time check reads. The anti-join
    // leaves out owners who already have a row, whether sent, pending or settled.
    const candidates = await executeExomemSql`
      /* exomem:service-notice-fanout-candidates */
      SELECT covered.tenant_id, owner.email::text AS owner_email,
             tenant.time_zone, tenant.email_scheme, tenant.theme_choice
      FROM exomem_service_notice_covered_tenants(${notice.cell_ids as string[]}::text[]) AS covered
      JOIN exomem_tenants AS tenant ON tenant.id = covered.tenant_id
      JOIN exomem_users AS owner ON owner.id = tenant.owner_user_id
      WHERE NOT EXISTS (
        SELECT 1 FROM exomem_email_outbox AS outbox
        WHERE outbox.dedupe_key = ${serviceNoticeDedupePrefix(noticeId)} || covered.tenant_id::text
      )
      ORDER BY covered.tenant_id
      LIMIT ${SERVICE_NOTICE_FANOUT_BATCH}
    `;
    // A maintenance email is useless once the work starts; an incident email goes stale a day on.
    const expiresAt = maintenance
      ? new Date(notice.starts_at as Date)
      : new Date(
          new Date(notice.resolved_at as Date).getTime() + RESOLVED_EMAIL_WINDOW_HOURS * 3_600_000
        );
    const inputs: EnqueueExomemEmailInput<"maintenance_scheduled" | "incident_resolved">[] = (
      candidates.rows as Candidate[]
    ).map((owner) => ({
      kind: maintenance ? "maintenance_scheduled" : "incident_resolved",
      dedupeKey: serviceNoticeDedupeKey(noticeId, owner.tenant_id),
      recipient: owner.owner_email,
      recipientTimeZone: owner.time_zone,
      recipientEmailScheme: owner.email_scheme,
      recipientThemeChoice: owner.theme_choice,
      tenantId: owner.tenant_id,
      payload: { version: 1, noticeId, tenantId: owner.tenant_id },
      expiresAt,
    }));
    enqueued += (await enqueueExomemEmails(executeExomemSql, inputs)).length;
  }
  return { enqueued };
}
