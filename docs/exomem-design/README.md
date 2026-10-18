# Exomem — design handoff

> **Start with [`CANON.md`](CANON.md).** It names the one board, props and image that are canonical for every screen and state, and it wins over anything below.

**Status:** design locked 12 Oct 2026 after 38 review rounds. This folder is everything needed to build it: the rules, the design system, every surface and state, the copy, and what the backend must provide.
**Product:** Exomem, an epistemic knowledge base served over MCP, plus Exomem Cloud. By Substrate Systems.
**Positioning:** "Grows with you. Stays true." Exomem is *an epistemic knowledge base*: one memory for every assistant and every session a person connects. Never write a fixed number of assistants ("4 assistants" is banned).

> If anything here disagrees with the reference boards, the boards win for visuals and copy, this README wins for rules and behaviour. If anything disagrees with the code's real capabilities, stop and ask the product owner; do not invent backend behaviour to match a picture.

---

## 0. How to use this folder

| Path | What it is |
| --- | --- |
| `README.md` | This file. Rules, system, surfaces, contracts, QA. |
| `KICKOFF.md` | The prompt that starts the build in Claude Code. |
| `system/tokens.css` | **Every colour** (dark + light), type families, radii, durations, easings, graph opacities, the scrollbar, focus ring, reduced motion. Extends `.brand-exomem` in `src/app/globals.css`. |
| `system/components.css` | Every class-based component style from the four product surfaces, verbatim from the boards, colours as tokens. Generated. |
| `system/motion.css` | All 60 animations, verbatim, with the timing each element uses. Generated. |
| `system/components.md` | The component inventory: exact specs and states for every control, container, brand element, graph element, reader block; every animation; the inline styles as built. |
| Lint config (`npm run lint`) | Fails on any raw colour in Exomem source. Added with the foundation build. |
| `reference/prototypes/exomem-flow-prototype.html` | The clickable prototype: landing → start with your email → inbox → invitation → Paddle → connect → Home → graph viewer → back. Has a Desktop/Phone switch and pills to jump between flows. Open in Chrome. |
| `reference/prototypes/exomem-viewer-prototype.html` | The graph viewer on its own (narrow window = phone layout). |
| `reference/boards/*.dc.html` | The design sources. Each is an HTML template plus a `renderVals()` JavaScript class. **Copy wording verbatim from these**; the JS shows every state and how numbers are computed. |

How to read a `.dc.html`: markup inside `<x-dc>` uses `{{ holes }}`, `<sc-for list=… as=…>` (loops) and `<sc-if value=…>` (conditionals). The `<script data-dc-script>` holds `data-props` (every prop, its options and default — i.e. every state the surface has) and a class whose `renderVals()` returns the values for the holes. Copy lives in that class (e.g. `copy()` in `Journey-Page.dc.html`).

| Board | Surface |
| --- | --- |
| `Landing-Page.dc.html` | The landing, with the whole flow embedded (views: page, journey, email, home, graph). Theme toggle, palettes. |
| `R19-Landing.dc.html`, `R20-Mobile.dc.html` | Landing sections at desktop and 390 px phone; the hero graph, pillars, living map. |
| `Journey-Page.dc.html` | Every step of sign-in, invitation, subscribe, connect, consent, errors (≈30 steps). The field animation and hover. |
| `Home-Page.dc.html` | Home (the control plane): every state and modal. |
| `Viewer.dc.html` | The graph viewer and note reader, desktop and phone. |
| `R28-Emails.dc.html`, `R12-Lifecycle.dc.html` | The one email template, its slots, the six state bands, all emails 01–19. |
| `R30-Screens.dc.html` | Gallery of every new state (invitations, reviewer, any MCP app, breaks, Home states and flows, light). |
| `R36-Viewer.dc.html` | Gallery of every viewer state. |
| `R37-Hover.dc.html` | Flow-page hover: **C, glow only, is chosen.** |
| `R15-Scrollbar.dc.html` | The scrollbar, live. |
| `R40-Design-System.dc.html` | **The design system as one board**: every colour, type style, space, component, graph element, reader block and animation, dark and light side by side, rendered from `system/tokens.css`. Start here for any visual question. |


---

## 1. Rules that override everything

These came out of review. Breaking one is a bug, not a style choice.

