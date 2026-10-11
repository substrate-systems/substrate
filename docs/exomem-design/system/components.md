# Exomem components — the locked inventory

Every component the design uses, where its exact styles live, and its states. Build each **once** (React component + CSS module, tokens only) and use it everywhere. Values below are the locked ones; `components.css` and `motion.css` hold them verbatim from the boards, and `tokens.css` holds every colour.

**The lock, in three files and a lint:**

| File | Holds | Rule |
| --- | --- | --- |
| `tokens.css` | Every colour (dark + light), type families, radii, durations, easings, graph opacities, scrollbar, focus ring, reduced motion | The only place a raw colour may appear |
| `components.css` | Every class-based style from the four product surfaces, verbatim, colours as tokens | Port each section into its surface's CSS module; don't restyle |
| `motion.css` | All 60 keyframes, verbatim, with the timing each element uses | Use these keyframes; no new animations without the product owner's yes |
| Lint config | Fails on any raw colour in Exomem source (ESLint for TS/TSX style values, Stylelint for CSS) | Runs in CI with `npm run lint`. Migrate the raw colours in `src/app/exomem` |

When porting: Landing's `.hp` (hero panel) and Home's `.hp` (page root) are different things with the same name in the boards; rename one (e.g. `heroPanel`, `homePage`). Some rules read per-element custom properties set at runtime (`--dd`, `--nd`, `--ld`, `--wd`, `--td`, `--tw`, `--gd`, `--rd`, `--i`, `--d`, `--dl`, `--hd`, `--ed`, `--L`, `--o`, `--bass`, `--mid`, `--treb`): they are delays, lengths and audio levels computed per element; see the board's JS for how each is computed.

---

## Controls

| Component | Exact spec | States | Source |
| --- | --- | --- | --- |
| **Button · primary** | h 36 in panels, 46–48 as a page's main action, padding 0 14, r 7, fill `--fg-primary`, text `--bg-base`, Plex Mono 12 | hover: none beyond cursor; disabled: 40% + reason in label; working: label changes ("Connecting…") | `.btn.pri` (Viewer); flow/Home inline |
| **Button · secondary** | same size, transparent, border `rgba(ink,.16)` | hover border `rgba(ink,.34)` | `.btn` |
| **Button · amber** | border `rgba(amber,.55)`, text `--exo-amber` | hover fill `rgba(amber,.08)` | `.btn.amb` — only for epistemic actions (Why is this true?) |
| **Button · ghost** | no border, Plex Mono 11, `--fg-muted`, padding 2 4, r 4 | hover `--fg-primary` | `.ghost` |
| **Icon button** | 28 × 28 (36 on phone), borderless, `--fg-muted` | hover `--fg-secondary` | theme toggle, speaker `.mbtn` |
| **Zoom stack** | 32 × 32 buttons in one bordered column, r 8, ground at .82 | hover `--bg-hover` | `.zb` |
| **Filter chip** | h 30, padding 0 10, r 6, border `rgba(ink,.14)`, Plex Mono 11.5, a 22 × 6 line sample of the relation style | off: text `--fg-tertiary`, border `.06`; review chip: amber text + amber line | `.chip`, `.chip.offc`, `.chip.lensc` |
| **Type chip** (relations popover) | h 26, padding 0 8, r 5, count in `--fg-muted` | off: dashed border, struck; none in vault: 45%, inert | `.tchip` |
| **Tag chip** | Plex Mono 11, padding 3 8, r 4, border `rgba(ink,.16)`, `--fg-secondary` | `current`: amber text + amber line | `.rchip`, `.rchip.cur` |
| **Segmented switch** | 4 segments (Off / Light / Balanced / Maximal), 1 px track border, selected filled `--fg-primary` with `--bg-base` text | the description below reserves its height (min-height 38) | Home, Journey `joined` |
| **Switch** | the whole row is the control (`role="switch"`, padding 12 14, r 9, border `.10`); track 36 × 20 r 10, knob 16, 200 ms | off: track `rgba(ink,.18)`, knob `--fg-primary`; on: track `--exo-amber`, knob `--bg-base` (white in light) | Home "Grow automatically" |
| **Text field** | label Plex Mono 12 `--fg-muted` above; field h 48, padding 0 14, r 8, `--bg-panel`, border `rgba(ink,.14)`, Inter 15; amber border on focus | error: generic message, never which part failed | flow `#jp-email`, Home |
| **Address field** | text field + Copy inside right; address breaks only after `.io/` (zero-width space) | Copied ✓ for 1.6 s | flow `other`, Home add row |
| **Search** | h 36, r 8, `/` glyph, ⌘K hint; results popover with section label | focus: amber border; "NO MATCHES" | Viewer header |
| **Timeline** | play (26 round), speed (½× / 1× / 2×), 12 month ticks (h 30 desktop / 22 phone, bar 4 px: future `--bg-track`, past `--fg-tertiary`, current `--exo-amber`) | playing: ❚❚ | `.tick` |

