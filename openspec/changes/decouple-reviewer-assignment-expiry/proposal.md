## Why

A single thirty-minute clock has to contain cell provisioning, two human clean-client
runs, and the whole promotion sequence. It cannot, and it has cost every window so far.

The reviewer rollout assignment is created with

```sql
LEAST((SELECT expires_at FROM ..._bootstrap_authorities WHERE id = authorityId),
      (SELECT expires_at FROM exomem_staged_client_releases WHERE id = stage_id))
```

in `admitReviewerOAuthBootstrapInTransaction` (`oauth-store.ts`), the branch
`admitFirstOAuthInviteAtomic` takes when the transaction is bound to a live bootstrap
authority. Authority creation refuses any
expiry beyond thirty minutes (`operator-controls.ts`, `expiresAt > Date.now() + 30 * 60_000`),
so `LEAST` always picks the authority and the assignment can never outlive `run` by more
than half an hour. The staged release's own expiry — the bound an operator actually sets —
is never the effective one.

That assignment expiry is not a bookkeeping detail. It gates:

- the internal-canary credential, whose expiry is `LEAST(requested, assignment, stage)`;
- every canary token path — issue, read, MCP read and refresh rotation — each requiring
  `assignment.state = 'active' AND assignment.expires_at > now()`;
- `storeClientArtifact`, which is the `import` step;
- the `cells` precondition inside `promoteExomemHostedCohort`, which requires the same
  assignment still active and unexpired.

So one clock covers: provisioning a cell, a person completing seven manual operations in a
real Claude client, the same seven in a real ChatGPT client, then `observe` → `sign` →
`import` for each platform, then `promote`. In the 2026-08-22 window `run` consumed the
authority at 23:42:54 and the cell only reached `CELL_READY` at 23:51:14 — eight and a half
minutes of a thirty-minute budget gone before a human could begin, with the assignment
expiring at 00:10:54.

The binding buys nothing. The authority is consumed in the same transaction that creates
the assignment, and a consumed one-shot authority cannot admit anything again — its client
is disabled and versioned, and a client with bootstrap history can never be re-enabled or
repurposed. Tying the assignment's lifetime to a capability that no longer exists does not
constrain an attacker. It constrains the operator, and only the operator.

The thirty-minute cap on an **unconsumed** authority is a different thing and is correct:
that is a live, unspent privilege sitting in the control plane, and it should be short.

## What Changes

- Derive the reviewer rollout assignment's expiry from the staged client release alone,
  rather than `LEAST(authority, stage)`. The staged release is operator-created with a
  deliberate expiry and is already the bound every downstream predicate re-checks.
- Leave the thirty-minute cap on bootstrap authority creation exactly as it is.
- Leave the internal-canary credential's `LEAST(requested, assignment, stage)` as it is; it
  follows the assignment automatically, so the constraint lifts rather than moving one step
  along.
- No admission predicate changes. No change to what promotion evidence attests, to the
  requirement that a clean real client performs it, or to any digest comparison.

## Impact

- Affected specs: `exomem-hosted-mcp-oauth`
- Affected code: `src/lib/exomem-hosted/oauth-store.ts` (assignment insert in the reviewer
  bootstrap attach path)
- Affected docs: `docs/runbooks/exomem-hosted-alpha.md` — the "clear half hour" guidance in
  the ordered promotion procedure becomes the staged release expiry the operator chose.

## Non-Goals

- Extending the unconsumed authority's thirty-minute cap.
- Removing or weakening any admission, evidence or promotion gate.
- Making the evidence run automatable. It stays a manual clean-client run by design; this
  change gives that run a sane amount of time, not a shortcut.
- Fixing the single-platform promotion route gap, where `promoteExomemHostedCohort` accepts
  a null `openaiArtifactId` but `POST /api/exomem/admin/contracts` refuses one. That is a
  real inconsistency with `scope-cohort-admission-per-platform` and belongs to its own
  change.