1. **Amber lights only live, retrieved or current state.** Never decoration, never a brand flourish. (Phosphor `#FFB000` dark, deep `#A86E00` light.)
2. **The site follows the device's colour scheme until the person picks one; dark and light are equally canonical.** One subtle switch, site-wide (landing, flow, Home, viewer), remembered in `localStorage["exomem-theme"]`, applied as `data-theme` on `<html>` before first paint. Dark applies when the device says nothing. Emails use the scheme the person had on the site, and dark when that is unknown.
3. **Model every state.** Every button does something real. No dead buttons (e.g. "Not now" on the consent page leads to a modelled *declined* state).
4. **Phone flow pages never scroll.** Each step fits one screen (layouts compute against the real screen height, 640–932 px). Home and the reader may scroll.
5. **Every number is computed at render** — prices, dates, time limits, counts, sizes. Never hard-code "in 24 hours"; compute "kept 24 h, until 13 Oct, 14:20" in the reader's time zone.
6. **Simple copy (Simplified Technical English spirit):** short sentences, plain words, no jargon, no exclamation marks. Headlines name the state, not the action.
7. **No account enumeration.** Sign-in, invitation and reviewer errors never reveal whether an email or account exists.
8. **Reviewer sign-in stays reachable** (app-directory reviewers use a username `exr_…` and password).
9. **Illustrations scale with their container** (width 100%, height auto). Never fixed pixel widths.
10. **Motion is quiet.** Ambient effects are slow and dim; nothing jitters, wobbles or slides into another element's place. All of it off under `prefers-reduced-motion`.
11. **Never advise deleting** to free storage. Offer more storage.
12. **Aligned or not at all.** Columns line up (fixed label columns on desktop; stacked on phone). Misalignment reads as not premium.
13. **WCAG 2.1 AA** contrast, focus, targets (≥ 40 px on phone), labels.
14. **Distribution is the plugin route.** The Claude connector covers Claude, Claude Code, Claude Desktop and Cowork; one OpenAI plugin covers ChatGPT and Codex. Any other MCP client connects with `https://substratesystems.io/api/exomem/mcp/v1`.
15. Sender is always `exomem@substratesystems.io`. The site lives at `substratesystems.io/exomem`.

---

## 2. Design system (locked)

Exomem is a sibling brand inside the Substrate system: it inherits Substrate's restraint and motion philosophy (`DESIGN_SYSTEM.md`) and overrides type, palette and accent within `.brand-exomem`.

**The system is locked in code, not just described.** `system/tokens.css` holds every colour used anywhere in the design (each one in the boards maps to a token; near-duplicates were merged), `system/components.css` and `system/motion.css` hold every component style and animation verbatim, `system/components.md` is the inventory with exact specs and states, and the raw-colour lint fails the build on any raw colour. Adding a token, a component variant or an animation needs the product owner's yes. The tables below summarise; the files are the source of truth.

**From the foundation build on, code is the source:** `src/app/exomem/exomem-tokens.css` and the component modules in `src/components/exomem/`. This `system/` folder is the frozen handoff snapshot; change the code, not these files.

### 2.1 Colour

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--bg-base` | `#0A0908` | `#FAF8F4` | Page |
| `--bg-panel` | `#100E0C` | `#FFFFFF` | Cards, panels, inputs |
| `--bg-raised` | `#12100E` | `#FFFFFF` | Popovers, search results, flow panel |
| `--bg-elevated` | `#14120F` | `#FFFFFF` | Sheets, modals, email card |
| `--bg-hover` | `#1A1815` | `#EFEBE3` | Hover/pressed fills |
| `--bg-track` | `#2A2724` | `#E5E0D6` | Tracks, timeline, sheet handle |
| `--fg-primary` | `#ECE9E2` | `#1A1814` | Headings, primary |
| `--fg-body` | `#C9C5BC` | `#3D3A34` | Long reading text |
| `--fg-secondary` | `#A39E93` | `#6B665C` | Body, descriptions |
| `--fg-muted` | `#858075` | `#7A756B` | Labels, metadata |
| `--fg-tertiary` | `#5C574D` | `#B5AFA3` | Faint labels, disabled |
| `--exo-amber` | `#FFB000` | `#A86E00` | Live / current only |

**Decision, 2026-10-12, approved by the product owner (AA text):** light `--fg-muted` is `#736E64` (was `#7A756B`); a new `--exo-amber-text` (dark `#FFB000`, light `#A06600`) colours amber text, and `--exo-amber` stays for lines, dots, fills and the focus ring; switched-off filter chips use `--fg-muted`, and `--fg-tertiary` is for disabled controls and non-text marks only. The table above keeps the handoff values; the code holds the current ones. On the same day, the owner moved light `--exo-amber-text` from `#9A6500` to `#A06600`. It is the smallest step from `--exo-amber` that reaches 4.5:1 on `--bg-base`, so amber text keeps the colour of amber fills.

Borders are ink at low alpha: rule `.07`, card `.10`, input/chip `.14`, a field straight on a flow page `.22`, hover `.34`. Amber line `.5` for "current" chips and amber buttons. Landing-only extra grounds (hero bands, footer) are in `Landing-Page.dc.html` (`PAL`).

### 2.2 Type

Two families, two weights (400, 500). Never bold.

