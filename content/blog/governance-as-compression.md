---
title: "Governance as compression: contracts and skills for AI-augmented codebases"
slug: governance-as-compression
description: "The pattern I shipped to fix AI-augmented development correction loops, and the controlled three-condition benchmark that revealed which layer does the work."
published: 2026-05-20
tags:
  - llm-governance
  - ai-augmented-development
  - contracts
  - skills
  - architecture
author: Hugo Ander Kivi
---

## The expensive part of AI-augmented development isn't the code

Eight months into AI-only coding on real codebases, I started keeping a tally of how often I corrected the same class of mistake. The number was embarrassing.

Every session, the model would re-derive the same business rule from the same files, sometimes getting it right, sometimes not. The friction wasn't in writing the code. It was in the loop around the code: explain the constraint, watch the model violate it anyway, correct, regenerate, re-explain, fix what regressed. The cost scaled with the complexity of the system's invariants, not the size of the diff.

Most discussions of AI-augmented productivity measure tokens-per-minute or acceptance rate. Those are downstream. The expensive item is the correction loop — the re-review and re-prompting that happens because the executor doesn't carry the rules between tasks.

I'll describe the pattern I shipped to fix this. Two layers — contracts and skills. The architectural insight that came out of measuring it is the part most worth landing first: the documentation matters far less than the runtime mechanism that brings it to the right task at the right time.

## An executor with no memory

The friction points at something structural. The model isn't completing your code — it's executing tasks: reading files, making decisions, producing output that has to hold against rules it can't see. And it carries nothing from one task to the next. Each one starts cold.

The gap that creates is worth naming precisely, because it isn't a reasoning gap — it's a starting-context gap. An executor that resets every task needs what a new engineer needs on day one: how the system actually behaves, the edge cases nobody wrote down, the business logic that governs the surface it's touching. The difference is it needs them on every task, and no one is going to re-explain them by hand each time.

So the context has to live somewhere durable, in a form something other than a human can pull into the working window at the moment a decision gets made.

That infrastructure has two units. One holds the knowledge. The other brings it to the moment.

## Contracts: the invariant layer

A contract is not documentation. It's not a runbook. It's not the README.

A contract is synthesized condensed information about a system or one of its subsystems, written so a reader — human or LLM — can operate on the system without re-deriving its truths from the surrounding noise. The synthesis is the work. Three sources combine into a single canonical artifact:

- **How the system actually behaves.** Not the design intent. Not the architecture diagram. The empirical behavior, including the parts that surprised someone when they shipped.
- **Insider knowledge that isn't in code.** Edge cases that were handled in a one-line conditional with no comment. Decisions made in a meeting two years ago that explain why a field is nullable. Behavior under failure that's only visible if you've been on-call for it.
- **Business logic that governs the surface.** What is and isn't allowed. The constraints that aren't enforced by types but by consequences.

What goes into a contract: anything that requires reading the whole flow to understand. What stays out: one-off knowledge with no compounding value across tasks. The test is whether a future reader on a future task would have to derive it again from primary sources. If yes, it belongs in the contract.

