# Button

Buttons in mono: primary once per view for the thing the page is for; the label cross-fades while working.

**You provide** `variant` (`primary`, `secondary` default, `amber` only for epistemic actions like "Why is this true?", `ghost`), `size` (`panel` 36 px, `page` 46 px for a page's main action), `working` with `workingLabel` ("Connecting…"), and the usual button props.

**Rules.** Verb first, sentence case. Disabled is 40% and the reason is in the label or next to it. Keyboard focus is a solid amber ring with a soft outer ring (`exo-focus-ring`); forced colours draw the edge.
