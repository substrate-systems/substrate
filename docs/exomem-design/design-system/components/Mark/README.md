# Mark

The Dot E, alive: the logo at rest, and a meter that writes itself while something is in progress.

**Use it** wherever the icon appears alone: app tiles, the checkout summary tile, status lines, the connect tile. Where there is room for the name, use `Wordmark` instead. Never put both side by side.

**You provide**
- `size` in px. Below 32 px the small cut (10 dots) is drawn automatically, with the same steps.
- `state`: `rest` (default; the middle row breathes), `recall` (the row waves), `save` (the row writes in), `working` (no count: a comet runs the whole stroke), `progress`, `done` (the whole E lit, sealed once; a halo in light), `failed` (un-writes, then rests), `off` (no amber: nothing is live).
- For `progress`: `steps` and `step` (0-based; `step === steps` is done), or `value` 0–1.
- `label` (default "Exomem"); `null` when words beside it already say what is happening.

**How it moves.** The dots are ordered the way a pen draws the E. Each step owns a stretch of that stroke: up to five steps end on the letter's corners, more split it evenly. State is three numbers (`--exo-w` written, `--exo-b` the pen's end, `--exo-rest`) that the browser animates, so a step finishing is the pen moving on, never a swap. Going back to rest dissolves; failing runs the stroke backwards first.

**Transitions.** Change `state` (and `step`) whenever the real state changes; the mark animates from wherever it is. You never trigger an animation yourself.

| From → to | What moves |
|---|---|
| rest → working | frame dims to faint ink, a comet starts running the stroke |
| any → progress | written dots stay, the pen moves on to the next stretch with its wave |
| progress / working → done | the rest of the stroke writes itself, the whole E lights, one seal ripple |
| done → rest | written dots dissolve together while the frame returns to full ink |
| progress → failed | the stroke runs backwards to nothing, then the logo rests |
| any → off | amber fades to ink; nothing moves |
| rest → recall / save | the middle row waves / writes in once |

**Do** pair every non-rest state with words on the page. **Don't** use amber states as decoration: amber means something is live, retrieved or current.
