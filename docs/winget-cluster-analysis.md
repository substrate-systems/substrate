# Keyword-Cannibalisation & Content-Quality Analysis: Winget / PC-Setup Blog Cluster

**Scope:** 6 articles on substratesystems.io, all ending in an Endstate CTA, published 2026-07-03 to 2026-07-04.
**Framing note:** GSC reports all six as "Discovered — currently not indexed." On a domain with ~zero backlinks, that status is already fully explained by domain authority, not by this cluster's content quality. Nothing below claims the cluster caused the non-indexing. This is an independent risk assessment of what happens *when* Google does crawl and evaluate these pages.

**Method:** Full body text of all six articles was tokenized and compared pairwise using (a) content-word Jaccard similarity, (b) TF‑IDF cosine similarity, (c) exact 6-word-shingle (verbatim phrase) overlap, and (d) a "core-topic" Jaccard that excludes the 51 terms appearing in ≥5 of 6 docs (shared marketing/tool vocabulary like "endstate," "winget," "settings," "portable," "free"). This isolates genuine topical duplication from shared CTA boilerplate. All six full documents were also close-read manually. N=6 documents (4,137 measured body words), N=15 pairs — this is a census, not a sample, so figures below are descriptive (means, ranges, proportions), not inferential; no p-values apply.

---

## 1. Per-article target intent

| # | Article (slug) | Words / Published | Primary target query | Secondary queries |
|---|---|---|---|---|
| 1 | `winget-export-microsoft-store-apps` | 521 / 07-03 | "why does winget export skip Microsoft Store apps" | "winget list source column msstore", "winget install --source msstore --id" |
| 2 | `set-up-new-windows-pc-fast` | 570 / 07-03 | "how to set up a new Windows PC fast" | "winget export apps.json backup", "capture Windows settings before reinstall" |
| 3 | `reinstall-all-apps-with-winget` | 596 / 07-03 | "how to reinstall all apps with winget" | "winget export import tutorial", "what does winget import not restore" |
| 4 | `new-windows-pc-setup-guide` (pillar) | 703 / 07-04 | "complete guide to setting up a new Windows PC" | everything in the cluster — self-declared aggregator ("Each section links to a deeper write-up") |
| 5 | `share-your-app-setup` | 626 / 07-04 | "share app settings/config with someone else" | "dotfiles for non-developers", "transfer MSI Afterburner / OBS config" |
| 6 | `free-open-source-pc-migration-alternative` | 1552 / 07-03 | "[EaseUS/Zinstall/Laplink] free alternative" (brand-comparison) | "is winget export a PC migration tool", "byte-copy vs reinstall PC migration" |

**[FINDING]** Article #4's title ("complete guide to setting up a new Windows PC") and article #2's title ("how to set up a new Windows PC in minutes, not a weekend") target the same head phrase — "set up a new Windows PC" — differentiated only by a modifier ("complete guide" vs "in minutes"). Articles #1 and #3 share tags `winget`+`backup` and both center the `winget export`/`import` command pair. Article #5 (give your config to someone else) and #6 (brand-name competitor comparison) are the only two with genuinely distinct intent shapes from the rest.
**[STAT:n]** n = 6 articles, tags cross-referenced from frontmatter.

---

## 2. Pairwise overlap matrix (all 15 pairs)

Ratings combine three quantitative measures — **raw Jaccard** (shared content words ÷ union), **core Jaccard** (same, with 51 cluster-wide boilerplate terms excluded), and **verbatim 6-gram count** (exact shared 6-word phrases) — with a qualitative read of whether the pair competes for the same query or just shares marketing language.