| Role | Family | Size / line | Notes |
| --- | --- | --- | --- |
| Display (landing hero, board titles) | IBM Plex Mono 500 | 40–56, tracking −0.02em | |
| Page title (flow step, reader H1) | Plex Mono 500 | 26 desktop / 21–24 phone | |
| Panel title | Plex Mono 500 | 17–19 | |
| Section label | Plex Mono 400 | 11, tracking .1–.14em, UPPERCASE | `--fg-muted` |
| Metadata, chips, buttons | Plex Mono 400 | 11–12.5 | |
| Reading body (reader) | Inter 400 | 16 / 1.7 | `--fg-body` |
| Body | Inter 400 | 13.5–15 / 1.55 | `--fg-secondary` |
| Email body | Inter | 15 / 1.6 | |

The wordmark is the **E-initial wordmark** (the dotted E plus "xomem"); the icon is the **Dot E**. Never redraw either: use the SVGs in the boards (`Journey-Page.dc.html` header, `Viewer.dc.html` header).

### 2.3 Space, radii, elevation

Spacing steps: 4, 6, 8, 12, 16, 24, 32, 48, 64. Radii: tags 4, controls 7, cards 9, popovers 10, phone sheet 16. One shadow, for popovers/sheets only (`--shadow-pop`). Focus ring: 2 px amber, offset 2 (the existing rule in `globals.css` is 1 px at 65%; the design uses 2 px — update it). Desktop content widths: Home column 640, reader 640, viewer panel 400; the flow panel width comes from `dims()` in `Journey-Page.dc.html`.

### 2.4 Motion

| Token | Value | Use |
| --- | --- | --- |
| `--dur-hover` | 150 ms | Hover colour |
| `--dur-state` | 300 ms | Opacity/colour state changes, glow on/off |
| `--dur-move` | 600 ms, `--ease-settle` | Camera and layout moves |
| `--dur-sheet` | 350 ms | Phone sheet |

Ambient effects (all optional, all dim, all off under reduced motion): the flow field's walking light; a light running along one link at a time on the landing pillars and living map (cycle 7–15 s, opacity ≤ .6); the Home mark's lit row breathing; the viewer's live dot. **Hover on the flow pages is glow only** (the closest note lights amber, its links warm to .45, notes within 120 px wake to .62 opacity; nothing moves). Landing graphs: hovered node gets a ring, others dim to .42, its edges turn amber.

### 2.5 Components

Build these once and use them everywhere. Full specs, states and sources: `system/components.md`.

| Component | Anatomy and states |
| --- | --- |
| **Button / primary** | Fill `--fg-primary`, text `--bg-base`, Plex Mono 12, h 36–44, r 7. Disabled = 40% opacity with the reason in text ("Send another link in 0:42"). |
| **Button / secondary** | Transparent, border input, hover border strong. |
| **Button / amber** | Border amber line, text amber, hover amber 8% fill. Only for epistemic actions ("Why is this true?"). |
| **Button / ghost** | Text only, `--fg-muted` → `--fg-primary` on hover. Back links, "Copy path", "Pause". |
| **Filter chip** | h 30, border input, line sample + label. Off: muted text, faint border. `aria-pressed`. |
| **Tag chip** | Plex Mono 11, r 4, border input. Status variant "current": amber text + amber line. |
| **Segmented switch** (levels Off/Light/Balanced/Maximal) | Track with 1 px border; selected segment filled `--fg-primary`. Description underneath reserves its height so nothing jumps. |
| **Switch** ("Grow automatically") | A switch, not a checkbox; no black borders. |
| **Field** | h 44, `--bg-panel`, border input; amber border on focus. A field straight on a flow page takes `--bg-raised` and the `.22` field border (R47 flow). Address field has Copy inside, right. The MCP address breaks only after `.io/`. |
| **Card / notice** | `--bg-panel`, border card, r 9, padding 12–16. Notices (trouble, storage 80%/full) carry one action. |
| **Modal** | Centered, `--bg-elevated`, r 12, scrim. Steps inside (ask → working → done); Esc closes. |
| **Popover** | `--bg-raised`, border input, r 10, shadow. |
| **Phone sheet** | Bottom sheet, r 16 top, handle 36×4. Two heights: peek (≈188 px) and open (≈56% of screen); content scrolls only when open. |
| **Theme toggle** | 28 px borderless half-moon icon, `--fg-muted`, label "Switch to light/dark mode". |
| **Live line** | Blinking amber dot + one mono line ("Claude Code recalled 4 notes · 12 s ago"); pausable in the viewer. |
| **Scrollbar** | `system/tokens.css`. Everywhere, including the page itself. Chip rows hide theirs. |
| **Field (graph background)** | The living web behind flow pages. Kinds: *quiet* (before anything connects: a light walks, nothing grows), *hold* (paying/confirming: still), *go* (connecting: links draw in), *done* (connected: amber settles), *stop* (ended/error: grey). See `kindOf()` in `Journey-Page.dc.html`. |
| **Email** | One template, ten slots (§3.4). |

---

## 3. Surfaces

### 3.1 Landing (`substratesystems.io/exomem`)

