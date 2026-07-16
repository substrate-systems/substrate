export type ViewerDirection = -1 | 0 | 1;

export function boundedViewerIndex(
  currentIndex: number,
  direction: Exclude<ViewerDirection, 0>,
  total: number
): number {
  if (total <= 0) return 0;
  return Math.min(total - 1, Math.max(0, currentIndex + direction));
}

export function adjacentImageIndices(currentIndex: number, total: number): number[] {
  if (total <= 0) return [];
  const boundedIndex = Math.min(total - 1, Math.max(0, currentIndex));
  return [boundedIndex - 1, boundedIndex, boundedIndex + 1].filter(
    (index) => index >= 0 && index < total
  );
}

export function swipeNavigationDirection(
  startX: number,
  endX: number,
  threshold = 48
): ViewerDirection {
  const distance = endX - startX;
  if (Math.abs(distance) < threshold) return 0;
  return distance < 0 ? 1 : -1;
}
