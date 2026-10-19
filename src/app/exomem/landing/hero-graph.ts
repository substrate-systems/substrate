// The hero's illustration uses invented travel notes to answer "where are we staying
// in Reykjavík?". The same notes and links are laid out wide on desktop (Landing-Page board)
// and tall on a phone (R20-Mobile); the coordinates are the boards'. The vault is a
// drawing, not anyone's data.

export type NoteRole =
  | "note"
  /** A person or a place: drawn as a square. */
  | "entity"
  /** The old plan the recall strikes through. */
  | "superseded"
  /** A note the recall reads, lit in order 1 → 2 → 3. */
  | "answer";

export type HeroNote = { path: string; role: NoteRole; answer?: 1 | 2 | 3 };

export const HERO_NOTES: readonly HeroNote[] = [
  { path: "trip/flights.md", role: "note" },
  { path: "trip/car-rental.md", role: "note" },
  { path: "trip/itinerary.md", role: "answer", answer: 2 },
  { path: "Maria", role: "entity" },
  { path: "trip/airbnb-laugavegur.md", role: "superseded" },
  { path: "trip/hotel-borg.md", role: "answer", answer: 3 },
  { path: "Reykjavík", role: "entity" },
  { path: "sources/booking-email.md", role: "answer", answer: 1 },
  { path: "trip/budget.md", role: "note" },
  { path: "notes/restaurants.md", role: "note" },
  { path: "sources/chat-with-maria.md", role: "note" },
  { path: "trip/packing-list.md", role: "note" },
];

/** The note the answer settles on, and the plan it replaced. */
export const ANSWER_NOTE = 5;
export const SUPERSEDED_NOTE = 4;

/** A note's name without its folder, as the phone labels it. */
export function noteName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

type LabelBounds = { x: number; y: number; width: number; height: number };

/** Keep a measured on-demand label inside the drawing and clear of persistent text. */
export function heroLabelOffset(
  bounds: { width: number; height: number },
  label: LabelBounds,
  obstacles: readonly LabelBounds[],
  halo: number
): { x: number; y: number } {
  const padding = halo / 2;
  const x = Math.max(padding, Math.min(label.x, bounds.width - padding - label.width)) - label.x;
  const left = label.x + x;
  const right = left + label.width;
  const candidates = [
    0,
    ...obstacles.flatMap((other) => [
      other.y - halo - label.y - label.height,
      other.y + other.height + halo - label.y,
    ]),
  ].sort((a, b) => Math.abs(a) - Math.abs(b));
  const y =
    candidates.find((offset) => {
      const top = label.y + offset;
      const bottom = top + label.height;
      return (
        top >= padding &&
        bottom <= bounds.height - padding &&
        obstacles.every(
          (other) =>
            right <= other.x - halo ||
            left >= other.x + other.width + halo ||
            bottom <= other.y - halo ||
            top >= other.y + other.height + halo
        )
      );
    }) ?? 0;
  return { x, y };
}

export type LinkKind = "relates" | "supports" | "refines" | "contradicts" | "supersedes";

/** Paint order: the quiet links first, then the recall's typed links. */
export const HERO_LINKS: readonly { from: number; to: number; kind: LinkKind }[] = [
  { from: 0, to: 1, kind: "relates" },
  { from: 1, to: 2, kind: "relates" },
  { from: 3, to: 0, kind: "relates" },
  { from: 3, to: 4, kind: "relates" },
  { from: 0, to: 4, kind: "relates" },
  { from: 2, to: 6, kind: "relates" },
  { from: 5, to: 6, kind: "relates" },
  { from: 3, to: 8, kind: "relates" },
  { from: 8, to: 7, kind: "relates" },
  { from: 10, to: 11, kind: "relates" },
  { from: 11, to: 9, kind: "relates" },
  { from: 9, to: 6, kind: "relates" },
  { from: 8, to: 10, kind: "relates" },
  { from: 7, to: 5, kind: "supports" },
  { from: 7, to: 4, kind: "contradicts" },
  { from: 2, to: 5, kind: "refines" },
  { from: 4, to: 5, kind: "supersedes" },
];

type Label = {
  x: number;
  y: number;
  anchor?: "start" | "middle";
  tone: "ink" | "muted" | "amber";
  /** Phone: the name shows only while the note is hovered or tapped. */
  onDemand?: boolean;
};

export type HeroLayout = {
  width: number;
  height: number;
  /** The faint dot grid behind the web: first dot and spacing. */
  gridStart: number;
  notes: readonly { x: number; y: number; label: Label }[];
  /** Note marks and their sizes. */
  noteRadius: number;
  noteOpacity: number;
  answerRadius: Readonly<Record<1 | 2 | 3, number>>;
  haloRadius: number;
  entitySize: number;
  entityStroke: number;
  supersededRadius: number;
  supersededStroke: number;
  hitRadius: number;
  ringRadius: number;
  ringStroke: number;
  /** Labels: the size of names always shown, of names shown on demand, and the halo behind the text. */
  labelSize: number;
  onDemandLabelSize: number;
  labelHalo: number;
  /** The default label opacity for muted names (desktop dims them a little). */
  mutedLabelOpacity: number;
  /** Stroke widths of the typed links. */
  supportsWidth: number;
  refinesWidth: number;
  contradictsWidth: number;
  supersedesWidth: number;
  /** The supersedes link is a drawn curve with its own arrowhead and name. */
  supersedes: {
    d: string;
    length: number;
    arrow: string;
    label: { x: number; y: number; anchor: "start" | "middle"; size: number };
  };
  /** The line struck through the superseded note's name. */
  strike: { x1: number; x2: number; y: number; width: number };
};

