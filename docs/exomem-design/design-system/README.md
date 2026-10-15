# Exomem Design System (component library)

The live library is the **Exomem Design System** artifact on claude.ai ([local component previews](components/)): the brand book, every token in dark and light, the brand assets, and 15 components with live previews. This folder is the same content as files, so a build agent can use it without opening the page.

| Path | What |
|---|---|
| `BRAND-BOOK.md` | Usage rules: amber, copy, colour, type, shape, the graph, motion and states, focus and validation, iconography. |
| `tokens.json` | Every token: colours (dark, light), type styles, radii, shadow, graph opacities, durations, easings. Matches `system/tokens.css` plus the R42 field tokens and three additions (`exo-amber-text`, `exo-phosphor`, `r-field`, `dur-swap`, `dur-write`, `we-faint`), all from approved values. |
| `components/bundle.js`, `bundle.css`, `index.d.ts` | The React 18 library as one script (`window.Exomem`) and its styles. Load React, then the tokens, `bundle.css`, `bundle.js`. |
| `components/src/` | Sources (`index.tsx`, `geometry.ts`, CSS, the alive engine) and `build.mjs` (esbuild). In the product, import from `src/` instead of the bundle. |
| `components/<Name>/README.md`, `preview.html` | What each component takes, its rules, and a live example. |
| `assets/<Group>/README.md` | What each brand file is for and its inks. The files themselves are in `../brand/exomem-brand-kit/`. |

Components: `Mark`, `Wordmark` (every state, including the writing E), `AliveGraph` + `fireAlive`, `Progress`, `LiveLine`, `Steps`, `Notice`, `Button`, `TextField`, `Switch`, and the transitions `Swap`, `Crossfade`, `Collapse`, `FadeIn`, `Skeleton`.

To change the system: edit it on the artifact page (tokens, notes) or ask Claude to revise it there; regenerate this folder from it. New tokens go to the operator as proposals.
