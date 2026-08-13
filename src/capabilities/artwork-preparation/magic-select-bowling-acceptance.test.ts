import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { isolateBackground } from "./background-isolation";
import { analyzeArtwork } from "./image-analysis";
import { decodePngUpload } from "./image-decode";
import {
  isResidueLikeSeed,
  selectMagicColor,
} from "./magic-color-selection";
import { VISIBLE_ALPHA_THRESHOLD } from "./pixel-metrics";

/**
 * Real bowling ORIGINAL — local-only, not committed. Skips cleanly in CI
 * when the file is absent. Never mutates customer/Supabase state.
 */
const BOWLING_ORIGINAL = ".local-acceptance/bowling-phase2/original.png";

const LEGIT_POINTS = [
  { x: 150, y: 753 },
  { x: 545, y: 680 },
  { x: 622, y: 725 },
  { x: 456, y: 549 },
  { x: 633, y: 668 },
  { x: 788, y: 651 },
];

const HOLES = [
  { name: "hole1", left: 452, top: 276, right: 482, bottom: 294, seed: { x: 468, y: 292 } },
  { name: "hole2", left: 483, top: 308, right: 516, bottom: 333, seed: { x: 504, y: 326 } },
  { name: "hole3", left: 514, top: 277, right: 546, bottom: 294, seed: { x: 529, y: 292 } },
] as const;

const RESIDUE_SEED = { x: 321, y: 620 };
const OUTLINE_SEED = { x: 449, y: 549 };

const hasBowling = existsSync(BOWLING_ORIGINAL);

