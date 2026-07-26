# Substrate SEO/GEO strategy — Semrush-validated, 2026-07-24

**Status:** active
**Data source:** Semrush, `us` database, pulled 2026-07-24 via MCP. Access expires ~2026-07-27;
raw figures are preserved in the KB at
`Sources/Sessions/2026-07-24-semrush-raw-export-substrate-endstate-exomem-2026-07-24`.
**Relationship to `docs/winget-cluster-analysis.md`:** that document's cannibalisation
analysis stands. Its implicit premise — that the winget cluster served real search demand —
does not. See §3.

---

## 1. Baseline — measured, not inferred

| Metric                                  | substratesystems.io                 | mem0.ai   |
| --------------------------------------- | ----------------------------------- | --------- |
| Ranking keywords, US                    | **0** (`ERROR 50 :: NOTHING FOUND`) | thousands |
| Ranking keywords, all ~100 regional DBs | **0**                               | —         |
| Authority Score                         | **2**                               | **40**    |
| Referring domains                       | **33**                              | **3,378** |
| Backlinks                               | 54 (20 follow / 34 nofollow)        | 149,720   |

**AS 2 with 33 referring domains is the binding constraint.** KD 40+ is unwinnable at this
authority regardless of content quality. Everything below is bounded by it.

**Timeline reality:** content published today realistically ranks October–December 2026.
SEO cannot contribute to a summer-2026 stars/users target. That is a launch problem — see §7.

---

## 2. Endstate: the search demand is real, at task level

The initial read of _category and tool_ terms suggested this market barely existed:
`winget export` 20/mo, `winget microsoft store apps` **0**, `pc migration software` 320 —
the largest non-branded category term. That read was too narrow and is corrected here.

**People don't search the category. They search the task.** The "transfer programs between
computers" family, from the Zinstall ∩ Laplink keyword gap:

| Keyword                                                      | Vol | KD     | Zinstall | Laplink |
| ------------------------------------------------------------ | --- | ------ | -------- | ------- |
| `how do i transfer software from one pc to another`          | 390 | 26     | 15       | 3       |
| `how to move a software program to another computer`         | 390 | **22** | 11       | 2       |
| `how to transfer one program from one computer to another`   | 390 | 32     | 7        | 3       |
| `how to transfer programs from one computer to another`      | 390 | 26     | 14       | 3       |
| `how to move a program from one pc to another`               | 320 | 32     | 13       | 3       |
| `how to move software from one pc to another`                | 320 | 32     | 28       | 4       |
| `how to transfer a program to another computer`              | 320 | 30     | 13       | 2       |
| `how can you transfer programs from one computer to another` | 260 | 27     | 15       | 3       |
| `how to move a program from one computer to another`         | 260 | 31     | 40       | 4       |
| `how can i transfer programs from one computer to another`   | 210 | **22** | 16       | 4       |
| `how do i transfer a program to another computer`            | 210 | **22** | 13       | 5       |
| `how do i transfer programs from one computer to another`    | 210 | 23     | 9        | 2       |
| `how to move a program to another computer`                  | 210 | 23     | 15       | 4       |

**≈3,600/mo at KD 22–32**, all one intent, all served honestly by Endstate.

Plus the task-level set from `phrase_questions`:

