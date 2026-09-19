import type { ExomemSql } from "./db";
import { EXOMEM_HOSTED_PROFILE } from "./hosted-profile";

/** Current admission requires a live candidate and its imported provisioning
 * target. Retain historical cell-based reasons for existing diagnostic readers;
 * this probe no longer emits them or treats observed cells as target authority.
 */
export const HOSTED_COHORT_CLOSURE_REASONS = [
  "no_live_candidate",
  "no_imported_runtime_target",
  "no_bound_cell_for_live_candidate",
  "bound_cells_disagree_on_contract",
] as const;
export type HostedCohortClosureReason = (typeof HOSTED_COHORT_CLOSURE_REASONS)[number];

/**
 * The target's existence and the reason it is unavailable. `live` is the admission decision and nothing else; `reason` is
 * diagnosis carried alongside it, never consulted to admit or refuse anyone.
 */
export type HostedCohortTargetProbe =
  | { readonly live: true }
  | { readonly live: false; readonly reason: HostedCohortClosureReason };

type HostedCohortTargetCounts = {
  live_candidates: number;
  imported_targets: number;
};

/**
 * Whether Hosted has a routable contract target, and why not when it has none.
 *
 * A reviewed runtime target is imported independently of observed cells. A
 * bound cell remains serving evidence, but it cannot be the prerequisite for
 * the first provision that creates one.
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
             (target.candidate_id IS NOT NULL) AS imported
      FROM exomem_agent_contract_candidates AS candidate
      LEFT JOIN exomem_runtime_targets AS target
        ON target.candidate_id = candidate.id
       AND target.release_version = candidate.source_release
       AND target.protocol_version = candidate.protocol_version
       AND target.agent_profile = candidate.profile_id
       AND target.command_fingerprint = candidate.command_fingerprint
       AND target.schema_digest = candidate.schema_digest
       AND target.compatibility_digest = candidate.compatibility_digest
      WHERE candidate.profile_id = ${EXOMEM_HOSTED_PROFILE}
        AND candidate.state = 'live'
    )
    SELECT COUNT(*)::int AS live_candidates,
           COUNT(*) FILTER (WHERE imported)::int AS imported_targets
    FROM live_candidate
  `;
  const counts = rows[0] as HostedCohortTargetCounts | undefined;
  if (Number(counts?.imported_targets ?? 0) === 1) return { live: true };
  if (Number(counts?.live_candidates ?? 0) === 0)
    return { live: false, reason: "no_live_candidate" };
  return { live: false, reason: "no_imported_runtime_target" };
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
