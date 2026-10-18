# Exomem design: the canon

**Read this first.** This file says what is canonical, screen by screen and state by state. If anything else in `docs/exomem-design/` disagrees with it, this file wins. Anything it doesn't list is history: useful for the reasoning behind a decision, never a spec.

Order of authority:

1. **This file**: which board, which props, which image.
2. **The board it names**, rendered with exactly those props. Its markup is the exact spec: sizes, spacing, type, copy and motion. The image in `canon/` is that render, so you can compare at a glance.
3. **The READMEs** (`README.md`, `UPDATE-2026-10-13.md`) for rules and behaviour the drawings can't show.
4. **The real code** for what is possible. If a canonical design needs something the backend can't do, stop and ask. Don't fake it, and don't quietly change the design to fit.

Last updated: round 57, 17 October 2026.

## New in rounds 49 to 57 (build these)

**Home** (`Home-Page`). The desktop sits in the landing's 1056 px frame, in two columns: status, then apps, how much Exomem joins in and your data on the left (656 px); the map preview and plan and account on the right (368 px). The header has no tabs: wordmark, theme, email · Sign out, aligned to the frame. On a phone the map preview sits under the status. The graph behind the header, the motion and every state are unchanged.

**The map preview** on Home (inside `Home-Page`, prop `mapVault` for the sample sizes):

- It is a small view of the person's real map: the same data and the same layout as the map page, scaled to the card and nudged apart only so no two notes touch (at least 2.2 px between edges at card scale), so "Open the map" lands on the same picture. Use the map's own endpoint; nothing else.
- Notes are solid. Their colour is ink mixed with the panel (about 40%, 62% for the most-linked notes), never `opacity`. Size follows how linked a note is. A superseded note is a hollow ring.
- Links show their type in the line: supports solid, refines dotted, contradicts dashed, relates fainter. Ink only. Amber appears only when an assistant really recalls or saves, on the notes it used, with words.
- Topic labels sit over their cluster in small caps: up to 7 on desktop, 4 on a phone. With only a few notes, the notes' own names are shown instead (no label covers a line or another label). With one note, its name.
- The foot of the card: what it shows on the left ("253 notes · 7 topics", "9 notes", "146 of 4,213 notes", "1 note", "No notes yet"), "Open the map →" on the right. When an assistant recalls or saves, the left side reads "Claude Code recalled 3 notes" with an amber dot for 3 seconds, while those notes light.
- A large vault draws its most-linked notes (about 150) and the rest as dust, like the map's large view. No notes yet: the card says "Your map starts with your first note."
- Data needs: the map's data on Home (the viewer's endpoint), and note ids on each activity event so the right notes light. Without ids, the recall still lights the card, starting from the app's side, but not the exact notes.
- The engine attaches to the card exactly as to the header graph: hover glow, ink pulses at rest, events.

**Amber in light (settled in rounds 52 and 53).** In light everything amber is the gold `#A86E00` (`exo-amber`): lit notes, lit links, the logo's middle row, focus, and the halo around a lit note, which is the same gold at 18% opacity. That is what the landing's graphs already draw; the engine now does the same, so the landing, Home and the map preview match. (Until round 52 the engine drew a phosphor halo in light.) **Settled in round 53:** the flow pages' field draws the same flat gold halo: a lit or hovered note (`.gn.c0`, `.gn.on`) gets `box-shadow: 0 0 0 5px rgba(168,110,0,.18)` in light; no blurred phosphor glow anywhere in light. Compared live against a soft phosphor glow and a soft gold glow (history); the flat halo won for being calm and matching Home and the landing. **Fixed in round 53:** after connecting (`handback`, `joined`, `kept`) the settling animation (`jNodeRest`) ran with fill `both` and held every note grey, so the hover grew a note without lighting it. It now runs `backwards` with only a start keyframe, so a settled note takes its class styles again and hovers like every other page, in both themes. **Also round 53:** field notes and dots get a whole-pixel size and position (`Math.round`); a fractional box was snapped to pixels on each axis separately, which drew some notes as ovals. (Round 53 spaced the Home map preview at 2.2 px; round 54 replaces that with the node-awareness rule below.) **No see-through notes anywhere:** a note is drawn solid, its colour mixed with what is behind it (`color-mix`), never with `opacity`, so a link never shows through it; the landing's hero and "How it works" graphs now follow this too. **The living map on the landing answers the pointer** like every other graph (`data-hover="glow"`); its hub, already amber at rest, is marked `data-lit` so the hover leaves it as it is (the engine skips the neighbour wake on lit notes). Small amber text uses `exo-amber-text` `#A06600`, which passes AA on paper (4.5:1); `#A86E00` is 4.0:1, fine for dots, lines and large text. Dark mode is unchanged: `#FFB000` for the note and its halo at 16%.

**Check your email** (`Journey-Page`, `step: sent`, `sentCopy: r49`). Same centred layout as every flow page. Lede: "Open the email from Exomem to continue, on any device." The card: "Sent to {address}" with **Change** beside it, then two notes: "Nothing after a minute? Look in spam." and "Open it in this browser and this tab moves on by itself." (from an app: "Open it in this browser to finish connecting {app}."). Main button "Open {inbox} ↗" when we can tell the inbox (on a phone, always: "Open your email app ↗" at worst), then a quiet "Send again in 0:42". Otherwise (desktop, unknown domain) the main button is "Send again", dimmed while it counts down. Same words for every address, so nothing is revealed.

- Which inbox: first the address's domain (gmail.com, googlemail.com → Gmail; outlook.com, hotmail.com, live.com, msn.com → Outlook; icloud.com, me.com, mac.com → iCloud Mail; proton.me, protonmail.com, pm.me → Proton Mail; yahoo.com → Yahoo Mail; fastmail.com → Fastmail). For any other domain the server looks up its MX records (`dns.resolveMx`): Google's mail servers → Gmail, Microsoft's → Outlook. It's a DNS lookup about the domain, never about the person, so it reveals nothing; cache it per domain.
- Links on desktop: Gmail `https://mail.google.com/mail/?authuser={address}#search/from%3A{sender}+in%3Aanywhere` (opens the right account, on our email); Outlook `https://outlook.live.com/mail/0/` (personal) or `https://outlook.office.com/mail/` (work, from MX); iCloud `https://www.icloud.com/mail`; Proton `https://mail.proton.me/u/0/inbox`; Yahoo `https://mail.yahoo.com/`; Fastmail `https://app.fastmail.com/mail/Inbox`. Open in a new tab.
- On a phone every address gets a button. A known provider keeps its name ("Open Gmail ↗") and opens its app if installed, else its web inbox; any other address gets "Open your email app ↗", which opens the phone's mail app. iOS: `message://` (Apple Mail; for a Gmail address with the Gmail app, `googlegmail://`). Android: `intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.APP_EMAIL;end`. Test each on a real device before shipping.
- When we can't tell (an unknown domain on desktop): no inbox button. The main button is "Send again", dimmed while it counts down. There is no reliable generic "open your inbox" link on desktop (`mailto:` opens a new message, not the inbox).
- The tab moving on by itself: when the link opens in the same browser, it tells this tab (a `storage` event) and this tab goes on.