## Containers

| Component | Exact spec | Source |
| --- | --- | --- |
| **Card** | `--bg-panel`, border `rgba(ink,.10)`, r 9, padding 12 14, gap 6 | `.card` |
| **Notice** | card + one action; trouble / storage 80% / storage full | Home |
| **Row** (list) | padding 7 0, divider `rgba(ink,.06)`, 13 px; hover tints the title amber | `.prow`, `.feed` |
| **Stat tile** | card; value Plex Mono 22 (17 phone), label 12 (10.5 phone); "to review" tile amber with amber border `.35` | Viewer overview |
| **Popover** | `--bg-raised`, border `.14`, r 10, padding 14 16, `--shadow-pop` | relations popover, music popover `.mpop` |
| **Modal** | `--bg-elevated`, r 12, scrim `--scrim`; steps ask → working → done; Esc closes | Home modals |
| **Phone sheet** | r 16 top, `--bg-elevated`, top border `.10`, handle 36 × 4 `--bg-track`; peek 188 px, open 56% of screen, `--dur-sheet` | `.sheet` |
| **Panel** (desktop viewer) | 400 wide, padding 24 26, left border `.08` | Viewer aside |
| **Reader column** | max 640, padding 44 0 90; sticky top bar 52 | Viewer reader |

## Brand and live elements

| Component | Spec | Source |
| --- | --- | --- |
| **Wordmark** | E-initial wordmark SVG, 16–17 px tall; never redrawn | flow header, emails |
| **Mark (Dot E)** | 5 × 5 dot grid, middle row amber; Home: lit row breathes (`hpBreath`, `hpEb`) | Viewer header, Home |
| **Live line** | 7 px amber dot (`vBlink` 1.6 s) + Plex Mono 11.5 line; Pause/Resume ghost; paused: grey dot, still | Viewer, Home |
| **Theme toggle** | half-moon 13 px in a 28 px button, label "Switch to light/dark mode" | every header |
| **Scrollbar** | `tokens.css` | everywhere |
| **Paired tiles** (consent) | app tile ↔ Exomem tile with a pairing line; connecting: dot travels (`jTravel`), Exomem tile border amber; connected: tile blooms (`jBloom`), tint `--exo-tint` | `.pl`, `.pd`, `.xt` |

## The graph (one language, three places)

| Element | Resting | Lit / active | Source |
| --- | --- | --- | --- |
| Note | `--fg-primary` at `--graph-node` (.24; light .3); hub .5; size 3 + 0.55 × degree, max 14 | amber, opacity 1, glow `--exo-glow`, scale 1.35–1.7 | `.gn`, `.nd` |
| Link | 1 px `--fg-primary` at `--graph-link` | amber .45–.62 | `.ge .gi`, `.ln` |
| Typed link (viewer) | supports amber 2 px; refines amber dotted (2/6); contradicts ink dashed (7/12); supersedes amber + chevron at 62%; relates plain .35 | in overview at `--graph-link-*` | `.ln.t-*`, `.ln.ov-*` |
| Signal | 5 px amber dot travelling a link (`vSig` / `jSig`, 1.4–1.5 s) | reverse with `vSigR` | `.sg`, `.gp` |
| Label | Plex Mono 11, padding 1 5, r 3, ground at .78 | focus amber; hover label floats (z 3) and moves nothing | `.lb` |
| Edge label (hover) | Plex Mono 9.5 at the link's 55% point, ground .88 | core types amber | `.el` |
| Flow hover | **glow only**: nearest note within 70 px → amber, scale 1.55, glow; its links → amber .45; notes within 120 px → .62 | 300 ms | `.gn.c0`, `.gn.c1`, `.ge.cn` |
| Landing hover | hovered note ring .7 + scale 1.3; others .42; other links .16; its links amber .6; ambient animation pauses | 350–450 ms | `.hn`, `.he` |
| Field kinds | quiet / hold / go / done / stop (see README §2.5) | — | `kindOf()` in `Journey-Page.dc.html` |

