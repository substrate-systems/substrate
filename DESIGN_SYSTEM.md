# Substrate Design System v1

A restrained, systems-first design language for infrastructural products.

---

## Philosophy

Substrate's visual identity is **infrastructural, not decorative**. Every design decision serves clarity and longevity. The system is intentionally constrained to prevent visual drift across products and time.

**Core principles:**

- **Restraint over expression** — Fewer tokens, used consistently
- **Depth over decoration** — Motion and materials create space, not ornament
- **Clarity over cleverness** — Every element earns its place

---

## Color System

All colors are semantic. Use role-based tokens, not raw values.

### Backgrounds (dark to light)

| Token         | Value     | Usage                           |
| ------------- | --------- | ------------------------------- |
| `bg-base`     | `#050505` | Page background, deepest layer  |
| `bg-surface`  | `#0a0a0a` | Card/section backgrounds        |
| `bg-elevated` | `#111111` | Hover states, elevated surfaces |
| `bg-subtle`   | `#171717` | Subtle differentiation          |

### Foregrounds (bright to dim)

| Token          | Value     | Usage                       |
| -------------- | --------- | --------------------------- |
| `fg-primary`   | `#fafafa` | Headings, primary text      |
| `fg-secondary` | `#a3a3a3` | Body text, descriptions     |
| `fg-tertiary`  | `#525252` | Labels, captions, metadata  |
| `fg-muted`     | `#262626` | Disabled states, decorative |

### Borders

| Token             | Value                    | Usage                  |
| ----------------- | ------------------------ | ---------------------- |
| `border-subtle`   | `rgba(255,255,255,0.06)` | Section dividers       |
| `border-default`  | `rgba(255,255,255,0.10)` | Default borders        |
| `border-emphasis` | `rgba(255,255,255,0.20)` | Focus states           |
| `border-strong`   | `rgba(255,255,255,0.40)` | Hover states, emphasis |

### Accents

| Token              | Value                    | Usage                  |
| ------------------ | ------------------------ | ---------------------- |
| `accent-glow`      | `rgba(255,255,255,0.03)` | Ambient depth cues     |
| `accent-highlight` | `rgba(255,255,255,0.08)` | Interactive highlights |

---

## Typography

All text uses **Inter** with light weights for an architectural feel.

### Scale

| Token        | Size     | Weight | Tracking | Usage              |
| ------------ | -------- | ------ | -------- | ------------------ |
| `display-lg` | 3.5rem   | 300    | -0.02em  | Hero headlines     |
| `display`    | 2.5rem   | 300    | -0.02em  | Section headlines  |
| `display-sm` | 2rem     | 300    | -0.02em  | Large headings     |
| `heading-lg` | 1.5rem   | 300    | -0.01em  | Section titles     |
| `heading`    | 1.25rem  | 300    | -0.01em  | Subsection titles  |
| `heading-sm` | 1.125rem | 300    | 0        | Small headings     |
| `body-lg`    | 1.125rem | 300    | 0        | Lead paragraphs    |
| `body`       | 1rem     | 300    | 0        | Body text          |
| `body-sm`    | 0.875rem | 300    | 0        | Captions, metadata |
| `label`      | 0.75rem  | 400    | 0.2em    | Labels (uppercase) |
| `label-sm`   | 0.625rem | 400    | 0.2em    | Small labels       |

### Rules

- **Headings**: Light weight (300), negative tracking
- **Body**: Light weight (300), normal tracking
- **Labels**: Normal weight (400), wide tracking, uppercase
- Never use bold (700) or heavier weights
- Never use decorative fonts

---

## Spacing

An architectural scale based on 8px. Limited options enforce consistency.

| Token | Value | Usage           |
| ----- | ----- | --------------- |
| `0`   | 0     | Reset           |
| `1`   | 4px   | Micro gaps      |
| `2`   | 8px   | Tight spacing   |
| `3`   | 12px  | Small gaps      |
| `4`   | 16px  | Default spacing |
| `6`   | 24px  | Medium spacing  |
| `8`   | 32px  | Large spacing   |
| `12`  | 48px  | Section padding |
| `16`  | 64px  | Large sections  |
| `24`  | 96px  | Major sections  |
| `32`  | 128px | Hero spacing    |
| `40`  | 160px | Maximum spacing |

### Rules

- Use the scale exclusively — no arbitrary values
- Vertical rhythm matters more than horizontal
- Generous whitespace signals quality

---

## Motion

Motion is **physical, not decorative**. Elements should feel like they have mass and settle into place.

