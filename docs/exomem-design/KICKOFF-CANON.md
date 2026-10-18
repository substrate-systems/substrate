# Prompt for Claude Code

Paste this as the task, with this folder copied into `docs/exomem-design/` (it replaces the files of the same name).

---

Read `docs/exomem-design/CANON.md` first. It is the authority for the Exomem web design. For every screen and state it names one board, the exact props, and a rendered image in `docs/exomem-design/canon/`. Anything it doesn't list is history, not a spec.

Work screen by screen. Render our build in the same state, at the same size and theme as the canon image: desktop 1280 × 820 and 1440 × 900, phone 390 × 844, and flow pages also at 390 × 640 and 390 × 932. Put the two side by side and fix every difference: position, size, weight, colour, copy, line breaks, spacing and motion. "Close" is not done. The board's markup has the exact values when an image isn't enough.

Rules:
- Use the board's copy word for word.
- Don't redraw, simplify or re-seed any graph. Use `reference/engine/alive-engine.js` and the board's data.
- Flow pages are centred, and they stay vertically centred as the phone gets taller. See "Rules a drawing can't show" in CANON.md.
- Where you think the canon is wrong, or the backend can't support it, stop and ask. Don't pick a third version.

Order (the "New in rounds 49 to 57" section of CANON.md has the details):
1. Home's new layout and the map preview (`Home-Page`), at every vault size, in both themes.
2. Amber in light: gold `#A86E00` for every note, link, focus and halo (flat, 18%), on the engine graphs and on the flow pages' field; small amber text `#A06600`; no phosphor glow in light. Dark mode doesn't change.
2b. Round 53 fixes (CANON "Amber in light" and the Theme rule): hover lights notes after connecting; field notes at whole pixels (round, never oval); solid notes, never opacity; the landing's living map answers the pointer; Home's map preview keeps notes apart.
3. The theme control (`R52-Theme-Control`): Auto, Light, Dark; the button shows the theme in force and opens a three-row menu; our own glyphs; on every page, including the flow pages. The boards now carry it, so match the running board as well as the sheet.
3b. Home: the wordmark's middle row ripples once when an app recalls or saves (see CANON.md).
3c. The theme choice saved on the account and carried into emails (CANON Theme rule): this needs a backend field and both themes in the email templates (`R28-Emails`, `R41-Emails-Phone` carry the dark design with a `prefers-color-scheme` light block); a picked theme sends that scheme only.
4. The "Check your email" card (`Journey-Page`, `step: sent`), including which inbox to offer and the phone's mail-app button.
5. Flow-page vertical placement at 640, 844 and 932 px tall.
6. The map page (`Viewer`), rounds 54 to 57. Build it with Sigma.js + graphology, and treat the board as the spec, not the code:
   - Level of detail: test against the board's three vaults, `vault: few | sample | large`, and then your real vault.
   - Focus ring: at most 12 links (8 on a phone), with the "+N more links" and "Show all on the map" chips (`reference/engine/graph-layout.js` → `capRing`).
   - Hover: the stage hit-tests what is under the pointer; the rest steps back; light mode steps back further.
   - Names without folders, plus a type tag on hover.
   - Supersedes: one arrowhead into the newer note.
   - The reader: the body is the note; links, sources and history sit beside it, with the "On the map" crop at the top.
   - Back and Escape retrace steps.
   - Timeline by month, week or day (week by default).
   - Physics: ForceAtlas2 settles in about 2 s on load and runs about 1 s when notes arrive. Notes are draggable and stay where you drop them; nothing moves at rest.
   Run `reference/tools/flow-audit.js` against the board and copy its checks for the Sigma build: every line must start with OK.
7. Check the map against your real vault and the Exomem codebase: note types, statuses, link types and directions, the `## Relations` parsing, ids. Where the board's sample data and the real data disagree, the real data wins; tell me what changed.
8. Every other screen in the CANON image index, in order.

Open for a later design pass (don't invent these; ask): how "Show on the map" should give a big-picture sense of where a note sits (beyond the reader's map crop); more link language than lines and one arrowhead (direction, motion when a link is used, age); live physics tuning once Sigma is in.

When you finish, list each screen as "matches" or say what still differs and why.
