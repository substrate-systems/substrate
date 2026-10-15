# Kickoff: build the 13–14 Oct design update (rounds 41–47)

Paste into Codex or Claude Code at the root of the substrate repo, with this folder unzipped somewhere it can read. Use the strongest model at high effort.

```text
You're continuing the build of Exomem's web experience. The first design handoff is in docs/exomem-design/
(its KICKOFF.md and README.md still apply). the operator has approved more design since: it's in the folder
exomem-design-update-2026-10-13/. Build it faithfully; don't redesign.

READ FIRST, IN THIS ORDER
1. exomem-design-update-2026-10-13/README.md, then BRIEF.md (all of it).
2. system/CHANGES-R41-R43.md: the approved design-system changes as exact CSS. BRIEF §6b and §6c
   add what rounds 44–47 decided on top of it.
3. design-system/README.md and BRAND-BOOK.md: the component library (tokens, Mark, Wordmark, the writing E,
   AliveGraph, Progress, fields, buttons, and the transitions Swap / Crossfade / Collapse). Build the product's
   components from design-system/components/src/, not by re-deriving them from the boards.
4. engine/ENGINE.md and engine/alive-engine.js: the motion engine every graph uses.
5. The boards named in each BRIEF section, the review boards R45-Review, R46-Review and R47-Review (each lists
   what changed and where to look), and the prototypes (open them in Chrome).
6. the operator's taste log if your Exomem MCP is connected: "the approved design reference for settled preferences and decisions".

FIRST TASKS, BEFORE ANY UI
- Store the brand kit and this folder as README "Where this goes" says. Ask the operator before pushing to the repo.
- Check every row of BRIEF §9 against the code (this repo and the exomem repo): exists, gap, or verify.
  Report it, with the smallest backend change for each gap. That includes the three health endpoints
  the status page needs (status/STATUS-PAGE.md).

THEN
1. Reply with a plan only: the PRs, in order, each with its scope, files, backend dependency and open
   questions. Wait for the operator's go-ahead.
2. Suggested order: system changes (CHANGES §1–6, BRIEF §6b–6c: selection colours, solid notes) and the
   engine → the component library in the product → the subscribe step (BRIEF §4) → start-page and connect
   flow (§6, §6c) → Home and viewer cases → accessibility (§7) → the status page (status/).
3. Each PR: every state in the board's data-props, desktop 1440 and phone 390×844, dark and light, Playwright
   screenshots beside the board, reduced motion, forced colours, an axe run, tests for the state logic.
4. Paddle's dashboard styling is a separate task: follow paddle/exomem-paddle-styling-brief.md, in the operator's
   browser, after he signs in.

NON-NEGOTIABLES (in addition to the first KICKOFF's)
- Every number from its source at run time (Paddle for prices and tax, the server for counts and dates).
- Amber only for what is live or current. No account enumeration. No browser validation bubbles.
- Never fake backend behaviour to match a board. Work on branches; never push to main.
- No state change flashes: use the library's transitions; the writing E shows progress for any step count.
- Copy never explains how Exomem works inside; it says what is true for the person and what they can do.
```