| Keyword                                                          | Vol | KD     |
| ---------------------------------------------------------------- | --- | ------ |
| `transfer programs apps new computer without installation disks` | 720 | **21** |
| `migration assistant for windows`                                | 720 | 28     |
| `windows easy transfer` (legacy MS tool, Laplink ranks #1)       | 880 | 34     |
| `how to reinstall windows without losing files and apps`         | 480 | 31     |
| `how to transfered already installed programs to new computer`   | 320 | **19** |
| `windows transfer tool`                                          | 390 | 39     |
| `how to transfer favorites to a new computer`                    | 260 | 25     |
| `transfer programs to new computer`                              | 210 | 29     |
| `do you have to reinstall apps after windows 11 upgrade`         | 140 | 30     |
| `transfer firefox profile to new computer`                       | 110 | 19     |

**Total honest Endstate opportunity: ~6,000–7,000/mo at KD 19–34.**

Both incumbents ranking here are paid, closed-source tools with thin content. Zinstall sits
at positions 7–40; Laplink at 2–5. A genuinely better free, open-source answer is
competitive on merit — this is the one place where AS 2 costs least, because the pages
holding these positions are not strong.

### Deliberately excluded

The larger Quicken (~1,050/mo), QuickBooks (~890), MS Office (~1,040), iTunes (~530) and
file-transfer (~2,900) clusters. **These are document and data migration. Endstate moves
apps and their settings.** Ranking for them would produce bounces and require dishonest
copy. `how to transfer files from pc to pc` (2,900/mo) is the single biggest term in the
space and Endstate does not do it — leave it.

### A pattern that failed testing

`move vivaldi to a new laptop windows 11` showed 1,000/mo at KD 10, suggesting a
programmatic "move &lt;app&gt; to new PC" play across the 357 settings modules. **Tested and
rejected:** `transfer vs code settings to new computer` 20, `move steam to new pc` 20,
`transfer notepad++ settings` **0**, `move chrome profile to new computer` 20. Only
`transfer firefox profile to new computer` (110, KD 19) has real volume. The Vivaldi figure
is almost certainly a Semrush artifact. Do not build a programmatic page generator on it.

### Recommended Endstate action

**One definitive pillar page** targeting `how to transfer programs from one computer to
another` and its ~13 near-identical variants — they are one intent and should not be split
across pages (that is precisely the cannibalisation `winget-cluster-analysis.md` documented).
Fold the existing winget posts in as supporting sections or internal links rather than
writing anything new for them.

---

## 3. The winget cluster

Measured volume for what these five posts target:

| Keyword                                                | Volume      |
| ------------------------------------------------------ | ----------- |
| `winget microsoft store apps`                          | **0**       |
| `transfer apps from old pc to new pc`                  | **0**       |
| `backup app settings windows`                          | **0**       |
| `bulk install windows apps`                            | 10          |
| `winget export` · `winget import` · `winget configure` | **20** each |

Keep the posts — they cost nothing to hold and serve visitors arriving via distribution.
**Write no more of them.** Redirect that effort to the §2 pillar.

---

## 4. Exomem / the AI cluster

Reachable band only (KD ≤ 32), SERP-checked:

| Target                                       | Vol           | KD      | SERP verdict                                                                                           |
| -------------------------------------------- | ------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `claude-mem` · `how to install claude mem`   | 4,400 · 2,400 | 25 · 19 | **Strong** — GitHub #1, then termdock, augmentcode, datacamp, medium, mindstudio. No vendor lock.      |
| `how to build an mcp server` (+4 variants)   | ~1,300        | 19–28   | **Strong** — _zero_ official docs in the top 8                                                         |
| `obsidian mcp` · `obsidian with claude code` | 1,300 · 90    | 28 · 27 | **Strong** — GitHub #1, then Obsidian forum, Reddit, personal blogs                                    |
| `markdown knowledge base`                    | 50            | **8**   | **Strong** — no vendor lock                                                                            |
| `claude code memory` · `claude memory`       | 880 · 1,900   | 26 · 29 | **Good** — Anthropic docs hold only #1 and #6                                                          |
| `mcp memory server` · `basic memory mcp`     | 90 · 50       | 22 · 10 | **Good**                                                                                               |
| `openspec`                                   | 5,400         | 31      | **Good** — GitHub #1, openspec.dev #2, then Medium, a personal blog (#6), ThoughtWorks                 |
| `claude agent sdk`                           | 6,600         | 29      | **Moderate** — Anthropic docs #1, official GitHub #2. Ceiling ~#3                                      |
| `claude code settings`                       | 720           | 28      | **Moderate** — Anthropic docs at #1, #4, #10                                                           |
| `subagents`                                  | 590           | 27      | **Demoted** — Anthropic, OpenAI and LangChain docs hold #1, #2, #3, #6. Make it a section, not a page. |

### claude-mem is a search competitor, not a product competitor

An earlier draft called it Exomem's "most direct product overlap." **That was wrong.**
claude-mem stores in a proprietary SQLite + Chroma vector DB at `~/.claude-mem/` with
optional cloud sync to cmem.ai, auto-capturing and AI-compressing session activity — session
continuity with a managed backend. Exomem is a governed long-term store in markdown files
the user owns. Architecturally near-opposite.

It is also agent-agnostic (Codex, Gemini, Copilot, OpenCode), so **agnosticism is not
Exomem's differentiator — file ownership and governance is.**

They compete for the same _search intent_, which makes an honest "these solve different
problems, here's how to tell which you need" comparison both winnable and the strongest GEO
asset available. `exomem-vs-mem0-letta-zep.md` proves the format works; it simply omits the
competitor with the most search demand.

### Not doing

`claude code skills` (KD 50), `claude.md` (44), `anthropic skills` (70), `claude skills` (75).
Revisit once referring domains clear ~100.

---

## 5. The competitor playbook, read off traffic data

**mem0's organic traffic is not from memory keywords.** Its top non-branded pages:

| Keyword                   | Volume | Position | Landing page                                 |
| ------------------------- | ------ | -------- | -------------------------------------------- |
| `claude pricing`          | 22,200 | 6        | `/blog/anthropic-claude-pricing`             |
| `claude plans`            | 9,900  | 7        | same                                         |
| `claude ai pricing`       | 8,100  | 5        | same                                         |
| `claude subscription`     | 6,600  | 4        | same                                         |
| `longmemeval leaderboard` | 5,400  | **1**    | `/blog/ai-memory-benchmarks-in-2026` (KD 22) |

**Zep's** comes from a named open-source artifact (`graphiti`, 5,400/mo) and a
model-context-window analysis post.

> Traffic comes from **named artifacts you own** and **reference/benchmark content about the
> ecosystem your buyers live in** — not product-category keywords.

**Substrate already owns an untargeted instance.** `governance-as-compression` is a
controlled three-condition benchmark — structurally the same asset as mem0's longmemeval
page, which ranks #1 at KD 22. It has no keyword target, no named result, and no benchmark
framing. Naming the result is the cheapest high-leverage change available.

---

## 6. GEO

The `claude-mem`, `obsidian mcp` and `how to build an mcp server` SERPs are dominated by
Reddit, GitHub, Medium, YouTube and DataCamp — **precisely the sources answer engines cite.**
Ranking and being cited are the same problem here.

1. **Own the comparison framing.** Being _in_ the comparison set beats ranking #1 for a
   category term.
2. **Hold entity-description consistency** across `public/llms.txt`, `public/llms-full.txt`,
   GitHub, PyPI and AlternativeTo. Already the practice.
3. **Close the two known citation-surface gaps** from the 2026-07-16 audit: PyPI project-URL
   fields, and Exomem's absence from the official MCP Registry.
4. **Give `governance-as-compression` a named, citable result.**

**Caveat:** this Semrush MCP exposes no AI-visibility report, and Traffic Analytics is not
included in the plan. GEO measurement stays manual answer-engine probes plus
`triggered_serp_features` on tracked keywords.

---

## 7. Distribution — the actual lever for summer 2026

SEO cannot move stars or users by end of summer. Two things can:

### The unposted launch

`docs/launch-submissions.md` contains Show HN / Product Hunt / Reddit copy drafted in early
July and **never posted**. It is free, takes an hour, and is the only mechanism that can
plausibly produce a four-figure star count in five weeks.

### The PR list Semrush just produced

Referring domains of Zinstall and Laplink — outlets that demonstrably cover PC-migration
software, so the pitch is warm rather than cold:

**Editorial:** pcmag (AS 80) · chip.de (80) · techtarget (77) · techradar (76) ·
arstechnica (67) · computerhope (67) · gizmodo (60) · overclockers.co.uk (60) ·
makeuseof (58) · bleepingcomputer (57) · informer (66)

**Listable directories (self-serve, do these first):** softonic (98) · uptodown (91) ·
crunchbase (72) · zoominfo (71) · g2 (67)

Softonic and Uptodown carry 290 and 696 links respectively into EaseUS alone — this category
runs on download portals. Endstate should be listed on both.

---

## 8. Measurement setup

**No Semrush project exists for substratesystems.io** — `list_projects` returns only
`phcuk.org` (ID 30022159). No Site Audit, no Position Tracking history.

Set up in the Semrush UI (the MCP `projects` toolkit is read-only):

1. Create a project for `substratesystems.io`.
2. **Position Tracking** — desktop, US. ~30 keywords from §2 and §4, plus branded controls
   (`exomem`, `endstate`, `substrate systems`).
3. **Site Audit** — weekly.
4. **Competitors:** `zinstall.com`, `laplink.com`, `mem0.ai`.

> ⚠️ **This is Olivia's subscription and it expires ~2026-07-27.** Tracked keywords consume
> her plan quota, and any project created will stop updating when access ends. Confirm with
> her first. All raw data is already preserved in the KB, so the analysis survives regardless.

---

## 9. Success criteria

At AS 2, the honest first milestone is existence, not traffic.

| Horizon     | Criterion                                            |
| ----------- | ---------------------------------------------------- |
| 1 month     | `domain_rank` returns a row at all                   |
| 3 months    | Top-100 for ≥10 tracked keywords; ≥1 page top-30     |
| 6 months    | ≥1 page top-10; referring domains ≥ 60               |
| 9–12 months | Referring domains ≥ 100 → re-evaluate KD 40–50 terms |

If the 3-month criterion misses, the constraint is authority, and effort belongs in §7.
