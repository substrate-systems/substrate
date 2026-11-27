/**
 * Queues the monthly digest (`send-monthly-whats-new-digest`, D3 and D4). It
 * runs in the per-minute delivery job, never in a request. Each tick takes the
 * month that the operator approved (`ready_to_queue`, past its `send_after`: a
 * month that went out on the standing switch waits a day for a stop) and queues one bounded
 * page of owners for it, in tenant id order after the last page, in one
 * transaction with the month's cursor. When a page holds fewer owners than the
 * batch, no owner is left: the month becomes `queued` and no later tick scans
 * it. A repeat adds nothing: the dedupe key is unique and the insert ignores a
 * key it already has.
 *
 * The owners come from `exomem_whats_new_digest_recipients()` (migration 0098)
 * in one statement, with the running release of each, so a page costs a fixed
 * number of statements whatever it holds. Each owner's notes are the selected
 * ones that the owner's cell runs (`owner-notes.ts`); an owner left with fewer
 * than 3 gets no row.
 */

import { withExomemTransaction } from "../db";
import { enqueueExomemEmails, type EnqueueExomemEmailInput } from "../email-outbox";
import type { ExomemEmailScheme } from "@/lib/email-templates/exomem-email";
import type { ExomemThemeChoice } from "@/lib/exomem/theme";
import { lockMonthToQueue, readSelectionNotes, recordQueuedPage } from "./months";
import { notesForRunningRelease } from "./owner-notes";
import { unsubscribeKeyConfigured } from "./unsubscribe";

// 10,000 owners queue in 50 ticks of this size, as service notices do (design D4).
export const WHATS_NEW_DIGEST_FANOUT_BATCH = 200;

// Sorts before every tenant id (the database never generates it), so the first page needs no special case.
const BEFORE_EVERY_TENANT = "00000000-0000-0000-0000-000000000000";

/** The row's dedupe key: one digest per month and owner. */
export function whatsNewDigestDedupeKey(month: string, tenantId: string): string {
  return `whats-new-digest:${month}:${tenantId}`;
}

type Candidate = {
  tenant_id: string;
  owner_email: string;
  time_zone: string | null;
  email_scheme: ExomemEmailScheme | null;
  theme_choice: ExomemThemeChoice | null;
  running_release: string | null;
};

/** A digest is for last month and stays worth sending through the month it arrives in. */
function expiryOf(month: string): Date {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number + 1, 1));
}

export async function fanOutWhatsNewDigestEmails(): Promise<{ enqueued: number }> {
  // The digest's unsubscribe link needs its key: without it nothing is queued, and the
  // approval page says so (describeOverview).
  if (!unsubscribeKeyConfigured()) return { enqueued: 0 };
  return withExomemTransaction(async (tx) => {
    const month = await lockMonthToQueue(tx);
    if (!month) return { enqueued: 0 };
    const selection = await readSelectionNotes(month.month, month.finalSelection, tx);
    if (!selection) {
      throw new Error("what's new digest: a selected note is missing from the stored files");
    }
    const { rows } = await tx`
      /* exomem:whats-new-digest-fanout-candidates */
      SELECT recipient.tenant_id, recipient.owner_email, recipient.time_zone,
             recipient.email_scheme, recipient.theme_choice, recipient.running_release
      FROM exomem_whats_new_digest_recipients() AS recipient
      WHERE recipient.tenant_id > ${month.cursor ?? BEFORE_EVERY_TENANT}::uuid
      ORDER BY recipient.tenant_id
      LIMIT ${WHATS_NEW_DIGEST_FANOUT_BATCH}
    `;
    const owners = rows as Candidate[];
    const expiresAt = expiryOf(month.month);
    const inputs: EnqueueExomemEmailInput<"whats_new_digest">[] = owners.flatMap((owner) =>
      notesForRunningRelease(selection, owner.running_release)
        ? [
            {
              kind: "whats_new_digest" as const,
              dedupeKey: whatsNewDigestDedupeKey(month.month, owner.tenant_id),
              recipient: owner.owner_email,
              recipientTimeZone: owner.time_zone,
              recipientEmailScheme: owner.email_scheme,
              recipientThemeChoice: owner.theme_choice,
              tenantId: owner.tenant_id,
              payload: { version: 1 as const, month: month.month, tenantId: owner.tenant_id },
              expiresAt,
            },
          ]
        : []
    );
    const queued = (await enqueueExomemEmails(tx, inputs)).length;
    await recordQueuedPage(tx, month.month, {
      cursor: owners.at(-1)?.tenant_id ?? null,
      queued,
      done: owners.length < WHATS_NEW_DIGEST_FANOUT_BATCH,
    });
    return { enqueued: queued };
  });
}
