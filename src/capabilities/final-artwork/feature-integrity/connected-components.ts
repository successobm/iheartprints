/**
 * DTF Feature Integrity Phase 1: 4-connected component labelling over a
 * binary mask. Pure — no I/O, no provider.
 *
 * 4-connectivity (never 8) matches every other labeller in this codebase
 * (`region-separation.ts`'s `labelInteriorRegions`,
 * `background-cavities.ts`'s `labelComponents`) — deliberately, so a
 * diagonal single-pixel gap is never treated as connectivity here either.
 * Stack-based flood fill, O(n) in pixel count.
 */

export interface ComponentBounds {
  left: number;
  top: number;
  /** Exclusive. */
  right: number;
  /** Exclusive. */
  bottom: number;
  width: number;
  height: number;
}

export interface ComponentRecord {
  id: number;
  pixelCount: number;
  bounds: ComponentBounds;
  /** True when this component touches the raster's outer edge — never meaningful "enclosed" negative space. */
  touchesBorder: boolean;
}

export interface LabelledComponents {
  /** Component id per pixel, or `-1` for a pixel not in `mask`. */
  labels: Int32Array;
  components: ComponentRecord[];
}

/** Labels every 4-connected component of `mask` (nonzero pixels). */
export function labelConnectedComponents(
  mask: Uint8Array,
  width: number,
  height: number,
): LabelledComponents {
  const labels = new Int32Array(width * height).fill(-1);
  const components: ComponentRecord[] = [];
  const stack: number[] = [];

  for (let start = 0; start < width * height; start += 1) {
    if (!mask[start] || labels[start] >= 0) continue;

    const id = components.length;
    stack.length = 0;
    stack.push(start);
    labels[start] = id;

    let pixelCount = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let touchesBorder = false;

    while (stack.length) {
      const p = stack.pop()!;
      pixelCount += 1;
      const x = p % width;
      const y = (p / width) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true;

      if (x > 0) {
        const q = p - 1;
        if (mask[q] && labels[q] < 0) {
          labels[q] = id;
          stack.push(q);
        }
      }
      if (x < width - 1) {
        const q = p + 1;
        if (mask[q] && labels[q] < 0) {
          labels[q] = id;
          stack.push(q);
        }
      }
      if (y > 0) {
        const q = p - width;
        if (mask[q] && labels[q] < 0) {
          labels[q] = id;
          stack.push(q);
        }
      }
      if (y < height - 1) {
        const q = p + width;
        if (mask[q] && labels[q] < 0) {
          labels[q] = id;
          stack.push(q);
        }
      }
    }

    components.push({
      id,
      pixelCount,
      bounds: {
        left: minX,
        top: minY,
        right: maxX + 1,
        bottom: maxY + 1,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
      },
      touchesBorder,
    });
  }

  return { labels, components };
}