## Note reader blocks

| Block | Spec | Source |
| --- | --- | --- |
| Paragraph | Inter 16 / 1.7, `--fg-body` | `.rd p` |
| Section label | Plex Mono 13, caps, tracking .08em, `--fg-muted` | `.rd h2` |
| Wikilink | amber Plex Mono .88 em, underline `rgba(amber,.4)` offset 3, no wrap; unresolved dotted grey, inert | `.rd .wl` |
| Observation | grid 104 px category + content (stacked on phone), padding 11 14, r 8, `--bg-panel`; context line 13 `--fg-secondary`; tags Plex Mono 11 `--fg-muted`; anchor = element id | `.rd .obs` |
| Families | decision ◆ amber 2 px left rule + tint · open question ? dashed frame · constraint ⊣ grey rule · fact ■ / finding ● / pattern, method ↻ neutral · superseded ↧ muted, category struck · relational → plain | `.rd .f-*` |
| Relation row | grid 104 px type + link | `.rd .rel` |
| Source card | ↳ + name + path (mono 11) + date; opens the source | `.rd .srcc` |

## Email

One template, ten slots — README §3.4. Band palette per state: arrive (sparse, one amber light arriving), live (links amber-tinted, busy notes lit), readonly (intact, one light held), kept (intact, grey), fading (far end thinning), gone (ghost only). Light inbox: `#FAF8F4` ground, ink text, `#A86E00` amber (renderer `light()` in `R12-Lifecycle.dc.html`).

---

## A. Every animation

All from `motion.css`. Off under reduced motion.

