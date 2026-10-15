# AliveGraph

The graph behind every Exomem surface: ink pulses walk the links at rest, and amber lights only when something really happened.

**You provide** `nodes` (`[x, y, r]`) and `edges` (`[i, j]`) in `viewBox` units, a unique `id`, and `state`: `live` (default), `still`, or `cut` (can't reach Exomem: links fade, hover stops, nothing moves).

**Events.** Call `fireAlive(id, { kind: 'recall' | 'save' | 'connect' })` when one happens, always with words on the page. While a payment or import runs: `fireAlive(id, { kind: 'work', on: true, amber: true, toward: '<selector of the thing working>' })`, then `{ kind: 'work', on: false }`. `clear: '<selector>'` keeps events off notes under your text.

**Rules it keeps.** Ambient motion is ink, never amber. Links stop at a note's edge. In light, moving ink matches dark mode's contrast, not its opacity. Reduced motion: nothing travels; events light their notes in place. The engine (`alive-engine.js`) is inside the bundle and attaches itself.