Source: `Landing-Page.dc.html`, `R19-Landing.dc.html`, `R20-Mobile.dc.html`. Sections in order: hero (living graph that answers a question; 4 answer labels on phone, tap any node for its name), proof, "Stays true" pillars, the viewer preview, doors (Claude / ChatGPT / any MCP app), Cloud, stays-yours, footer. Header: wordmark, nav links that smooth-scroll, theme toggle, Sign in. Plain graph links are visible at `.22` opacity even when scaled down. Primary CTA: "Start with your email".

### 3.2 Start, sign-in and consent (`/exomem/sign-in`, `/exomem/invite`, `/exomem/setup`, `/exomem/authorize`)

Source: `Journey-Page.dc.html` (prop `step` lists every state; prop `app` is `web` when the person started on our site, or the app that opened the page: `Claude`, `ChatGPT`, `Claude Code`). The full copy per step is in **Appendix A**.

Paths:

- **From the web:** start with your email → check your email → (subscribe → Paddle → confirming) → add to your assistant (Claude / ChatGPT / another app) → finish in that app → connected, with level instructions for apps without the plugin → Home.
- **From an app (OAuth):** sign in → consent ("Connect Claude to your memory": scopes, signed in as …) → connecting → handback ("Taking you back to Claude…"; Claude Code: "Back to your terminal").
  - *Not now* → **declined**: "Claude isn't connected. Nothing was shared. We told Claude you said no." + Connect after all. The app receives `access_denied`.
  - Already connected → "Connect again" or *Keep it as it is* → **kept**.
- **Invitations:** friend (friend price shown, struck usual price, duration note "for as long as you stay subscribed"), covered (no checkout), already has Exomem (apply the friend price to the existing plan), invalid/used (names no one).
- **Reviewer:** username + password, one generic error, sample account.
- **Breaks:** connect error (our fault, nothing changed, Try again + status page), ended, paused, suspended, expired, read-only.

The Paddle overlay is themed and shows "Friend price from Alex · applied". Phone: no scrolling; every step fits.

### 3.3 Home (`/exomem/home`) — the control plane

Source: `Home-Page.dc.html` (props list every state: `account` owner/reviewer, `fresh`, `connected`, `trouble`, `storageUsedGb`, `exportState`, `openModal`…). Simple, short, alive but not busy.

- **Header:** wordmark · *Home* · *Your graph* (→ viewer) · theme toggle · email · Sign out.
- **Status:** "Your memory is on"; a live line ("Waiting for the first note from Claude" on a new account, then a cycling "Claude Code recalled 4 notes · 12 s ago"). The mark's lit row breathes.
- **Notices** (only when true): trouble; storage at 80% or full (action: Add storage). First-note card for new accounts.
- **Connected apps:** one row per app (Disconnect); then one quiet row "Add another app — Claude, ChatGPT, or any app that supports MCP · Set up", which opens: directory hint (Claude/ChatGPT, only if not connected), step 1 the address with Copy, step 2 level switch + "Level instructions · N characters" with Copy and "Read the full text".
- **How much Exomem joins in:** two compact rows, *Chat apps* (default **Maximal**) and *Coding agents* (default **Balanced**): words left, segmented switch right. Note: "Your assistant can change these too." Level descriptions in Appendix C; instruction blocks are copied verbatim per level from the exomem repo `docs/prominence.md`. Plugins carry skills, so plugin users need no instructions.
- **Plan and account:** plan (friend price shown when present), next payment, Manage billing (Paddle); storage bar "2 of 5 GB" + Add storage; email + Change…
- **Your data:** Export (none / packing / ready "kept 24 h, until …" / failed / expired; download links are fresh and short-lived; "Restore this export…"), Bring a vault, Delete (hidden for reviewers).
- **Modals:** More storage (+10 / +50 / +100 GB packs via Paddle, "Grow automatically" switch, done); Bring a vault (drop zone; folder, zip, Markdown files, Obsidian vault, PDFs; checking → summary → running → done; an Exomem export restores as is); Restore; Change email (with the lost-inbox note); Billing; Delete; Signed out.
- **Reviewer Home:** sample notes, access end date, no billing, no delete.

### 3.4 Emails

Source: `R28-Emails.dc.html` (template and catalogue), `R12-Lifecycle.dc.html` (`email()` renderer). **One `email()` template, ten slots:**

1. Sender and subject — "Exomem", or "Alex via Exomem" when a person sent it; subject ≤ 45 characters.
2. Preheader — the one fact that matters next.
3. State band — the web in the account's state: *arrive, live, readonly, kept, fading, gone*. Production: 1200 × 240 PNG, empty alt.
4. Wordmark — 16 px, never the icon alone.
5. Headline — Plex Mono 24, ≤ 6 words, names the state.
6. Body — Inter 15/1.6, one or two short paragraphs.
7. A note *or* facts — never both. A note is a person's own words with their name; facts are label/value rows.
8. One action — one button, at most one text link.
9. Small print — every time limit, computed at send, in the reader's time zone; say what happens if ignored.
10. Footer — "Exomem by Substrate Systems". Service emails, no unsubscribe.