| Pair | Rating | Raw Jaccard | Core Jaccard | Verbatim 6-grams | Justification |
|---|---|---|---|---|---|
| set-up-fast ↔ reinstall-apps | **HIGH** ⚠ | 0.405 | 0.300 | 27 | Highest overlap of all 15 pairs on every measure. Both walk export→save→import→gaps→Endstate with the same commands and near-identical CTA language. |
| set-up-fast ↔ pillar-guide | **HIGH** ⚠ | 0.348 | 0.233 | 38 | Contains a **verbatim, word-for-word identical closing paragraph** ("Setting up a new machine will never be zero work…"). Titles target the same head phrase. |
| reinstall-apps ↔ pillar-guide | MEDIUM | 0.281 | 0.166 | 3 | Pillar's "Getting your apps back" section compresses reinstall-apps' two gaps into 2 bullets + explicit link — expected pillar summarization, not spoke-vs-spoke duplication. |
| winget-export ↔ reinstall-apps | **HIGH** ⚠ | 0.262 | 0.130 | 4 | reinstall-apps' "What winget misses" section restates winget-export's entire thesis (Store-source gap) as one of three bullets, with an explicit backlink — near-total subsumption of winget-export's unique claim. |
| pillar-guide ↔ free-alt | MEDIUM | 0.256 | 0.179 | 9 | Pillar recaps free-alt's whole argument (paid tools, $50–130, byte-copy risk) in one paragraph + link — summarization, low competitive-collision risk since pillar doesn't try to rank for brand-comparison queries itself. |
| winget-export ↔ pillar-guide | MEDIUM | 0.225 | 0.088 | 5 | Pillar's 1-bullet compression of winget-export's finding + direct link; standard hub behavior. |
| winget-export ↔ set-up-fast | LOW | 0.220 | 0.074 | 2 | Numerically borderline but qualitatively distinct: core topics (Store-source diagnostic vs. general speed-workflow) don't actually overlap; the raw score is inflated by shared CTA boilerplate. |
| reinstall-apps ↔ free-alt | MEDIUM | 0.209 | 0.132 | 19 | free-alt's "winget export" aside restates reinstall-apps' "what winget misses" bullets nearly point-for-point, though free-alt's primary intent (comparison-shopping) differs. |
| set-up-fast ↔ free-alt | MEDIUM | 0.207 | 0.128 | 22 | Shares the "300+ apps (editors and IDEs…)" boilerplate list and CTA almost verbatim; different primary intent softens the collision risk. |
| pillar-guide ↔ share-setup | LOW | 0.183 | 0.108 | 0 | Pillar links out to share-setup as an aside; share-setup's substance (sharing configs with others) is genuinely distinct. |
| set-up-fast ↔ share-setup | LOW | 0.182 | 0.108 | 0 | No verbatim overlap; unrelated use cases (own-machine restore vs. handing config to someone else). |
| reinstall-apps ↔ share-setup | LOW | 0.177 | 0.105 | 0 | Same as above. |
| winget-export ↔ free-alt | LOW | 0.171 | 0.086 | 0 | free-alt mentions the Store-app gap in one sentence only; different primary (brand-comparison) intent. |
| share-setup ↔ free-alt | LOW | 0.156 | 0.106 | 0 | Zero verbatim overlap; fully distinct topics (config-sharing feature vs. competitor pricing). |
| winget-export ↔ share-setup | LOW | 0.153 | 0.069 | 0 | Unrelated. |

**[STAT:effect_size]** Raw Jaccard across all 15 pairs: mean = 0.229, median = 0.209, range [0.153, 0.405]. Core-topic Jaccard (boilerplate excluded): mean = 0.134, median = 0.108, range [0.069, 0.300]. **[STAT:n]** n = 15 pairs, 6 documents.

**[FINDING]** Three pairs are flagged where Google would plausibly struggle to pick a winner: **set-up-fast ↔ reinstall-apps**, **set-up-fast ↔ pillar-guide**, and **winget-export ↔ reinstall-apps**. All three involve either a verbatim-shared paragraph, a fully-subsumed unique claim, or both.

**[LIMITATION]** Lexical-overlap measures (Jaccard, cosine, shingles) undercount *paraphrase*-level duplication — e.g., winget-export's "writes out the packages it can round-trip from the winget source" vs. reinstall-apps' "only serializes packages from the winget source" say the same thing in different words, which token-overlap stats score as dissimilar even though a search engine's semantic ranking would likely treat them as redundant. The HIGH rating on winget-export↔reinstall-apps leans on manual reading precisely because the token stats alone (core Jaccard 0.130) would understate it.

---

## 3. Unique-substance audit

| Article | Est. % genuinely unique to it | Verdict |
|---|---|---|
| winget-export | ~60% | Narrow but real: the Source-column diagnostic and the `winget install --source msstore --id` manual-fix command appear nowhere else in the cluster, even though the underlying *fact* (Store apps get skipped) is restated in 3 siblings. |
| set-up-fast | ~30% | **Mostly a reframe.** Structurally identical to reinstall-apps (export→save→import) and pillar-guide (its closing paragraph is copied verbatim into the pillar). Its only distinguishing content is the "save it somewhere you own" file-hygiene beat and a narrative wrapper ("used to cost me an evening"). |
| reinstall-apps | ~48% | The `--include-versions`, `--ignore-unavailable`, `--ignore-versions` flag reference is genuinely unique — a real command cheat-sheet nothing else in the cluster has — even though the "3 things winget misses" framing is repeated elsewhere. |
| pillar-guide | ~18% | **Weakest unique-content share of the six.** Its organizing idea ("two halves: apps vs. settings") is itself lifted from set-up-fast's "two halves" framing. Most of the article is compressed restatement + links. This is expected for a hub page, but as currently written it adds almost no new information over its own spokes. |
| share-setup | ~80% | Most independent article in the cluster (0 verbatim 6-grams shared with any sibling, lowest core-Jaccard scores). Unique passage: *"This is dotfiles, but for normal apps and normal people."* and the credential-handling explanation ("The settings modules deliberately leave out tokens, API keys, and account state…") appear nowhere else. |
| free-alt | ~75% | Largest and most externally-sourced piece: named competitor pricing with citations (easeus.com, zinstall.com, laplink.com, windowscentral.com), a comparison table, and an FAQ block. ~20-25% (the "What free-but-limited looks like" section) restates winget-export/reinstall-apps material, but the bulk is genuinely new competitive research. |

