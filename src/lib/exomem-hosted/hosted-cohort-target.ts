import type { ExomemSql } from "./db";
import { EXOMEM_HOSTED_PROFILE } from "./hosted-profile";

/**
 * Why Hosted has no routable contract target, when it has none.
 *
 * The absence of a target is not one state. It is three, and they want three
 * different actions from whoever is holding the outage:
 *
 * - `no_live_candidate` — nothing has ever been promoted for this profile. The
 *   fleet is empty and the virgin-install bootstrap is what builds it.
 * - `no_bound_cell_for_live_candidate` — a candidate is live, but no bound cell
 *   is serving its release, protocol and fingerprints. The catalogue exists;
 *   nothing is running it yet.
 * - `bound_cells_disagree_on_contract` — a candidate is live and its bound cells
 *   report more than one gateway contract digest. That is an ordinary state part
 *   way through a rotation.
 *
 * Only the first is cleared by the bootstrap. Running it in either of the other
 * two would build a second reviewer-purpose tenant for a fleet that already has
 * one, which is why the reason travels with the refusal instead of being guessed
 * from the fact that admission is shut.
 */
export const HOSTED_COHORT_CLOSURE_REASONS = [
  "no_live_candidate",
  "no_bound_cell_for_live_candidate",
  "bound_cells_disagree_on_contract",
] as const;
export type HostedCohortClosureReason = (typeof HOSTED_COHORT_CLOSURE_REASONS)[number];

/**
 * The target's existence, and — when it does not exist — which of the three
 * absences it is. `live` is the admission decision and nothing else; `reason` is
 * diagnosis carried alongside it, never consulted to admit or refuse anyone.
 */
export type HostedCohortTargetProbe =
  | { readonly live: true }
  | { readonly live: false; readonly reason: HostedCohortClosureReason };

type HostedCohortTargetCounts = {
  live_candidates: number;
  routable_targets: number;
  disagreeing_candidates: number;
};

/**
 * Whether Hosted has a routable contract target, and why not when it has none.
 *
 * `routable_targets` counts exactly what the previous `SELECT candidate.id …
 * GROUP BY candidate.id HAVING COUNT(DISTINCT …) = 1` returned rows for: a live
 * candidate joined to at least one matching bound cell, all of them agreeing on
 * one gateway contract digest. The join became a `LEFT JOIN` so a candidate with
 * no matching cell still produces a row to count — that is the only difference,
 * and it changes which candidates are *counted*, never which are *routable*.
 * The decision is `routable_targets === 1`, as it has always been.
 *
 * Reason and decision come out of one statement on purpose. A second query would
 * see a second snapshot, and could classify a closure that the decision never
 * made — telling an operator about a state the service was never in.
 *
 * That is the same shape as the `live_target` CTE inside `redeemInviteAtomic`
 * (db.ts) and `admitFirstOAuthInviteAtomic` (oauth-store.ts); those select the
 * target's columns because they pin an operation to it, while this only asks
 * whether one exists.
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
export async function probeHostedCohortTarget(tx: ExomemSql): Promise<HostedCohortTargetProbe> {
  const { rows } = await tx`
    /* exomem:live-hosted-cohort-target-exists */
    WITH live_candidate AS (
      SELECT candidate.id,
             COUNT(DISTINCT catalog_cell.observed_gateway_contract_digest) AS contract_digests
      FROM exomem_agent_contract_candidates AS candidate
      LEFT JOIN exomem_cells AS catalog_cell
        ON catalog_cell.routing_state = 'bound'
       AND catalog_cell.release_version = candidate.source_release
       AND catalog_cell.protocol_version = candidate.protocol_version
       AND catalog_cell.observed_gateway_contract_digest IS NOT NULL
       AND catalog_cell.observed_command_fingerprint = candidate.command_fingerprint
       AND catalog_cell.observed_schema_digest = candidate.schema_digest
      WHERE candidate.profile_id = ${EXOMEM_HOSTED_PROFILE}
        AND candidate.state = 'live'
      GROUP BY candidate.id
    )
    SELECT COUNT(*)::int AS live_candidates,
           COUNT(*) FILTER (WHERE contract_digests = 1)::int AS routable_targets,
           COUNT(*) FILTER (WHERE contract_digests > 1)::int AS disagreeing_candidates
    FROM live_candidate
  `;
  const counts = rows[0] as HostedCohortTargetCounts | undefined;
  if (Number(counts?.routable_targets ?? 0) === 1) return { live: true };
  if (Number(counts?.live_candidates ?? 0) === 0)
    return { live: false, reason: "no_live_candidate" };
  if (Number(counts?.disagreeing_candidates ?? 0) > 0) {
    return { live: false, reason: "bound_cells_disagree_on_contract" };
  }
  // `exomem_agent_contract_candidates_one_live_idx` is unique on `profile_id`
  // where `state = 'live'`, so reaching here means exactly one live candidate
  // whose `contract_digests` is neither 1 nor more than 1: it has no bound cell.
  return { live: false, reason: "no_bound_cell_for_live_candidate" };
}

/**
 * Whether Hosted currently has a routable contract target to pin a provision to.
 *
 * The admission decision on its own, for the callers that only need to know
 * whether to proceed. Refusal sites want `probeHostedCohortTarget` instead, so
 * the refusal can name which closure it is.
 */
export async function hasLiveHostedCohortTarget(tx: ExomemSql): Promise<boolean> {
  return (await probeHostedCohortTarget(tx)).live;
}
