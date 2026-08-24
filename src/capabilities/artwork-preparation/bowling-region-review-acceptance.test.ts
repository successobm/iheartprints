import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { analyzeArtwork } from "./image-analysis";
import { decodePngUpload, encodeRgbaToPng } from "./image-decode";
import {
  computeRegionMap,
  renderRegionContextHighlight,
  renderRegionDetailCrop,
} from "./region-separation";
import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

// Resolved at module load, matching every other real-asset test in this repo.
const ROOT = process.cwd();
const BOWLING_ORIGINAL = path.resolve(ROOT, ".local-acceptance/8e632bd5-2257-48c2-8dad-efa8549cf88e_Bowling_Logo.png");
const hasBowling = existsSync(BOWLING_ORIGINAL);
const OUTPUT_DIR = path.resolve(ROOT, ".local-acceptance/phase14-region-review");

/**
 * Intelligent Separation Phase 14 — REAL-ASSET ACCEPTANCE.
 *
 * READ-ONLY on the customer's file: only ever `readFileSync`d, never
 * written to, never uploaded anywhere. All output goes to
 * `.local-acceptance/phase14-region-review/` — inside the same gitignored
 * directory the asset itself lives in, so nothing here can enter the
 * release diff (`.gitignore:41` covers the whole `.local-acceptance/` tree).
 *
 * Generates, for human inspection:
 *   - one context PNG + one detail-crop PNG per consequential region
 *   - a contact sheet tiling every region's detail crop in one image
 *   - a JSON manifest (region id / bounds / pixel count / grid position)
 *     cross-referencing the contact sheet, since PNG cells carry no
 *     embedded text label
 *
 * Also asserts, structurally, the property the whole phase exists to
 * guarantee: every one of the real artwork's consequential regions produces
 * a VISUALLY DISTINCT context/detail pair from every other region.
 */
