import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

import {
  clampMagicSelectTolerance,
  eraseMagicSelection,
  isResidueLikeSeed,
  MAGIC_SELECT_DEFAULT_TOLERANCE,
  MAGIC_SELECT_RULE_V1,
  MAGIC_SELECT_RULE_V2,
  MAGIC_SELECT_TOLERANCE_MAX,
  selectConnectedMagicColor,
  selectMagicColor,
  selectMagicColorByMode,
} from "./magic-color-selection";
import { VISIBLE_ALPHA_THRESHOLD } from "./pixel-metrics";

function solid(
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number, number],
): RgbaImage {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = fill(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { width, height, data };
}

describe("Magic Select — connected colour selection", () => {
  it("F: tolerance 0 selects exact colour only", () => {
    const image = solid(5, 5, (x, y) => {
      if (x === 2 && y === 2) return [10, 10, 10, 255];
      if (x === 3 && y === 2) return [11, 10, 10, 255];
      return [200, 200, 200, 255];
    });
    const result = selectConnectedMagicColor(image, { x: 2, y: 2 }, 0);
    assert.equal(result.outcome, "eligible");
    assert.equal(result.selection!.pixelCount, 1);
  });

  it("D/E: selects the connected component, not a disconnected same colour", () => {
    const image = solid(9, 3, (x, y) => {
      if (y === 1 && (x === 1 || x === 2 || x === 3)) return [0, 0, 0, 255];
      if (y === 1 && (x === 6 || x === 7)) return [0, 0, 0, 255];
      return [255, 255, 255, 255];
    });
    const result = selectConnectedMagicColor(image, { x: 1, y: 1 }, 8);
    assert.equal(result.outcome, "eligible");
    assert.equal(result.selection!.pixelCount, 3);
    assert.equal(result.selection!.mask[1 * 9 + 6], 0);
    assert.equal(result.selection!.mask[1 * 9 + 7], 0);
  });

  it("G: increasing tolerance expands or equals selection monotonically", () => {
    const image = solid(6, 3, (x, y) => {
      if (y !== 1) return [255, 255, 255, 255];
      if (x === 1) return [0, 0, 0, 255];
      if (x === 2) return [5, 0, 0, 255];
      if (x === 3) return [12, 0, 0, 255];
      if (x === 4) return [25, 0, 0, 255];
      return [255, 255, 255, 255];
    });
    const t0 = selectConnectedMagicColor(image, { x: 1, y: 1 }, 0).selection!.pixelCount;
    const t8 = selectConnectedMagicColor(image, { x: 1, y: 1 }, 8).selection!.pixelCount;
    const t12 = selectConnectedMagicColor(image, { x: 1, y: 1 }, 12).selection!.pixelCount;
    const t40 = selectConnectedMagicColor(image, { x: 1, y: 1 }, 40).selection!.pixelCount;
    assert.ok(t0 <= t8 && t8 <= t12 && t12 <= t40);
    assert.equal(t0, 1);
    assert.equal(t8, 2);
    assert.equal(t12, 3);
    assert.equal(t40, 4);
  });

  it("H: transparent pixels do not bridge regions", () => {
    const image = solid(5, 3, (x, y) => {
      if (y !== 1) return [255, 255, 255, 255];
      if (x === 1 || x === 3) return [0, 0, 0, 255];
      if (x === 2) return [0, 0, 0, 0];
      return [255, 255, 255, 255];
    });
    const result = selectConnectedMagicColor(image, { x: 1, y: 1 }, 40);
    assert.equal(result.selection!.pixelCount, 1);
  });

  it("I: very-low-alpha fringe does not bridge (α < visible threshold)", () => {
    const image = solid(5, 3, (x, y) => {
      if (y !== 1) return [255, 255, 255, 255];
      if (x === 1 || x === 3) return [0, 0, 0, 255];
      if (x === 2) return [0, 0, 0, VISIBLE_ALPHA_THRESHOLD - 1];
      return [255, 255, 255, 255];
    });
    const result = selectConnectedMagicColor(image, { x: 1, y: 1 }, 40);
    assert.equal(result.selection!.pixelCount, 1);
  });

  it("AE: works for red and blue residue, not only black", () => {
    const red = solid(4, 3, (x, y) => {
      if (y === 1 && (x === 1 || x === 2)) return [220, 10, 10, 255];
      return [250, 250, 250, 255];
    });
    const blue = solid(4, 3, (x, y) => {
      if (y === 1 && x === 1) return [20, 40, 220, 255];
      return [250, 250, 250, 255];
    });
    assert.equal(selectConnectedMagicColor(red, { x: 1, y: 1 }, 8).selection!.pixelCount, 2);
    assert.equal(selectConnectedMagicColor(blue, { x: 1, y: 1 }, 8).selection!.pixelCount, 1);
  });

  it("already-removed seed refuses selection", () => {
    const image = solid(3, 3, () => [0, 0, 0, 0]);
    assert.equal(
      selectConnectedMagicColor(image, { x: 1, y: 1 }, 8).outcome,
      "already_removed",
    );
  });

  it("erase clears exactly the mask and preserves RGB", () => {
    const image = solid(3, 3, (x, y) =>
      x === 1 && y === 1 ? [12, 34, 56, 255] : [200, 200, 200, 255],
    );
    const selected = selectConnectedMagicColor(image, { x: 1, y: 1 }, 0);
    eraseMagicSelection(image, selected.selection!.mask);
    const i = (1 * 3 + 1) * 4;
    assert.equal(image.data[i + 3], 0);
    assert.equal(image.data[i], 12);
    assert.equal(image.data[i + 1], 34);
    assert.equal(image.data[i + 2], 56);
  });

  it("clamps tolerance into the Phase 1.7 range", () => {
    assert.equal(clampMagicSelectTolerance(-4), 0);
    assert.equal(clampMagicSelectTolerance(99), MAGIC_SELECT_TOLERANCE_MAX);
    assert.equal(clampMagicSelectTolerance(Number.NaN), MAGIC_SELECT_DEFAULT_TOLERANCE);
  });

  it("selectionKey is stable for the same inputs", () => {
    const image = solid(4, 4, (x, y) =>
      x === 1 && y === 1 ? [0, 0, 0, 255] : [255, 255, 255, 255],
    );
    const a = selectConnectedMagicColor(image, { x: 1, y: 1 }, 8);
    const b = selectConnectedMagicColor(image, { x: 1, y: 1 }, 8);
    assert.equal(a.selection!.selectionKey, b.selection!.selectionKey);
    assert.equal(a.selection!.selectionMode, "connected");
    assert.equal(a.selection!.ruleVersion, MAGIC_SELECT_RULE_V1);
  });
});

function transparentWith(
  width: number,
  height: number,
  paint: (set: (x: number, y: number, rgba: [number, number, number, number]) => void) => void,
): RgbaImage {
  const image = solid(width, height, () => [0, 0, 0, 0]);
  paint((x, y, rgba) => {
    const i = (y * width + x) * 4;
    image.data[i] = rgba[0];
    image.data[i + 1] = rgba[1];
    image.data[i + 2] = rgba[2];
    image.data[i + 3] = rgba[3];
  });
  return image;
}

function fillRect(
  set: (x: number, y: number, rgba: [number, number, number, number]) => void,
  x0: number,
  y0: number,
  w: number,
  h: number,
  rgba: [number, number, number, number],
) {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      set(x, y, rgba);
    }
  }
}

