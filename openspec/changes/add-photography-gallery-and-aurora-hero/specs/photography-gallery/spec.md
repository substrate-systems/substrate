## ADDED Requirements

### Requirement: Photography index

The site SHALL serve a statically generated page at `/photography` that presents Hugo Ander Kivi's photography as a quiet personal creative practice and lists every published curated series.

#### Scenario: Initial index lists Iceland aurora

- **WHEN** a visitor loads `/photography`
- **THEN** the page contains a series entry linking to `/photography/iceland-aurora`
- **AND** the entry identifies the series as Iceland aurora photography from March 2026

#### Scenario: Index is not a product catalogue

- **WHEN** the photography index is rendered
- **THEN** it does not present pricing, lead capture, client services, comments, likes, or product calls to action

### Requirement: Curated Iceland aurora series

The site SHALL serve a statically generated editorial gallery at `/photography/iceland-aurora` containing an ordered selection of 12–18 photographs from Hugo's March 2026 Iceland aurora work.

The sequence MUST include both colour and black-and-white work, MUST begin from recognisable place/aurora context, MUST move into the abstract motion studies, and MUST close with `20260323_012607_A7RV_02136.jpg` returning the viewer to the Iceland landscape.

#### Scenario: Gallery preserves editorial order

- **WHEN** the Iceland gallery is rendered
- **THEN** its images appear in the exact order declared by the static series manifest

#### Scenario: Both treatments are represented

- **WHEN** the full Iceland sequence is inspected
- **THEN** it contains at least one colour image and at least one black-and-white image

#### Scenario: Near duplicates are curated out

- **WHEN** colour and black-and-white treatments of the same capture both appear
- **THEN** the manifest documents their intentional relationship through adjacency or an explicit pairing

### Requirement: Static typed series data

Published photography series SHALL be defined by typed static metadata containing the series slug, title, date/location framing, description, cover image, and an ordered image collection. Each image SHALL include its path, intrinsic dimensions, and alt text; a short caption is optional.

#### Scenario: Build validates image metadata

- **WHEN** gallery data is tested or built
- **THEN** every image path is unique within its series, resolves to a project asset, has positive dimensions, and has non-empty alt text

### Requirement: Editorial responsive presentation

The Iceland series SHALL use an image-first linear presentation on a near-black canvas. Large single frames and generous spacing SHALL be the default. Paired frames MAY be used only when declared intentionally in series data.

#### Scenario: Mobile preserves sequence and image integrity

- **WHEN** the gallery is viewed at a portrait-mobile viewport
- **THEN** every photograph remains visible in editorial order without horizontal page scrolling or an unintended destructive crop

#### Scenario: Images do not cause layout shift

- **WHEN** gallery images load
- **THEN** their intrinsic aspect-ratio space is reserved before the image bytes complete

### Requirement: Accessible full-screen viewer

A visitor SHALL be able to open any gallery photograph through a semantic button into a labelled modal full-screen viewer and navigate the ordered series using visible controls, a keyboard, and horizontal touch/pointer swipe input. Viewer navigation SHALL NOT wrap from the last photograph to the first or from the first to the last. While open, the viewer SHALL contain focus, make the underlying page non-interactive, lock background scrolling, and expose the current position as “image N of total.”

#### Scenario: Keyboard viewer flow

- **WHEN** a keyboard user activates a photograph
- **THEN** focus moves into the viewer
- **AND** the viewer exposes labelled modal-dialog semantics and contains focus
- **AND** the underlying page cannot be interacted with or scrolled
- **AND** previous/next controls and arrow keys navigate the series
- **AND** the previous control is disabled on the first image and the next control is disabled on the last image
- **AND** assistive technology can determine the current image position in the sequence
- **AND** `Escape` closes the viewer
- **AND** focus returns to the photograph that opened it

#### Scenario: Viewer is optional enhancement

- **WHEN** viewer scripting is unavailable or the visitor never opens it
- **THEN** the complete ordered series remains viewable as normal page content

#### Scenario: Reduced motion

- **WHEN** the visitor prefers reduced motion
- **THEN** the viewer does not use non-essential movement transitions

### Requirement: Gallery loading discipline

The gallery SHALL mark only the first in-flow series photograph as priority/eager. Every later in-flow photograph SHALL remain lazy loaded. The unopened viewer SHALL NOT preload the complete series; while open it MAY preload the current photograph and at most the immediately previous and next photographs.

#### Scenario: Initial series request is bounded

- **WHEN** `/photography/iceland-aurora` first loads without scrolling
- **THEN** only the first in-flow series photograph is marked priority/eager
- **AND** the unopened viewer does not request all viewer-sized series derivatives