**Theme control** (`R52-Theme-Control`, decided). Three states: Auto (follows the device, the default), Light, Dark. The button shows the theme in force with our own glyphs (half circle, sun, moon; exact SVGs on the board, not an icon library). A tap opens a small menu, Auto, Light, Dark, with the current one ticked; picking a row applies at once and closes it. Button: 15 px glyph in a round 36 px target (40 px on phones) that fills with `bg-hover`. Menu: `bg-raised`, border-card, `r-pop`, `shadow-pop`, rows 36 px (44 px on phones). **Since round 53 the boards carry it** (Landing, Home, the map, the flow pages), so the running boards show it at its real place and behave as specified: the button keeps the old 28 px footprint in the header row (a negative margin), the menu opens under it: left-aligned in desktop headers; right-aligned on phones, on the flow pages and on the map; the choice is kept in the browser key `exomem-theme-choice` until sign-in, then on the account, and set as `data-theme-choice` on `<html>` before first paint. Switching never reloads or remounts anything: the page flips `data-theme` and the CSS variables, and the live graphs pick up the new ink and amber in place (the prototype runtime does the same since round 53). On the flow pages it sits top right at the page gutter, on the wordmark's centre line.

**Breathing room around the header (round 53).** Background graphs (Home's header graph, the flow pages' field) keep a 10 px margin around the wordmark, the theme control and the account. A note that would fall inside it is nudged to the nearest side; nothing is removed and its links stay, so the graph reads the same. **The field's links** are 9% of the ink in both themes (`.gi`), the same strength as Home's header graph (about 1.2:1 against the page); the content graphs (landing, map card) are stronger because there the graph is the point. **The landing tells the Reykjavík story:** "where are we staying in Reykjavík?", the Airbnb superseded by the hotel booking (`trip/hotel-borg.md`, booked 2 May), with Maria and Reykjavík as the two topics. **"How it works" diagrams sit centred** in their column on every size; the words stay left. **Checkout:** its header keeps the email clear of the theme control (40 px), and in light every glow, halo and focus ring is the gold.

**Node and link awareness (rounds 54 to 56, every graph).** Layout helpers live in `reference/engine/graph-layout.js`; the boards inline the same steps. Checked by an audit of every board state (all counts 0):
- *Notes may sit close, never on each other.* At least 4.5 px between note edges on the Home map card, 18 px centre to centre in the flow field (stars: 14 px), 4 px between edges on the map page (on a phone's overview notes ease apart on screen by a few px; hubs, the focus and the review pair stay put).
- *Nothing sits under a label or the header.* Topic labels sit centred straight above their hub (so you can tell which topic a label names); the few notes under a label step up or down, clear of it. Background graphs keep 10 px around the wordmark, the theme control and the account.
- *A link always leaves a note's centre:* drawn centre to centre, or trimmed along that same line. An HTML link is a 1 px tall box turned about its left-middle, so its `top` is the centre line minus 0.5 px. Notes on the map page don't drift one by one, and a note's move and resize share one easing curve.
- *Background links keep clear of the theme button.* No background link runs under the button's hover circle (the circle stays solid `bg-hover`; translucent versions were compared and dropped).
- *Links elsewhere are round 54's:* the flow field links each note to its nearest neighbours; the map page draws every real relation. Round 55's stricter link rules (no crossings, notes pushed off links) were tried and dropped as too busy; the helpers stay in the module, unused.

**The map card: your vault as constellations (Home, round 56; the card only).** The map card is a preview, so it summarises; the map page is for exploring and keeps every link. On the card:
- *Stars* are real notes in their real places. Each topic draws one *figure* through 13 stars, joined from the hub by the shortest lines (a drawing, like real constellations, not a claim that those notes link). Figure stars are 1.9 px dots at 48% ink, figure lines 26% ink; every other note is a pinpoint (0.8 to 1.7 px, 26% ink); hubs 3.4 px.
- *Which 13:* mostly how often the note was recalled in the last 90 days, a little how connected it is, and only from the topic's nearer 60% of notes, so the figure stays compact (`pickConstellation`). **Usage is display only: recall ranking never uses it** (being used a lot doesn't make a note true, and popular notes would beat the newer ones that superseded them).
- *Stable sky:* a figure redraws only when 3 or more of its 13 stars change, so the sky stays recognisable and slowly evolves. Under about 30 notes there are no figures, only stars.
- *Halos:* each topic has a small bright halo (radius 16, 7% ink at the centre) inside a wide soft one (radius 44, 4.5%), both fading to nothing.
- *Between topics:* one quiet line from hub to hub where two topics share at least 3 links (stronger the more they share).
- *Live and pointing:* when Exomem recalls or saves a note, its star lights gold with its real links and its topic's figure, then fades back; pointing at a star does the same and shows its name; pointing at a topic label brightens that figure; a click opens the map page focused there; phones open the map on tap. Gold only for what is live: none at rest.
- The sample board uses sample recall counts; the product reads real ones from Exomem. Before shipping, render the card from a real vault and check: at most 7 topics, 13 stars per figure, compact figures, nothing overlapping, labels above their hub.

**The map page at every size, and how zoom behaves (round 56).** The board has three real vaults: `vault: few` (about 12 notes), `sample` (253) and `large` (about 2,000 notes and 5,000 links, generated, not painted). Build the product against all three.
- *Level of detail:* up to 600 notes, everything draws. A bigger vault draws its 400 most-linked notes when zoomed out (the banner says "400 of 2,007 · The most-linked notes. Zoom in or search to see the rest.") and, zoomed in, every note in view (up to 900), always plus the note in focus, its links and the pair under review. Layout work uses grids, so a large vault stays fast.
- *Zoom changes space, not size:* a note is its normal size at the overview, at most about 20% larger zoomed in and about 8% smaller zoomed out; lines stay 1 px. A vault under 40 notes draws its notes 1.6 times larger so a dozen notes don't look like dust. More names appear as you zoom in, never on top of each other.
- *The focus ring keeps its on-screen size at any zoom:* zoom out and the rest of the map shrinks while the ring and its labels stay readable; zoom in and the ring stays on screen.
- *Cursor:* an ordinary arrow over the map, a pointer over notes and labels, the closed hand only while dragging.
- *Images in notes:* an embedded image (`![[file.png]]`) renders in the note at full column width with its file name under it; other embedded files show as a file card.

