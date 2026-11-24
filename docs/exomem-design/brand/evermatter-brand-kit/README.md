# Evermatter brand kit · Dot E

The Evermatter logo is the word Evermatter with the **Dot E** as its capital and the rest in IBM Plex Mono 500 lowercase, the same rule as the Exomem logo. The Dot E is a 5 × 7 dot grid in the shape of an E, with one lit middle row. Its motion is the signature: the row waves while it works, and the whole E lights when it connects.

This kit replaces the Exomem kit, which stays untouched beside it in `../exomem-brand-kit/` and `../_archive/`. The mark, its states, the colours, the icons and the email bands keep their art. The word and every file that draws it are new.

The files are served from `public/evermatter/`. This folder holds this README and `_render/`: the generators and the social card's SVG source.

## What's here (`public/evermatter/`)

| Folder | Files | Use |
|---|---|---|
| `lockup/` | `evermatter-wordmark-initial.svg` (**the logo**), `-small` (below 22 px cap height), `-mono`; `evermatter-lockup.svg` (horizontal), `-stacked`, `evermatter-wordmark.svg` (plain type); each with `-on-light` | Type is outlined: no font needed. Every viewBox hugs its ink, and each file's width and height equal its viewBox. |
| `mark/` | `evermatter-mark.svg`, `-on-light`, `-small`, `-small-on-light`, `-mono-white`, `-mono-black` | The mark alone. Use `-small` below 32 px. Same art as the Exomem kit. |
| `icons/` | `favicon.ico` (16/32/48), `favicon.svg`, `favicon-16/32/48.png`, `apple-touch-icon.png`, `icon-192/512.png`, `icon-maskable-512.png`, `site.webmanifest` | Same art as the Exomem kit. The manifest names Evermatter and serves from `/evermatter/icons/`. |
| `social/` | `og-image.png` (1200 × 630); source `_render/og-image.svg` | Link previews. The logo is the initial wordmark, not the mark beside the name. |
| `email/` | `wordmark-dark.png`, `wordmark-light.png` (399 × 48, shown at 24 px); `band-<state>[-dark|-light].png` (18 bands, unchanged) | Email header and the web band per account state. |

## Vertical alignment

The Dot E, the lowercase letters and the two t letters share one baseline, and the Dot E and the t letters share one cap line.

- The kit draws type at 40 units per em. Plex Mono cap height is 698/1000 em, which is 27.92 units. The Plex Mono t reaches the full cap height.
- In the initial wordmark the Dot E's top dots and the t tops touch the cap line. The Dot E's bottom dots and the letters stand on the baseline. The lit middle row sits at half the cap height.
- In the horizontal lockup the mark spans the same two lines.
- Measured deviation in every file: at most 0.002 units.

## Rules

- The initial wordmark is the logo wherever the name fits. The Dot E alone is the icon. Never put both side by side; the horizontal lockup is only for places that demand icon and name in one image.
- Amber marks the live part only: the middle row at rest, the whole E when the account is live. Never decoration.
- The middle row has four dots, not five.
- App icons always use the dark tile, even on light pages.
- One public name: Evermatter.
- Clear space: the height of the middle row on every side.
- Reduced motion: states read through colour and shape; the ripple does not move.

## Colours

Phosphor amber `#FFB000` on warm black `#0A0908`, text `#ECE9E2`. On light (paper `#FAF8F4`): text `#1A1814`, amber `#A86E00`.

## How the files were made

The lockups come from the Exomem kit's files. `_render/kitgen.py` outlines the new word from IBM Plex Mono Medium (fonts from Google Fonts, OFL, not committed: put `IBMPlexMono-Medium.ttf`, `IBMPlexSans-Medium.ttf` and `Inter-var.ttf` in a `fonts/` folder beside `_render/`). For each file, it recovers the old word's scale, origin and baseline by fitting the old outline. It draws the new word with the same placement, then rebuilds the viewBox to hug the ink. The same outliner reproduces the Exomem "xomem" path exactly, which proves the placement. `_render/og.py` builds the social card with HarfBuzz-shaped, outlined Inter text.
