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

The fonts come from Google Fonts (OFL) and are not committed. Put `IBMPlexMono-Medium.ttf` and `Inter-var.ttf` in a `fonts/` folder beside `_render/`. The Python steps need `fonttools` and `uharfbuzz`.

1. Run `python _render/kitgen.py <public/exomem/lockup> <out>`. For each Exomem lockup, it recovers the old word's scale, origin and baseline by fitting the old outline, and asserts that the fit redraws the old word within 0.01 units. It draws the new word with the same placement and rebuilds the viewBox to hug the ink. It prints each file's distance from the cap line and the baseline.
2. Run `python _render/og.py <exomem-brand-kit/_render/raster.json> <out>/evermatter-wordmark-initial.svg _render/og-image.svg`. It builds the social card with HarfBuzz-shaped, outlined Inter text. The logo's cap height is 88 px, so the baseline falls on a whole pixel (y = 354).
3. Render the PNGs with sharp (libvips) from the SVGs, flattened on their ground:
   - `email/wordmark-dark.png` and `-light.png`: the initial wordmark at 1200 dpi, resized to 48 px tall, on `#0A0908` / `#FAF8F4`.
   - `social/og-image.png`: `_render/og-image.svg` at 72 dpi, 1200 × 630.
4. Strip the `pHYs` chunk from each PNG. A density tag makes some mail clients size the image from it; the Exomem files carry none.