describe("Bowling real-asset acceptance — Phase 14 region review visual clarity", { skip: !hasBowling }, () => {
  function tileContactSheet(images: RgbaImage[], cellSize: number, columns: number): RgbaImage {
    const rows = Math.ceil(images.length / columns);
    const gap = 4;
    const width = columns * cellSize + (columns + 1) * gap;
    const height = rows * cellSize + (rows + 1) * gap;
    const data = Buffer.alloc(width * height * 4, 235); // light gray background
    for (let i = 0; i < images.length; i += 1) {
      const img = images[i]!;
      const col = i % columns;
      const row = Math.floor(i / columns);
      const originX = gap + col * (cellSize + gap);
      const originY = gap + row * (cellSize + gap);
      // Center the (already square-ish, possibly not exactly cellSize) crop
      // inside its cell without resampling — nearest-neighbor scale down
      // only if it doesn't fit, otherwise a straight center-crop-in-place.
      const scale = Math.min(1, cellSize / img.width, cellSize / img.height);
      const drawW = Math.max(1, Math.round(img.width * scale));
      const drawH = Math.max(1, Math.round(img.height * scale));
      const offsetX = originX + Math.floor((cellSize - drawW) / 2);
      const offsetY = originY + Math.floor((cellSize - drawH) / 2);
      for (let y = 0; y < drawH; y += 1) {
        const srcY = Math.min(img.height - 1, Math.floor(y / scale));
        for (let x = 0; x < drawW; x += 1) {
          const srcX = Math.min(img.width - 1, Math.floor(x / scale));
          const srcO = (srcY * img.width + srcX) * 4;
          const destO = ((offsetY + y) * width + (offsetX + x)) * 4;
          data[destO] = img.data[srcO]!;
          data[destO + 1] = img.data[srcO + 1]!;
          data[destO + 2] = img.data[srcO + 2]!;
          data[destO + 3] = 255;
        }
      }
    }
    return { width, height, data };
  }

  it("generates per-region context + detail artifacts and a contact sheet; every region is visually distinct", () => {
    mkdirSync(OUTPUT_DIR, { recursive: true });

    const originalBytes = readFileSync(BOWLING_ORIGINAL);
    assert.equal(
      createHash("sha256").update(originalBytes).digest("hex"),
      "99ee94fcc89884415e7188d8bc06f804cc5222ec4652fb68ee75c0e0a080afa5",
      "must be the exact audited real asset",
    );
    const decoded = decodePngUpload(originalBytes);
    const analysis = analyzeArtwork({
      image: decoded.image,
      format: "image/png",
      byteSize: originalBytes.length,
      declaresAlphaChannel: decoded.header.declaresAlphaChannel,
      printPlacement: "full_front",
      intendedPrintWidthIn: 10.5,
    });
    const computation = computeRegionMap(
      decoded.image,
      "bowling-phase14-acceptance",
      analysis.estimatedBackgroundColor,
      analysis.backgroundTolerance,
    );
    const regions = [...computation.regionMap.consequentialRegions].sort((a, b) => a.regionId - b.regionId);
    assert.ok(regions.length >= 4, "expect at least the 4 categories this acceptance requires");

    const manifest: Array<{
      regionId: number;
      bounds: (typeof regions)[number]["bounds"];
      pixelCount: number;
      fillRatio: number;
      contactSheetIndex: number;
      contextFile: string;
      detailFile: string;
    }> = [];

    const detailCrops: RgbaImage[] = [];
    const detailHashes = new Set<string>();
    const contextHashes = new Set<string>();

    regions.forEach((region, index) => {
      const context = renderRegionContextHighlight(decoded.image, computation.label, region.regionId);
      const detail = renderRegionDetailCrop(decoded.image, computation.label, region.regionId, region.bounds);

      const contextHash = createHash("sha256").update(context.data).digest("hex");
      const detailHash = createHash("sha256").update(detail.data).digest("hex");
      // THE REGRESSION GUARANTEE, on the real asset: no two regions may ever
      // render the same context or the same detail crop.
      assert.ok(!contextHashes.has(contextHash), `region ${region.regionId}'s context view duplicates an earlier region's — the visual-isolation fix has regressed`);
      assert.ok(!detailHashes.has(detailHash), `region ${region.regionId}'s detail crop duplicates an earlier region's — the visual-isolation fix has regressed`);
      contextHashes.add(contextHash);
      detailHashes.add(detailHash);

      const contextFile = `region-${region.regionId}-context.png`;
      const detailFile = `region-${region.regionId}-detail.png`;
      writeFileSync(path.join(OUTPUT_DIR, contextFile), encodeRgbaToPng(context));
      writeFileSync(path.join(OUTPUT_DIR, detailFile), encodeRgbaToPng(detail));

      detailCrops.push(detail);
      manifest.push({
        regionId: region.regionId,
        bounds: region.bounds,
        pixelCount: region.pixelCount,
        fillRatio: region.pixelCount / (region.bounds.width * region.bounds.height),
        contactSheetIndex: index,
        contextFile,
        detailFile,
      });
    });

    // Contact sheet: every region's detail crop, tiled, in regionId order —
    // manifest.json's `contactSheetIndex` is the cross-reference (row-major,
    // fixed column count below).
    const COLUMNS = 5;
    const sheet = tileContactSheet(detailCrops, 200, COLUMNS);
    writeFileSync(path.join(OUTPUT_DIR, "contact-sheet.png"), encodeRgbaToPng(sheet));

    // The four required categories, selected from the manifest's own
    // measured properties (never assumed from prior-phase narrative):
    //   - largest region             -> "large garment/substrate candidate"
    //   - second-largest region      -> "intentional black design candidate"
    //     (both are large; Phase 9/10's own tests independently identified
    //     these two specific ids as the badge disc and the banner)
    //   - smallest region            -> "small counter/enclosed candidate"
    //   - lowest fill-ratio region   -> "outline/shadow-like candidate"
    //     (a thin stroke has far fewer filled pixels than its own bounding
    //     box, which is exactly what a low fill ratio measures — this is a
    //     geometric proxy, not a semantic claim about what the mark depicts)
    // Each category is drawn from what's LEFT after the previous ones claim
    // a region, so the four categories can never collapse onto the same
    // region merely because one metric (e.g. fill ratio) happens to also
    // rank a large region low.
    const remaining = [...manifest];
    function takeExtreme<T extends { pixelCount: number; fillRatio: number }>(
      pool: T[],
      key: (r: T) => number,
      pick: "max" | "min",
    ): T {
      const sorted = [...pool].sort((a, b) => (pick === "max" ? key(b) - key(a) : key(a) - key(b)));
      const chosen = sorted[0]!;
      const index = pool.indexOf(chosen);
      pool.splice(index, 1);
      return chosen;
    }

    const categories = {
      largeGarmentSubstrateCandidate: takeExtreme(remaining, (r) => r.pixelCount, "max"),
      intentionalBlackDesignCandidate: takeExtreme(remaining, (r) => r.pixelCount, "max"),
      smallEnclosedCounterCandidate: takeExtreme(remaining, (r) => r.pixelCount, "min"),
      outlineOrShadowLikeCandidate: takeExtreme(remaining, (r) => r.fillRatio, "min"),
    };

    writeFileSync(
      path.join(OUTPUT_DIR, "manifest.json"),
      JSON.stringify(
        {
          sourceSha256: "99ee94fcc89884415e7188d8bc06f804cc5222ec4652fb68ee75c0e0a080afa5",
          algorithmVersion: computation.regionMap.algorithmVersion,
          totalConsequentialRegions: regions.length,
          contactSheetColumns: COLUMNS,
          contactSheetCellPx: 200,
          regions: manifest,
          requiredCategories: categories,
        },
        null,
        2,
      ),
    );

    // Structural proof the 4 required categories are genuinely distinct
    // regions, not the same one counted twice — guaranteed by construction
    // (`takeExtreme` removes each pick from the pool), asserted anyway.
    const categoryIds = new Set(Object.values(categories).map((c) => c.regionId));
    assert.equal(categoryIds.size, 4, "the 4 required categories must resolve to 4 distinct regions");
  });
});