describe("Magic Select 1.7B — real bowling acceptance", { skip: !hasBowling }, () => {
  function preparedBowling() {
    const bytes = readFileSync(BOWLING_ORIGINAL);
    const decoded = decodePngUpload(bytes);
    const analysis = analyzeArtwork({
      image: decoded.image,
      format: "image/png",
      byteSize: bytes.length,
      declaresAlphaChannel: decoded.header.declaresAlphaChannel,
      printPlacement: "full_front",
      intendedPrintWidthIn: 10.5,
    });
    const isolated = isolateBackground(decoded.image, {
      backgroundColor: analysis.estimatedBackgroundColor,
      tolerance: analysis.backgroundTolerance,
      guidedRemovalPoints: LEGIT_POINTS,
    }).image;
    return isolated;
  }

  function holeHits(mask: Uint8Array, width: number) {
    const hits = { hole1: 0, hole2: 0, hole3: 0 };
    for (const hole of HOLES) {
      let count = 0;
      for (let y = hole.top; y < hole.bottom; y += 1) {
        for (let x = hole.left; x < hole.right; x += 1) {
          if (mask[y * width + x] === 1) count += 1;
        }
      }
      hits[hole.name] = count;
    }
    return hits;
  }

  function lumaAt(data: Buffer, idx: number) {
    return 0.2126 * data[idx]! + 0.7152 * data[idx + 1]! + 0.0722 * data[idx + 2]!;
  }

  function isDarkInk(data: Buffer, pixel: number) {
    const idx = pixel * 4;
    return data[idx + 3]! >= VISIBLE_ALPHA_THRESHOLD && lumaAt(data, idx) < 64;
  }

  function thickOutlineHits(
    image: { width: number; height: number; data: Buffer },
    mask: Uint8Array,
  ) {
    const { width, height, data } = image;
    let count = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixel = y * width + x;
        if (mask[pixel] !== 1) continue;
        if (!isDarkInk(data, pixel)) continue;
        let minRun = 255;
        for (const [dx, dy] of [
          [1, 0],
          [0, 1],
        ] as Array<[number, number]>) {
          let run = 1;
          for (const step of [1, -1] as const) {
            let cx = x + dx * step;
            let cy = y + dy * step;
            while (cx >= 0 && cy >= 0 && cx < width && cy < height && run < 64) {
              if (!isDarkInk(data, cy * width + cx)) break;
              run += 1;
              cx += dx * step;
              cy += dy * step;
            }
          }
          if (run < minRun) minRun = run;
        }
        if (minRun >= 3) count += 1;
      }
    }
    return count;
  }

  function islandCount(mask: Uint8Array, width: number, height: number) {
    const seen = new Uint8Array(mask.length);
    const stack = new Int32Array(mask.length);
    let islands = 0;
    for (let seed = 0; seed < mask.length; seed += 1) {
      if (mask[seed] !== 1 || seen[seed] === 1) continue;
      islands += 1;
      let top = 0;
      stack[top++] = seed;
      seen[seed] = 1;
      while (top > 0) {
        const pixel = stack[--top]!;
        const x = pixel % width;
        const y = (pixel - x) / width;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as Array<[number, number]>) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const neighbor = ny * width + nx;
          if (mask[neighbor] !== 1 || seen[neighbor] === 1) continue;
          seen[neighbor] = 1;
          stack[top++] = neighbor;
        }
      }
    }
    return islands;
  }

  it("residue seed (321,620) magnetizes hundreds of specks and zero holes/outlines", () => {
    const image = preparedBowling();
    assert.equal(isResidueLikeSeed(image, RESIDUE_SEED), true);

    const byTol: Record<string, { n: number; holes: number; thick: number; islands: number }> = {};
    for (const tol of [8, 12, 20, 40] as const) {
      const result = selectMagicColor(image, RESIDUE_SEED, tol);
      assert.equal(result.outcome, "eligible");
      assert.equal(result.selection!.selectionMode, "similar");
      const holes = holeHits(result.selection!.mask, image.width);
      const holeTotal = holes.hole1 + holes.hole2 + holes.hole3;
      const thick = thickOutlineHits(image, result.selection!.mask);
      assert.ok(
        result.selection!.pixelCount >= 100,
        `t=${tol} expected hundreds, got ${result.selection!.pixelCount}`,
      );
      assert.equal(holeTotal, 0, `t=${tol} selected finger-hole pixels`);
      assert.equal(thick, 0, `t=${tol} selected thick-outline pixels`);
      byTol[String(tol)] = {
        n: result.selection!.pixelCount,
        holes: holeTotal,
        thick,
        islands: islandCount(result.selection!.mask, image.width, image.height),
      };
    }

    assert.ok(byTol["8"]!.n >= 100);
    assert.ok(byTol["12"]!.n >= byTol["8"]!.n);
    assert.ok(byTol["40"]!.n >= byTol["12"]!.n);
    console.log("bowling magnetic residue", JSON.stringify(byTol));
  });

  it("finger-hole clicks stay connected and do not attract siblings or residue", () => {
    const image = preparedBowling();
    for (const hole of HOLES) {
      assert.equal(isResidueLikeSeed(image, hole.seed), false);
      const result = selectMagicColor(image, hole.seed, 8);
      assert.equal(result.selection!.selectionMode, "connected");
      const hits = holeHits(result.selection!.mask, image.width);
      const others = HOLES.filter((candidate) => candidate.name !== hole.name);
      for (const other of others) {
        assert.equal(
          hits[other.name],
          0,
          `${hole.name} click magnetized ${other.name}`,
        );
      }
      assert.equal(result.selection!.mask[RESIDUE_SEED.y * image.width + RESIDUE_SEED.x], 0);
    }
  });

  it("thick outline click stays connected and does not harvest global outlines", () => {
    const image = preparedBowling();
    assert.equal(isResidueLikeSeed(image, OUTLINE_SEED), false);
    const result = selectMagicColor(image, OUTLINE_SEED, 8);
    assert.equal(result.selection!.selectionMode, "connected");
    const holes = holeHits(result.selection!.mask, image.width);
    assert.equal(holes.hole1 + holes.hole2 + holes.hole3, 0);
    assert.ok(
      result.selection!.pixelCount < 200,
      `outline click harvested ${result.selection!.pixelCount} pixels`,
    );
  });
});
