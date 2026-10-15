import type { ExomemSql } from "./db";

/** Serialize item replacements without making webhook projection wait on a provider. */
export function lockExomemSubscriptionUpdate(tx: ExomemSql, tenantId: string) {
  return tx`
    /* exomem:lock-subscription-update */
    SELECT pg_advisory_xact_lock(hashtext('exomem-subscription-update:' || ${tenantId}::text))
  `;
}
