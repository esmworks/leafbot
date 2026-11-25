/** Where a tile sits in the area the tiles wrap in, by its layout rather than as it slides. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The order with the dragged tile moved beside the tile under the point, or null when nothing
 * changes: the point is over the dragged tile's own place, between tiles, or already on the side
 * it would go. It lands on the side of that tile's middle the point is on: left or right, or
 * above or below for a tile about as wide as the row, where sideways means nothing. After it
 * moves the point sits over its new place or on the same side as before, so holding still never
 * flips it back and forth.
 */
export function orderAt(
  order: readonly string[],
  dragId: string,
  boxes: ReadonlyMap<string, Box>,
  x: number,
  y: number,
  rowWidth: number,
): string[] | null {
  const overId = order.find((id) => {
    const b = boxes.get(id);
    return !!b && x >= b.left && x < b.left + b.width && y >= b.top && y < b.top + b.height;
  });
  if (!overId || overId === dragId) return null;
  const b = boxes.get(overId)!;
  const after = b.width > rowWidth * 0.75 ? y > b.top + b.height / 2 : x > b.left + b.width / 2;
  const rest = order.filter((id) => id !== dragId);
  rest.splice(rest.indexOf(overId) + (after ? 1 : 0), 0, dragId);
  return rest.every((id, i) => id === order[i]) ? null : rest;
}

/** The order a drag shows, kept to the tiles there are now: gone ones left out, new ones last. */
export function reconcile(order: readonly string[], ids: readonly string[]): string[] {
  const now = new Set(ids);
  const kept = order.filter((id) => now.has(id));
  const known = new Set(kept);
  return [...kept, ...ids.filter((id) => !known.has(id))];
}