Each email follows the person's theme choice (see CANON.md, Theme): on Auto it is built on the scheme the site showed, or dark when that is unknown, and the other scheme applies through `prefers-color-scheme` in mail apps that report one; on a picked Light or Dark it is sent in that scheme only. Inviters get exactly two emails: used (12) and ended unused (13). Full catalogue: **Appendix B**.

### 3.5 Graph viewer (new route, e.g. `/exomem/graph`)

Source: `Viewer.dc.html`, gallery `R36-Viewer.dc.html`. Entered from Home's header (*Your graph*); "Home" goes back; the theme carries across. Built on Shneiderman's mantra: **overview first, zoom and filter, then details on demand**, plus history and easy reversal.

- **Overview:** the whole vault. Lines carry their type: supports (amber, 2 px in focus), refines (dotted amber), contradicts (dashed ink), supersedes (amber with arrow), relates to (plain); the other 28 built-in relations and any custom ones draw plain. Cluster labels (domains) are clickable and zoom to the cluster.
- **Zoom and pan:** wheel / pinch, drag; + / − / "Show everything". Range ≈ 0.3× to 7× of fit. **While gesturing, move one layer with a transform and redraw once on release.** More notes name themselves as you zoom in (busiest first, never overlapping).
- **Filter:** five core chips in the header; "+30" opens every relation with its count in this vault, tap to show/hide everywhere; "Show all", "Only the five"; a "Your own" group for custom relations.
- **Hover (desktop):** the note's name and link count float above everything; each of its links names its relation along the line; neighbours brighten slightly. Hover must move nothing else.
- **Details:** click a note: the camera moves to it, its links gather in a ring labelled by type; panel shows status, summary, supersession, sources, links, "Read the whole note →". Click the focused note (or its *read* tag) to open the reader. Back walks your trail.
- **Why is this true?:** the trail lights up (sources and supporting notes, signal flowing toward the note); panel gives a short answer built only from those notes, the trail list, and any open disagreement with "Review the two side by side". Footer: "From your notes only."
- **Review disagreements:** header chip "19 to review". Shows pair A/B with dates, sources and each note's claim; camera zooms to the pair. Choices: *B holds · it supersedes A*, *A holds · it supersedes B*, *Both hold, in different situations*, *Not a disagreement*, *Ask me in a week*. Every choice has Undo. Exomem never picks a side.
- **Live:** "Claude Code is recalling 3 notes" — recalled notes light, the line lights; Pause/Resume.
- **Time:** play the vault growing, quarter-month steps (seamless), speed ½× / 1× / 2×; month ticks are clickable.
- **Listening (opt-in):** speaker icon → microphone or a song file; bass breathes the hubs, highs shimmer the lines, beats send a light down a link. Nothing recorded or sent. Hosted iframes may block the microphone.
- **Phone:** the map turns on its side to fill the screen; header = mark, search, theme, Home; filters scroll sideways underneath; details rise in the sheet (peek, then open); pinch and drag.
- **Stability rule:** keep one DOM element per note, per link and per label in a fixed order (or use a WebGL renderer). Nothing may slide into another element's place when hover, live events or playback change.
- **Production renderer:** Sigma.js (WebGL, on graphology) is the recommended renderer for real vaults; it is fully stylable (node/edge reducers, custom programs, label and hover renderers). Keep the look above.

### 3.6 Note reader

Source: `Viewer.dc.html` (mode `read`). Opens from the viewer; full screen on phone. It renders **Exomem's real note format** with a component per block:

| Note markup | Component |
| --- | --- |
| frontmatter `type`, `status`, tags | Tag chips; "current" in amber; created / edited / last edited by line |
| lead paragraph, `##` sections | Reading text (Inter 16/1.7); section labels in mono caps |
| `[[path]]` wikilinks | Amber mono link, follows to that note in the reader (unresolved: dotted, inert) |
| `- [category] content #tags (context) ^anchor` | Observation card: fixed 104 px category column (stacked on phone), content, context line, tags in mono; anchor becomes the element id |
| category families | `decision` ◆ amber left rule and tint · `open question` ? dashed frame · `constraint` ⊣ grey rule · `fact` ■ / `finding` ● / `pattern`, `method` ↻ neutral · `superseded` ↧ muted, category struck · relational (`used by`, `explains`) → plain |
| `## Relations` with `- type [[target]]` | Two-column list, type in mono |
| sources | Citation cards: name, path, date; open the source note |

Beside it (desktop) or below it (phone): **Around this note** — links grouped by type, sources, history (created, supersedes, edited N times · last by, recalled by). Top bar: ← map, ‹ previous note, the path, Copy path, Why is this true?