| Keyframe | Board | Timing as used | What it is |
| --- | --- | --- | --- |
| `hpType` | Landing-Page | `hpType 6.5s steps(34) infinite` | hero question types in, holds, clears |
| `hpNode1` | Landing-Page | `hpNode1` | answer note 1 lights |
| `hpNode2` | Landing-Page | `hpNode2` | answer note 2 lights |
| `hpNode3` | Landing-Page | `hpNode3` | answer note 3 lights |
| `hpHalo` | Landing-Page | `hpHalo 6.5s ease-out infinite` | halo behind the answer |
| `hpDraw1` | Landing-Page | `hpDraw1` | answer link 1 draws |
| `hpFade2` | Landing-Page | `hpFade2` | answer label 2 fades in |
| `hpFade3` | Landing-Page | `hpFade3` | answer label 3 |
| `hpDraw4` | Landing-Page | `hpDraw4` | answer link 4 draws |
| `hpFade4` | Landing-Page | `hpFade4` | answer label 4 |
| `hpDraw5` | Landing-Page | `hpDraw5` | strike-through draws over the superseded note |
| `hpRow1` | Landing-Page | `hpRow1` | answer row 1 rises in |
| `hpRow2` | Landing-Page | `hpRow2` | answer row 2 |
| `hpRow3` | Landing-Page | `hpRow3` | answer row 3 |
| `hpDrift` | Landing-Page | `(name set per element)` | hero web drifts slowly |
| `ptRun` | Landing-Page | `ptRun var(--d,4s) cubic-bezier(.45,0,.55,1) var(--dl,0s) infinite` | a light runs along one link (pillars, map) |
| `ppIn` | Landing-Page | `ppIn var(--d,4.2s) ease-out var(--dl,0s) infinite` | the receiving note answers with a soft pulse |
| `brBreath` | Landing-Page | `brBreath 6s ease-in-out infinite` | the living map hub breathes |
| `mzMarch` | Landing-Page | `mzMarch 6s linear infinite` | dashed supersession line marches |
| `hpTypeM` | Landing-Page | `hpTypeM 6.5s steps(21) infinite` | phone hero question typing |
| `jWork` | Journey-Page | `jWork 1.4s cubic-bezier(.45,0,.55,1) infinite` | working dots |
| `jTwinkle` | Journey-Page | `jTwinkle var(--td) ease-in-out var(--tw) infinite` | background stars twinkle |
| `jWake` | Journey-Page | `jWake 1.6s cubic-bezier(.2,.7,.2,1) var(--wd) both` | stars wake when connected |
| `jLine` | Journey-Page | `jLine 1.8s ease-in-out var(--ld) infinite` | connecting lines sweep |
| `jGrow` | Journey-Page | `jGrow 1.6s cubic-bezier(.3,0,.2,1) both` | web grows a new link |
| `jDraw` | Journey-Page | `jDraw 1.05s cubic-bezier(.3,0,.2,1) var(--dd) both` | links draw in while connecting |
| `jGlow` | Journey-Page | `jGlow 1.4s ease-out var(--dd) both` | existing links glow while connecting |
| `jLive` | Journey-Page | `jLive 2.6s ease-out both` | links settle lit after connecting |
| `jSig` | Journey-Page | `jSig 1.5s cubic-bezier(.45,0,.55,1) both` | a signal travels a link once connected |
| `jRest` | Journey-Page | `(name set per element)` | note rests |
| `jHit` | Journey-Page | `jHit 1s ease-out var(--nd) both` | note is hit while connecting |
| `jNodeRest` | Journey-Page | `jNodeRest 2.6s ease-out both` | notes settle after connecting |
| `jHubIn` | Journey-Page | `jHubIn 1.4s ease-out both,jHub 2.8s ease-in-out 1.4s infinite alternate` | hub lights in |
| `jHub` | Journey-Page | `jHubIn 1.4s ease-out both,jHub 2.8s ease-in-out 1.4s infinite alternate` | hub breathes |
| `jTravel` | Journey-Page | `jTravel 1.1s cubic-bezier(.65,0,.35,1) infinite` | pairing dot travels between the two tiles |
| `jBloom` | Journey-Page | `jBloom 1.1s ease-out both` | Exomem tile blooms on connect |
| `jBreath` | Journey-Page | `jBreath 3.2s ease-in-out infinite` | mark row breathes |
| `jWave` | Journey-Page | `jWave 1.1s ease-in-out infinite` | mark dots wave while connecting |
| `jSweep` | Journey-Page | `jSweep 1.1s ease-in-out infinite` | mark sweeps while connecting |
| `jIgnite` | Journey-Page | `jIgnite .7s ease-out both` | mark ignites on connect |
| `jSettle` | Journey-Page | `jSettle .9s cubic-bezier(.16,1,.3,1) both` | mark settles |
| `jIn` | Journey-Page | `jIn .6s cubic-bezier(.16,1,.3,1) both` | content fades up in |
| `hPull` | Journey-Page | `hPull 1.1s cubic-bezier(.45,0,.2,1) infinite` | held line pulls while connecting |
| `hIn` | Journey-Page | `hIn .8s cubic-bezier(.34,1.5,.64,1) both` | held line snaps in on connect |
| `cGlint` | Journey-Page | `cGlint 5s ease-in-out var(--gd) infinite` | a glint crosses the Cut E facets (consent) |
| `cGlint2` | Journey-Page | `cGlint2 1.1s ease-in-out var(--gd) infinite` | fast glint while connecting |
| `cLit` | Journey-Page | `cLit .7s ease-out var(--gd) both` | every facet lights on connect |
| `jpBlink` | Journey-Page | `jpBlink 1.4s ease-in-out infinite` | waiting dot blinks |
| `hpPack` | Home-Page | `hpPack 1.2s ease-in-out infinite` | export packing pulse |
| `hpBreath` | Home-Page | `hpBreath 3.4s ease-in-out var(--hd) infinite` | Home mark lit row breathes |
| `hpEb` | Home-Page | `hpEb 5.5s ease-in-out var(--ed) infinite` | Home mark slow breath |
| `hpLv` | Home-Page | `hpLv 2.4s ease-in-out infinite` | live line dot |
| `hpIn` | Home-Page | `hpIn .5s ease both` | live line text fades in |
| `vPulse` | Viewer | `vPulse 3s ease-in-out infinite` | focused note pulses |
| `vDrift` | Viewer | `vDrift var(--dd) ease-in-out infinite alternate` | notes drift 1.4 px |
| `vSig` | Viewer | `vSig 1.4s cubic-bezier(.4,0,.2,1) both` | signal along a link |
| `vSigR` | Viewer | `vSigR` | signal, reversed direction |
| `vFade` | Viewer | `vFade .25s ease both` | edge labels fade in |
| `vIn` | Viewer | `vIn .2s ease both` | popover drops in |
| `vBlink` | Viewer | `vBlink 1.6s ease-in-out infinite` | live dot blinks |