**A note with many links, and labels you can read (map page, round 57).** Real notes can have 100+ links; drawing them all as a ring is unreadable (see the "all" option in the round 57 comparison).
- *The focus ring holds at most 12 notes on desktop, 8 on a phone* (`ringMode: top`, the default). Picked in this order: the note that supersedes it, what it supersedes, unresolved disagreements, supports, refines, then the rest by how connected they are. The other links are not drawn; one chip under the ring says "+106 more links · read the note for all 118" and opens the reader, which lists every link grouped by type. Up to 12 links, nothing changes. Prototyped and rejected: one note per link type with "+N" (`types`), and leaving notes in place with the links lit (`place`, Obsidian-style), which on a big vault draws lines across the whole map. Both stay in the board as props. Comparison: [desktop](canon/viewer/r57-ring-options--desktop.webp) · [phone](canon/viewer/r57-ring-options--phone.webp) (left to right: all, top, types, place).
- *Cluster labels have a halo* (`clStyle: halo`): the muted text colour, medium weight, with a soft ring of page colour behind the letters, so lines and notes under a label never cut through it. Not amber: amber means live. Comparison: [labels](canon/viewer/r57-cluster-labels.webp) (before, halo, pill; light and dark).
- *The review pair reads A then B:* A is the note on the left (or, when they are stacked, the one on top), and its label sits left or above; B's sits right or below. The card lists A first and "A holds" means that note.
- *One place for links (reader):* the main column is the note's own content: properties, Markdown, observations and files. Links (both directions, grouped and read from this end), sources, "Mentioned in", "About" and history live only beside it, or below it on a phone. A note's written "## Relations" section is shown there in full, not repeated in the body, and nothing generates a links list in the body. A note never writes its own backlinks into its body.
- *For the build (Sigma.js + graphology):* node sizes are set in screen space and barely scale with zoom (a gentle zoom-to-size function, not the default square root); labels come from a density grid, busiest first; links touching the focus are capped as above. Like Obsidian, the layout is live: ForceAtlas2 runs on load and settles in about 2 s, then stops so the map doesn't drift while you read. Dragging a note pulls its links along, and the note stays where you drop it (pinned per person). Search, focus and zoom never re-run the layout.
- *"+N more" is two chips:* "+106 more links" opens the reader already at its link list (the heading flashes amber once), and "Show all on the map" lights every link in place, Obsidian-style; "Back to the top 12" returns. So the whole set is always one click away, and the default stays readable at any vault size.
- *Hover follows the pointer exactly and puts your attention on one note* (desktop). The map decides from what is under the pointer: a note or its name both mean that note. Over empty map, off the map, or after a click on the void, nothing is hovered (it never sticks).
  - The note goes full ink with a soft halo disc, with no outline and no growth. Its name is plain bright text on a page-colour halo, never a box, followed by its type as a small neutral tag ("cache-warm-66  Pattern"). No link count and no neighbour names: the lit links already show those. In the overview each lit link names its kind. With a note open, hovering a ring note brightens its name and adds the same type tag (on the far side when the name sits left of the dot), so hover reads the same everywhere; only the link name on the line is left out, because the label already says how it links.
  - Its links light up (75%) and its neighbours come forward (85%).
  - Everything else steps back, as in Obsidian: other notes to 28% in dark and 14% in light, links to 8% and 5%. Light mode steps back further so the focus reads as clearly as in dark.
  - With a note open, pointing at one of its ring notes stays subtle (that note and its link to the focus light up). Pointing anywhere else gives the same focus as the overview, and the ring steps back too.
  - A note that already has its name on the map lights that name rather than repeating it. A new tooltip opens on the side with room (right, then left, above, below), and when a name sits to the left of its note, the type tag goes on the far side. Not amber: amber means live. The board keeps `hoverStyle: glow` and `ring` as props. Phones have no hover. Text can't be selected on the map, only in the reader. Comparison: [hover](canon/viewer/r57-hover-options.webp) · [focus on hover](canon/viewer/r57-hover-focus.webp) (overview, pointing away from an open note, pointing at a ring note; light and dark).
- *Back undoes the last step:* from a note, Back goes to the note you came from, then to the review pair you opened it from ("← review"), then to the overview. Escape steps back one level: a menu closes, the reader or "why" returns to the note, and a note goes back. "Show all on the map" belongs to one visit of one note; any move resets it.
- *Link colour:* the four core kinds have their own look: supports is solid amber, refines dotted, contradicts dashed, and supersedes amber with one arrowhead at the end, pointing into the note that replaced the old one, as on the landing. It shows whenever either end is in focus or under the pointer, so supersedes reads by direction, not thickness. The other 30+ kinds share one ink line at 55%.
- *Names drop `.md`* everywhere on screen (labels, panel, reader, search, review). Attachments keep their extension (`run-014-latency.png`), and Copy path copies the real path. The desktop shows the folder, the phone the bare name.
- *Links look like links:* every row in a link list ends in a chevron that turns amber on hover. In the body, a wikilink to a note that isn't in the vault (`[[mteb-2026]]`) is muted and dotted, and says "Not in your vault yet" on hover.
- *Plain properties:* no reference row. The note's path is in the breadcrumb with Copy path, and the internal `exomem://memory/…` id is never shown. A note is never listed as its own source.
- *The live line and the large-vault banner sit on a solid strip*, so notes passing under them never make them unreadable. On a phone the banner reads "400 of 2,007 · Most-linked notes. Zoom in for more." so it fits.
- *Review in plain words:* "These two notes say different things. Which is right now? The other isn't deleted: it stays in your vault, marked superseded, and Exomem records why." The cards and map labels are tagged "older" and "newer" (no A and B). The buttons are "Newer is right · the older becomes superseded" (filled, the usual case), "Older is right · the newer becomes superseded", "Both hold, in different situations", then "Not a disagreement" and "Remind me in a week". On a phone they read "Newer is right" / "Older is right".
- *Zoom with a note open* zooms the map around the note while the ring keeps its size, so the ring seems to rebuild as the map moves. That is intended. Phones pinch; there are no zoom buttons on a phone.
- *The listen menu* (music) has a heading ("LET THE GRAPH LISTEN", small mono caps over a hairline), then two items with icons: Use the microphone, Play a song from a file.
- *Landing hero dot grid:* the dots are ink at 7% in dark and 20% in light, so the grid reads the same in both themes.
- *The timeline steps by month, week or day.* A Month / Week / Day switch sits next to the speed (Week is the default) (M / W / D on a phone), with ‹ › to step one unit. Play steps a quarter month, a week or a day at a time (a year by day plays in about 30 s at 1×). The label shows the date at that grain ("your knowledge on 14 Mar 2026", "week of 9 Mar 2026"), and the current month's bar fills to the exact day. Nothing finer than a day.
- *The map is alive, not sealed (for the Sigma build).* New notes pop in with a slight overshoot; the board does this. In the product, the layout keeps a little life: ForceAtlas2 runs for about a second whenever notes arrive (a save, a sync, the timeline playing), so neighbours shift to make room and the map settles again, like Obsidian re-indexing. When the map is at rest, nothing moves. Dragging a note pulls its links along, and it stays where you drop it. With reduced motion there is no layout animation, and new notes simply appear.
- *On the map a note is its name only* ("hybrid-weights-206"), on desktop and phone alike. The folder shows in the panel, the reader's breadcrumb and search, and the hover tag gives the type, so the two never repeat.
- *Sizes stay calm:* a note's size follows its links on a square-root scale, from 3 to 12 px, so a note with 118 links is only about twice the size of one with 4. Every note on the focus ring is the same size (8 px). Recalled notes glow amber but don't grow.
- *The reader shows where the note sits:* an "On the map" card at the top of its side column (above the links on a phone) is a crop of the actual map around the note. It uses the same positions (turned like the phone map on a phone), draws the links on its ring in the map's styles and nearby notes faint, and ends with "+106 more". The crop always takes in the nearest topic and names it (RETRIEVAL, LATENCY…), so you can tell where the note sits. So it looks like the place you'll land, never like a diagram. Clicking it, or "Show on the map →", opens the map at that note.
- *Relations are written in the note, shown in one place.* Exomem writes a note's typed links in its Markdown (frontmatter and a "## Relations" section). The reader reads them from there and shows them, together with the links other notes make to it, in the side list. The file itself is unchanged.
- *Sample notes read like real ones:* every note family in the sample vaults has a real body (index-rebuild, rerank-cost, cache-warm, fts5, rrf-k, issue-212, vault-sync, edge-cases, no-gpu-default, chunking, the 30 Jun meeting, recall-at-10, plugin-route, plus the hubs). The numbered notes in the large vault read their family's body. Hubs worth opening for full notes: newer-constraint, gpu-batching, first-latency, run-014, embedding-models, supersede-not-delete, old-plan.
- *The why-trail's line runs through the centre of its dots* (a 2 px line under 7 px dots).
- *The reader's header names its primitives:*
  - The type is a small label ("INSIGHT").
  - The status is a dot and a word: live in amber, pending dashed, superseded struck through, retired grey.
  - Each project is a first-class pill ("◆ exomem"); clicking it finds that project's notes.
  - Each one explains itself in the tooltip ("Live: recall uses it", "Project exomem: find its notes").