**[STAT:n]** n = 6 articles; percentages estimated from verbatim-shingle dup-fraction (0.0–0.13 across docs) combined with paragraph-level manual review, not a single automated score — treat as directional, not exact.

**Bluntest call:** set-up-fast and pillar-guide are the two weakest links by this measure. set-up-fast is largely reinstall-apps re-narrated for a "speed" angle, and pillar-guide currently functions more as a link directory than a standalone deep guide.

---

## 4. Internal link graph

Extracted directly from markdown links in each article body:

| From → To | Link |
|---|---|
| winget-export → reinstall-apps | "what winget reinstalls, and what it misses" |
| winget-export → /endstate | CTA |
| set-up-fast → reinstall-apps | "what winget export misses" |
| set-up-fast → /endstate | CTA |
| reinstall-apps → winget-export | "why winget export skips your Store apps" |
| reinstall-apps → /endstate | CTA |
| pillar-guide → reinstall-apps, winget-export, share-setup, set-up-fast, free-alt | all 5 spokes, plus /endstate, /download |
| share-setup → /endstate, /download only | no sibling-article links |
| free-alt → /endstate (external abs. URL), /download, GitHub, competitor sites | no sibling-article links |

**In-degree / out-degree (within the 6-article cluster only):**

| Article | In (from siblings) | Out (to siblings) |
|---|---|---|
| pillar-guide | **0** | 5 |
| winget-export | 2 (reinstall-apps, pillar-guide) | 1 |
| reinstall-apps | 3 (winget-export, set-up-fast, pillar-guide) | 1 |
| set-up-fast | 1 (pillar-guide) | 1 |
| share-setup | 1 (pillar-guide) | 0 |
| free-alt | 1 (pillar-guide) | 0 |

**[FINDING]** This is a **one-way fan-out, not a pillar-and-spoke mesh**. The pillar links to all 5 spokes (correct pillar behavior), but **zero spokes link back to the pillar** — pillar-guide has in-degree 0 from its own cluster. The trio winget-export/reinstall-apps/set-up-fast forms a partial mesh (winget-export↔reinstall-apps is reciprocal; set-up-fast→reinstall-apps is one-way, not reciprocated), while share-setup and free-alt are pure link **sinks**: each receives exactly one inbound link from the pillar and links to nothing else in the cluster — they are dead ends for both users and crawlers.
**[STAT:n]** n = 6 nodes, 9 directed edges total among siblings (excluding CTA/external links).

**[LIMITATION]** This graph covers only the 6 articles supplied. Homepage, sitemap, category/tag pages, or nav links elsewhere on substratesystems.io could still route crawl equity into pillar-guide or the two orphaned pieces — not verified here.

---

## 5. Helpful-content risk call

| Signal | Observation |
|---|---|
| Word count | 521–1552 words, median ≈610. Short, but not automatically thin — winget-export's 521 words carry one specific, correct, narrowly-scoped technical fact, which is appropriate length for that query. |
| Publication clustering | 4 of 6 published 2026-07-03, remaining 2 on 2026-07-04 — **a 6-post cluster inside a 48-hour window**, a programmatic/campaign publication signature rather than organic editorial cadence. |
| Templated section structure | Confirmed quantitatively: 3 of 4 core how-to articles end in a near-identical CTA section — winget-export 22.6% of its body, set-up-fast 32.0%, reinstall-apps 25.4% (mean 26.7%, n=3) — each titled a variant of "How/Where/The version Endstate ___" and each repeating a near-verbatim "300+ apps (editors and IDEs, terminals, creative apps like Blender and DaVinci Resolve…)" boilerplate list, confirmed present in 5 of 6 articles. |
| Uniform commercial CTA | All 6 articles link to `/endstate` or `/download`. "Endstate" mention density ranges 0.60–1.80 per 100 words (mean 1.10, median 1.01, n=6) — even the ostensibly-neutral how-to pieces (winget-export, reinstall-apps) carry the pitch as a first-person "I built X" narrative device, not an incidental mention. |
| Genuine first-hand value | Mixed, and this is the load-bearing signal. share-setup and free-alt show the lowest cross-document duplication (0 verbatim 6-grams with any sibling; core-Jaccard 0.07–0.18) and contain specific, checkable, sourced claims (competitor pricing with citations, credential-handling specifics) — genuine first-hand product knowledge. winget-export's core technical claim (winget's dual-source architecture) is specific and correct. By contrast, set-up-fast and pillar-guide sit at the top of the duplication table (Jaccard 0.35–0.41) and contribute comparatively little beyond what reinstall-apps and each other already say. |
| Authorship / E-E-A-T | Consistent first-person voice throughout ("I built Endstate," "I hit the Store-app gap on my own machines") and primary-source citations in free-alt (vendor pricing pages) — a positive signal Google's helpful-content guidance explicitly weighs. |

