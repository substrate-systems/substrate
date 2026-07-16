## ADDED Requirements

### Requirement: Authored aurora hero background

The homepage hero SHALL use a web derivative of `20260323_012442_A7RV_02129-3.jpg`, photographed and edited by Hugo Ander Kivi, instead of the stock `metal-structure-dark.jpg` background.

The hero treatment SHALL preserve the canonical Substrate wordmark and copy as foreground elements. Its image crop, dimming, local gradient, vignette, noise, and optional parallax SHALL be tuned together for the photograph and MAY differ from the previous material overlay values.

#### Scenario: Desktop hero remains authored and legible

- **WHEN** the homepage is viewed at a representative desktop viewport
- **THEN** the aurora structure remains visibly recognisable as the hero atmosphere
- **AND** the wordmark, primary tagline, and secondary tagline remain effortlessly legible

#### Scenario: Portrait-mobile crop is art-directed

- **WHEN** the homepage is viewed at a portrait-mobile viewport
- **THEN** the hero uses a reviewed crop/object position that retains a meaningful part of the aurora composition
- **AND** the foreground content is not obscured by a bright region

#### Scenario: Reduced motion hero

- **WHEN** the visitor prefers reduced motion
- **THEN** the hero renders a static final image treatment without parallax

### Requirement: Explicit continuation control

The homepage hero SHALL provide a visible, clickable `Explore ↓` control near its lower edge that navigates to `#content` on the first meaningful content section below the hero.

#### Scenario: Scroll continuation is understandable

- **WHEN** a visitor sees the full-screen hero
- **THEN** the text `Explore` and a downward directional cue make continuation below the fold explicit without relying on an unlabeled decorative line

#### Scenario: Continuation control is accessible

- **WHEN** a keyboard or touch user interacts with `Explore ↓`
- **THEN** the control has an accessible name, visible keyboard focus, and at least a 44×44 CSS-pixel interaction target

#### Scenario: Reduced-motion scroll cue

- **WHEN** the visitor prefers reduced motion
- **THEN** the control remains understandable and usable without a movement animation

### Requirement: Product-thesis hero copy

The homepage hero SHALL retain `A foundational systems company.` as its primary positioning line and SHALL use `Owned machines. Durable memory. Source-grounded AI.` as its secondary line.

#### Scenario: Hero communicates the product thesis

- **WHEN** a visitor reads the hero foreground content
- **THEN** the company category remains clear in the primary line
- **AND** the secondary line names owned machines, durable memory, and source-grounded AI without adding product-detail copy to the hero

#### Scenario: Product thesis remains subordinate and responsive

- **WHEN** the hero is viewed at desktop, tablet, or portrait-mobile breakpoints
- **THEN** the secondary line may wrap without competing with the wordmark or primary line
- **AND** it does not overlap or crowd the `Explore ↓` control

### Requirement: Continuity-led homepage narrative

The first meaningful content below the hero SHALL state that software should leave people with more control and SHALL frame Substrate as building systems for continuity across machines, knowledge, and tool memory.

The homepage SHALL replace the current abstract axiom list with the following ordered statements:

1. `Your setup should survive the machine.`
2. `Your memory should outlive the session.`
3. `Your AI should show its sources.`

The product section SHALL preserve the order Q, Endstate, Exomem and SHALL describe Q as source-grounded AI for content libraries, Endstate as local-first Windows setup and restore, and Exomem as durable agent memory built on owned Markdown.

#### Scenario: Narrative connects worldview to products

- **WHEN** a visitor continues below the hero
- **THEN** the thesis appears before the three ordered continuity statements
- **AND** the product section follows with descriptions that make the Q, Endstate, and Exomem mapping concrete

#### Scenario: Homepage remains product-first

- **WHEN** the homepage narrative is inspected
- **THEN** products and the shared systems thesis drive the page
- **AND** B2B contracting, photography, and writing are not presented as homepage products

### Requirement: Energy-resolving motion system

The below-fold narrative SHALL use a restrained monochrome motion sequence in which a fine structural line connects the thesis to the three ordered statements. Statement activation SHALL use opacity, foreground contrast, and small positional changes rather than decorative effects.

The sequence SHALL remain in normal document flow and SHALL NOT pin the viewport or require the animation to finish before the visitor can continue. Product interactions MAY extend a hairline, increase contrast, and move a directional arrow by a few pixels.

#### Scenario: Motion adds a memorable structural sequence

- **WHEN** a visitor scrolls through the homepage with motion enabled
- **THEN** the thesis and structural line reveal in sequence
- **AND** each continuity statement becomes visually active as the structural progression reaches it
- **AND** the visitor can continue scrolling naturally at every point

#### Scenario: Reduced motion preserves the complete narrative

- **WHEN** the visitor prefers reduced motion
- **THEN** the thesis, structural line, continuity statements, and products render in their complete static state
- **AND** no content or relationship depends on an animation playing

### Requirement: Authored hero metadata and social treatment

Public asset metadata and attribution documentation SHALL identify Hugo Ander Kivi as the photographer of the active aurora hero and SHALL NOT continue to identify Adrien Olichon/Pexels as the active homepage hero author. The default Substrate `/api/og` image SHALL use the authored aurora visual treatment rather than the retired stock hero texture.

#### Scenario: Root metadata reflects current hero authorship

- **WHEN** the homepage metadata and attribution documentation are inspected
- **THEN** Hugo Ander Kivi is identified as the active hero photographer
- **AND** Adrien Olichon/Pexels is not described as the active hero source

#### Scenario: Default OG treatment matches the homepage identity

- **WHEN** `/api/og` renders its default 1200×630 image
- **THEN** it uses the authored aurora asset with readable Substrate foreground content
