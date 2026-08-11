import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import {
  BOWLING_DISPLAY_GLYPH_X,
  BOWLING_FINGER_HOLES,
  BOWLING_SMALL_GLYPH_X,
  bowlingLetterformArtwork,
  darkOutlinedDisplayArtwork,
  getPixel,
  toPngBytes,
} from "./artwork-fixtures";
import { createArtworkPreparationCapability } from "./artwork-preparation-capability";
import {
  CAVITY_WALL_BASE_PX,
  CAVITY_WALL_INRADIUS_RATIO,
} from "./background-cavities";
import { isolateBackground, VISIBLE_ALPHA_THRESHOLD } from "./background-isolation";
import { decodePngUpload } from "./image-decode";
import { analyzeArtwork } from "./image-analysis";

/**
 * THE ENCLOSED-CAVITY ACCEPTANCE REGRESSION.
 *
 * Visual acceptance of the real bowling logo found the defect this suite
 * pins: the exterior went transparent, and the counters inside the lettering
 * — large ("SPLIT DISTURBERS") and small ("DISTURBING FROM DAY ONE") — stayed
 * black, because a border-seeded fill can never reach them.
 *
 * The customer's own file is deliberately not committed to this repository
 * (privacy and ownership — see `artwork-fixtures.ts`), so the acceptance case
 * is `bowlingLetterformArtwork()`: the same 979x1024 canvas, the same
 * near-black dithered exterior, and every element of the real logo whose
 * outcome is in question, positive and negative in one image.
 *
 * The negative controls are what make the positive result mean anything. If
 * the finger holes, the outline crescent, and the drop shadow did not survive
 * this, the counters disappearing would be a bug rather than a fix.
 *
 * ## WHAT THIS SUITE DOES AND DOES NOT PROVE
 *
 * A later audit ran the real customer file through this pipeline and found
 * that the fixture's display glyphs are EASIER than the customer's. A plain
 * white glyph body puts ~20px of stroke around a large counter; the real
 * artwork's outlined display face puts a compound 26–61px wall around one, and
 * the automatic pass refuses those. So:
 *
 *   AUTOMATICALLY SAFE — proven here, and on the real file:
 *     * the exterior background
 *     * hairline and small-wording counters (the real file's tagline, all nine
 *       of them once `CAVITY_WALL_BASE_PX` reached 6)
 *     * thin-walled display counters, which is what this fixture's are
 *     * isolated near-background speckle
 *
 *   AMBIGUOUS — NOT automatically removable, on this fixture or on the real
 *   file, and deliberately so:
 *     * heavy compound-stroke display counters
 *
 *   The reason is measured, not incidental: on the real artwork the
 *   wall/inradius statistic runs 2.11–5.29 for genuine letter counters and
 *   2.89–4.69 for the bowling ball's finger holes. The finger holes sit INSIDE
 *   the counter range. The populations are nested, so no threshold separates
 *   them and any automatic answer risks deleting the customer's ball. Those
 *   regions are preserved and the customer removes them with a click
 *   (`guided-removal.test.ts`, `guided-cleanup-capability.test.ts`).
 *
 * The tests below name which class they are exercising, so nothing here can be
 * read as "large counters are handled automatically". They are not, and the
 * ambiguous case is pinned explicitly at the end of this suite.
 */
