Exomem is one knowledge base for every assistant you connect. The brand is a dark, quiet instrument: warm black, ink, and one phosphor amber that lights only what is live. Build every surface from these tokens and components; the boards in the design handoff are the reference for layouts.

## The one hard rule

Amber (`exo-amber`) lights only what is live, retrieved or current: a note an assistant just recalled, the step happening now, keyboard focus, the current chip. Never decoration, never a brand flourish, never a constant glow. When nothing is live, nothing is amber, and the logo's middle row is the only amber on the page.

## Content fundamentals

- **Plain and short.** Say what is happening in the person's terms: "Your bank approves", "Paid. Switching on your Exomem." Sentence case everywhere, including buttons and titles.
- **Never leak how we work inside.** No reasoning, no system terms, no "we know where it went". Copy says what is true for the person and what they can do.
- **You and we.** "You" is the person; "we" is Exomem. Assistants are named ("Claude", "ChatGPT"), never counted: never write how many assistants Exomem works with. Say "every assistant you connect".
- **Numbers are computed at render.** Prices, VAT, dates, counts and percentages come from the live source (Paddle, the vault) through `Intl`; nothing is typed into copy. Whole prices drop ".00" in sentences and the hero (`€15`); ledger rows keep two decimals.
- **Errors say what to do**, under about 45 characters, in the field's own line. Never say whether an account exists.
- **Trouble says what still works first**: "Recall works, and nothing is lost."
- No exclamation marks, no emoji. Glyphs that carry meaning: ✓ (done), → (next), › (more), ▾ (choose), · (separator), – (a list dash).

## Colour

- Ground: `bg-base`. Panels and cards: `bg-panel` with a 1 px `exo-border-card`. Popovers: `bg-raised` with `shadow-pop`. Sheets and modals: `bg-elevated` over `scrim`.
- Text: headings and primary text `fg-primary`; long reading `fg-body`; descriptions `fg-secondary`; labels and metadata `fg-muted`; placeholders and hint lines `fg-placeholder`. `fg-tertiary` is for disabled and off states only, never for anything that must be read.
- Small amber text uses `exo-amber-text` (it passes AA in light); `exo-amber` itself is for dots, rings and text 24 px and up in light.
- Lines: `exo-rule` between rows and sections, `exo-border-input` on controls at rest, `exo-border-strong` on hover.
- The site follows the device's colour scheme until the person picks one, and dark applies when the device says nothing; light is equally canonical (`data-theme="light"` on `<html>`). In light, `exo-phosphor` (the bright amber) appears only as the halo around a lit note or a lit E.
- Selected text uses `selection-bg` under `selection-fg` (ink) in both themes; never the browser's blue. A selection is current, so it may be amber.
- Two token notes are flagged where a locked value misses AA: `fg-muted` on `bg-base` in light (4.3:1) and `fg-footer` (3.5–3.7:1). Changing them is the operator's call; until then follow their notes.

## Type

- Two families: `mono` (IBM Plex Mono 400/500) for headings, labels, buttons, numbers and anything the system says; `sans` (Inter 400/500) for sentences people read. Both load from Google Fonts.
- Page heading: `page-title` (28 px, 22 on phone). A state's title: `block-title`. The one big price: `price-hero`. Text: `body`, `small`, `reading` in the note reader. Labels: `label` above fields; `caps` for uppercase kickers; `meta` for live lines and chips.
- Numbers are tabular (`font-variant-numeric: tabular-nums`) wherever they change.

## Shape and layout

- Radii: `r-tag` tags, `r-ctl` buttons and chips, `r-field` fields, `r-card` cards and notices, `r-pop` popovers and the E tile, `r-sheet` phone sheets.
- Borders, not shadows: cards and panels carry `exo-border-card` and no shadow. `shadow-pop` is only for things that float.
- Controls: 36 px in panels, 46–48 px for a page's main action; fields 48 px. Phone: 16 px side gutter, everything one column, 360 px wide and up.
- The checkout and the start pages centre one panel (max 940 px) under a centred heading; Home and the viewer are full-width tools.

