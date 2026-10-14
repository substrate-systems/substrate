# The alive engine

`alive-engine.js` is the motion engine behind every graph in the design (landing hero, "how it works" diagrams, the living map, Home's band, the start-page field, checkout). It is the reference implementation: port it into a small client module (no framework needed) and keep its behaviour.

## Motion grammar (decided in round 41)

- **At rest (ambient):** ink only, never amber. Pulses fill link by link (no dot, no tail), every few seconds. "A + loop": today's walking light stays as the idle state. On Home the walker is ink.
- **Events:** amber, only when something really happened (a recall, a save, a connection, a payment landing). Always paired with words on the page.
- **Work:** while something is in progress (a payment), pulses run faster and flow into the thing that is working. Amber for a payment, because it is what is happening now.
- **Reduced motion:** nothing travels or loops. Events light their notes without moving.

## Attach

```html
<svg data-alive="loop" data-graph='{"n":[[x,y,r],…],"e":[[i,j],…]}' data-ink="#ECE9E2" data-amber="#FFB000"
     data-alive-key="unique-id" data-entry="x,y" data-walk="ink" data-hover="glow" data-avoid="x,y,w,h" data-births="off">
```

| Attribute | Meaning |
|---|---|
| `data-alive` | `loop` (shipped choice), `current`, `tide`, `tideloop`, `grow`, or `off` |
| `data-graph` | nodes `[x, y, r]` and edges `[i, j]` in the svg's viewBox units |
| `data-ink`, `data-amber` | the theme's ink and amber. In light, the engine detects dark ink and matches dark mode's **contrast** for moving ink (not its opacity) |
| `data-walk="ink"` | the walker is ink (Home) |
| `data-hover="glow"` | hovering lights the closest note and its links |
| `data-avoid` | a rectangle where the page's text sits; events never light notes there |
| `data-entry` | where events come from by default |

## Events

```js
window.__exoAlive.fire('svg[data-alive-key="k1"]', { kind: 'recall' });           // recall | save | connect
window.__exoAlive.fire(sel, { kind: 'recall', from: 2, of: 4 });                    // start near the 3rd of 4 app tiles
window.__exoAlive.fire(sel, { kind: 'recall', clear: 'div[data-ck]' });             // only notes and links that can be seen
window.__exoAlive.fire(sel, { kind: 'work', on: true, amber: true, clear: 'div[data-ck]', toward: 'div[data-ck] [data-panel]' });
window.__exoAlive.fire(sel, { kind: 'work', on: false });
```

`clear` takes a selector for the page's own content: notes under text, controls, pictures or anything with a fill or border are left out (empty layout boxes don't count). `toward` makes work pulses arrive at notes next to that element.

## Rules it keeps

- Links stop at a note's edge (no lines through notes).
- The ambient layer sits under the page's own drawing; events and hover sit on top.
- It survives re-renders: it reattaches its layers, waits up to ~10 s when its svg is detached, then rebuilds.
- Every animation frame is scheduled before work runs and wrapped in try/catch, so one bad frame can't freeze it.

## Backend it needs

Home's amber events are real: an activity feed of recalls and saves (app, time, note count). Until that exists, Home shows the ink walker only. See the brief.