The structural form is unsurprising. YAML frontmatter declaring status (Locked, Draft), schema version, and last-updated date. A locked invariants section that enumerates the load-bearing rules separately from the prose, in operational language. A failure modes section. Citations where the source is external (an RFC, an OWASP recommendation, a regulator's guidance). The form is not the point — pick a structure and keep it. The discipline is in what the document contains, not where the headings sit.

A contract that's wrong is worse than no contract. It hands the executor a confident wrong answer dressed up as authority. Auditing is a separate discipline from writing: claims have to be verifiable against the system, ambiguity has to be flagged for resolution, drift has to be caught as the system evolves. Most failure modes of contract-based governance come from contracts being wrong, not contracts being missing. The fix is to treat every contract as a living artifact and to make audit a normal part of the team's cadence — not a quarterly exercise that nobody schedules.

## Skills: the binding layer

A contract on the shelf is inert.

The agent has no way to know a relevant contract exists unless something points at it. That something is the skill. The skill is the runtime mechanism that brings the right contract into the working context at the moment it matters.

I use the `SKILL.md` convention familiar to anyone who has worked inside Claude Code's skill system. A skill is itself a small markdown file with frontmatter (a name, a description) and a body that tells the agent *when* this skill applies and *what* to load when it does. Triggers are natural-language and keyword-based: the agent matches the description of the task it's about to do against the description of available skills, picks the one that fits, and follows the instructions in the body.

One architectural choice is load-bearing: **skills point at contracts; they don't duplicate content.** A skill says "when this kind of task starts, load the contract at this path before proposing changes." It does not restate the invariants. The indirection is by reference, not by value. Contracts can change without skill updates. Skills can be added without re-editing the contracts they consume.

Versioning is git. Contracts live next to the code they govern; their history is the version log; the diff is the changelog. There is no separate schema-version field on a contract for the purpose of versioning — the schema field, when used, exists for *consumers of the contract* (other implementations, third parties), not as a substitute for revision control. Adding a versioning scheme on top of git buys nothing and adds a ceremony nobody maintains. The pattern composes with established spec tooling; I run contracts alongside OpenSpec, which handles the change-and-archive lifecycle as the underlying behavior evolves.

This split — knowledge in contracts, binding in skills — looks fussier than it needs to be. The first time I built this, I tried to collapse the layers: I put the contract content inside the skill so a single file would carry the rules and the trigger. The result of measuring that decision is in the next section. I'll spoil it now because the spoiler is the point: the layering matters more than the documentation does.

## A worked example: permission rules in a multi-tenant SaaS

The pattern is easiest to see at small scale. Consider a multi-tenant SaaS with role-based access control, delegation, and tenant isolation. Permission logic is exactly the kind of surface where business invariants are subtle, business-critical, and easy to violate silently — the kind of surface where an LLM with the wrong assumptions ships a bug that nobody catches at review.

Here's the contract.

```markdown
---
name: permissions-contract
status: Locked
schema_version: 1.0
last_updated: 2026-05-12
governs:
  - src/permissions/
  - src/auth/scope.ts
  - src/auth/delegation.ts
---

# Permissions Contract

## Locked Invariants

1. **Admin floor.** A tenant must always have at least one active admin.
   Demoting the last admin of a tenant is forbidden regardless of who
   initiates the action — including support staff acting on the tenant's
   behalf. The check runs on the resulting state, not the requesting actor.

2. **Delegation lifetime.** A delegated permission cannot outlast the
   delegator's own session or the delegator's own grant. Revocation of the
   delegator's grant revokes all permissions delegated from it, transitively.

3. **Scope inheritance.** Permissions inherited through group membership
   cannot exceed the group's own grant on the resource. A user who is both
   directly granted Editor and inherits Viewer through a group has Editor;
   a user who inherits Editor through a group but is directly granted
   Viewer is capped at the inherited Editor only if the direct grant is
   explicitly upgraded — direct grants do not silently override group
   ceilings.

4. **Tenant isolation.** A user's permissions in tenant A grant no
   capabilities in tenant B, regardless of role label equivalence. There
   is no cross-tenant admin role. Support staff act on tenants via
   explicit, audited impersonation, never via shared role membership.

5. **Audit completeness.** Every permission change emits an audit event
   containing the resulting state, the actor, the reason if supplied, and
   the prior state. Audit emission is on the write path; a permission
   change that did not produce an audit event is treated as having not
   occurred and must be reverted.

## Failure Modes

- Permission changes applied before audit emission, leaving silent drift
  between the live state and the audit log
- Delegation chains that survive revocation of an intermediate grant
- Cross-tenant role label collisions interpreted as cross-tenant authority
- Group-derived ceilings silently overridden by direct grants

## Audit Notes

This contract is audited against the live system every release cycle.
Discrepancies are resolved before merge.
```

And here's the skill that binds it.

```markdown
---
name: permissions-changes
description: |
  Use when the task touches permissions, roles, scopes, delegation, or
  tenant boundaries. Triggers on paths under src/permissions/, src/auth/,
  and on natural-language mentions of "permission", "role", "scope",
  "delegate", "admin", "tenant isolation".
---

# Skill: permissions-changes

Before proposing any change matching the trigger:

1. Load `contracts/permissions-contract.md` into context.
2. Read the Locked Invariants section in full. Do not skim.
3. For each invariant, identify whether the proposed change interacts
   with it. State the interaction explicitly in the plan.
4. If the change would violate an invariant, stop. Do not propose a
   workaround. Propose either (a) a contract amendment with an
   accompanying schema bump, or (b) a different approach to the task
   that preserves the invariant.
5. If the change affects the audit path, confirm the audit event is
   emitted before the state change is acknowledged to the caller. State
   the ordering in the plan.

Do not duplicate the contract content into this skill. If the contract
needs to change, edit the contract, not this skill.
```

The flow is mechanical. A developer asks the agent for a delegation feature — "let support staff temporarily act on behalf of a tenant admin." The skill's description matches on "delegate" and the tenant-boundary keywords. The skill loads the contract. Invariant 2 (delegation lifetime) and invariant 4 (tenant isolation) are now in context. The agent's plan acknowledges both. The proposal includes the revocation-cascade behavior and an explicit impersonation event in the audit path, because invariants 2 and 5 are sitting in its working memory rather than waiting in a file the agent didn't open.

That's it. The interesting thing about this example is how unimpressive it looks on the page. The agent did not become smarter. It was given the right context at the right moment, by a small file that knew which other small file to load. That's the entire trick.

## What changed when I measured it

The failure modes the framework catches read like a textbook list. Re-derivation of business logic that's already documented somewhere the agent didn't open. Context loss across sessions. Edge-case assumptions that quietly contradict the rules. Silent invariant violations that pass review because the reviewer assumed the agent "knew." Each of these is a real failure mode I've watched repeat across enough sessions to recognize them by their shape rather than their content.

The list of failure modes is theoretical until you measure it. I measured it.

I didn't arrive at skills first. The result came out of three governance attempts on the same codebase, the same model (Opus 4.7), the same task distribution, each graded against a blind rubric: tool call count, tokens, error rate, bug encounters, output consistency across reruns of the same task, and correction cycles between reviewer and agent. The reference point was a no-governance baseline that scored roughly 7/10 — acceptable on average, capable of shipping bugs a reviewer should catch and doesn't always. Against that baseline I tried three things in sequence.

**Attempt one: a single `AGENTS.md` at the project root.** This is the prevailing wisdom in the agentic coding community — one instructions file the agent reads on every task, and you're governed. It helped marginally. A single root file is a junk drawer: too broad to be precise, too long to stay loaded in full, too undifferentiated to bind to a specific decision. The improvement over baseline was barely worth measuring.

**Attempt two: `AGENTS.md` as an index that points to scoped contract docs, lazy-loaded.** The obvious refinement. Keep the root file small, make it a table of contents, have it reference scoped contracts the agent pulls in when a task looks relevant. This was better than the single file — and inconsistent, session to session, in a way the first attempt at least failed predictably. The failure mode is specific and worth naming: the agent reads the reference but can skip the dereference. Loading is advisory. The pointer says "there's a permissions contract over there; load it if this looks like a permissions task," and the agent decides whether to actually pull it into context. Under task pressure, it often decides not to.

**Attempt three: skills with triggered contract loading.** The skill matches the task on its description and loads the contract unconditionally — the agent doesn't get a vote. The scoped contracts are identical to attempt two; the only thing that changed is what does the loading. The result was a step-change: 9 to 9.5 out of 10, consistently across sessions, with several critical bugs caught at plan time that would otherwise have shipped.

The middle attempt is the one that carries the argument. It pre-empts the obvious objection — *you didn't need skills, you just needed a better-organized `AGENTS.md` with references to scoped docs.* I tried exactly that. It doesn't hold, and it fails for a structural reason rather than a tuning one. Attempts two and three hold the documentation constant: the same scoped contracts, the same content, the same paths. The only variable is the loading mechanism. So the step-change is attributable to the mechanism, not to having scoped contracts at all.

That isolates the architectural insight cleanly. The binding mechanism has to live in the loader, not in the documentation pointing to it. Advisory loading — the agent reads a pointer and decides whether to dereference — is structurally weaker than triggered loading, where the skill pulls the contract in on a task match regardless of the agent's judgment. The difference is who decides. Leave the decision to the agent and it skips under pressure, exactly when the rules matter most. Move the decision into the trigger and the right context appears whether the agent would have asked for it or not.

This generalizes uncomfortably. Every governance scheme I've seen that leaves loading to the agent's discretion produces the same signature: the docs exist, the references exist, the team is satisfied that *we have governance*, and under pressure the agent operates as if the docs were absent. The discipline isn't writing rules, and it isn't even pointing at them. It's making the rules load themselves at the moment of decision.

## Where it doesn't work, and the trait behind it

The pattern has limits. They are worth stating plainly so the framework doesn't get oversold.

It doesn't help on genuinely novel problems where the invariants aren't yet known. You cannot contract what you cannot articulate. The earliest stages of a system — when the behavior is still being discovered — are the wrong place to lock contracts. Premature contracting freezes assumptions before they've earned the right to be invariants.

It doesn't survive teams that don't audit. A wrong contract, left to drift while the system changes underneath it, is a confident hallucination factory. The agent obeys it; the agent's output looks authoritative; the bug ships with documentation backing it up. The discipline of auditing contracts is not optional. If a team isn't going to keep the contracts honest, the team is better off without them.

It doesn't fix capability gaps. Some failures of LLM-driven work are reasoning failures, not context failures. Loading more context into a session where the model fundamentally can't reason about the problem at hand produces longer, more confident wrongness. Contracts and skills are the right tool when the failure is *the agent didn't know*. They are the wrong tool when the failure is *the agent can't think*.

A note on scope. The same contract-and-skill shape applies outside production code. I've used it on personal artifacts where a design system needed to survive regeneration without drift — the contract holds the spec, the skill loads it at regeneration time, the artifact comes out identical to the canonical version. The shape generalizes anywhere a non-stateful executor has to behave consistently against rules that aren't intrinsic to the tools it's using.

This pattern was not designed. It came from staying in the friction long enough to feel what was structural. Every correction loop that cost an hour, every regression that shipped because the model *knew* something it didn't, every back-and-forth that should have been one round — those are signals. I noticed them because I tolerated them long enough to see what they had in common. The instinct to systematize the friction rather than work around it is the trait that produced the pattern.

The contracts and skills aren't the artifact. The artifact is what gets shipped. The contracts and skills are the substrate that makes shipping possible without re-paying the context tax every session.