## The graph

Every surface has the same graph behind it (`AliveGraph`). Notes are `fg-primary` at `graph-node`, links at `graph-link`; busy notes at `graph-hub`. At rest, ink pulses walk the links: the system is on. Amber appears only for an event that really happened (a recall, a save, a connection, a payment landing), always paired with words on the page. While something works, pulses run faster and flow toward it. When Exomem can't be reached, the graph is cut: links fade, hover stops, nothing moves.

## Motion and states

- **Nothing flashes.** A state change is a movement: text cross-fades (`Swap`), panes cross-fade in one place (`Crossfade`), messages open to their height (`Collapse`), new content fades up (`FadeIn`). Layout never jumps: a panel keeps the height of its tallest state.
- **The writing E** (`Mark`, `Wordmark`, `Progress`) shows progress for any number of steps. The dots are ordered the way a pen draws the letter; each step owns a stretch of the stroke (up to five steps end on the letter's corners, more split it evenly); the step running now has a wave travelling along it. No count: the pen runs the whole stroke. A percentage: the stroke fills to it. Done: the whole E lights and a seal ripples along it once. Failure: the stroke runs backwards, then the logo rests. Off: no amber.
- **How states connect.** Every state is a target, never a sequence to replay: from whatever the E is doing, it moves to the new state. Rest → working: the frame dims and the comet starts. Working or a step → next step: what is written stays, the pen moves on. Any → done: the rest of the stroke writes itself, then one seal. Done → rest: everything written dissolves together while the frame returns. Progress → failed: the stroke runs backwards, then rest. Any → off: amber fades to ink. The Mark card's panel lets you try every pair.
- Timing: `dur-hover` for hover, `dur-state` for colour and glow, `dur-swap` for cross-fades, `dur-write` for the E, `dur-move` for layout and camera; `ease-out-expo` for entrances, `ease-settle` for moves.
- **Reduced motion:** every ambient and transition effect is off. States still read through colour and shape.

## Focus, fields and validation

- Keyboard focus: a solid `exo-amber` ring 2 px outside the control, with a soft `exo-focus-ring` beyond it; a transparent outline underneath so forced colours draw it. Mouse clicks show no ring.
- Fields: `exo-field-bg`, 1 px `exo-border-input`, `r-field`, amber caret. A field or address box straight on a flow page takes `bg-raised` and `exo-border-field`. Focus: amber border and the soft ring. Error: an ink border and the message in `fg-primary` in the line under the field. No red, no icons; amber always means focus.
- Forms use `novalidate`. Judge a field when the person leaves it; once it shows an error, re-check on every keystroke; on submit, focus the first error and clear nothing. Mark the rare optional field "(optional)"; no asterisks.
- Forced colours: buttons and fields get system-colour borders. The graph may drop out; that's fine.

## Iconography

- The Dot E is the only brand symbol. Use the `Mark` and `Wordmark` components in product UI and the files under Logos and Mark elsewhere; never redraw, outline, or put the mark beside the wordmark.
- There is no icon font. UI glyphs are the few typographic ones listed under Content; the theme toggle is a 13 px half-moon. App and browser icons are under Icons, always on the dark tile.
- Provider logos (Paddle, Claude, ChatGPT and others) are never redrawn or embedded; name them in text.

## Using the components

Load React 18, then `components/bundle.js` and `components/bundle.css` after the tokens; everything is on `window.Exomem` (`Exomem.Mark`, `Exomem.Progress`, `Exomem.fireAlive`, …). Each component's card says what it takes. The essentials:

```jsx
<Exomem.Wordmark height={17} state={reachable ? 'rest' : 'off'} />
<Exomem.Progress steps={['Sent to Paddle', 'Your bank approves', 'Paid', 'Switching on your Exomem']} step={i} doneLabel="Paid. Your Exomem is ready." />
<Exomem.Crossfade show={paid ? 'paid' : 'form'} panes={{ form: <PaddleFrame />, paid: <Paid /> }} />
<Exomem.TextField label="New email" validate={checkEmail} checkSignal={submits} />
```
