# Kickoff prompt for Claude Code

Paste this into Claude Code, opened at the root of the `substrate` repo (with the `exomem` repo checked out beside it if you can). Run it on **Opus at extra-high effort**: it's a large, exacting build.

Once this folder is on the branch you're working from, the short version is enough:

```text
Read docs/exomem-design/KICKOFF.md and do exactly what it says. The design system board is
docs/exomem-design/reference/boards/R40-Design-System.dc.html; the locked values are in docs/exomem-design/system/.
```

The full prompt:

```text
You're building Exomem's new web experience in this repo. The design is finished and locked after 39 review
rounds; your job is to build it faithfully, not to redesign it. Launch is about a week out.

READ FIRST, IN THIS ORDER, BEFORE WRITING ANY CODE
1. docs/exomem-design/README.md — the rules (§1), the design system (§2), every surface and state (§3),
   what the backend must provide (§4), the launch cut (§5), the QA checklist (§6), and all copy (appendices).
2. docs/exomem-design/system/components.md — every component with exact specs and states.
3. docs/exomem-design/system/tokens.css, components.css, motion.css — the locked values, in code — and the
   design system board, reference/boards/R40-Design-System.dc.html (open it in a browser), which renders them.
4. The reference boards in docs/exomem-design/reference/boards/ for whichever surface you're on, and the two
   prototypes in docs/exomem-design/reference/prototypes/ (open them in a browser; they're the behaviour spec).

NON-NEGOTIABLES
- Tokens only. No raw colours, no new colours, sizes, radii, shadows or animations. Add
  docs/exomem-design/system/check-tokens.mjs to CI; it must pass. Anything new needs the product owner's yes.
- Copy is verbatim from the boards (appendices list it). Never write "4 assistants".
- Every number is computed at render (prices, dates, time limits, counts, sizes), in the reader's time zone.
- Dark is the default; light is equally canonical; one switch, site-wide, remembered in
  localStorage "exomem-theme", applied as data-theme on <html> before first paint (no flash).
- Phone flow pages never scroll (fit 640–932 px tall screens). Amber lights only live/retrieved/current state.
- No account enumeration in any error. Reviewer sign-in stays reachable. WCAG 2.1 AA. Reduced motion = no motion.
- Never fake backend behaviour to match a design. README §4 marks each need as exists / gap / verify:
  check it against the current code (this repo and the exomem repo) before you build on it. If something is a
  gap, stop and tell the product owner what it needs and propose the smallest backend change; don't invent it silently.

HOW TO WORK
1. First, reply with a plan only: the PRs you'll open for the launch cut (README §5, step 1), in order, each
   with its scope, the files it touches, the backend it depends on (and whether that exists today), and your
   open questions. Wait for the product owner's go-ahead.
2. PR 1 is the foundation: tokens (merge system/tokens.css into the .brand-exomem scope in globals.css),
   the scrollbar on every page, the theme switch, the shared components from components.md as React
   components + CSS modules, check-tokens in CI, and migrating the raw colours it finds in src/app/exomem today.
3. Then one PR per surface, in launch-cut order: landing → sign-in / invite / reviewer → Paddle subscribe →
   add to your assistant + consent (incl. declined and kept) + handback → Home → the launch emails.
4. Each PR: walk every state the board's data-props lists; attach Playwright screenshots of desktop (1440)
   and phone (390×844), dark and light, next to the same state in the prototype; run reduced motion and an
   axe check; add tests for state logic (what shows when). Tick the README §6 checklist in the PR body.
5. Work on branches and open PRs. Never push to main. Ask before touching billing, auth or deletion code paths.

WHEN A BOARD AND THE CODE DISAGREE
Visuals and copy: the board wins. Rules and behaviour: the README wins. Real capability: the code wins, and
you tell the product owner. When unsure, ask one specific question rather than guessing.

Start now with step 1: read everything listed above and send the plan.
```

## After launch

Use the same prompt with step 3 replaced by README §5 steps 2 and 3: friend invitations, storage add-ons, email change and bring-a-vault; then the graph viewer, note reader, Why and Review. The viewer needs the graph, why, review and note-read web routes from README §4 first.
