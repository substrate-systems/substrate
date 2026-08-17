import type { ExomemSql } from "./db";

/**
 * Whether Hosted currently has a routable contract target to pin a provision to.
 *
 * True when exactly one `hosted-alpha-agent-v1` candidate is live and every
 * bound cell serving that candidate's release agrees on a single gateway
 * contract digest. That is the same shape as the `live_target` CTE inside
 * `redeemInviteAtomic` (db.ts) and `admitFirstOAuthInviteAtomic`
 * (oauth-store.ts); those select the target's columns because they pin an
 * operation to it, while this only asks whether one exists.
 *
 * It exists so an admission path can say *why* it refused. Under provisioner
 * wire protocol v2 a provision must name an exact contract, and when no cohort
 * is live there is nothing to name — a real, operator-fixable state that used
 * to reach the invited person as an opaque 500 or as "this link is invalid".
 * Neither was true: the invitation is fine and unconsumed, and admission is
 * shut.
 *
 * Callers must already hold the `exomem-hosted-alpha-cohort` advisory lock, so
 * the answer cannot change under them before they act on it.
 */
export async function hasLiveHostedCohortTarget(tx: ExomemSql): Promise<boolean> {
  const { rows } = await tx`
    /* exomem:live-hosted-cohort-target-exists */
    SELECT candidate.id
    FROM exomem_agent_contract_candidates AS candidate
    JOIN exomem_cells AS catalog_cell
      ON catalog_cell.routing_state = 'bound'
     AND catalog_cell.release_version = candidate.source_release
     AND catalog_cell.protocol_version = candidate.protocol_version
     AND catalog_cell.observed_gateway_contract_digest IS NOT NULL
     AND catalog_cell.observed_command_fingerprint = candidate.command_fingerprint
     AND catalog_cell.observed_schema_digest = candidate.schema_digest
    WHERE candidate.profile_id = 'hosted-alpha-agent-v1'
      AND candidate.state = 'live'
    GROUP BY candidate.id
    HAVING COUNT(DISTINCT catalog_cell.observed_gateway_contract_digest) = 1
  `;
  return rows.length === 1;
}