---

## 4. What the backend must provide

Status is from the repos as of 12 Oct 2026 (`substrate` 544a7ef, `exomem` b2999e4). **Verify each before building on it.**

| Need | For | Status |
| --- | --- | --- |
| Email magic-link sign-in, reviewer credentials (`exr_…`, ≤ 90 days) | 3.2 | Exists |
| OAuth consent + `access_denied` on Not now | 3.2 | Consent exists; confirm the denied redirect |
| Paddle checkout, billing portal, grace/read-only/ended states | 3.2, 3.3 | Exists |
| Invitations: email-bound, single use, sign the person in, 30 days, 7-day hold after accepting unpaid | 3.2 | Operator invites exist (≤ 30 days); verify self-serve and the hold |
| **Friend price as a Paddle discount**, lasting while subscribed; apply to an existing plan; returns on resubscribe | 3.2 | **Gap** (no discount code found) |
| **Storage add-ons** (+10/50/100 GB) and Grow automatically; code limit today 5 GB | 3.3 | **Gap** |
| **Email change** (confirm new, notify old, stop the change) | 3.3 | **Gap** |
| Export: packing → ready, kept `EXOMEM_EXPORT_TTL_HOURS` (default 24 h), fresh short-lived download links | 3.3 | Exists; check link freshness |
| Restore from an Exomem export | 3.3 | Exists |
| **Vault import** (folder, zip, Markdown, Obsidian, PDFs) | 3.3 | `cloud_import.py` imports tar archives safely; client-side packaging of folders/zips/files and PDF handling to confirm |
| Involvement level per context, readable and settable by the assistant | 3.3 | Home has the picker (`assistant-instructions.ts`); **hosted plugin profiles don't expose `configure_memory` yet** |
| **Graph API** for the viewer: notes (id, path, kind, status, created), typed edges (incl. custom), hubs/domains, counts; paged or tiled for large vaults | 3.5 | Typed epistemic graph sidecar exists in exomem; **no web endpoint** |
| Live activity stream (recall/save events per app) | 3.3, 3.5 | **Gap** for the web (call ledger exists server-side) |
| Why: answer + citations for a note | 3.5 | `ask_memory` / `read_memory`; needs a web route |
| Review queue and decisions (supersede either way, dismiss `intentional:` / `false_positive:`, snooze) with undo | 3.5 | `review_memory(mode="attention")`, `triage_memory`, supersede exist; needs a web route |
| Note read (raw Markdown + frontmatter + history) | 3.6 | `read_memory(include_raw, include_history)`; needs a web route |
| All 19 emails with computed time limits | 3.4 | Some exist; build the template once and port each |

---

## 5. Launch cut

Launch is targeted for about a week out. Ship in this order; the rest is designed and waits.

1. **Launch (must):** tokens + components + scrollbar + theme switch + the raw-colour lint in CI (migrate the raw colours in `src/app/exomem` today); landing; start with your email + sign-in + reviewer; Paddle subscribe; add to your assistant + consent (incl. declined/kept) + handback; Home (apps, levels, plan, export, delete); emails 01, 01w, 03, 04, 05, 06, 07, 08.
2. **Next:** friend invitations + emails 09–13, 18; storage add-ons + 14, 15, 19; email change + 16/16b; bring a vault + 17.
3. **Then:** graph viewer (overview, zoom/filter, details, reader), then Why and Review, then phone viewer polish, then listening.

---

## 6. QA checklist

- [ ] Every surface in dark **and** light; theme survives navigation and reload; no flash on load.
- [ ] Phone (390 × 844 and 375 × 667): flow pages never scroll; targets ≥ 40 px; Home/reader scroll with the Exomem scrollbar.
- [ ] Every numbered value computed (prices, dates, limits, counts); no hard-coded durations in copy.
- [ ] Sign-in, invite, reviewer errors leak nothing about accounts.
- [ ] Every button reaches a modelled state (walk Appendix A).
- [ ] `prefers-reduced-motion`: no animation, no transitions, the page still reads.
- [ ] Contrast AA in both themes (amber `#A86E00` on paper, not `#FFB000`).
- [ ] Keyboard: visible amber focus ring; modals trap focus and close on Esc; viewer chips/buttons reachable.
- [ ] Viewer: hover, live events and playback move nothing but their own element; pan/zoom smooth at 60 fps on a mid laptop.
- [ ] Copy matches the boards word for word; no "4 assistants"; sender and URLs as in §1.
- [ ] The raw-colour lint passes; no animation outside `system/motion.css`.

---

## Appendix A — start, sign-in and consent copy

Generated from `Journey-Page.dc.html` → `copy()`. "web" = started on our site; "app" = opened by an assistant (shown for Claude; Claude Code differs only where noted in the source). `—` = no button. Dates, prices and codes shown (e.g. “until 10 November”, EX-7Q4M) are examples; the real ones are computed when the page renders. When started on the web, the app name is the one the person picked.

