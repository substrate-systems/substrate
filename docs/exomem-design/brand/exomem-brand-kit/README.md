# Exomem brand kit · Dot E

The Exomem mark is the **Dot E**: a 5 × 7 dot grid in the shape of an E, with one lit middle row. Everything is kept;
what matters now is lit. Its motion is the signature: the row waves while it works, and the whole E lights when it
connects.

## What's here

| Folder | Files | Use |
|---|---|---|
| `mark/` | `exomem-mark.svg`, `-on-light`, `-small`, `-small-on-light`, `-mono-white`, `-mono-black` | The mark alone. Use `-small` below 32 px. Mono versions are for single-ink print, embossing and watermarks only. |
| `lockup/` | `exomem-wordmark-initial.svg` (**the logo**: the Dot E is the capital E of *Exomem*), `-small` (below 22 px text), `-mono`; `exomem-lockup.svg` (horizontal), `-stacked`, `exomem-wordmark.svg`; each with `-on-light` | Every file's viewBox hugs its ink exactly, so it sits true in any container. Type is IBM Plex Mono 500 converted to outlines: no font needed. |
| `icons/` | `favicon.ico` (16/32/48), `favicon.svg`, `favicon-16/32/48.png`, `apple-touch-icon.png`, `icon-192/512.png`, `icon-maskable-512.png`, `site.webmanifest` | Browser tabs, home screens, PWA. Favicons sit on a dark tile so they read on light and dark tab bars. The 16 px icon is pixel-exact. |
| `social/` | `og-image.png` (1200 × 630) | Link previews. |
| `email/` | `band-arrive/live/readonly/kept/fading/gone.png` (1200 × 240, shown at 600) | The web band at the top of each email, one per account state. |
| `react/` | `ExomemMark.tsx` | The first living mark (idle, recall, save, conn, off). Superseded in round 44 by `Mark` and `Wordmark` in the component library (`design-system/`), which add the writing E for progress. |

## Colours

Phosphor amber `#FFB000` on warm black `#0A0908`, text `#ECE9E2`. On light (paper `#FAF8F4`): text `#1A1814`, amber `#A86E00` for the lit row, lines and dots (`#A06600` when amber is small text). These match the locked design system (tokens.css). The `-on-light` files were recoloured to them on 13 Oct 2026; the first kit (Ash `#E7E3DC`, `#1B1916`, `#A04800`) is kept in `../_archive/`.

## The logo and the icon

- **The wordmark is the logo** (`exomem-wordmark-initial`): wherever there is room for a name.
- **The Dot E alone is the icon**: favicons, app icons, the connect tile, avatars.
- **Never both side by side**: with the E inside the word, an icon next to it says E twice. The horizontal lockup is only for places that demand icon and name in one image.

## Rules

- Amber marks the live part only: the middle row at rest, the whole E when the account is live (paid, connected). While working (paying, setting up), the rows light one after another in amber.
- One colour. Never a gradient, never two accents, never outlined, never a constant glow.
- The middle row has four dots, not five. The shorter arm is what makes it read as an E and not a grid.
- App icons are always the dark tile, even on light pages. On light pages without a tile, use `-on-light`.
- Clear space: at least the height of the middle row on every side of a lockup.
- Reduced motion: states still read through colour and shape.

## Head tags

```html
<link rel="icon" href="/exomem/icons/favicon.ico" sizes="any">
<link rel="icon" href="/exomem/icons/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/exomem/icons/apple-touch-icon.png">
<link rel="manifest" href="/exomem/icons/site.webmanifest">
<meta property="og:image" content="/exomem/social/og-image.png">
```