## B. Inline component styles as built

The boards set most layout inline. These are the distinct inline styles on buttons and inputs, normalised to tokens (`…` = a value computed per state). Collapse them into the components above; anything not covered is a bug in the port, not a new variant.

**Landing-Page · `<button>`** (most used first)

- ×3 `height: 52px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-family: 'IBM Plex Mono', monospace; font-size: 14.5px; font-weight: 500; background: …; color: …; border: 0; cursor: pointer; width: 100%;`
- ×3 `height: 34px; padding: 0 14px; border-radius: 17px; border: 1px solid rgba(…,.18); background: rgba(…,.9); color: …; font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; cursor: pointer`
- ×2 `width: 28px; height: 28px; border-radius: 14px; border: 0; background: transparent; color: …; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; padding: 0; flex: none`
- ×2 `display: inline-block; background: …; color: …; font-family: 'IBM Plex Mono', monospace; font-size: 14px; font-weight: 500; padding: 13px 20px; border-radius: 8px; border: 0; cursor: pointer`
- ×1 `color: …; border: 0; background: transparent; cursor: pointer`
- ×1 `font-family: 'IBM Plex Mono', monospace; font-size: 13.5px; font-weight: 500; padding: 13px 20px; border-radius: 8px; background: …; color: …; border: 0; cursor: pointer;`
- ×1 `font-family: 'IBM Plex Mono', monospace; font-size: 13.5px; padding: 13px 18px; border-radius: 8px; border: 1px solid rgba(…,.16); color: …; display: flex; justify-content: space-between; align-items: center; gap: 14px; cursor: pointer; text-align: left; display: inline-flex; background: transparent;`
- ×1 `border-radius: 8px; background: …; border: 1px solid rgba(…,.07); padding: 14px 16px; font-family: 'IBM Plex Mono', monospace; font-size: 13px; display: flex; justify-content: space-between; align-items: center; gap: 14px; cursor: pointer; text-align: left; width: 100%; color: …;`
- ×1 `font-family: 'IBM Plex Mono', monospace; font-size: 13.5px; font-weight: 500; padding: 12px 18px; border-radius: 8px; background: …; color: …; border: 0; cursor: pointer;`
- ×1 `font-family: 'IBM Plex Mono', monospace; font-size: 13px; color: …; padding: 12px 8px; border: 0; background: transparent; cursor: pointer`
- ×1 `border-radius: 8px; background: …; border: 1px solid rgba(…,.07); padding: 12px 14px; font-family: 'IBM Plex Mono', monospace; font-size: 13px; display: flex; justify-content: space-between; align-items: center; gap: 14px; cursor: pointer; text-align: left; width: 100%; color: …;`

**Journey-Page · `<button>`** (most used first)

- ×3 `min-height: 44px; padding: 0 16px; border: 1px dashed …; border-radius: 8px; background: transparent; color: …; font-family: 'IBM Plex Mono', monospace; font-size: 12.5px; cursor: pointer`
- ×1 `order: 9; min-height: 40px; padding: 0 14px; border: 1px dashed …; border-radius: 8px; background: transparent; color: …; font-family: 'IBM Plex Mono', monospace; font-size: 12px; cursor: pointer`
- ×1 `height: 40px; min-width: 84px; padding: 0 14px; border: 0; border-radius: 7px; background: …; color: …; font-family: 'IBM Plex Mono', monospace; font-size: 13px; font-weight: 500; cursor: pointer; flex: none`
- ×1 `flex: 1; min-height: 38px; border: 0; border-radius: 6px; background: …; color: …; font-family: 'IBM Plex Mono', monospace; font-size: 12.5px; cursor: pointer`
- ×1 `height: 40px; min-width: 112px; padding: 0 14px; border: 1px solid …; border-radius: 8px; background: transparent; color: …; font-family: 'IBM Plex Mono', monospace; font-size: 12.5px; cursor: pointer; flex: none`
- ×1 `width: 100%; min-height: 72px; box-sizing: border-box; display: flex; align-items: center; gap: 14px; padding: 14px 16px; border-radius: 10px; border: 1px solid …; background: …; color: …; cursor: pointer; text-align: left`
- ×1 `width: 100%; height: 48px; border: 0; border-radius: 8px; background: …; color: …; opacity: …; font-family: 'IBM Plex Mono', monospace; font-size: 14px; font-weight: 500; cursor: pointer`
- ×1 `min-height: 44px; padding: 0 16px; border: 0; background: transparent; color: …; font-family: 'IBM Plex Mono', monospace; font-size: 13px; cursor: pointer`
- ×1 `border: 0; background: transparent; padding: 0; color: …; font: inherit; text-decoration: underline; cursor: pointer`
- ×1 `min-height: 32px; border: 0; background: transparent; padding: 0; font-family: Inter, system-ui, sans-serif; font-size: 12px; color: …; text-decoration: underline; cursor: pointer`
- ×1 `margin-top: auto; height: 46px; border-radius: 6px; border: 0; background: …; color: …; font-family: Inter, system-ui, sans-serif; font-size: 14px; font-weight: 500; cursor: pointer`