export const DESKTOP_LAYOUT: HeroLayout = {
  width: 490,
  height: 420,
  gridStart: 14,
  notes: [
    { x: 130, y: 92, label: { x: 130, y: 81, tone: "muted" } },
    { x: 262, y: 80, label: { x: 262, y: 69, tone: "muted" } },
    { x: 388, y: 112, label: { x: 388, y: 101, tone: "muted" } },
    { x: 58, y: 170, label: { x: 58, y: 159, tone: "muted" } },
    { x: 158, y: 220, label: { x: 166, y: 237, tone: "muted" } },
    { x: 330, y: 196, label: { x: 344, y: 214, anchor: "start", tone: "amber" } },
    { x: 434, y: 240, label: { x: 434, y: 229, tone: "muted" } },
    { x: 250, y: 288, label: { x: 250, y: 306, tone: "ink" } },
    { x: 90, y: 306, label: { x: 90, y: 322, tone: "muted" } },
    { x: 380, y: 326, label: { x: 380, y: 342, tone: "muted" } },
    { x: 156, y: 370, label: { x: 156, y: 386, tone: "muted" } },
    { x: 312, y: 380, label: { x: 312, y: 396, tone: "muted" } },
  ],
  noteRadius: 3.2,
  noteOpacity: 0.35,
  answerRadius: { 1: 4, 2: 3.6, 3: 5 },
  haloRadius: 12,
  entitySize: 7,
  entityStroke: 1,
  supersededRadius: 4,
  supersededStroke: 1.3,
  hitRadius: 16,
  ringRadius: 10,
  ringStroke: 1.2,
  labelSize: 9.5,
  onDemandLabelSize: 9.5,
  labelHalo: 3.5,
  mutedLabelOpacity: 0.8,
  supportsWidth: 2,
  refinesWidth: 1.4,
  contradictsWidth: 1.2,
  supersedesWidth: 1.6,
  supersedes: {
    d: "M 170 214 Q 245 158 324.2 193.4",
    length: 170,
    arrow: "M 319.8 187.2 L 324.2 193.4 L 316.5 194.5",
    label: { x: 208, y: 168, anchor: "start", size: 9 },
  },
  strike: { x1: 94.8, x2: 237.2, y: 234, width: 1 },
};

export const PHONE_LAYOUT: HeroLayout = {
  width: 358,
  height: 410,
  gridStart: 12,
  notes: [
    { x: 58, y: 46, label: { x: 58, y: 34, tone: "ink", onDemand: true } },
    { x: 186, y: 28, label: { x: 186, y: 16, tone: "ink", onDemand: true } },
    { x: 300, y: 64, label: { x: 276, y: 46, tone: "ink" } },
    { x: 26, y: 128, label: { x: 26, y: 116, tone: "ink", onDemand: true } },
    { x: 86, y: 196, label: { x: 92, y: 220, tone: "muted" } },
    { x: 262, y: 176, label: { x: 262, y: 204, tone: "amber" } },
    { x: 334, y: 214, label: { x: 308, y: 238, anchor: "middle", tone: "ink", onDemand: true } },
    { x: 174, y: 292, label: { x: 174, y: 318, tone: "ink" } },
    { x: 36, y: 300, label: { x: 36, y: 288, tone: "ink", onDemand: true } },
    { x: 310, y: 326, label: { x: 284, y: 314, tone: "ink", onDemand: true } },
    { x: 100, y: 372, label: { x: 100, y: 360, tone: "ink", onDemand: true } },
    { x: 236, y: 384, label: { x: 236, y: 372, tone: "ink", onDemand: true } },
  ],
  noteRadius: 3.6,
  noteOpacity: 0.32,
  answerRadius: { 1: 5, 2: 4.4, 3: 6.5 },
  haloRadius: 14,
  entitySize: 8,
  entityStroke: 1.1,
  supersededRadius: 5,
  supersededStroke: 1.5,
  hitRadius: 18,
  ringRadius: 12,
  ringStroke: 1.3,
  labelSize: 13,
  onDemandLabelSize: 12,
  labelHalo: 5,
  mutedLabelOpacity: 1,
  supportsWidth: 2.2,
  refinesWidth: 1.6,
  contradictsWidth: 1.3,
  supersedesWidth: 1.7,
  supersedes: {
    d: "M 96 186 Q 172 112 253.9 170.2",
    length: 190,
    arrow: "M 250.0 162.6 L 253.9 170.2 L 245.4 169.1",
    label: { x: 172, y: 128, anchor: "middle", size: 11.5 },
  },
  strike: { x1: 14, x2: 170, y: 216, width: 1.2 },
};
