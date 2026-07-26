---
title: "Exomem vs claude-mem: session continuity and durable knowledge are different problems"
slug: exomem-vs-claude-mem
description: "claude-mem captures what your agent did and replays it into the next session. Exomem stores what you concluded, in Markdown you own. An honest comparison of two tools that get filed together and solve different problems."
published: 2026-07-25
tags:
  - exomem
  - agent-memory
  - ai-agents
  - mcp
  - claude-code
author: Hugo Ander Kivi
status: published
---

claude-mem is the most popular memory tool for Claude Code by a wide margin — 88,000 stars and shipping constantly. I get asked how Exomem compares often enough that it deserves a straight answer.

The straight answer is that they solve different problems, and the comparison people expect is the wrong one.

## The one distinction that actually matters

**claude-mem remembers what your agent did. Exomem remembers what you concluded.**

claude-mem hooks into the session lifecycle, captures the agent's activity as it happens, compresses it with an LLM, and injects the relevant parts back into your next session. You do nothing. That is the entire point, and it is genuinely well built.

Exomem does not watch your sessions. It stores durable conclusions — decisions, findings, failures, patterns — as typed Markdown notes in a vault you own, with the sources they came from, and a review queue for when they go stale. Something only enters it because you or your agent decided it was worth keeping.

One is automatic and about continuity. The other is deliberate and about knowledge. Neither replaces the other, and I'll come back to that.

## Comparison

|                                  | claude-mem                                             | Exomem                                                   |
| -------------------------------- | ------------------------------------------------------ | -------------------------------------------------------- |
| What it captures                 | Session activity, automatically via lifecycle hooks    | Conclusions you choose to keep                           |
| Where it stores                  | SQLite + Chroma vector DB in `~/.claude-mem/`          | Markdown files in your own Obsidian vault                |
| Can you read it without the tool | Not really — it's a database                           | Yes, they're just files                                  |
| Retrieval                        | Semantic summaries, progressive disclosure             | Hybrid FTS5 + local vectors + graph, 864 ms at 50k notes |
| Structure                        | Session logs and observations                          | Typed sources, notes, entities, evidence, supersession   |
| Human review                     | Not the model                                          | Audit and attention queues                               |
| Multimodal                       | Text                                                   | OCR, audio/video ASR, CLIP image search, all local       |
| Cloud                            | Optional sync to cmem.ai                               | None; optional self-hosted REST                          |
| Clients                          | Claude Code, Codex, Gemini, Copilot, OpenCode and more | Any MCP client, plus CLI and REST                        |
| Language                         | JavaScript                                             | Python                                                   |
| Licence                          | Apache-2.0                                             | AGPL-3.0                                                 |
| Price                            | Free                                                   | Free, self-hosted                                        |

Both are open source and both are agent-agnostic, so if you've seen Exomem described as "the agnostic one", that isn't the difference. The difference is where the data lives and who curates it.

## Where claude-mem is the better choice

I'd rather say this plainly than have you discover it after an afternoon.

**You want continuity with zero effort.** claude-mem's whole design is that you install it and never think about it again. Exomem asks you to decide what's worth keeping. If you don't want to make that decision, Exomem will feel like homework.

**You want your agent to recall its own work.** "What was I doing in this repo last Tuesday, and what did I try?" is exactly claude-mem's question. Exomem has no idea what your agent did unless something was deliberately written down.

**You're working in one tool and want it to feel continuous.** That's a real want and claude-mem serves it directly.

## Where Exomem is the better choice

**You want the knowledge to outlive the tool.** Exomem's notes are Markdown in your vault. Open them in Obsidian, grep them, put them in git, keep them if you stop using Exomem tomorrow. A database in `~/.claude-mem/` is a dependency; a folder of Markdown is not.

**You need to know where a claim came from.** Exomem keeps raw sources separate from compiled conclusions, preserves evidence append-only, and records supersession when a conclusion replaces an older one. When you ask "why do we believe this?", there's an answer with a path attached.

**Conclusions go stale and you want to catch it.** Audit and attention queues surface unprocessed sources, stale notes, broken links and claims that sit too close together. Compression doesn't do this — a summary of a wrong conclusion is a confident wrong conclusion.

**Your knowledge isn't only text.** PDFs, screenshots, recordings and images become searchable through local extraction, without anything leaving the machine.

## They're not actually an either/or

The framing everyone reaches for is "which memory tool should I use", and I don't think that's the right question.

Running both is coherent. Let claude-mem handle session continuity, so your agent picks up where it left off. Let Exomem hold the durable layer, so the conclusion you reached three months ago is still findable, still attributed, and still yours when you switch tools. They write to different places and neither knows about the other.

If you only want one, the honest test is whether you'd be upset to lose it. If losing your memory store would cost you an afternoon of re-explaining context, claude-mem is the fit. If it would cost you a year of accumulated reasoning, you want files you own.

## Installing either

**claude-mem** is a plugin install inside Claude Code, and its README covers the other clients: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem).

**Exomem** is one line, and it wires up every agent client on the machine:

```
curl -fsSL https://raw.githubusercontent.com/Artexis10/exomem/main/scripts/install.sh | sh
```

On Windows, use PowerShell:

```
irm https://raw.githubusercontent.com/Artexis10/exomem/main/scripts/install.ps1 | iex
```

Or try it against a bundled sample vault before installing anything:

```
uvx exomem demo
```

That runs fully local and read-only, and finishes in about a second.

## Where you can get it

Exomem is on [PyPI](https://pypi.org/project/exomem/) and [GitHub](https://github.com/Artexis10/exomem), AGPL-3.0, and the product page is at [substratesystems.io/exomem](/exomem). The comparison against mem0, Letta, Zep, cognee and Basic Memory — the other tools people weigh this against — is [here](/blog/exomem-vs-mem0-letta-zep).

## FAQ

**Does Exomem watch my Claude Code sessions like claude-mem does?**
No. It has hooks that remind the agent to search before answering and to save at natural stopping points, but it does not capture or compress your session transcripts. Nothing is written unless something decides it's worth keeping.

**Can I use both at once?**
Yes. They store in different places and neither is aware of the other. claude-mem covers continuity, Exomem covers durable knowledge.

**Is claude-mem's data really not portable?**
It's SQLite plus a Chroma vector store, so it's inspectable if you're willing to query it — it just isn't something you'd read or edit by hand, and it isn't meaningful outside the tool. Exomem's notes are Markdown files that are useful on their own.

**Which one is "agnostic"?**
Both. claude-mem supports Claude Code, Codex, Gemini, Copilot, OpenCode and others; Exomem works with any MCP client plus CLI and REST. Agnosticism isn't the distinguishing feature — file ownership and curation are.