describe("Magic Select — Phase 1.7B magnetic similar", () => {
  it("A: disconnected residue islands of the same colour are attracted", () => {
    const image = transparentWith(24, 12, (set) => {
      fillRect(set, 1, 1, 2, 2, [0, 0, 0, 255]);
      fillRect(set, 18, 1, 2, 2, [0, 0, 0, 255]);
    });
    const result = selectMagicColor(image, { x: 1, y: 1 }, 8);
    assert.equal(result.selection!.selectionMode, "similar");
    assert.equal(result.selection!.ruleVersion, MAGIC_SELECT_RULE_V2);
    assert.equal(result.selection!.pixelCount, 8);
    assert.equal(result.selection!.mask[1 * 24 + 18], 1);
  });

  it("B: residue-like seed selects multiple islands, not one connected island", () => {
    const image = transparentWith(40, 8, (set) => {
      for (const x of [1, 8, 16, 24, 32]) {
        fillRect(set, x, 2, 2, 2, [12, 8, 0, 255]);
      }
    });
    const connected = selectConnectedMagicColor(image, { x: 1, y: 2 }, 8);
    const magnetic = selectMagicColor(image, { x: 1, y: 2 }, 8);
    assert.equal(connected.selection!.pixelCount, 4);
    assert.equal(magnetic.selection!.selectionMode, "similar");
    assert.equal(magnetic.selection!.pixelCount, 20);
  });

  it("C: same-colour enclosed blob is not attracted from a residue seed", () => {
    const image = transparentWith(28, 20, (set) => {
      fillRect(set, 1, 1, 2, 2, [0, 0, 0, 255]);
      fillRect(set, 10, 6, 8, 8, [0, 0, 0, 255]);
    });
    const result = selectMagicColor(image, { x: 1, y: 1 }, 8);
    assert.equal(result.selection!.selectionMode, "similar");
    assert.equal(result.selection!.pixelCount, 4);
    assert.equal(result.selection!.mask[10 * 28 + 14], 0);
  });

  it("D: same-colour thick outline touching transparency is not attracted", () => {
    const image = transparentWith(24, 16, (set) => {
      fillRect(set, 1, 1, 2, 2, [0, 0, 0, 255]);
      fillRect(set, 8, 4, 12, 4, [0, 0, 0, 255]);
    });
    const result = selectMagicColor(image, { x: 1, y: 1 }, 8);
    assert.equal(result.selection!.selectionMode, "similar");
    assert.equal(result.selection!.pixelCount, 4);
    assert.equal(result.selection!.mask[6 * 24 + 10], 0);
  });

  it("E: interior seed falls back to connected", () => {
    const image = transparentWith(24, 16, (set) => {
      fillRect(set, 4, 4, 12, 8, [0, 0, 0, 255]);
      fillRect(set, 20, 1, 2, 2, [0, 0, 0, 255]);
    });
    const result = selectMagicColor(image, { x: 10, y: 8 }, 8);
    assert.equal(isResidueLikeSeed(image, { x: 10, y: 8 }), false);
    assert.equal(result.selection!.selectionMode, "connected");
    assert.equal(result.selection!.pixelCount, 12 * 8);
    assert.equal(result.selection!.mask[1 * 24 + 20], 0);
  });

  it("F: thick-outline seed falls back to connected", () => {
    const image = transparentWith(20, 10, (set) => {
      fillRect(set, 2, 2, 14, 4, [0, 0, 0, 255]);
      fillRect(set, 17, 1, 2, 2, [0, 0, 0, 255]);
    });
    const result = selectMagicColor(image, { x: 8, y: 3 }, 8);
    assert.equal(result.selection!.selectionMode, "connected");
    assert.equal(result.selection!.mask[1 * 20 + 17], 0);
  });

  it("G/H: enclosed cavity seed stays local; sibling cavity is not attracted", () => {
    const image = transparentWith(32, 14, (set) => {
      fillRect(set, 2, 2, 10, 10, [0, 0, 0, 255]);
      fillRect(set, 18, 2, 10, 10, [0, 0, 0, 255]);
    });
    const first = selectMagicColor(image, { x: 6, y: 6 }, 8);
    assert.equal(first.selection!.selectionMode, "connected");
    assert.equal(first.selection!.pixelCount, 100);
    assert.equal(first.selection!.mask[6 * 32 + 22], 0);
    const second = selectMagicColor(image, { x: 22, y: 6 }, 8);
    assert.equal(second.selection!.selectionMode, "connected");
    assert.equal(second.selection!.pixelCount, 100);
    assert.equal(second.selection!.mask[6 * 32 + 6], 0);
  });

  it("I: raising tolerance increases colour recall without loosening structure", () => {
    const image = transparentWith(30, 12, (set) => {
      fillRect(set, 1, 1, 2, 2, [0, 0, 0, 255]);
      fillRect(set, 8, 1, 2, 2, [6, 0, 0, 255]);
      fillRect(set, 16, 1, 2, 2, [15, 0, 0, 255]);
      fillRect(set, 4, 6, 10, 4, [0, 0, 0, 255]);
    });
    const t0 = selectMagicColor(image, { x: 1, y: 1 }, 0);
    const t8 = selectMagicColor(image, { x: 1, y: 1 }, 8);
    const t12 = selectMagicColor(image, { x: 1, y: 1 }, 12);
    const t40 = selectMagicColor(image, { x: 1, y: 1 }, 40);
    assert.equal(t0.selection!.pixelCount, 4);
    assert.equal(t8.selection!.pixelCount, 8);
    assert.equal(t12.selection!.pixelCount, 8);
    assert.equal(t40.selection!.pixelCount, 12);
    for (const result of [t0, t8, t12, t40]) {
      assert.equal(result.selection!.selectionMode, "similar");
      assert.equal(result.selection!.mask[8 * 30 + 8], 0);
    }
  });

  it("J: alpha below the visible threshold does not select or bridge", () => {
    const image = transparentWith(12, 6, (set) => {
      fillRect(set, 1, 1, 2, 2, [0, 0, 0, 255]);
      fillRect(set, 6, 1, 2, 2, [0, 0, 0, VISIBLE_ALPHA_THRESHOLD - 1]);
    });
    const result = selectMagicColor(image, { x: 1, y: 1 }, 40);
    assert.equal(result.selection!.pixelCount, 4);
    assert.equal(result.selection!.mask[1 * 12 + 6], 0);
  });

  it("K: non-black residue colours magnetize", () => {
    const image = transparentWith(20, 8, (set) => {
      fillRect(set, 1, 1, 2, 2, [220, 10, 10, 255]);
      fillRect(set, 12, 1, 2, 2, [220, 10, 10, 255]);
      fillRect(set, 1, 5, 2, 2, [20, 40, 220, 255]);
    });
    const red = selectMagicColor(image, { x: 1, y: 1 }, 8);
    assert.equal(red.selection!.selectionMode, "similar");
    assert.equal(red.selection!.pixelCount, 8);
    assert.equal(red.selection!.mask[1 * 20 + 12], 1);
    assert.equal(red.selection!.mask[5 * 20 + 1], 0);
  });

  it("L: selection mode is deterministic for the same seed", () => {
    const image = transparentWith(16, 8, (set) => {
      fillRect(set, 1, 1, 2, 2, [0, 0, 0, 255]);
      fillRect(set, 8, 1, 2, 2, [0, 0, 0, 255]);
    });
    const a = selectMagicColor(image, { x: 1, y: 1 }, 8);
    const b = selectMagicColor(image, { x: 1, y: 1 }, 8);
    assert.equal(a.selection!.selectionMode, b.selection!.selectionMode);
    assert.equal(a.selection!.selectionKey, b.selection!.selectionKey);
    assert.equal(a.selection!.pixelCount, b.selection!.pixelCount);
  });

  it("M: selectionKey changes with tolerance, mode, mask, and rule version", () => {
    const image = transparentWith(16, 8, (set) => {
      fillRect(set, 1, 1, 2, 2, [0, 0, 0, 255]);
      fillRect(set, 10, 1, 2, 2, [0, 0, 0, 255]);
    });
    const similar8 = selectMagicColor(image, { x: 1, y: 1 }, 8);
    const similar0 = selectMagicColor(image, { x: 1, y: 1 }, 0);
    const connected = selectMagicColorByMode(image, { x: 1, y: 1 }, 8, "connected");
    assert.notEqual(similar8.selection!.selectionKey, similar0.selection!.selectionKey);
    assert.notEqual(similar8.selection!.selectionKey, connected.selection!.selectionKey);
    assert.equal(similar8.selection!.ruleVersion, MAGIC_SELECT_RULE_V2);
    assert.equal(connected.selection!.ruleVersion, MAGIC_SELECT_RULE_V1);
  });

  it("N: replaying connected mode never becomes magnetic", () => {
    const image = transparentWith(16, 8, (set) => {
      fillRect(set, 1, 1, 2, 2, [0, 0, 0, 255]);
      fillRect(set, 10, 1, 2, 2, [0, 0, 0, 255]);
    });
    const replayed = selectMagicColorByMode(image, { x: 1, y: 1 }, 8, "connected");
    assert.equal(replayed.selection!.selectionMode, "connected");
    assert.equal(replayed.selection!.pixelCount, 4);
    assert.equal(replayed.selection!.mask[1 * 16 + 10], 0);
  });
});