- *Nothing in a note is cut off:* observation categories wrap ("operating / constraint") rather than ending in "…". A link row whose name doesn't fit shows the full path in the tooltip.
- *One tooltip for the map page* (`data-tip`): an inverted ink chip, 12 px Inter, max 280 px wide. It appears after 350 ms, fades in over 120 ms, sits 8 px above the element (below when there's no room) and stays inside the page. It replaces the browser's own tooltips on the map controls (zoom, fit, speed, step, music, theme), the reader's header, links to missing notes and cut-off link rows. Note names on the map keep their own hover label.
- *Each board's CSS stays inside that board* (runtime `@scope`, like CSS modules). The landing embeds the map, and the landing's `.pt` rule had been hiding the reader's link names there.

**The note reader shows the whole note (map page, round 55).** Header: the note type (Exomem's 17 types: Insight, Research note, Failure, Pattern, Experiment, Source…), the status (11 statuses; the class decides the look: live statuses amber, pending dashed, superseded struck through, retired and abandoned muted) and its projects; then the note's own title (not the file name), created, updated, edits and last editor, all its tags, and a properties box with the type's fields (severity, pattern type, hypothesis, outcome, started, concluded…) and the note's `exomem://` reference. Body: full Markdown — `###` headings, bulleted and numbered lists, bold, italic, inline code, code blocks, quotes, tables (scroll sideways on a phone), links (↗) and embedded files as a file card — on top of observations and relations; a leading `# title` is not repeated. Beside it (below it on a phone): links grouped by type and read from this end (supports / supported by, part of / contains; relates to and contradicts read the same both ways), "Mentioned in" with the sentence around each mention, "About" (the people, places and things it concerns; each opens the map searching for it, and search also matches tags and entities), sources with their evidence files (a source note shows its own files even when it cites nothing), and the revision history (date, what changed, by which app), then when it was last recalled.

**The wordmark reacts to real activity (Home, round 53).** When an app recalls or saves, the header wordmark's middle row ripples once, left to right, in step with the map card: each of the four gold dots throws a disc of the same gold that grows to 3.2× and fades over 1 s, 90 ms apart. Nothing at rest, never as decoration; with reduced motion, nothing. The logo stays still on every other page.

## How to match a screen

1. Find the screen below. Open the board it names (`reference/boards/<Board>.dc.html`) with the props listed, or look at the image.
2. Render the build in the same state, at the same size, in the same theme.
3. Put the two side by side and fix every difference: position, size, weight, colour, copy, line breaks, spacing, motion. "Close" is not done. If you think the board is wrong, say so and ask. Don't pick a third version.

Sizes: desktop boards are drawn at **1280 × 820** (the viewer at 1440 × 900). Check the build at 1280 and at 1440: the layout is the same, only the outer margins grow. Phones are drawn at **390 × 844**. Flow pages are also checked at **390 × 640** (the shortest phone) and **390 × 932** (the tallest). Long pages (Home, the landing) are drawn full length.

Images are named `<screen>/<state>--<device>-<theme>.webp`. Every state has a dark image. The main states also have a light one. Light is as canonical as dark: where only dark is shown, the light version is the same board with `theme: light`.

Sample values in the images (prices, dates, names, counts, the email address) are samples. Every real number comes from its live source at run time.

## Canonical props

The boards still carry switches from the rounds that explored alternatives. Only these values are canonical. Never build another value.

| Prop | Canonical value | Means |
|---|---|---|
| `alive` | `loop` | "A + loop": ink pulses at rest, the walking light idle, amber only for real events |
| `hover` | `glow` | Hover lights the closest note and its links. Nothing moves |
| `field` | `web` | The start-page field |
| `mark` | `dot` | The Dot E |
| `accent` | `#FFB000` | `exo-amber` (light: `#A86E00`; small amber text `#A06600`) |
| `checkout` | `inline` | Paddle inline, in our panel. Never the overlay |
| `ckSummary` / `summary` | `hero` | Checkout summary B, "the price first" |
| `sentCopy` | `r49` | The round 49 "Check your email" card |
| `mapVault` | sample only | `normal`, `few`, `large` show the map preview at three vault sizes; the real card draws the person's map |
| `activity` | `on` where Home has an activity feed | Only real events light anything |

`ckFields` is only sample content inside Paddle's frame. Paddle draws those fields; style them in Paddle's dashboard (`paddle/exomem-paddle-styling-brief.md`).

## Screens

| Screen | Board | Props (plus the canonical ones) | Images |
|---|---|---|---|
| Landing | `Landing-Page` | `device`, `theme`, `fluid: true` | `canon/landing/` |
| Sign in, check your email, getting in, invitations, reviewer, subscribe, choose an assistant, connect, account states | `Journey-Page` | `step`, `app` (`web` for the site's own flow, `Claude` / `ChatGPT` for connecting from the site, `Claude Code` for an app's own sign-in), `device`, `screenH` on phones | `canon/journey/` |
| Checkout, every state, price, country and buyer | `Checkout-Inline` inside `Journey-Page` (`step: subscribe`, `paying`, `confirming`); the full matrix is `R42-Checkout-States` | `checkoutState`, `ckBuyer`, `country`, `price` | `canon/journey/web/`, `canon/sheets/R42-Checkout-States.webp` |
| Home | `Home-Page` | `state`, `account`, `fresh`, `firstNote`, `reach`, `trouble`, `exportState`, `storageUsedGb`, `openModal`, `mapVault` (sample size of the map preview), `device`, `theme` | `canon/home/` |
| The map (viewer) | `Viewer` | `start`, `vault`, `reach`, `device`, `theme` | `canon/viewer/` |
| Getting in: expired, used, too many links, waitlist | `R43-Getting-In` (states of `Journey-Page`) | | `canon/sheets/R43-Getting-In.webp` |
| First day, empty and large vaults, no results | `R43-Data-Cases` | | `canon/sheets/R43-Data-Cases.webp` |
| Can't reach Exomem | `R43-Unreachable` | | `canon/sheets/R43-Unreachable.webp` |
| Accessibility: forced colours, 200% zoom, sideways, screen readers | `R43-Accessibility` | | `canon/sheets/R43-Accessibility.webp` |
| Emails | `R28-Emails` (desktop), `R41-Emails-Phone` (phone, waitlist W1) | | `canon/sheets/` |
| The writing E: every progress state and every change between states | `Writing-E` (component); `R44-Writing-E`, `R44-Writing-E-Light` | | `canon/sheets/R44-*.webp` |
| Theme control | `R52-Theme-Control` | | `canon/sheets/R52-Theme-Control.webp` |
| Fields, focus and validation | `Fields-Demo` (password "exomem") and `system/CHANGES-R41-R43.md` §2–3 | | |
| Tokens, type, components | `design-system/` and the Exomem Design System artifact | | |

**Not decided yet:** a shared header and footer for the other signed-in pages (setup, delete, support). Until then they keep their boards.

## Motion

Motion is part of the design, not decoration added at the end. The boards play it. The images can't, so these are the sources:

| What | Source | Watch it in |
|---|---|---|
| Every graph: pulses at rest, the walking light, amber events, hover glow, links stopping at a note's edge, reduced motion | `reference/engine/alive-engine.js`, `reference/engine/ENGINE.md` | `Landing-Page`, `Home-Page` (`activity: on`), `Journey-Page`, `prototypes/exomem-alive.html` |
| Start-page field: walks while you read, lights when you connect, pulses flow into the checkout while paying, answers once when paid, holds still and cut when Exomem can't be reached | `Journey-Page` (`field: web`) | `Journey-Page` with `step: auto` (plays the journey) |
| The writing E: steps, no count, percentage, done, failure, off, and the change between any two | `Writing-E` (`weDrive`) | `R44-Writing-E`, "Try any transition" panel |
| State changes: text cross-fades, panes cross-fade in place, messages open to their height, new content fades up. Nothing flashes, layout never jumps | Component library: `Swap`, `Crossfade`, `Collapse`, `FadeIn` | `Checkout-Inline`, `prototypes/exomem-checkout.html` |
| Content entering a flow page | `jIn` 0.6 s `cubic-bezier(.16,1,.3,1)`, fades up 8 px | `Journey-Page` |
| Home's mark: the lit row breathes while the memory is on | `Home-Page` | Only there |
| Home's header wordmark: the middle row ripples once on a real recall or save (see "The wordmark reacts to real activity") | `Home-Page` (`activity: on`) | Only there; the tile's breathing carries on, they are different marks |

Timing tokens: `dur-hover` 150 ms, `dur-state` 300 ms, `dur-swap` 450 ms, `dur-sheet` 350 ms, `dur-move` 600 ms, `dur-write` 900 ms; `ease-settle` and `ease-out-expo`. Under reduced motion nothing travels or loops. States still read through colour and shape.

## Rules a drawing can't show

These are where builds have drifted. Each one is how the boards already behave.

- **Flow pages sit in the middle, never at the top.** On a phone the column is centred vertically in the space between 84 px from the top and 150 px from the bottom (the field and the origin line live in that bottom band). On desktop it is centred in the page's full height. As the phone gets taller (640 → 932), the column moves down with it. It never stays pinned under the header. Below 720 px tall, the tiles above the title are hidden and the column's gap drops from 26 to 14 px. Phone flow pages don't scroll from 640 to 932 px tall, except the checkout.
- **Flow pages are centred**: tiles, title, lede and buttons on the column's centre line. Cards inside the column keep their own left-aligned rows ("Sent to … address").
- **The wordmark** is 17 px tall, its top edge 29 px from the top of the page, on every page. Horizontally it sits on the page's content edge: the 1056 px frame's edge on the landing and Home (112 px at 1280), 40 px on the flow pages, 16 px on phones. Signed in, it links to Home. The one exception is the map page (`Viewer`): a full-screen tool, it carries the Dot E alone at the left of its toolbar (26 px on desktop, 24 px on phones), which returns to the map's overview; Home is its own button in the toolbar, after the theme control.
- **Graphs are the canonical ones.** Use the engine and the boards' node data. Don't redraw, simplify, restyle or re-seed a graph to fit a layout. Notes are solid and lines stop at a note's edge. Never put a note over a line with `opacity`.
- **In light, every amber is the gold `#A86E00`**, halos a flat 18% (engine graphs and the flow pages' field alike), no phosphor glow; small amber text is `exo-amber-text` `#A06600` (see above).
- **Amber only for what is live, retrieved or current**, always with words on the page that say what happened. When nothing is live, the logo's middle row is the only amber on the page. (The landing's living map is a running demo of a recall, so its hub is amber with that cause on screen; it is marked `data-lit`.)
- **Theme:** Auto (default), Light, Dark. The state is set before first paint (`data-theme-choice` on `<html>`, the glyph picked by CSS). The button shows the state in force; a tap opens the three-row menu. Same control on every page, including flow pages, placed as in the Theme control entry above (desktop headers: just before the account or Sign in; flow pages: top right; the map: in its toolbar, just before Home; the other signed-in pages, until their shared header is decided: top right, before the account). No tooltip or toast. Exact drawing and SVGs: `R52-Theme-Control`. The choice is saved on the account (and in the browser until sign-in), so it follows the person to every device and takes effect the moment it is picked, on the page and from the next email on. Emails follow the same choice: **Auto** builds the email on the theme the site showed when it was sent and adds the other one through `prefers-color-scheme`, so mail apps that report a theme show the matching one; **Light** or **Dark** sends that theme only (`color-scheme` set to just that scheme, no `prefers-color-scheme` block). Emails sent before sign-in (the sign-in link) use the choice the page had when the request was made. Some mail apps (the Gmail and Outlook apps) recolour emails in their own dark mode whatever we send; we don't fight that.
- **Text selection** is `selection-bg` under `selection-fg`, never the browser's blue.
- **Phone targets** are at least 40 px. Footer links on phones are 40 px rows.
- **Copy** is the board's copy, word for word. Don't rephrase. If copy must change for a technical or legal reason, ask first and record the change here.

## History: not specs

These stay in `reference/boards/` as a record. Don't build from them.

| Board | What it is now |
|---|---|
| `R12-Lifecycle`, `R19-Landing`, `R20-Mobile`, `R30-Screens` | Early rounds. Superseded by `Landing-Page`, `Journey-Page`, `Home-Page` |
| `R36-Viewer` | Gallery from the round that designed the viewer. `Viewer` is canonical |
| `R37-Hover` | Three hover ideas; `glow` was chosen |
| `R41-Alive`, `R41-*-Loop`, `R41-Start-Tide-Light`, `R41-Home-Live`, `R41-Home-Phone` | Motion studies. The chosen motion is in the main boards and the engine |
| `R41-Icons-Copy`, `R41-Light-Amber` | Records of decisions now in the tokens and boards |
| `R42-Inputs-Focus` | The proposal. What was decided is in `Fields-Demo` and CHANGES §2–3 |
| `R42-Summary-Layouts` | Three checkout summaries; B (`hero`) was chosen |
| `R42-Checkout-Live` | A live demo of the checkout. `Checkout-Inline` is the component |
| `E-Studies`, `R15-Scrollbar` | Studies |
| `R40-Design-System` | Superseded by `design-system/` |
| `R45-Review`, `R46-Review`, `R47-Review` | Change logs from those rounds |
| `Coverage` | The old index of what is drawn. This file replaces it |
| `R49-Home-Option1` | Became `Home-Page` in round 50 (the earlier Home is in git history) |
| `R49-Theme-Control`, `R50-Theme-Control`, `R51-Theme-Control` | Earlier rounds of the theme control (dots; the glyphs now used; Lucide options). Replaced by `R52-Theme-Control` |

## Image index

Every image below is the named board rendered with the canonical props plus the state's own props (in `canon/jobs.json`).

### Landing

| State | Board props | Images |
|---|---|---|
| page | `fluid: true` | [desktop-dark](canon/landing/page--desktop-dark.webp) · [desktop-light](canon/landing/page--desktop-light.webp) · [phone-dark](canon/landing/page--phone-dark.webp) · [phone-light](canon/landing/page--phone-light.webp) |

### Journey · from the site (`app: web`)

| State | Board props | Images |
|---|---|---|
| Sign in (start with your email) | `step: "signedout"`, `app: "web"` | [desktop-dark](canon/journey/web/signedout--desktop-dark.webp) · [desktop-light](canon/journey/web/signedout--desktop-light.webp) · [phone-dark](canon/journey/web/signedout--phone-dark.webp) · [phone-light](canon/journey/web/signedout--phone-light.webp) · [phone640-dark](canon/journey/web/signedout--phone640-dark.webp) · [phone932-dark](canon/journey/web/signedout--phone932-dark.webp) |
| Check your email | `step: "sent"`, `app: "web"` | [desktop-dark](canon/journey/web/sent--desktop-dark.webp) · [desktop-light](canon/journey/web/sent--desktop-light.webp) · [phone-dark](canon/journey/web/sent--phone-dark.webp) · [phone-light](canon/journey/web/sent--phone-light.webp) · [phone640-dark](canon/journey/web/sent--phone640-dark.webp) · [phone932-dark](canon/journey/web/sent--phone932-dark.webp) |
| Sign-in link expired | `step: "linkexpired"`, `app: "web"` | [desktop-dark](canon/journey/web/linkexpired--desktop-dark.webp) · [phone-dark](canon/journey/web/linkexpired--phone-dark.webp) |
| Sign-in link already used | `step: "linkused"`, `app: "web"` | [desktop-dark](canon/journey/web/linkused--desktop-dark.webp) · [phone-dark](canon/journey/web/linkused--phone-dark.webp) |
| Too many links | `step: "ratelimited"`, `app: "web"` | [desktop-dark](canon/journey/web/ratelimited--desktop-dark.webp) · [phone-dark](canon/journey/web/ratelimited--phone-dark.webp) |
| On the waitlist | `step: "waitlist"`, `app: "web"` | [desktop-dark](canon/journey/web/waitlist--desktop-dark.webp) · [phone-dark](canon/journey/web/waitlist--phone-dark.webp) |
| Can't reach Exomem | `step: "unreachable"`, `app: "web"` | [desktop-dark](canon/journey/web/unreachable--desktop-dark.webp) · [phone-dark](canon/journey/web/unreachable--phone-dark.webp) |
| App reviewer sign-in | `step: "reviewer"`, `app: "web"` | [desktop-dark](canon/journey/web/reviewer--desktop-dark.webp) · [phone-dark](canon/journey/web/reviewer--phone-dark.webp) |
| Reviewer sign-in failed | `step: "reviewerfail"`, `app: "web"` | [desktop-dark](canon/journey/web/reviewerfail--desktop-dark.webp) · [phone-dark](canon/journey/web/reviewerfail--phone-dark.webp) |
| Invitation | `step: "invite"`, `app: "web"`, `invite: "friend"` | [desktop-dark](canon/journey/web/invite--desktop-dark.webp) · [phone-dark](canon/journey/web/invite--phone-dark.webp) |
| Accepting an invitation | `step: "accepting"`, `app: "web"`, `invite: "friend"` | [desktop-dark](canon/journey/web/accepting--desktop-dark.webp) · [phone-dark](canon/journey/web/accepting--phone-dark.webp) |
| Invitation can't be used | `step: "invitebad"`, `app: "web"`, `invite: "friend"` | [desktop-dark](canon/journey/web/invitebad--desktop-dark.webp) · [phone-dark](canon/journey/web/invitebad--phone-dark.webp) |
| Invited, already has Exomem | `step: "inviteexisting"`, `app: "web"`, `invite: "friend"` | [desktop-dark](canon/journey/web/inviteexisting--desktop-dark.webp) · [phone-dark](canon/journey/web/inviteexisting--phone-dark.webp) |
| Friend price added | `step: "inviteapplied"`, `app: "web"`, `invite: "friend"` | [desktop-dark](canon/journey/web/inviteapplied--desktop-dark.webp) · [phone-dark](canon/journey/web/inviteapplied--phone-dark.webp) |
| Invitation kept | `step: "invitekept"`, `app: "web"`, `invite: "friend"` | [desktop-dark](canon/journey/web/invitekept--desktop-dark.webp) · [phone-dark](canon/journey/web/invitekept--phone-dark.webp) |
| Subscribe (inline checkout) | `step: "subscribe"`, `app: "web"` | [desktop-dark](canon/journey/web/subscribe--desktop-dark.webp) · [desktop-light](canon/journey/web/subscribe--desktop-light.webp) · [phone-dark](canon/journey/web/subscribe--phone-dark.webp) · [phone-light](canon/journey/web/subscribe--phone-light.webp) |
| Paying | `step: "paying"`, `app: "web"` | [desktop-dark](canon/journey/web/paying--desktop-dark.webp) · [desktop-light](canon/journey/web/paying--desktop-light.webp) · [phone-dark](canon/journey/web/paying--phone-dark.webp) · [phone-light](canon/journey/web/paying--phone-light.webp) |
| Paid, switching on | `step: "confirming"`, `app: "web"` | [desktop-dark](canon/journey/web/confirming--desktop-dark.webp) · [phone-dark](canon/journey/web/confirming--phone-dark.webp) |
| Add Exomem to your assistant | `step: "choose"`, `app: "web"` | [desktop-dark](canon/journey/web/choose--desktop-dark.webp) · [desktop-light](canon/journey/web/choose--desktop-light.webp) · [phone-dark](canon/journey/web/choose--phone-dark.webp) · [phone-light](canon/journey/web/choose--phone-light.webp) · [phone640-dark](canon/journey/web/choose--phone640-dark.webp) · [phone932-dark](canon/journey/web/choose--phone932-dark.webp) |
| Waiting for the assistant | `step: "waiting"`, `app: "web"` | [desktop-dark](canon/journey/web/waiting--desktop-dark.webp) · [phone-dark](canon/journey/web/waiting--phone-dark.webp) |
| Any other app (MCP address) | `step: "other"`, `app: "web"` | [desktop-dark](canon/journey/web/other--desktop-dark.webp) · [phone-dark](canon/journey/web/other--phone-dark.webp) |
| Assistant connected | `step: "joined"`, `app: "web"` | [desktop-dark](canon/journey/web/joined--desktop-dark.webp) · [desktop-light](canon/journey/web/joined--desktop-light.webp) · [phone-dark](canon/journey/web/joined--phone-dark.webp) · [phone-light](canon/journey/web/joined--phone-light.webp) |
| Preparing | `step: "preparing"`, `app: "web"` | [desktop-dark](canon/journey/web/preparing--desktop-dark.webp) · [phone-dark](canon/journey/web/preparing--phone-dark.webp) |
| Read-only | `step: "readonly"`, `app: "web"` | [desktop-dark](canon/journey/web/readonly--desktop-dark.webp) · [phone-dark](canon/journey/web/readonly--phone-dark.webp) |
| Subscription ended | `step: "ended"`, `app: "web"` | [desktop-dark](canon/journey/web/ended--desktop-dark.webp) · [phone-dark](canon/journey/web/ended--phone-dark.webp) |
| Paused | `step: "paused"`, `app: "web"` | [desktop-dark](canon/journey/web/paused--desktop-dark.webp) · [phone-dark](canon/journey/web/paused--phone-dark.webp) |
| Suspended | `step: "suspended"`, `app: "web"` | [desktop-dark](canon/journey/web/suspended--desktop-dark.webp) · [phone-dark](canon/journey/web/suspended--phone-dark.webp) |
| Request expired | `step: "expired"`, `app: "web"` | [desktop-dark](canon/journey/web/expired--desktop-dark.webp) · [phone-dark](canon/journey/web/expired--phone-dark.webp) |
| Check your email, with an inbox button | `step: "sent"`, `app: "web"`, `email: "reader@gmail.com"` | [desktop-dark](canon/journey/web/sent-gmail--desktop-dark.webp) · [phone-dark](canon/journey/web/sent-gmail--phone-dark.webp) |

### Journey · connecting an assistant from the site (`app: Claude`)

| State | Board props | Images |
|---|---|---|
| Connect (consent) | `step: "connect"`, `app: "Claude"` | [desktop-dark](canon/journey/claude/connect--desktop-dark.webp) · [desktop-light](canon/journey/claude/connect--desktop-light.webp) · [phone-dark](canon/journey/claude/connect--phone-dark.webp) · [phone-light](canon/journey/claude/connect--phone-light.webp) · [phone640-dark](canon/journey/claude/connect--phone640-dark.webp) · [phone932-dark](canon/journey/claude/connect--phone932-dark.webp) |
| Connecting | `step: "connecting"`, `app: "Claude"` | [desktop-dark](canon/journey/claude/connecting--desktop-dark.webp) · [phone-dark](canon/journey/claude/connecting--phone-dark.webp) |
| Connected, back to the app | `step: "handback"`, `app: "Claude"` | [desktop-dark](canon/journey/claude/handback--desktop-dark.webp) · [desktop-light](canon/journey/claude/handback--desktop-light.webp) · [phone-dark](canon/journey/claude/handback--phone-dark.webp) · [phone-light](canon/journey/claude/handback--phone-light.webp) |
| Not connected | `step: "declined"`, `app: "Claude"` | [desktop-dark](canon/journey/claude/declined--desktop-dark.webp) · [phone-dark](canon/journey/claude/declined--phone-dark.webp) |
| Nothing changed | `step: "kept"`, `app: "Claude"` | [desktop-dark](canon/journey/claude/kept--desktop-dark.webp) · [phone-dark](canon/journey/claude/kept--phone-dark.webp) |
| That didn't finish | `step: "connecterror"`, `app: "Claude"` | [desktop-dark](canon/journey/claude/connecterror--desktop-dark.webp) · [phone-dark](canon/journey/claude/connecterror--phone-dark.webp) |

### Journey · an app's own sign-in (`app: Claude Code`)

| State | Board props | Images |
|---|---|---|
| Sign in (start with your email) | `step: "signedout"`, `app: "Claude Code"` | [desktop-dark](canon/journey/claude-code/signedout--desktop-dark.webp) · [phone-dark](canon/journey/claude-code/signedout--phone-dark.webp) |
| Check your email | `step: "sent"`, `app: "Claude Code"` | [desktop-dark](canon/journey/claude-code/sent--desktop-dark.webp) · [phone-dark](canon/journey/claude-code/sent--phone-dark.webp) |
| Connect (consent) | `step: "connect"`, `app: "Claude Code"` | [desktop-dark](canon/journey/claude-code/connect--desktop-dark.webp) · [phone-dark](canon/journey/claude-code/connect--phone-dark.webp) |
| Connecting | `step: "connecting"`, `app: "Claude Code"` | [desktop-dark](canon/journey/claude-code/connecting--desktop-dark.webp) · [phone-dark](canon/journey/claude-code/connecting--phone-dark.webp) |
| Connected, back to the app | `step: "handback"`, `app: "Claude Code"` | [desktop-dark](canon/journey/claude-code/handback--desktop-dark.webp) · [phone-dark](canon/journey/claude-code/handback--phone-dark.webp) |

### Home

| State | Board props | Images |
|---|---|---|
| Ready (map: a normal vault) | — | [desktop-dark](canon/home/ready--desktop-dark.webp) · [desktop-light](canon/home/ready--desktop-light.webp) · [phone-dark](canon/home/ready--phone-dark.webp) · [phone-light](canon/home/ready--phone-light.webp) |
| Read-only | `state: "readonly"` | [desktop-dark](canon/home/readonly--desktop-dark.webp) · [desktop-light](canon/home/readonly--desktop-light.webp) · [phone-dark](canon/home/readonly--phone-dark.webp) · [phone-light](canon/home/readonly--phone-light.webp) |
| Subscription ended | `state: "ended"` | [desktop-dark](canon/home/ended--desktop-dark.webp) · [desktop-light](canon/home/ended--desktop-light.webp) · [phone-dark](canon/home/ended--phone-dark.webp) · [phone-light](canon/home/ended--phone-light.webp) |
| App reviewer sign-in | `account: "reviewer"` | [desktop-dark](canon/home/reviewer--desktop-dark.webp) · [phone-dark](canon/home/reviewer--phone-dark.webp) |
| First day · no notes (map: none yet) | `fresh: true` | [desktop-dark](canon/home/fresh--desktop-dark.webp) · [desktop-light](canon/home/fresh--desktop-light.webp) · [phone-dark](canon/home/fresh--phone-dark.webp) · [phone-light](canon/home/fresh--phone-light.webp) |
| First note (map: one note) | `fresh: true`, `firstNote: true` | [desktop-dark](canon/home/first-note--desktop-dark.webp) · [phone-dark](canon/home/first-note--phone-dark.webp) |
| lost | `reach: "lost"` | [desktop-dark](canon/home/lost--desktop-dark.webp) · [phone-dark](canon/home/lost--phone-dark.webp) |
| trouble | `trouble: true` | [desktop-dark](canon/home/trouble--desktop-dark.webp) · [phone-dark](canon/home/trouble--phone-dark.webp) |
| export packing | `exportState: "packing"` | [desktop-dark](canon/home/export-packing--desktop-dark.webp) · [phone-dark](canon/home/export-packing--phone-dark.webp) |
| export ready | `exportState: "ready"` | [desktop-dark](canon/home/export-ready--desktop-dark.webp) · [phone-dark](canon/home/export-ready--phone-dark.webp) |
| export failed | `exportState: "failed"` | [desktop-dark](canon/home/export-failed--desktop-dark.webp) · [phone-dark](canon/home/export-failed--phone-dark.webp) |
| export expired | `exportState: "expired"` | [desktop-dark](canon/home/export-expired--desktop-dark.webp) · [phone-dark](canon/home/export-expired--phone-dark.webp) |
| storage nearly full | `storageUsedGb: 4.7` | [desktop-dark](canon/home/storage-nearly-full--desktop-dark.webp) · [phone-dark](canon/home/storage-nearly-full--phone-dark.webp) |
| storage full | `storageUsedGb: 5` | [desktop-dark](canon/home/storage-full--desktop-dark.webp) · [phone-dark](canon/home/storage-full--phone-dark.webp) |
| modal room | `openModal: "room"` | [desktop-dark](canon/home/modal-room--desktop-dark.webp) · [phone-dark](canon/home/modal-room--phone-dark.webp) |
| modal room done | `openModal: "room-done"` | [desktop-dark](canon/home/modal-room-done--desktop-dark.webp) · [phone-dark](canon/home/modal-room-done--phone-dark.webp) |
| modal import notes | `openModal: "import-notes"` | [desktop-dark](canon/home/modal-import-notes--desktop-dark.webp) · [phone-dark](canon/home/modal-import-notes--phone-dark.webp) |
| modal import pick | `openModal: "import-pick"` | [desktop-dark](canon/home/modal-import-pick--desktop-dark.webp) · [phone-dark](canon/home/modal-import-pick--phone-dark.webp) |
| modal import summary | `openModal: "import-summary"` | [desktop-dark](canon/home/modal-import-summary--desktop-dark.webp) · [phone-dark](canon/home/modal-import-summary--phone-dark.webp) |
| modal import running | `openModal: "import-running"` | [desktop-dark](canon/home/modal-import-running--desktop-dark.webp) · [phone-dark](canon/home/modal-import-running--phone-dark.webp) |
| modal import done | `openModal: "import-done"` | [desktop-dark](canon/home/modal-import-done--desktop-dark.webp) · [phone-dark](canon/home/modal-import-done--phone-dark.webp) |
| modal restore | `openModal: "restore"` | [desktop-dark](canon/home/modal-restore--desktop-dark.webp) · [phone-dark](canon/home/modal-restore--phone-dark.webp) |
| modal restore done | `openModal: "restore-done"` | [desktop-dark](canon/home/modal-restore-done--desktop-dark.webp) · [phone-dark](canon/home/modal-restore-done--phone-dark.webp) |
| modal email | `openModal: "email"` | [desktop-dark](canon/home/modal-email--desktop-dark.webp) · [phone-dark](canon/home/modal-email--phone-dark.webp) |
| modal email sent | `openModal: "email-sent"` | [desktop-dark](canon/home/modal-email-sent--desktop-dark.webp) · [phone-dark](canon/home/modal-email-sent--phone-dark.webp) |
| modal billing | `openModal: "billing"` | [desktop-dark](canon/home/modal-billing--desktop-dark.webp) · [phone-dark](canon/home/modal-billing--phone-dark.webp) |
| modal delete | `openModal: "delete"` | [desktop-dark](canon/home/modal-delete--desktop-dark.webp) · [phone-dark](canon/home/modal-delete--phone-dark.webp) |
| Map preview · a few notes | `mapVault: "few"` | [desktop-dark](canon/home/map-few--desktop-dark.webp) · [desktop-light](canon/home/map-few--desktop-light.webp) · [phone-dark](canon/home/map-few--phone-dark.webp) · [phone-light](canon/home/map-few--phone-light.webp) |
| Map preview · a large vault | `mapVault: "large"` | [desktop-dark](canon/home/map-large--desktop-dark.webp) · [phone-dark](canon/home/map-large--phone-dark.webp) |

### The map (viewer)

| State | Board props | Images |
|---|---|---|
| overview | `start: "overview"` | [desktop-dark](canon/viewer/overview--desktop-dark.webp) · [desktop-light](canon/viewer/overview--desktop-light.webp) · [phone-dark](canon/viewer/overview--phone-dark.webp) · [phone-light](canon/viewer/overview--phone-light.webp) |
| note | `start: "note"` | [desktop-dark](canon/viewer/note--desktop-dark.webp) · [desktop-light](canon/viewer/note--desktop-light.webp) · [phone-dark](canon/viewer/note--phone-dark.webp) · [phone-light](canon/viewer/note--phone-light.webp) |
| why | `start: "why"` | [desktop-dark](canon/viewer/why--desktop-dark.webp) · [phone-dark](canon/viewer/why--phone-dark.webp) |
| read | `start: "read"` | [desktop-dark](canon/viewer/read--desktop-dark.webp) · [desktop-light](canon/viewer/read--desktop-light.webp) · [phone-dark](canon/viewer/read--phone-dark.webp) · [phone-light](canon/viewer/read--phone-light.webp) |
| review | `start: "review"` | [desktop-dark](canon/viewer/review--desktop-dark.webp) · [phone-dark](canon/viewer/review--phone-dark.webp) |
| types | `start: "types"` | [desktop-dark](canon/viewer/types--desktop-dark.webp) · [phone-dark](canon/viewer/types--phone-dark.webp) |
| reviewed | `start: "reviewed"` | [desktop-dark](canon/viewer/reviewed--desktop-dark.webp) · [phone-dark](canon/viewer/reviewed--phone-dark.webp) |
| noresults | `start: "noresults"` | [desktop-dark](canon/viewer/noresults--desktop-dark.webp) · [phone-dark](canon/viewer/noresults--phone-dark.webp) |
| empty | `vault: "empty"` | [desktop-dark](canon/viewer/empty--desktop-dark.webp) · [phone-dark](canon/viewer/empty--phone-dark.webp) |
| few | `vault: "few"` | The export omits these images. Render `Viewer` with the listed props; do not substitute historical images. |
| large | `vault: "large"` | [desktop-dark](canon/viewer/large--desktop-dark.webp) · [phone-dark](canon/viewer/large--phone-dark.webp) |
| lost | `reach: "lost"` | [desktop-dark](canon/viewer/lost--desktop-dark.webp) · [phone-dark](canon/viewer/lost--phone-dark.webp) |
| r57 cluster labels | — | [image](canon/viewer/r57-cluster-labels.webp) |
| r57 hover focus | — | [image](canon/viewer/r57-hover-focus.webp) |
| r57 hover options | — | [image](canon/viewer/r57-hover-options.webp) |
| r57 ring options | — | [desktop](canon/viewer/r57-ring-options--desktop.webp) · [phone](canon/viewer/r57-ring-options--phone.webp) |

### Reference sheets (whole boards)

| State | Board props | Images |
|---|---|---|
| R42 Checkout States | board `R42-Checkout-States` | [image](canon/sheets/R42-Checkout-States.webp) |
| R28 Emails | board `R28-Emails` | [image](canon/sheets/R28-Emails.webp) |
| R41 Emails Phone | board `R41-Emails-Phone` | [image](canon/sheets/R41-Emails-Phone.webp) |
| R43 Getting In | board `R43-Getting-In` | [image](canon/sheets/R43-Getting-In.webp) |
| R43 Data Cases | board `R43-Data-Cases` | [image](canon/sheets/R43-Data-Cases.webp) |
| R43 Unreachable | board `R43-Unreachable` | [image](canon/sheets/R43-Unreachable.webp) |
| R43 Accessibility | board `R43-Accessibility` | [image](canon/sheets/R43-Accessibility.webp) |
| R44 Writing E | board `R44-Writing-E` | [image](canon/sheets/R44-Writing-E.webp) |
| R44 Writing E Light | board `R44-Writing-E-Light` | [image](canon/sheets/R44-Writing-E-Light.webp) |
| R52 Theme Control | board `R52-Theme-Control` | [image](canon/sheets/R52-Theme-Control.webp) |
