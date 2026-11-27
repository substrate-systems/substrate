/**
 * How many notes a digest holds (`send-monthly-whats-new-digest`, D2 and D3). No imports, so the
 * operator page reads it. The months table's CHECK in migration 0097 spells the same bounds.
 */

export const MIN_PICKS = 3;
export const MAX_PICKS = 6;
