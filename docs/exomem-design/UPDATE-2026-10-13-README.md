# Exomem design update · 13 Oct 2026 (rounds 41–47)

Everything decided since the first handoff (substrate repo, `docs/exomem-design/`, commit `d15b099`), plus the brand assets as first-class files. Read `UPDATE-2026-10-13.md` first.
These files preserve the design reference. OpenSpec records the product requirements; product components own the deployed implementation.

Public examples use fictional release notes. Original review screenshots remain in the private design archive; public boards retain their review descriptions.

| Path | What it is |
|---|---|
| `UPDATE-2026-10-13.md` | The implementation guide: every change, the states, the copy, what the backend must provide, QA. |
| `KICKOFF-UPDATE.md` | The prompt that starts the build of this update in Codex or Claude Code. |
| `brand/exomem-brand-kit/` | **The brand.** Mark, wordmark (the logo), lockups, favicons and app icons, OG image, email bands, the living mark in React. SVG originals plus PNG renders. Rules in its README. |
| `brand/_archive/` | The first kit (10 Oct), kept unchanged. Never delete it. |
| `reference/boards/` | The design sources (`.dc.html`) for every surface and round 41–47 board, plus `canvas.json` (pages and positions). Copy wording from these. |
| `reference/prototypes/` | Open in Chrome: `exomem-landing.html` (the whole site and flow), `exomem-checkout.html` (the subscribe step with buttons for the rare cases), `exomem-viewer.html`, `exomem-alive.html` (the motion directions). |
| `reference/engine/` | `alive-engine.js`, the motion engine every graph uses, and `ENGINE.md`. |
| `system/` | The locked system as of 11 Oct, unchanged, plus `CHANGES-R41-R43.md`: the approved changes as exact CSS. |
| `design-system/` | **The component library**: tokens, brand book, the React bundle (`Mark`, `Wordmark`, `AliveGraph`, `Progress`, `Button`, `TextField`, transitions…) with sources and previews. The live version is the Design System artifact linked in its README. |
| `reference/status/` | The status page reference, Upptime config and theme. Free, off our servers. |
| `reference/paddle/` | The brief for the agent that styles Paddle's checkout in Paddle's dashboard. |
| `reference/tools/dcrt.js` | The small runtime the prototypes use to render boards (for reference). |

## Where this goes

1. **Google Drive:** `Exomem / Design / exomem-design-update-2026-10-13` (the whole folder) and `Exomem / Brand / exomem-brand-kit` (the kit, with `_archive`).
2. **Substrate repo** (ask the operator before pushing): merge into `docs/exomem-design/` (`BRIEF.md` as `UPDATE-2026-10-13.md`, boards into `reference/boards/`, prototypes into `reference/prototypes/`, `system/CHANGES-R41-R43.md` beside the system files, `engine/` as `reference/engine/`), and the kit into `docs/exomem-design/brand/`. The files the site serves go to `public/exomem/`.
3. Keep this zip as it is, too. It is the record of the design on 13 Oct.
