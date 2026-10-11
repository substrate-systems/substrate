// The Dot E, as drawn in the boards (Journey-Page and Viewer headers): 18 dots on a
// 48 × 48 grid. The ink dots are in reading order (top row, upper stem, lower stem,
// bottom row); the lit dots are the middle row, the one row that may glow amber.
// Never redraw it: these are the boards' coordinates.

export const DOT_E_RADIUS = 2.2;

export const DOT_E_INK: readonly (readonly [number, number])[] = [
  [13.6, 8.4],
  [18.8, 8.4],
  [24, 8.4],
  [29.2, 8.4],
  [34.4, 8.4],
  [13.6, 13.6],
  [13.6, 18.8],
  [13.6, 29.2],
  [13.6, 34.4],
  [13.6, 39.6],
  [18.8, 39.6],
  [24, 39.6],
  [29.2, 39.6],
  [34.4, 39.6],
];

export const DOT_E_LIT: readonly (readonly [number, number])[] = [
  [13.6, 24],
  [18.8, 24],
  [24, 24],
  [29.2, 24],
];