**Risk rating: MEDIUM overall, concentrated unevenly.** This is not the classic helpful-content-violation pattern (mass-produced, low-effort, no first-hand expertise) — the technical claims are accurate and specific, and authorship is consistent and transparent about its commercial angle. But the cluster does show real programmatic-SEO risk markers Google's systems are specifically built to catch: near-duplicate content targeting adjacent head-terms, a uniform commercial CTA embedded in every single page regardless of stated topic, and a templated skeleton with a verbatim-repeated boilerplate paragraph.

**Sub-cluster read:** the set-up-fast/reinstall-apps/pillar-guide triangle is where risk actually concentrates — in isolation, that trio would score closer to **HIGH**. winget-export, share-setup, and free-alt read individually as legitimate, narrowly-scoped, first-hand pieces — **LOW** in isolation. The blended cluster-wide rating is MEDIUM because 3 of 6 pages carry most of the risk and 3 of 6 are comfortably fine.

**[STAT:n]** Signal counts: n=6 articles, n=3 articles with explicit CTA sections measured, n=15 pairwise comparisons.

---

## 6. Recommendation

**Consolidate (partial) — not a blanket verdict.** The evidence doesn't support treating all six uniformly; the redundancy is concentrated in one triangle.

1. **301-redirect `set-up-new-windows-pc-fast` → `new-windows-pc-setup-guide`.** It has the weakest unique-substance score (~30%), the highest pairwise overlap in the cluster with both reinstall-apps (Jaccard 0.405) and the pillar (0.348, including a verbatim-duplicated closing paragraph), and a title competing with the pillar's for the same head phrase. Before redirecting, port its one distinct beat — "save it somewhere you own" (USB stick / no cloud account) — into the pillar's "Getting your apps back" section so that point isn't lost.
2. **Rewrite `new-windows-pc-setup-guide` into an actual deep guide, not a link directory**, absorbing set-up-fast's step-by-step content directly rather than just linking out. Currently ~18% of its body is genuinely new — that needs to rise substantially now that it's absorbing the traffic and link equity of the redirected URL.
3. **Keep-and-deepen `reinstall-all-apps-with-winget`.** Trim the paragraph that re-explains winget-export's Store-app finding down to a one-line pointer (it already links out — stop restating the fact first). Keep and expand the CLI-flag reference (`--include-versions`, `--ignore-unavailable`, `--ignore-versions`) since that's genuinely unique, useful reference content found nowhere else in the cluster.
4. **Leave alone: `winget-export-microsoft-store-apps`.** Distinct diagnostic intent, lowest duplication among the how-to trio, correct and narrowly scoped — appropriate length for its query.
5. **Leave alone: `share-your-app-setup` and `free-open-source-pc-migration-alternative`.** Both are substantively distinct from the rest of the cluster and from each other (0 verbatim 6-gram overlap between them); no cannibalization risk found.
6. **Fix the link graph regardless of the above, independent of any content decision**: add a "back to the complete guide" link from every surviving spoke (winget-export, reinstall-apps, share-setup, free-alt) up to the pillar. Right now the pillar has in-degree 0 from its own cluster — this is a free, low-risk fix that doesn't require rewriting any prose.

**What would change this recommendation:**
- GSC/analytics evidence (once the domain is indexed) showing set-up-new-windows-pc-fast independently earns impressions/clicks for queries reinstall-all-apps-with-winget does *not* rank for — would argue for keeping it standalone rather than merging.
- Keyword-research data (Ahrefs/SEMrush/GSC query reports) showing "set up a new Windows PC fast" and "reinstall apps with winget" pull meaningfully different search populations by intent (informational vs. transactional) — would override the textual-overlap-based merge call.
- A concrete plan to further differentiate set-up-fast (e.g., a distinct checklist/video-companion format) rather than leaving it as prose-parallel to reinstall-apps.

**Evidence that would *not* change it:** the current non-indexing status alone — that is fully explained by zero backlinks/domain age and says nothing about whether this specific redundancy will matter once the domain does get crawled and evaluated.