| Step | When | Context | Title — lede | Buttons |
| --- | --- | --- | --- | --- |
| `signedout` | first screen | web | **Start with your email** — New or returning, it’s the same step. No password. | Email me a link |
| `signedout` | first screen | app | **Connect Claude to your memory** — Sign in with your email. You’ll come straight back here. | Email me a sign-in link |
| `invite` | friend invitation opened | web | **Alex invited you to Exomem** — A knowledge base that every assistant you use shares. It keeps where each thing came from, and what changed. | Accept invitation |
| `accepting` | accepting, account being made | web | **Setting up your Exomem** — A few seconds. Then add it to your assistant. | — |
| `invitebad` | invitation expired or used | web | **This invitation can’t be used** — It has expired, or it was already used. Ask the person who invited you for a new one, or start with your email. | Start with your email |
| `inviteexisting` | invitee already has Exomem | web | **You already have Exomem** — Alex’s invitation can’t start a second one, but Alex’s friend price can go on the plan you have. It starts with your next payment. | Use Alex’s friend price / Keep my plan as it is |
| `inviteapplied` | friend price applied to their plan | web | **Friend price added** — Alex’s friend price starts with your next payment. Paddle sends the new amount on your receipt. <br>_friend price · from your next payment_ | Go to Home |
| `invitekept` | they kept their plan | web | **Nothing changed** — Your plan stays as it is. The invitation is used up, so nobody else can use it. | Go to Home |
| `connecterror` | our side failed | web | **That didn’t finish** — Exomem had a problem on our side while connecting your assistant. Nothing changed. Try again in a minute. <br>Notice: If it keeps happening, our status page says what we know. | Try again / Status page ↗ |
| `connecterror` | our side failed | app | **That didn’t finish** — Exomem had a problem on our side while connecting Claude. Nothing changed. Try again in a minute. <br>Notice: If it keeps happening, our status page says what we know. | Try again / Status page ↗ |
| `reviewer` | app-directory reviewer sign-in | web | **Sign in as a reviewer** — For app directory reviewers. Use the username and password from our submission notes. | Sign in as reviewer / Back to email sign-in |
| `reviewer` | app-directory reviewer sign-in | app | **Sign in as a reviewer** — For app directory reviewers. Use the username and password from our submission notes. | Sign in as reviewer / Back to email sign-in |
| `reviewerfail` | wrong reviewer credentials | web | **Sign in as a reviewer** — For app directory reviewers. Use the username and password from our submission notes. <br>Notice: That didn’t work. Check the username and password. | Sign in as reviewer / Back to email sign-in |
| `reviewerfail` | wrong reviewer credentials | app | **Sign in as a reviewer** — For app directory reviewers. Use the username and password from our submission notes. <br>Notice: That didn’t work. Check the username and password. If this page is older than 10 minutes, start again from Claude. | Sign in as reviewer / Back to email sign-in |
| `sent` | link sent (resend countdown) | web | **Check your email** — We sent you a link. Open it to continue. You can close this tab. | Send another link / Use a different email |
| `subscribe` | signed in, not subscribed | web | **Subscribe to finish setting up** — Paddle shows the price at checkout. Then add it to your assistant. | Subscribe / Not now |
| `paying` | Paddle overlay open | web | **Subscribe to finish setting up** — Paddle shows the price at checkout. Then add it to your assistant. | Subscribe |
| `confirming` | waiting for Paddle webhook | web | **Confirming your payment** — A few seconds. Then add it to your assistant. | — |
| `choose` | pick an assistant | web | **Add Exomem to your assistant** — Your Exomem is ready. Pick where you’ll use it first; you can add more any time. | — |
| `waiting` | finishing inside the app | web | **Finish in Claude** — In Claude, open Settings, then Connectors. Find Exomem and press Connect. Claude then opens a page here to confirm. | Open Claude ↗ / Pick another app |
| `other` | any other MCP app | web | **Add Exomem to your app** — Paste this address into the app’s connector or MCP settings. The app then opens a page here to confirm. | Pick another app |
| `joined` | the app connected | web | **Claude is connected.** — Try it: ask it to remember something today, then ask again tomorrow. <br>_Claude · memory on_ | Go to Home / Add ChatGPT too |
| `connect` | consent | app | **Connect Claude to your memory** — Everything you’ve kept, available in every session. | Connect / Not now |
| `preparing` | consent while the cell is starting | app | **Connect Claude to your memory** — Everything you’ve kept, available in every session. <br>Notice: Your Exomem is still starting. Connect now: its tools start working within a few minutes, and we’ll email you when it’s ready. | Connect / Not now |
| `readonly` | consent while payment failed | app | **Connect Claude to your memory** — You can still connect. It recalls but doesn’t save until billing is fixed. <br>Notice: Your last payment failed. Exomem is read-only while Paddle retries, until 25 October; after that the subscription ends. | Connect / Fix billing |
| `ended` | subscription ended | web | **Your subscription has ended** — Your memory is read-only and kept until 10 November. Export it any time before then, or resubscribe to connect your assistant. | Resubscribe / Export your memory |
| `ended` | subscription ended | app | **Your subscription has ended** — Your memory is read-only and kept until 10 November. Export it any time before then, or resubscribe to connect Claude. | Resubscribe / Export your memory |
| `paused` | subscription paused | web | **Your subscription is paused** — Your memory is kept and readable. Resume it to connect your assistant. | Resume subscription / Export your memory |
| `paused` | subscription paused | app | **Your subscription is paused** — Your memory is kept and readable. Resume it to connect Claude. | Resume subscription / Export your memory |
| `suspended` | account suspended | web | **This Exomem is suspended** — It can’t connect to your assistant while it’s suspended. Your memory is safe, and you can still export it. <br>Notice: Write to support and quote EX-7Q4M. We’ll tell you why it was suspended and what happens next. | Contact support / Export your memory |
| `suspended` | account suspended | app | **This Exomem is suspended** — It can’t connect to Claude while it’s suspended. Your memory is safe, and you can still export it. <br>Notice: Write to support and quote EX-7Q4M. We’ll tell you why it was suspended and what happens next. | Contact support / Export your memory |
| `expired` | OAuth request expired | app | **This request has expired** — Connection requests last 10 minutes. Start again from Claude, and it will bring you back here. | — |
| `connecting` | after Connect | app | **Connect Claude to your memory** — Everything you’ve kept, available in every session. | Connecting… |
| `handback` | connected, returning to the app | app | **Connected.** — Taking you back to Claude… <br>_If nothing happens, return to Claude. It’s connected._ | — |
| `declined` | Not now from inside an app | app | **Claude isn’t connected** — Nothing was shared. We told Claude you said no. You can close this tab. | Connect after all |
| `kept` | Keep it as it is | app | **Nothing changed** — Claude keeps the connection it has. You can close this tab. <br>_Claude · still connected_ | — |

