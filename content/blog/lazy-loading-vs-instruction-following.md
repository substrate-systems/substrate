---
title: "Lazy loading vs. instruction-following"
slug: lazy-loading-vs-instruction-following
subtitle: "Why skill-triggered governance produces the benchmark improvement"
description: "Skill-triggered context loading reliably outperforms bulk-loaded AGENTS.md. The mechanism behind the benchmark result — two cognitive operations, one binding layer."
published: 2026-05-24
date: 2026-05-24
status: draft
related: governance-as-compression
tags:
  - llm-governance
  - skills
  - rag
  - instruction-following
  - binding-mechanism
author: Hugo Ander Kivi
---

## The result, in one paragraph

The [governance-as-compression](/blog/governance-as-compression) piece showed a measurable result:

> Skill-triggered contract loading produced a substantial quality improvement over bulk loading via `AGENTS.md` / `CLAUDE.md`, from a **7/10 baseline** to **9–9.5/10** on the same task.

Same content. Same model. Same evaluator. Different loading mechanism.

The result is reproducible; what's worth naming is the **mechanism**.

## Two cognitive operations, not one

Loading information and using it are usually treated as a single problem: *give the model what it needs.* The model treats them as two operations, and the reliability profiles diverge sharply.

**Retrieval over available context.** Content sits in `AGENTS.md` / `CLAUDE.md`; the model is told it's there. To use it, the model has to:

1. Notice the situation calls for the content
2. Locate the relevant section
3. Apply it

This is closer to search-and-match than to directive execution. Engagement is *discretionary*: the content is one of many cues competing for attention weight in the model's working memory. Whether the model engages is probabilistic.

**Instruction-following.** A skill triggers on the task pattern, and the content arrives in the context already framed as instructions for the current task; the model executes against them. *There is no engagement decision.* The content is already in the role the model is trained to follow.

This is the binding mechanism. Not magical. Just a different cognitive operation.

## Why instruction-following is more reliable

Modern LLMs are post-trained heavily on instruction-following. The pipeline does the work in stages:

- **Instruction tuning / SFT**: supervised fine-tuning on instruction-response pairs. This is where the instruction-following capability is primarily instilled.
- **RLHF and its successors** (DPO, RLAIF, Constitutional AI): alignment refinement on top of SFT, calibrating the model toward human-preferred behavior.

The combined stack does the work: years of training across millions of examples shape a system that responds reliably to content framed as *do X*.

Retrieval-over-available-context is not the same operation. The model can do it — often well — but:

- The training signal is weaker
- The failure modes are different
- Engagement is calibrated to attention-economy tradeoffs, not to *always engage with rule X when situation Y holds*

The model can have the relevant content in context and still miss it. Not because it can't read; because reading discretionarily is a different act from executing directively.

This is partly why prompting tricks like *important: do X* or *MUST follow these rules* feel like they help. They're attempts to shift content from advisory toward instruction. They do help, but inconsistently, because the binding is still happening inside a passage the model has to decide to engage with. The base operation is still retrieval; the framing is partial conversion.

A skill cuts that step out: the trigger does the binding, and the model receives the relevant rules as its current operating instructions.

## What this looks like in practice

**Advisory framing**: rules sitting in `AGENTS.md` / `CLAUDE.md`, available to the model:

```markdown
## Code review rules

- Never use `enum`; prefer literal unions
- All public APIs must have explicit return types
- Avoid `any` — use `unknown` and narrow
```

The rules are present. Whether the model engages with them when reviewing code depends on retrieval reliability.

**Binding framing**: same rules, loaded by a skill triggered when a code-review task is detected:

```yaml
---
name: code-review
description: Review code changes for type discipline
---

When reviewing a code diff, apply these rules in order:

1. Reject any use of `enum` — flag with a suggestion to use a literal union
2. Verify public APIs have explicit return types
3. Replace `any` with `unknown` + narrowing
```

Same rules, different cognitive operation triggered.

## Implications for design

Three design moves follow.

### 1. Skills as the routing primitive

Don't rewrite all docs as instructions. That's overclaim, and impractical for any system with existing documentation. **Build skills that bind existing docs to task patterns.** The skill defines when to load specific docs and tools, what to do with them, and how to recognize success.

Docs stay polymorphic: reference, narrative, examples, whatever they need to be for human readers. Skills make them load-bearing for agents.

### 2. Tools grouped into skills, not flat menus

A flat tool menu forces the model into retrieval judgment: *which of these tools applies here?*

Skill-grouped tools force the model into instruction-following: *the skill triggered, the tools are loaded with their patterns, the next step is given.*

### 3. Eval signal at the boundary

Tools that emit *did this match the task requirement* let the model self-correct via instruction-following: *if the eval failed, retry with X.*

Tools that emit only *did this return* force the model into retrieval judgment to assess the result, which is the weaker operation.

## The same shape shows up at product scale

This is also why retrieval-augmented generation has the failure modes it has.

RAG, in this framing, is an **automated lazy loader**: when a question comes in, retrieve relevant chunks and put them in context. The chunks arrive as available content, not as instructions. The model still has to decide how much to weight them against its training, against the question framing, against other context. The same discretionary-engagement failure mode appears.

The fix is the same fix: **bind retrieval to a skill or contract** that frames the loaded content as the operating context for the response, not as ambient reference. The retrieval mechanism doesn't change; what changes is the cognitive operation the model performs on what's retrieved. Same architecture at a different scale.

## What this means in practice

If you're shipping AI-augmented work and the model keeps "forgetting" rules you've documented — the rules aren't being forgotten. They're being engaged with at the retrieval reliability profile rather than the instruction reliability profile.

**Move them from advisory to triggered, and the engagement rate changes.**

The skill is what does the binding; the docs don't need to be rewritten, just pointed at.