**Home-Page · `<button>`** (most used first)

- ×10 `min-height: 36px; min-width: 112px; padding: 0 14px; border: 1px solid …; border-radius: 6px; background: transparent; color: …; font-family: 'IBM Plex Mono', monospace; font-size: 12px; cursor: pointer; flex: none`
- ×9 `height: 46px; border: 0; border-radius: 8px; background: …; color: …; font-family: 'IBM Plex Mono', monospace; font-size: 13.5px; font-weight: 500; cursor: pointer`
- ×6 `flex: 1; min-height: 36px; border: 0; border-radius: 6px; background: …; color: …; font-family: 'IBM Plex Mono', monospace; font-size: 12px; cursor: pointer`
- ×6 `height: 40px; border: 0; background: transparent; color: …; font-family: 'IBM Plex Mono', monospace; font-size: 13px; cursor: pointer`
- ×4 `height: 32px; min-width: 76px; padding: 0 12px; border: 0; border-radius: 6px; background: …; color: …; font-family: 'IBM Plex Mono', monospace; font-size: 12px; cursor: pointer; flex: none`
- ×3 `height: 44px; border: 1px solid rgba(…,0.16); border-radius: 8px; background: transparent; color: …; font-family: 'IBM Plex Mono', monospace; font-size: 13px; cursor: pointer`
- ×2 `border: 0; background: transparent; padding: 0; color: …; font: inherit; cursor: pointer`
- ×2 `width: 28px; height: 28px; border-radius: 14px; border: 0; background: transparent; color: …; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; padding: 0`
- ×2 `border: 0; background: transparent; padding: 0; color: …; font: inherit; text-decoration: underline; cursor: pointer`
- ×2 `min-height: 44px; padding: 0 14px; border: 0; border-radius: 6px; background: …; color: …; font-family: 'IBM Plex Mono', monospace; font-size: 12.5px; font-weight: 500; cursor: pointer`
- ×2 `min-height: 44px; padding: 0 12px; border: 1px solid …; border-radius: 6px; background: transparent; color: …; font-family: 'IBM Plex Mono', monospace; font-size: 12px; cursor: pointer; min-width: 112px; text-align: center; flex: none`
- ×2 `min-height: 44px; padding: 0 12px; border: 0; border-radius: 6px; background: …; color: …; font-family: 'IBM Plex Mono', monospace; font-size: 12px; cursor: pointer; min-width: 112px; text-align: center; flex: none`

**Viewer · `<button>`** (most used first)

- ×3 `text-align: left`
- ×2 `color: var(--fg-muted)`
- ×2 `color: …`
- ×2 `height: 30px`
- ×2 `margin-left: auto`
- ×2 `padding: 2px 0`
- ×2 `color: var(--fg-primary); text-decoration: underline`
- ×2 `margin-left: auto; padding: 6px 4px`
- ×2 `padding: 6px 8px`
- ×2 `height: 42px`
- ×2 `padding: 8px 0`
- ×1 `flex: none`

**Viewer · `<input>`** (most used first)

- ×1 `flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--fg-primary); font: 13.5px Inter, system-ui, sans-serif`
- ×1 `flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--fg-primary); font: 15px Inter, system-ui, sans-serif`