describe("Bowling cavity acceptance — enclosed background vs intentional black", () => {
  let tempDir = "";
  let previousCwd = "";

  const originalFetch = globalThis.fetch;
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;
  const originalNetConnect = net.Socket.prototype.connect;
  let networkAttempts: string[] = [];

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-bowling-cavity-"));
    process.chdir(tempDir);

    // The whole acceptance run happens with the network physically removed:
    // no OpenAI, no Topaz, no segmentation service, no background-removal API.
    const trap = (label: string) =>
      ((...args: unknown[]) => {
        networkAttempts.push(`${label}:${String(args[0])}`);
        throw new Error(`Network access is forbidden here (${label})`);
      }) as never;

    networkAttempts = [];
    globalThis.fetch = trap("fetch");
    http.request = trap("http.request");
    https.request = trap("https.request");
    net.Socket.prototype.connect = trap("net.connect");
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    http.request = originalHttpRequest;
    https.request = originalHttpsRequest;
    net.Socket.prototype.connect = originalNetConnect;
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  // Deterministic and pure, so one run serves every assertion below.
  let cached: ReturnType<typeof runPreparation> | null = null;
  function prepareLocally(): ReturnType<typeof runPreparation> {
    cached ??= runPreparation();
    return cached;
  }

  function runPreparation() {
    const image = bowlingLetterformArtwork();
    const analysis = analyzeArtwork({
      image,
      format: "image/png",
      byteSize: 512_000,
      declaresAlphaChannel: false,
      printPlacement: "full_front",
      intendedPrintWidthIn: null,
    });
    const isolated = isolateBackground(image, {
      backgroundColor: analysis.estimatedBackgroundColor,
      tolerance: analysis.backgroundTolerance,
    });
    return { image, analysis, isolated };
  }

  it("removes the exterior background, exactly as it already did", () => {
    const { isolated } = prepareLocally();
    const prepared = isolated.image;

    assert.equal(getPixel(prepared, 0, 0).a, 0);
    assert.equal(getPixel(prepared, 978, 0).a, 0);
    assert.equal(getPixel(prepared, 0, 1023).a, 0);
    assert.equal(getPixel(prepared, 978, 1023).a, 0);
    assert.ok(
      isolated.record.exteriorPixelsRemoved > 400_000,
      `exterior removal, got ${isolated.record.exteriorPixelsRemoved}`,
    );
  });

  it("AUTOMATICALLY SAFE: removes thin-walled display counters", () => {
    const { isolated } = prepareLocally();
    const prepared = isolated.image;

    for (const x of BOWLING_DISPLAY_GLYPH_X) {
      assert.equal(
        getPixel(prepared, x + 50, 825).a,
        0,
        `display counter at x=${x} should be transparent`,
      );
      // The stroke around it is untouched.
      assert.equal(getPixel(prepared, x + 5, 825).a, 255);
      assert.equal(getPixel(prepared, x + 50, 785).a, 255);
      assert.equal(getPixel(prepared, x + 50, 875).a, 255);
    }
  });

  it("AUTOMATICALLY SAFE: removes the counters inside the small wording", () => {
    const { isolated } = prepareLocally();
    const prepared = isolated.image;

    for (const x of BOWLING_SMALL_GLYPH_X) {
      assert.equal(
        getPixel(prepared, x + 10, 952).a,
        0,
        `small-wording counter at x=${x} should be transparent`,
      );
      assert.equal(getPixel(prepared, x + 1, 952).a, 255, "its stroke must survive");
    }
  });

  it("NEGATIVE CONTROL: preserves the bowling ball's finger holes", () => {
    const { image, isolated } = prepareLocally();
    const prepared = isolated.image;

    for (const hole of BOWLING_FINGER_HOLES) {
      const pixel = getPixel(prepared, hole.x, hole.y);
      assert.equal(pixel.a, 255, `finger hole at ${hole.x},${hole.y}`);
      assert.deepEqual(pixel, getPixel(image, hole.x, hole.y), "byte-identical");
    }

    const holeRegions = isolated.cavities.regions.filter(
      (region) => region.pixelCount > 400 && region.pixelCount < 900,
    );
    assert.equal(holeRegions.length, 3, "three enclosed hole regions were considered");
    for (const region of holeRegions) {
      assert.equal(region.removed, false);
      assert.equal(region.decision, "preserved_wall_thicker_than_cavity");
    }
  });

  it("preserves the intentional outline crescent and the drop shadow", () => {
    const { image, isolated } = prepareLocally();
    const prepared = isolated.image;

    // Drop shadow band under the pins.
    assert.equal(getPixel(prepared, 360, 610).a, 255);
    assert.deepEqual(getPixel(prepared, 360, 610), getPixel(image, 360, 610));

    // Outline crescent along the ball's lower rim.
    assert.equal(getPixel(prepared, 560, 598).a, 255);
    assert.deepEqual(getPixel(prepared, 560, 598), getPixel(image, 560, 598));

    // Those two are the largest enclosed regions in the whole image, and both
    // are preserved for the same measured reason: far more artwork stands
    // between them and the exterior than their own size allows for a cavity.
    const preserved = isolated.cavities.regions
      .filter((region) => !region.removed)
      .sort((a, b) => b.pixelCount - a.pixelCount);
    assert.ok(preserved.length >= 2);
    for (const region of preserved.slice(0, 2)) {
      assert.ok(region.pixelCount > 2_000, `large region: ${region.pixelCount}px`);
      assert.ok(
        region.wallThicknessPx! >
          CAVITY_WALL_INRADIUS_RATIO * region.inradiusPx + CAVITY_WALL_BASE_PX,
        `wall ${region.wallThicknessPx} vs inradius ${region.inradiusPx}`,
      );
    }
  });

  it("changes nothing in the deep interior of the artwork", () => {
    const { image, isolated } = prepareLocally();
    const prepared = isolated.image;

    // Every documented edge pass reaches at most 2px from a removed pixel, so
    // anything further in must be byte-identical. This is the check that would
    // catch a cavity pass quietly eroding artwork somewhere nobody looked.
    const distance = distanceFromTransparent(prepared, 3);
    let changedDeep = 0;
    let changedTotal = 0;

    for (let pixel = 0; pixel < image.width * image.height; pixel += 1) {
      const idx = pixel * 4;
      const same =
        image.data[idx] === prepared.data[idx] &&
        image.data[idx + 1] === prepared.data[idx + 1] &&
        image.data[idx + 2] === prepared.data[idx + 2] &&
        image.data[idx + 3] === prepared.data[idx + 3];
      if (same) continue;
      changedTotal += 1;
      if (distance[pixel]! > 2) changedDeep += 1;
    }

    assert.ok(changedTotal > 0, "the preparation did do something");
    assert.equal(changedDeep, 0, `${changedDeep} deep-interior pixels changed`);
  });

  it("reports the cavity work it did, and preserves more than it removes", () => {
    const { analysis, isolated } = prepareLocally();
    const record = isolated.record;

    assert.equal(record.enclosedCavityRegionsRemoved, 17);
    assert.equal(record.enclosedCavityPixelsRemoved, 23_304);
    assert.ok(
      record.enclosedCavityRegionsPreserved > record.enclosedCavityRegionsRemoved,
      "most enclosed regions are still refused",
    );

    // Phase 1.2: an automatic preparation removes nothing on the customer's
    // authority, and says so.
    assert.equal(record.guidedRegionsRemoved, 0);
    assert.equal(record.guidedPixelsRemoved, 0);

    // The disconnected pool splits cleanly: what left plus what stayed is what
    // the analyzer originally counted. Speckle removals come out of the same
    // pool, so they are accounted for here too.
    assert.equal(
      record.interiorBackgroundColoredPixelsPreserved +
        record.enclosedCavityPixelsRemoved +
        record.specklePixelsRemoved,
      analysis.disconnectedBackgroundColoredPixels,
    );
    assert.ok(
      record.interiorBackgroundColoredPixelsPreserved > 4_000,
      `interior line work preserved: ${record.interiorBackgroundColoredPixelsPreserved}`,
    );

    // Every removed region is a counter: two size families, and nothing else.
    const removed = isolated.cavities.regions.filter((region) => region.removed);
    assert.equal(removed.filter((region) => region.pixelCount === 4_200).length, 5);
    assert.equal(removed.filter((region) => region.pixelCount === 192).length, 12);
    for (const region of removed) {
      assert.equal(region.boundaryForegroundFraction, 1);
      assert.ok(region.wallThicknessPx! <= 11);
    }
  });

  it("preserves geometry and leaves the content bounding box alone", () => {
    const { image, isolated } = prepareLocally();
    const prepared = isolated.image;

    assert.equal(prepared.width, image.width);
    assert.equal(prepared.height, image.height);
    assert.equal(isolated.record.aspectRatioPreserved, true);

    // Cavities are enclosed BY artwork, so removing them can never move the
    // artwork's outer bounds. The reference is the analyzer's own bounds,
    // computed from the exterior mask ALONE, before this pass existed.
    const bounds = visibleBounds(prepared);
    const analyzed = isolated.record.outputWidthPx === image.width
      ? analyzeArtwork({
          image,
          format: "image/png",
          byteSize: 512_000,
          declaresAlphaChannel: false,
          printPlacement: null,
          intendedPrintWidthIn: null,
        }).artworkBounds!
      : null;

    assert.ok(analyzed);
    // Never wider than the exterior-only bounds, and never inset by more than
    // the documented 2px fringe reach.
    assert.ok(bounds.left >= analyzed!.left && bounds.left <= analyzed!.left + 2);
    assert.ok(bounds.top >= analyzed!.top && bounds.top <= analyzed!.top + 2);
    assert.ok(
      bounds.right <= analyzed!.right - 1 && bounds.right >= analyzed!.right - 3,
    );
    assert.ok(
      bounds.bottom <= analyzed!.bottom - 1 && bounds.bottom >= analyzed!.bottom - 3,
    );
  });

  it("produces sane alpha statistics: a real subject, not a wipe", () => {
    const { isolated } = prepareLocally();
    const stats = alphaStatistics(isolated.image);

    assert.ok(stats.opaqueFraction > 0.25, `opaque ${stats.opaqueFraction}`);
    assert.ok(stats.transparentFraction > 0.5, `transparent ${stats.transparentFraction}`);
    // A narrow anti-aliased band, not a soft-focus mask.
    assert.ok(stats.partialFraction < 0.02, `partial ${stats.partialFraction}`);
  });

  it("AMBIGUOUS: leaves a heavy compound-stroke counter for the customer to decide", () => {
    // The class this fixture's own display glyphs are NOT in, pinned here so
    // the suite cannot be read as proving more than it does.
    //
    // `darkOutlinedDisplayArtwork` reproduces the real artwork's outlined
    // display face: a compound outer-outline + fill + inner-outline wall
    // around the counter. The automatic pass refuses it, and that refusal is
    // CORRECT — the wall/inradius statistic that would reach it also reaches
    // the finger holes above, which are the customer's bowling ball.
    const image = darkOutlinedDisplayArtwork();
    const analysis = analyzeArtwork({
      image,
      format: "image/png",
      byteSize: 64_000,
      declaresAlphaChannel: false,
      printPlacement: null,
      intendedPrintWidthIn: null,
    });
    const model = {
      backgroundColor: analysis.estimatedBackgroundColor,
      tolerance: analysis.backgroundTolerance,
    };

    const automatic = isolateBackground(image, model);
    assert.equal(automatic.record.enclosedCavityRegionsRemoved, 0);
    assert.equal(getPixel(automatic.image, 70, 80).a, 255, "still opaque");

    // And the resolution is a click, not a threshold.
    const guided = isolateBackground(image, {
      ...model,
      guidedRemovalPoints: [{ x: 70, y: 80 }],
    });
    assert.equal(guided.record.guidedRegionsRemoved, 1);
    assert.equal(getPixel(guided.image, 70, 80).a, 0, "removed on request");
  });

  it("runs the whole upload → prepare → approve flow offline and never touches the original", async () => {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const capability = createArtworkPreparationCapability(
      repo,
      assets,
      createDesignBriefCapability(repo),
    );

    const projectId = (await repo.createProject()).project.id;
    const uploadedBytes = toPngBytes(bowlingLetterformArtwork());
    const uploadedHash = createHash("sha256").update(uploadedBytes).digest("hex");

    await capability.uploadOriginal(projectId, {
      bytes: uploadedBytes,
      declaredContentType: "image/png",
      filename: "split disturbers.png",
    });
    await capability.setProductionContext(projectId, {
      productSummary: "T-shirts for our bowling team",
      productColor: "Black",
      printPlacement: "full_front",
    });
    const view = await capability.prepareBackground(projectId);
    assert.equal(view.hasPreparedArtwork, true);

    const preparation = await repo.getArtworkPreparation(projectId);
    const preparedBytes = await assets.downloadAssetBytes(preparation!.preparedAssetId!);
    const decoded = decodePngUpload(preparedBytes!.bytes);

    // The defect, end to end through the real capability: counters gone,
    // finger holes intact.
    assert.equal(getPixel(decoded.image, BOWLING_DISPLAY_GLYPH_X[0]! + 50, 825).a, 0);
    assert.equal(getPixel(decoded.image, BOWLING_SMALL_GLYPH_X[0]! + 10, 952).a, 0);
    for (const hole of BOWLING_FINGER_HOLES) {
      assert.equal(getPixel(decoded.image, hole.x, hole.y).a, 255);
    }

    const record = preparation!.preparation!;
    assert.equal(record.enclosedCavityRegionsRemoved, 17);
    assert.equal(record.enclosedCavityPixelsRemoved, 23_304);

    const originalAfter = await assets.downloadAssetBytes(preparation!.originalAssetId);
    assert.equal(
      createHash("sha256").update(originalAfter!.bytes).digest("hex"),
      uploadedHash,
      "the uploaded original is immutable",
    );

    // Phase 1.2: guided cleanup is offered at exactly this point — after the
    // automatic pass, before approval — and a click on the ball is refused.
    assert.equal(view.guidedCleanup.available, true);
    assert.equal(view.guidedCleanup.removalCount, 0);

    const clickedBall = await capability.applyGuidedCleanup(projectId, {
      x: BOWLING_FINGER_HOLES[0]!.x + 40,
      y: BOWLING_FINGER_HOLES[0]!.y,
    });
    assert.equal(clickedBall.outcome, "not_background", "the gold ball is artwork");
    assert.equal(clickedBall.view.guidedCleanup.removalCount, 0);

    const approved = await capability.approvePreparedArtwork(projectId);
    assert.equal(approved.approved, true);
    assert.equal(
      approved.guidedCleanup.available,
      false,
      "an approved preparation is history, not a working copy",
    );

    // No provider of any kind was reachable for the duration.
    assert.deepEqual(networkAttempts, []);
    assert.deepEqual(await repo.listGenerationJobs(projectId), []);
    assert.equal(await repo.claimNextQueuedFinalArtworkJob(), null);
  });
});