### Durations

| Token      | Value  | Usage                      |
| ---------- | ------ | -------------------------- |
| `micro`    | 150ms  | Micro-interactions, hovers |
| `default`  | 300ms  | Standard transitions       |
| `emphasis` | 600ms  | Important state changes    |
| `entrance` | 900ms  | Page entrance animations   |
| `slow`     | 1200ms | Background/ambient motion  |

### Easings

| Token       | Value                            | Feel                     |
| ----------- | -------------------------------- | ------------------------ |
| `out-expo`  | `cubic-bezier(0.16, 1, 0.3, 1)`  | Quick start, slow settle |
| `out-quart` | `cubic-bezier(0.25, 1, 0.5, 1)`  | Smooth deceleration      |
| `out`       | `cubic-bezier(0.33, 1, 0.68, 1)` | Standard ease-out        |
| `in-out`    | `cubic-bezier(0.65, 0, 0.35, 1)` | Symmetric, breathing     |

### Entrance Hierarchy

Elements enter in sequence to create depth perception:

1. **Background/Grid** — 1.2s, establishes spatial context
2. **Primary content** — 0.9s @ 0.3s delay
3. **Secondary content** — 0.8s @ 0.5s delay
4. **Tertiary content** — 0.7s @ 0.7s delay
5. **Indicators** — 0.6s @ 1.2s delay

### Rules

- Always respect `prefers-reduced-motion`
- Parallax: max 8px offset, restrained but perceptible
- Magnetic effects: max 6px offset
- No bouncing, no overshoot, no playful motion
- Motion should feel inevitable, not surprising

---

## Materials

Metallic textures add depth without decoration. They are **background-only**.

### Available Materials

| Token                | File                       | Character                 |
| -------------------- | -------------------------- | ------------------------- |
| `material-curve`     | `metal-curve-dark.jpg`     | Flowing, organic          |
| `material-lattice`   | `metal-lattice-dark.jpg`   | Structured, grid-like     |
| `material-structure` | `metal-structure-dark.jpg` | Industrial, architectural |

### Usage Rules

- **Opacity**: 2-4% maximum
- **Blend mode**: `luminosity` to remove color cast
- **Masking**: Always use radial gradient vignette
- **Animation**: Subtle breathing (8s cycle) if motion allowed
- **Never**: tile, repeat, use as decoration, draw attention

### Implementation

```html
<div class="material-overlay material-breathe bg-material-structure" aria-hidden="true" />
```

The `.material-overlay` class handles:

- Full coverage (`inset: 0`)
- Proper opacity and blend mode
- Vignette mask via `::after`
- Pointer events disabled

---

## Accessibility

### Color Contrast

- `fg-primary` on `bg-base`: 19.5:1 ✓
- `fg-secondary` on `bg-base`: 8.5:1 ✓
- `fg-tertiary` on `bg-base`: 4.6:1 ✓ (large text only)

### Reduced Motion

All motion respects `prefers-reduced-motion: reduce`:

- Animations complete instantly
- Transitions disabled
- Parallax disabled
- Material breathing disabled

### Focus States

Interactive elements use `border-emphasis` for visible focus indication.

---

## Implementation

### Tailwind Classes

```tsx
// Backgrounds
className = "bg-bg-base";
className = "bg-bg-surface";

// Text
className = "text-fg-primary text-display";
className = "text-fg-secondary text-body-lg";
className = "text-fg-tertiary text-label uppercase";

// Borders
className = "border border-border-default";
className = "border-t border-border-subtle";

// Spacing
className = "py-32 px-6"; // 128px vertical, 24px horizontal
className = "mb-12"; // 48px margin bottom
className = "gap-6"; // 24px gap

// Motion
className = "transition-colors duration-default ease-out";
className = "transition-transform duration-emphasis ease-out-expo";

// Layout
className = "max-w-content mx-auto"; // 768px centered
```

### CSS Variables

Available in `globals.css` for JavaScript access:

```css
var(--bg-base)
var(--fg-primary)
var(--border-default)
var(--ease-out-expo)
var(--duration-default)
```

---

## Extending the System

When adding new components:

1. **Use existing tokens** — Never introduce new colors or spacing values
2. **Follow the hierarchy** — Background → Content → Interactive
3. **Respect motion rules** — Check reduced motion, use approved easings
4. **Test contrast** — Ensure WCAG AA compliance
5. **Document deviations** — If a new token is truly needed, add it here first

---

_Substrate Design System v1 — Locked December 2024_
