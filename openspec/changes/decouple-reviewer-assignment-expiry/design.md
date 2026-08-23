## Context

The reviewer bootstrap exists so Hosted can be brought from no live cohort to a promoted
one. It is deliberately one-shot: an authenticated operator creates at most one active
authority, binding an invite, a pending candidate, a staged release and a pinned loopback
client. Redemption creates the reviewer tenant, entitlement, capacity reservation, rollout
assignment and provision operation in one transaction, and consumes the authority.

Everything after redemption is ordinary operator work performed against a tenant that
already exists: provision the cell, run a real client on each platform being promoted,
observe and sign what that client did, import the artifacts, promote.

The question this change settles is which of those two phases the assignment's clock
belongs to. Today it belongs to the first. It should belong to the second.

## Goals / Non-Goals

**Goals**

- Give the clean-client evidence phase a duration an operator chooses, bounded by the
  staged release they created.
- Keep the privileged, unspent bootstrap authority short-lived.
- Change one expression, so the reasoning is auditable and the blast radius is visible.

**Non-Goals**

- Loosening any gate that decides *whether* a client may be admitted or promoted.
- Automating, defaulting or otherwise weakening the evidence itself.

## Decisions

### Derive the assignment expiry from the staged release

The assignment insert becomes the staged release's `expires_at` rather than
`LEAST(authority, stage)`.

The authority is consumed in the same transaction that performs this insert. From the
instant the row exists, the authority is spent: it cannot admit a second authorization, its
pinned client is disabled and versioned, and a client carrying bootstrap history can never
be re-enabled or repurposed. A bound to a consumed capability is not a security property.

The staged release is the right bound because it is the thing the operator deliberately
created for this window, it already carries an `expires_at`, and every downstream predicate
already re-checks `stage.expires_at > now()` independently. Nothing gains reach: a canary
token path that today requires an active assignment *and* an unexpired stage will still
require both.

The new bound is not unbounded. `createStagedClientRelease` puts every stage expiry through
`boundedExpiry`, which refuses anything past `MAX_EXPIRY_MS` — seven days. So the ceiling
this change moves to is server-enforced, and it is the same seven days the runbook already
describes for an ordinary rollout assignment. The operator chooses within it; they cannot
exceed it.

**Alternatives considered.**

*Raise the thirty-minute authority cap.* Rejected. That lengthens the window in which an
unconsumed, unspent privilege sits in the control plane — the one window that genuinely
should be short. It also fixes the symptom in the wrong place: the operator would be
choosing an authority lifetime in order to buy assignment lifetime.

*Add a separate operator control to extend an assignment after consumption.* Rejected as
more surface for the same outcome. A new authenticated mutation on a privileged reviewer
assignment is a larger change to review than deleting one `LEAST`, and the operator already
expresses the intended window when creating the staged release.

*Leave it and split the work across two candidates.* Rejected. Promotion preconditions rest
on the same assignment being active, so splitting does not avoid the clock; it multiplies
the number of times the clock has to be beaten.

### Leave the canary credential expression alone

`createInternalCanaryReviewerCredentialAtomic` already computes
`LEAST(requested, assignment, stage)`. Once the assignment follows the stage, the credential
follows too, still never exceeding what the operator requested. Editing it as well would
add a second place to reason about with no behavioural difference.

## Risks / Trade-offs

**A reviewer-purpose tenant and its canary credentials live longer.** True, and it is the
intended effect. The mitigations are unchanged and independent: the credential still cannot
outlive what the operator requested or the staged release; it is revocable
(`revokeInternalCanaryReviewerCredentialAtomic`); the assignment is still
`marketplace_reviewer_purpose` on a throwaway tenant; and the sibling clients stay disabled
until their artifacts are imported. The exposure that grows is a test tenant the operator
created minutes earlier and will delete after the window.

**A stale assignment could sit active longer if a window is abandoned.** Also true, and it
is why the bound moves to the staged release rather than being removed. An abandoned window
is closed the way it is closed today — `revoke_reviewer_bootstrap`, credential revocation,
and the existing expiry sweeps over stages and assignments.

**The runbook's "clear half hour" stops being literal.** The ordered procedure should say
the window is the staged release expiry the operator chose, and that provisioning consumes
roughly ten minutes of it whatever that number is.

## Migration Plan

None. The expression governs rows created after deploy; existing assignments keep the
expiry they were written with. No schema change, no backfill, and the change is inert until
the next `run`.

## Open Questions

- What default staged-release expiry the promotion tooling should propose. One hour is what
  `prepare` used on 2026-08-22 and comfortably covers two platforms; the value belongs in
  the tooling and the runbook rather than in this predicate.