/** 4-connected BFS distance from any transparent pixel, capped at `max`. */
function distanceFromTransparent(image: RgbaImage, max: number): Int32Array {
  const { width, height, data } = image;
  const total = width * height;
  const distance = new Int32Array(total).fill(max + 1);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  for (let pixel = 0; pixel < total; pixel += 1) {
    if (data[pixel * 4 + 3]! === 0) {
      distance[pixel] = 0;
      queue[tail++] = pixel;
    }
  }

  while (head < tail) {
    const pixel = queue[head++]!;
    const next = distance[pixel]! + 1;
    if (next > max) continue;

    const x = pixel % width;
    const y = (pixel - x) / width;
    const visit = (neighbor: number): void => {
      if (distance[neighbor]! <= next) return;
      distance[neighbor] = next;
      queue[tail++] = neighbor;
    };

    if (x > 0) visit(pixel - 1);
    if (x < width - 1) visit(pixel + 1);
    if (y > 0) visit(pixel - width);
    if (y < height - 1) visit(pixel + width);
  }

  return distance;
}

function visibleBounds(image: RgbaImage): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  const { width, height, data } = image;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;

  for (let pixel = 0; pixel < width * height; pixel += 1) {
    if (data[pixel * 4 + 3]! < VISIBLE_ALPHA_THRESHOLD) continue;
    const x = pixel % width;
    const y = (pixel - x) / width;
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }

  return { left, top, right, bottom };
}

function alphaStatistics(image: RgbaImage): {
  opaqueFraction: number;
  transparentFraction: number;
  partialFraction: number;
} {
  const total = image.width * image.height;
  let opaque = 0;
  let transparent = 0;
  let partial = 0;

  for (let pixel = 0; pixel < total; pixel += 1) {
    const alpha = image.data[pixel * 4 + 3]!;
    if (alpha === 255) opaque += 1;
    else if (alpha === 0) transparent += 1;
    else partial += 1;
  }

  return {
    opaqueFraction: opaque / total,
    transparentFraction: transparent / total,
    partialFraction: partial / total,
  };
}