## Appendix B — email catalogue

Generated from `R28-Emails.dc.html`. Band = the state band in slot 3.

| # | Subject | Sent when | Band | Action |
| --- | --- | --- | --- | --- |
| 01 | Sign in to Exomem | a sign-in link is asked for | arrive | Sign in |
| 01w | Start your Exomem | “Start with your email” on the web | arrive | Start Exomem |
| 02 | You’re invited to Exomem | we invite someone (alpha) | arrive | Accept invitation |
| 03 | Your Exomem is ready | the cell finishes starting | live | Open Home |
| 04 | Your payment didn’t go through | Paddle reports a failed payment | readonly | Fix billing |
| 05 | Your Exomem subscription has ended | grace ends, or a cancel takes effect | kept | Export |
| 06 | 7 days until your Exomem is deleted | a week before deletion | fading | Export |
| 07 | Your Exomem has been deleted | deletion completes | gone | — |
| 08 | Your Exomem export is ready | an export finishes (kept EXOMEM_EXPORT_TTL_HOURS h) | live | Download export |
| 09 | Alex invited you to Exomem | a friend invitation with a friend price | arrive | Accept invitation |
| 10 | Alex is covering your Exomem | a complimentary invitation | arrive | Accept invitation |
| 11 | Alex’s invitation ends on … | three days before an unused invitation ends | fading | Accept invitation |
| 12 | Maria accepted your invitation | to you, the inviter, when it is used | live | — |
| 13 | Your invitation to Maria ended | to you, the inviter, if it is never used | kept | — |
| 14 | Your Exomem is 80% full | storage reaches 80%, once | readonly | Add storage |
| 15 | Your Exomem is full | storage is full | readonly | Add storage |
| 19 | More storage added | storage is added, by hand or automatically | live | Open Home |
| 16 | Confirm your new email | an email change, to the new address | arrive | Confirm this address |
| 16b | Your Exomem email is changing | an email change, to the old address | kept | Stop the change |
| 17 | Your vault is in Exomem | a vault import finishes | live | Open Home |
| 18 | Finish setting up your Exomem | accepted, not paid; 2 days before the 7-day hold ends | arrive | Finish setting up |

## Appendix C — involvement levels

| Level | What it does | Default for |
| --- | --- | --- |
| Off | Exomem stays connected but waits. It searches or saves only when you ask it to. |  |
| Light | Searches when you ask, or when the topic is clearly its. Saves only when you ask. |  |
| Balanced | Searches when the topic matches. Saves conclusions. Stays quiet. | coding agents |
| Maximal | Searches before every real question. Saves every step forward, and says so. | chat apps |

The instruction block for each level is copied verbatim from the exomem repo, `docs/prominence.md`, and shown with its character count. Plugins carry skills, so plugin users need no instructions.
