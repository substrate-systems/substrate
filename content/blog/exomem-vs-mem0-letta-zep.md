---
title: "Exomem vs mem0, Letta, Zep, cognee, and Basic Memory: an honest comparison of memory for AI agents"
slug: exomem-vs-mem0-letta-zep
description: "An honest comparison of memory for AI agents — Exomem vs mem0, Letta, Zep, cognee, and Basic Memory — on hosting, data ownership, storage format, retrieval, MCP support, license, and price."
published: 2026-07-04
tags:
  - exomem
  - ai-agents
  - agent-memory
  - mcp
  - open-source
author: Hugo Ander Kivi
status: published
---

I built [Exomem](https://substratesystems.io/exomem), so take the framing here for what it is: I have a horse in this race. But I've spent enough time reading how the other agent-memory tools actually work — where they put your data, what they charge, what you're locked into — that I think the comparison is worth writing down plainly, including the parts where the others are the better choice.

"Memory for AI agents" has become a crowded category, and most of the tools in it are solving a slightly different problem than the one Exomem solves. If you're an agent developer choosing a memory layer, the marketing pages all sound the same ("persistent long-term memory for your agents"), so the differences that matter are buried. This post is an attempt to surface them.

## The one distinction that actually matters

Underneath the feature lists, agent-memory tools split into two camps by **what your memory turns into**.

The first camp — mem0, Letta, Zep, cognee — *extracts* your data into a derived store. An LLM reads your conversations or documents and writes out facts, entities, and relationships into a vector database, a knowledge graph, or an agent's internal state. That processed artifact *is* the memory. It's often powerful, and for some problems it's exactly right — but it's not something you can open in a text editor, and it usually lives either in the vendor's cloud or in infrastructure you have to stand up and run (a graph DB, a vector store, a Postgres instance).

The second camp — Basic Memory and Exomem — keeps your memory as **plain Markdown files you own**. The AI reads and writes notes in a vault you can open in Obsidian, VS Code, or `cat`; the search index is a local sidecar you can delete and rebuild. The memory isn't a proprietary extraction of your data — it *is* your data, in a format you already understand.

Neither camp is "correct." Which one you want depends entirely on whether you're building an app that needs a managed memory API, or you want a durable knowledge base you'll still be able to read in ten years. Here's the whole field at a glance, then a fair case for each tool.

## Comparison

| Tool | Hosting | Your data | Multimodal | Knowledge layer | Retrieval | License | Price |
|---|---|---|---|---|---|---|---|
| Exomem | Self-hosted, local-first | Plain Markdown you own | OCR + audio/video ASR + CLIP image, all local | Typed sources / notes / entities / evidence, supersession, human review queues | Hybrid FTS5 + local vectors + graph — benchmarked (864 ms @ 50k notes) | AGPL-3.0 | Free (self-host) |
| Basic Memory | Local-first; optional cloud | Plain Markdown you own | Text only | Notes + wikilinks | Full-text + vector + wikilink graph | AGPL-3.0 | Free local; $15/mo cloud |
| mem0 | OSS core + managed cloud | LLM-extracted facts in a vector store (their cloud / your DB) | Text only | Auto-extracted memories | Semantic/vector + optional graph | Apache-2.0 (core) | Free 10k; $19–$249/mo |
| Letta (ex-MemGPT) | OSS server + managed cloud | Agent state in Postgres/pgvector | Text only | Self-editing memory blocks | Tiered core / recall / archival | Apache-2.0 | Free; $20/mo + usage |
| Zep | Cloud-first (self-host CE discontinued) | Temporal graph (their cloud / your graph DB) | Text only | Temporal knowledge graph | Embeddings + BM25 + graph, temporal | Graphiti Apache-2.0; cloud proprietary | Free 10k credits; $1,250–$3,750/yr |
| cognee | OSS + managed cloud | Graph + vector stores you run (or their cloud) | Documents (many formats) | Ontology knowledge graph | Knowledge graph + vector (ECL) | Apache-2.0 | Free 1M tokens; $2.50/1M tokens |

The two columns most people skim are the ones that decide it as a vault grows: **multimodal** — everything except Exomem is effectively text-only — and the **knowledge layer**, where typed entities, evidence, and human-review queues keep a large corpus *trustworthy*, not just a searchable pile of notes. That, plus retrieval actually benchmarked at 50,000 notes, is where Exomem separates from even the closest plain-files peer.

Prices and terms are current as of July 2026; check each vendor's own page before you commit.

## Where each of the others is the better choice

Honesty is the point of this post, so here's the real case for reaching for something other than Exomem.

### mem0 — when you want a managed memory API that distills conversations for you

mem0's whole premise is that you shouldn't have to manage a vault at all. You send it conversations; an LLM extracts what matters ("single-pass ADD-only extraction," as of their April 2026 algorithm) and stores the salient facts in a vector store, and you query them back by meaning. If you're shipping a product and want a memory layer that's a few SDK calls with a generous free tier (10,000 memories, no card), and you're happy for those memories to live in [mem0's cloud](https://mem0.ai/pricing) or a Qdrant instance you run, mem0 is the most direct fit. The core library is Apache-2.0 and self-hostable, and mem0 ships a hosted MCP server plus the local-first OpenMemory project. If you don't care about owning plain files and you *do* want automatic fact extraction, mem0 is a better match than a note vault.

### Letta — when you want a stateful-agent framework, not a note store

Letta (the productization of Berkeley's [MemGPT](https://github.com/letta-ai/letta) research) is really a different category. It's a full agent runtime whose agents manage their own tiered memory — a small **core** block that lives in the context window, searchable **recall** of past messages, and **archival** long-term storage the agent queries via tool calls — all persisted in Postgres/pgvector. If your goal is to build agents that edit their own memory and improve over time inside a framework, and you want to self-host the whole server (Apache-2.0, free) or run it on Letta Cloud (Pro from $20/mo), Letta is the right tool. Note that Letta is an MCP *client* — its agents mount MCP servers as toolsets — rather than a memory server you point an existing agent at, so it solves "build me a stateful agent," not "give my agent searchable memory over my notes."

### Zep — when your memory is evolving facts about entities over time

Zep is built around a **temporal knowledge graph**: nodes are entities, edges are facts, and when a new fact invalidates an old one, Zep records *when* it became untrue instead of just overwriting it. For agent memory that's fundamentally relational and time-sensitive — a user's changing preferences, a CRM-like history, facts with provenance — that temporal model captures something a flat note vault doesn't, and Zep Cloud advertises sub-200ms p95 retrieval at scale with enterprise governance. Its engine, [Graphiti](https://github.com/getzep/graphiti), is Apache-2.0 and ships an official MCP server. Two honest caveats: Zep discontinued its self-hostable Community Edition in 2025, so the managed service is now cloud-only (Graphiti is the piece you can self-host), and running Graphiti yourself means operating a graph database (Neo4j, FalkorDB, or Neptune). If a temporal graph is the right shape for your memory and you want it managed, Zep is purpose-built for it.

### cognee — when memory is really a GraphRAG problem

cognee treats memory as a data-engineering pipeline: its **ECL (Extract, Cognify, Load)** flow ingests heterogeneous sources and builds a queryable knowledge graph plus a vector index, with ontology generation for multi-hop reasoning. If your problem is "I have a pile of documents across many formats and I want structured, connected, semantically-searchable graph memory over all of it," cognee is a better fit than a note-first tool. It's Apache-2.0 and self-hostable (free forever on your own infrastructure), with a managed [Cognee Cloud](https://www.cognee.ai/pricing) at $2.50 per 1M tokens and an official `cognee-mcp` server. The tradeoff is infrastructure: even the light local default runs a graph store plus a vector store plus SQLite, and production means Postgres/pgvector or Neo4j — more moving parts than a single-file index, in exchange for richer graph reasoning.

### Basic Memory — the closest peer, and where Exomem pulls ahead

[Basic Memory](https://github.com/basicmachines-co/basic-memory) is the tool most like Exomem, and the one worth taking seriously: same core philosophy — memory stays as plain Markdown files you own, editable in Obsidian or any editor, with a native MCP server and the same AGPL-3.0 license — plus polished bidirectional human↔AI sync and a cheap $15/mo hosted option. If your memory is purely **text notes** and you want the lightest possible tool for exactly that, it's a genuinely good pick, and I'd point you to it without hesitation.

But "purely text notes" is the whole gap. Basic Memory is **text-only** — no OCR, no audio/video transcription, no image search — so screenshots, PDFs, scans, and recordings are invisible to it; Exomem indexes all of them, locally. It publishes **no retrieval benchmarks**, so you're trusting it holds up as the vault grows — where Exomem measured **864 ms end-to-end at 50,000 notes** and put the methodology in the repo so you can check it. And it has no typed knowledge layer — no evidence, supersession, or review queues to keep conclusions current as sources change. So the honest split is narrow and real: Basic Memory wins if you want the simplest text-only vault; Exomem wins the moment your memory includes mixed media, has to scale to a size you can verify, or needs to stay trustworthy over time — which, for most people accumulating a real knowledge base, it eventually does.

## What Exomem does differently

Exomem is built to be the most capable tool in the "your files stay plain Markdown you own" camp, and against the extract-into-a-store crowd it makes a deliberate bet: **your memory should *be* your vault, not a derived artifact locked in someone's store.** Concretely:

- **Your data stays plain and portable.** Notes are Markdown files in a vault you own; the search index is a local SQLite sidecar next to them. There's no import into a proprietary store and no cloud dependency for the lean install — FTS5 keyword search ships inside Python's bundled SQLite, so `pip install exomem` works with zero extra services.
- **Retrieval is measured, not asserted.** Exomem's hybrid `find()` runs **sub-second end-to-end at 50,000 notes — 864 ms measured on the reference desktop (Ryzen 7 5800X3D / RTX 5080 / 32 GB), hot cache off** — with the keyword/lexical lanes answering in milliseconds from the FTS5 index. The [benchmark methodology](https://github.com/Artexis10/exomem/blob/main/docs/benchmarks.md) is published in the repo so you can reproduce it. Most tools in this space don't publish reproducible numbers at scale at all.
- **It indexes more than text, fully locally.** Optional extras add local embeddings and CLIP image search, plus OCR (Tesseract), PDF/Office extraction, and speech-to-text (faster-whisper) — so screenshots, scans, audio, and video become searchable without anything leaving your machine.
- **It's built for knowledge that changes.** Typed folders for raw sources, compiled notes, entities, and evidence; a supersession history; and human review queues (audit and attention) that surface stale conclusions, unprocessed sources, and broken links. The server does deterministic work — search, extraction, ranking, file writes — and leaves the reasoning to your client model.

The honest tradeoff runs the other way too: if you want a fully managed memory API with nothing to run, mem0 or Zep Cloud will get you there with less setup; if you want a stateful-agent framework, that's Letta; if you want heavy GraphRAG over many sources, that's cognee; and if you want the simplest plain-Markdown memory with a cheap hosted tier, Basic Memory is right there. Exomem is the better choice when you want your memory to stay plain files you own, self-hosted with no cloud dependency, with multimodal indexing and measured sub-second retrieval at scale.

## Where you can get it

Exomem is [open source under AGPL-3.0 on GitHub](https://github.com/Artexis10/exomem), installs with `pip install exomem`, and runs against your existing Obsidian or Markdown vault. You can read the [product page](https://substratesystems.io/exomem) for the full feature list, check the [benchmarks](https://github.com/Artexis10/exomem/blob/main/docs/benchmarks.md) before you trust the numbers, or just point it at a vault and search.

## FAQ

**Which is the best open-source memory for AI agents?**
There isn't one "best" — it depends on what your memory is. For a managed memory API that extracts facts from conversations, mem0. For a stateful-agent framework, Letta. For a temporal knowledge graph, Zep/Graphiti. For GraphRAG over many sources, cognee. For memory that stays as plain Markdown files you own, Exomem or Basic Memory.

**What's the difference between Exomem and mem0?**
mem0 uses an LLM to extract facts from your conversations and stores them in a vector database (its cloud, or your own Qdrant). Exomem keeps your notes as plain Markdown files in a vault you own and indexes them locally. mem0 is a managed memory API; Exomem is a self-hosted knowledge substrate over your own files.

**How is Exomem different from Basic Memory?**
Both keep your memory as plain Markdown files you own, both are MCP-native, and both are AGPL-3.0 — they're close cousins. Basic Memory focuses on bidirectional human↔AI sync and offers a $15/mo hosted option. Exomem adds multimodal indexing (OCR, audio/video ASR, CLIP image search), typed knowledge operations with a human review loop, and published benchmarks for sub-second hybrid retrieval at 50,000 notes.

**Do I have to run a database or send my data to the cloud?**
Not with Exomem's lean install. Keyword/BM25 search runs on SQLite FTS5, which ships inside Python's standard library, so there's no separate database to operate and no cloud dependency. That's a real contrast with the graph-based tools (Zep/Graphiti, cognee), which expect a graph database, and with the managed services, which store your memory in their cloud.

**Is Exomem really free and open source?**
Yes — it's AGPL-3.0 licensed and [on GitHub](https://github.com/Artexis10/exomem), self-hosted, with no paid tier and no account required. You run it on your own machine against your own vault.

**Which agents and clients can use these?**
Exomem, Basic Memory, mem0, Zep (via Graphiti), and cognee all expose an MCP server, so any MCP-capable client — Claude Code, Claude Desktop, Codex, Cursor, or a custom agent — can use them. Letta is the exception: it's an agent runtime that *consumes* MCP tools rather than a memory server you attach to an existing agent.
