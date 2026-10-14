# Design system changes, rounds 41–43

The files beside this one (`tokens.css`, `components.css`, `motion.css`, `components.md`) are the system as locked on 11–12 Oct. These are the changes the operator approved after that, as exact CSS. Apply them to the product styles and the maintained ESLint and Stylelint rules in the foundation PR. Nothing else changes.

## 1. Light mode: lit notes at full strength, with a phosphor halo (round 41)

Bug: `components.css` line 201, `.t-light .gn {opacity:.3}`, also dims the lit note (`.gn.c0`, `.gn.on`), so light mode looked beige. Add after it:

```css
.t-light .gn.c0, .t-light .gn.on { opacity: 1; box-shadow: 0 0 9px 1px rgba(255, 176, 0, .5); }
.t-light .ge.cn .gi, .t-light .ge.on .gi { opacity: .85; }
```

The deep amber `#A86E00` stays the light amber (it always was). The bright `#FFB000` appears in light only as the halo around a lit note. Links stop at a note's edge in both themes.

## 2. Fields (round 42, proposal approved)

New tokens (dark / light):

```css
--exo-field-bg: #0C0A09;            /* light: #FAF8F4 */
--exo-focus-ring: rgba(255,176,0,.20);   /* light: rgba(255,176,0,.30) */
--fg-placeholder: #858075;          /* light: #757068 (the old #8A857B was 3.46:1, below 4.5) */
```

Text field (sizes unchanged: label Plex Mono 12 above, field h 48, padding 0 14, r 8, Inter 15):

```css
.field { background: var(--exo-field-bg); border: 1px solid var(--exo-border-input); caret-color: var(--exo-amber); }
.field::placeholder { color: var(--fg-placeholder); }
.field:hover { border-color: var(--exo-border-strong); }
.field:focus { outline: 2px solid transparent; border-color: var(--exo-amber); box-shadow: 0 0 0 3px var(--exo-focus-ring); }
.field[aria-invalid="true"] { border-color: var(--fg-primary); box-shadow: 0 0 0 .5px var(--fg-primary); }
.field-line { min-height: 18px; font-size: 12.5px; line-height: 18px; color: var(--fg-placeholder); }   /* hint and error share it */
.field-line.is-error { color: var(--fg-primary); }   /* no icon, no red, no amber: amber is focus */
```

A read-only, prefilled field shows its value in `--fg-muted` on a transparent fill, with a real `Change` button inside it on the right (underlined text button, focusable).

Keyboard focus for buttons and links:

```css
.brand-exomem button:focus-visible, .brand-exomem a:focus-visible {
  outline: 2px solid transparent; outline-offset: 2px;   /* forced colours paints this one */
  box-shadow: 0 0 0 2px var(--bg-panel), 0 0 0 4px var(--exo-amber), 0 0 0 7px var(--exo-focus-ring);
}
```

## 3. Validation (round 42)

Our forms use `novalidate`; the browser never shows its bubbles.

1. Judge a field when the person leaves it or presses the button, never while they type it for the first time.
2. Once a field has shown an error, re-check it on every keystroke, so the error goes the moment it's fixed.
3. On the button, check everything and move focus to the first field with an error. Clear nothing they typed.
4. Server errors (a wrong password) land on the field they belong to, in the same style. Never say whether an account exists.
5. Messages say what to do, under about 45 characters, in the field's line.
6. Mark the rare optional field "(optional)". No asterisks.
7. `aria-invalid`, `aria-describedby` to the line, and the line is a polite live region.

Reference: `boards/Fields-Demo.dc.html` (working) and `boards/R42-Inputs-Focus.dc.html`.

## 4. Forced colours (round 43)

```css
@media (forced-colors: active) {
  .brand-exomem button, .brand-exomem [role=button] { border: 1px solid ButtonText !important; }
  .brand-exomem input { border: 1px solid FieldText !important; }
}
```

The graph is decoration and may drop out in forced colours. That's fine.

## 5. Motion in light mode (round 42)

Moving ink in light mode matches dark mode's contrast, not its opacity. The engine does this (`par()` in `engine/alive-engine.js`). For CSS-driven walkers held dim (the start-page field during checkout), use `.3` in dark and `.38` in light for nodes, `.07` and `.085` for links.

## 6. The scrollbar

Unchanged, but it must be on every scroller, including the checkout page (where the page itself scrolls, field included) and every popover.

## 7. The checkout E (superseded in round 44 by the writing E: see BRIEF §6b)

`boards/Checkout-Inline.dc.html` has the exact CSS. While paying, the E beside the price lights row by row in amber (`ckScan`, 1.6 s loop, 0.12 s between rows). When paid, each row sweeps to full amber in about 0.6 s and stays (`ckRow`). In light, the lit E gets the phosphor halo (`drop-shadow(0 0 2.5px rgba(255,176,0,.6))`).
