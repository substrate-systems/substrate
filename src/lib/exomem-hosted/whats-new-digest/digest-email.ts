/**
 * What the `whats_new_digest` outbox kind checks and renders at send
 * (`send-monthly-whats-new-digest`, D3 and D5). The outbox registry
 * (email-outbox.ts) wires these in; the fan-out (fan-out.ts) queues the rows.
 * This module imports nothing at run time from the registry, so the registry
 * can load it first.
 */

import { z } from "zod";
import type { ExomemEmailScheme } from "@/lib/email-templates/exomem-email";
import type { ExomemThemeChoice } from "@/lib/exomem/theme";
import type { ExomemSql } from "../db";
import type { ExomemEmailAddressee } from "../email-outbox";
import { parseMonthName } from "./config";
import { renderWhatsNewDigestEmail } from "./email";
import { readSelectionNotes, sendableSelection } from "./months";
import type { MonthNote } from "./notes";
import { notesForRunningRelease } from "./owner-notes";
import { unsubscribeAddresses } from "./unsubscribe";

export type WhatsNewDigestPayload = { version: 1; month: string; tenantId: string };

const payloadSchema = z.strictObject({
  version: z.literal(1),
  month: z.string().refine((month) => parseMonthName(month) !== null),
  tenantId: z.uuid(),
});

export function readWhatsNewDigestPayload(
  value: Record<string, unknown>
): WhatsNewDigestPayload | null {
  const parsed = payloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export type WhatsNewDigestContext = {
  /** The owner's address, zone and scheme as the database holds them now. */
  owner: ExomemEmailAddressee;
  /** This owner's notes: the selected ones that their cell runs now. */
  notes: MonthNote[];
};

type OwnerRow = {
  owner_email: string;
  time_zone: string | null;
  email_scheme: ExomemEmailScheme | null;
  theme_choice: ExomemThemeChoice | null;
  running_release: string | null;
};

/**
 * The digest still holds when the month is still to send (the operator did
 * not skip it), the owner still has the setting on, and their cell is still
 * eligible and still runs at least 3 of the selected changes. Anything else
 * cancels the row.
 */
export async function whatsNewDigestStillHolds(
  tx: ExomemSql,
  payload: WhatsNewDigestPayload
): Promise<WhatsNewDigestContext | null> {
  const selection = await sendableSelection(tx, payload.month);
  if (!selection) return null;
  const { rows } = await tx`
    /* exomem:email-whats-new-digest-owner */
    SELECT recipient.owner_email, recipient.time_zone, recipient.email_scheme,
           recipient.theme_choice, recipient.running_release
    FROM exomem_whats_new_digest_recipients() AS recipient
    WHERE recipient.tenant_id = ${payload.tenantId}::uuid
  `;
  const owner = rows[0] as OwnerRow | undefined;
  if (!owner) return null;
  const selected = await readSelectionNotes(payload.month, selection, tx);
  const notes = selected && notesForRunningRelease(selected, owner.running_release);
  if (!notes) return null;
  return {
    owner: {
      email: owner.owner_email,
      timeZone: owner.time_zone,
      emailScheme: owner.email_scheme,
      themeChoice: owner.theme_choice,
    },
    notes,
  };
}

/**
 * The email, with the two headers of RFC 8058 for its one-click unsubscribe:
 * the address that a mail client POSTs to, and the one-click marker.
 */
export function renderWhatsNewDigest(input: {
  payload: WhatsNewDigestPayload;
  context: WhatsNewDigestContext;
  emailScheme: ExomemEmailScheme | null;
  themeChoice?: ExomemThemeChoice | null;
  publicBaseUrl: string;
}) {
  const { post, page } = unsubscribeAddresses(input.publicBaseUrl, input.payload.tenantId);
  return {
    ...renderWhatsNewDigestEmail(
      { month: input.payload.month, notes: input.context.notes, unsubscribeUrl: page },
      { base: input.emailScheme, themeChoice: input.themeChoice }
    ),
    headers: {
      "List-Unsubscribe": `<${post}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}
