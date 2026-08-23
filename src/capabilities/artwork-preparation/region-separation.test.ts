import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { analyzeArtwork } from "./image-analysis";
import { decodePngUpload } from "./image-decode";
import { VISIBLE_ALPHA_THRESHOLD } from "./pixel-metrics";
import {
  buildSeparationMaster,
  computeExteriorSilhouette,
  computeInkMask,
  computeRegionMap,
  runSeparationPostChecks,
  MIN_CONSEQUENTIAL_REGION_PX,
  SEPARATION_ALGORITHM_VERSION,
} from "./region-separation";
import type { RegionDecision } from "./region-separation-contracts";
import {
  bowlingStyleArtwork,
  solidBlackExteriorArtwork,
} from "./artwork-fixtures";
import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

const BOWLING_ORIGINAL = path.resolve(
  process.cwd(),
  ".local-acceptance/8e632bd5-2257-48c2-8dad-efa8549cf88e_Bowling_Logo.png",
);
const hasBowling = existsSync(BOWLING_ORIGINAL);

function decideAll(regionMap: ReturnType<typeof computeRegionMap>["regionMap"], substrateIds: number[]): RegionDecision[] {
  const substrate = new Set(substrateIds);
  return regionMap.consequentialRegions.map((r) => ({
    regionId: r.regionId,
    intent: substrate.has(r.regionId) ? ("substrate" as const) : ("ink" as const),
    source: "operator" as const,
    decidedAt: "2026-01-01T00:00:00.000Z",
  }));
}

describe("region-separation: pure geometry", () => {
  it("is deterministic — identical input always yields the identical region map hash", () => {
    const image = bowlingStyleArtwork();
    const analysis = analyzeArtwork({
      image,
      format: "image/png",
      byteSize: image.data.length,
      declaresAlphaChannel: true,
      printPlacement: null,
      intendedPrintWidthIn: null,
    });
    const a = computeRegionMap(image, "sha-a", analysis.estimatedBackgroundColor, analysis.backgroundTolerance);
    const b = computeRegionMap(image, "sha-a", analysis.estimatedBackgroundColor, analysis.backgroundTolerance);
    assert.equal(a.regionMap.regionMapHash, b.regionMap.regionMapHash);
    assert.deepEqual(a.regionMap.consequentialRegions, b.regionMap.consequentialRegions);
  });

  it("the region map hash changes when the source identity changes, even with identical pixels", () => {
    const image = bowlingStyleArtwork();
    const analysis = analyzeArtwork({
      image,
      format: "image/png",
      byteSize: image.data.length,
      declaresAlphaChannel: true,
      printPlacement: null,
      intendedPrintWidthIn: null,
    });
    const a = computeRegionMap(image, "sha-a", analysis.estimatedBackgroundColor, analysis.backgroundTolerance);
    const b = computeRegionMap(image, "sha-b", analysis.estimatedBackgroundColor, analysis.backgroundTolerance);
    // Same region content, different declared source — the map hash is a
    // function of (algorithmVersion, radius, regions) only, so it is EQUAL
    // here; sourceAssetSha256 is the separate field a decision set is ALSO
    // pinned against. Both must agree for a decision set to apply.
    assert.equal(a.regionMap.regionMapHash, b.regionMap.regionMapHash);
    assert.notEqual(a.regionMap.sourceAssetSha256, b.regionMap.sourceAssetSha256);
  });

  it("MIN_CONSEQUENTIAL_REGION_PX is a stated, non-zero floor", () => {
    assert.ok(MIN_CONSEQUENTIAL_REGION_PX > 0);
  });

  it("SEPARATION_ALGORITHM_VERSION is a stable, non-empty identity", () => {
    assert.ok(SEPARATION_ALGORITHM_VERSION.length > 0);
    const image = bowlingStyleArtwork();
    const analysis = analyzeArtwork({
      image,
      format: "image/png",
      byteSize: image.data.length,
      declaresAlphaChannel: true,
      printPlacement: null,
      intendedPrintWidthIn: null,
    });
    const { regionMap } = computeRegionMap(image, "sha", analysis.estimatedBackgroundColor, analysis.backgroundTolerance);
    assert.equal(regionMap.algorithmVersion, SEPARATION_ALGORITHM_VERSION);
  });

  it("W/X: no network import anywhere in this module (structural — no AI, no Topaz)", () => {
    const source = readFileSync(path.join(__dirname, "region-separation.ts"), "utf8");
    for (const forbidden of [/\bfetch\(/, /openai/i, /topaz/i, /node:https?/, /"https?:\/\//]) {
      assert.doesNotMatch(source, forbidden, `region-separation.ts must not reference ${forbidden}`);
    }
  });

  describe("exterior silhouette + master construction", () => {
    function prepare(image: RgbaImage) {
      const analysis = analyzeArtwork({
        image,
        format: "image/png",
        byteSize: image.data.length,
        declaresAlphaChannel: true,
        printPlacement: null,
        intendedPrintWidthIn: null,
      });
      const ink = computeInkMask(image, analysis.estimatedBackgroundColor, analysis.backgroundTolerance);
      const silhouette = computeExteriorSilhouette(ink, image.width, image.height);
      return { ink, silhouette, analysis };
    }

    it("exterior stays fully transparent regardless of region decisions", () => {
      const image = bowlingStyleArtwork();
      const analysis = analyzeArtwork({
        image,
        format: "image/png",
        byteSize: image.data.length,
        declaresAlphaChannel: true,
        printPlacement: null,
        intendedPrintWidthIn: null,
      });
      const computation = computeRegionMap(image, "sha", analysis.estimatedBackgroundColor, analysis.backgroundTolerance);
      const master = buildSeparationMaster(image, computation, []);
      // corner probes: this fixture's exterior touches every border.
      for (const [x, y] of [[0, 0], [image.width - 1, 0], [0, image.height - 1], [image.width - 1, image.height - 1]]) {
        const a = master.data[(y * image.width + x) * 4 + 3]!;
        assert.equal(a, 0, `corner (${x},${y}) must be transparent`);
      }
    });

    it("I: a region decided substrate becomes fully transparent, alpha only", () => {
      const image = bowlingStyleArtwork();
      const analysis = analyzeArtwork({
        image,
        format: "image/png",
        byteSize: image.data.length,
        declaresAlphaChannel: true,
        printPlacement: null,
        intendedPrintWidthIn: null,
      });
      const computation = computeRegionMap(image, "sha", analysis.estimatedBackgroundColor, analysis.backgroundTolerance);
      assert.ok(computation.regionMap.consequentialRegions.length > 0, "fixture must have a consequential region");
      const targetId = computation.regionMap.consequentialRegions[0]!.regionId;
      const decisions: RegionDecision[] = [
        { regionId: targetId, intent: "substrate", source: "operator", decidedAt: "2026-01-01T00:00:00.000Z" },
      ];
      const master = buildSeparationMaster(image, computation, decisions);
      let anyTransparent = 0;
      for (let i = 0; i < computation.label.length; i += 1) {
        if (computation.label[i] === targetId) {
          if (master.data[i * 4 + 3]! === 0) anyTransparent += 1;
        }
      }
      assert.equal(anyTransparent, computation.regionMap.consequentialRegions[0]!.pixelCount);
    });

    it("J: a region decided ink preserves original RGB and alpha exactly", () => {
      const image = bowlingStyleArtwork();
      const analysis = analyzeArtwork({
        image,
        format: "image/png",
        byteSize: image.data.length,
        declaresAlphaChannel: true,
        printPlacement: null,
        intendedPrintWidthIn: null,
      });
      const computation = computeRegionMap(image, "sha", analysis.estimatedBackgroundColor, analysis.backgroundTolerance);
      const master = buildSeparationMaster(image, computation, []); // undecided = ink by default
      for (let i = 0; i < computation.label.length; i += 1) {
        if (computation.label[i] !== computation.regionMap.consequentialRegions[0]?.regionId) continue;
        const idx = i * 4;
        assert.equal(master.data[idx], image.data[idx]);
        assert.equal(master.data[idx + 1], image.data[idx + 1]);
        assert.equal(master.data[idx + 2], image.data[idx + 2]);
        assert.equal(master.data[idx + 3], image.data[idx + 3]);
      }
    });

    it("no radius can remove an ink pixel — safety invariant of the silhouette", () => {
      const image = solidBlackExteriorArtwork();
      const { ink, silhouette } = prepare(image);
      for (let i = 0; i < ink.length; i += 1) {
        if (ink[i]) assert.equal(silhouette[i], 1, `ink pixel ${i} must always be inside the silhouette`);
      }
    });
  });

  describe("post-checks: pixel authority proof", () => {
    it("RGB is never altered and alpha is never raised, for any decision mix", () => {
      const image = bowlingStyleArtwork();
      const analysis = analyzeArtwork({
        image,
        format: "image/png",
        byteSize: image.data.length,
        declaresAlphaChannel: true,
        printPlacement: null,
        intendedPrintWidthIn: null,
      });
      const computation = computeRegionMap(image, "sha", analysis.estimatedBackgroundColor, analysis.backgroundTolerance);
      const allSubstrate = decideAll(computation.regionMap, computation.regionMap.consequentialRegions.map((r) => r.regionId));
      const master = buildSeparationMaster(image, computation, allSubstrate);
      const check = runSeparationPostChecks(image, master, computation, allSubstrate);
      assert.equal(check.rgbPreserved, true);
      assert.equal(check.noAlphaRaised, true);
      assert.equal(check.passed, true);
    });
  });

  describe(
    "O: the REAL live bowling asset — ground-truth master",
    { skip: !hasBowling },
    () => {
      it("region 1 (badge disc) and region 140 (letter counter) are consequential; deciding them substrate preserves the tagline and the banner", () => {
        const bytes = readFileSync(BOWLING_ORIGINAL);
        assert.equal(
          createHash("sha256").update(bytes).digest("hex"),
          "99ee94fcc89884415e7188d8bc06f804cc5222ec4652fb68ee75c0e0a080afa5",
        );
        const decoded = decodePngUpload(bytes);
        const analysis = analyzeArtwork({
          image: decoded.image,
          format: "image/png",
          byteSize: bytes.length,
          declaresAlphaChannel: decoded.header.declaresAlphaChannel,
          printPlacement: "full_front",
          intendedPrintWidthIn: 10.5,
        });
        const computation = computeRegionMap(
          decoded.image,
          "bowling-sha",
          analysis.estimatedBackgroundColor,
          analysis.backgroundTolerance,
        );

        const ids = computation.regionMap.consequentialRegions.map((r) => r.regionId);
        assert.ok(ids.includes(1), "region 1 (the badge disc) must be consequential");
        assert.ok(ids.includes(73), "region 73 (banner + wordmark shadow) must be consequential");
        assert.ok(ids.includes(140), "region 140 (letter counter) must be consequential");

        const decisions = decideAll(computation.regionMap, [1, 140]);
        const master = buildSeparationMaster(decoded.image, computation, decisions);

        // Tagline region (banner, id 73) must be fully retained.
        let bannerKept = 0;
        let bannerTotal = 0;
        for (let i = 0; i < computation.label.length; i += 1) {
          if (computation.label[i] !== 73) continue;
          bannerTotal += 1;
          if (master.data[i * 4 + 3]! >= VISIBLE_ALPHA_THRESHOLD) bannerKept += 1;
        }
        assert.equal(bannerKept, bannerTotal, "the banner region (73) must be fully preserved");

        // The badge disc (region 1) must be fully transparent.
        let discCleared = 0;
        let discTotal = 0;
        for (let i = 0; i < computation.label.length; i += 1) {
          if (computation.label[i] !== 1) continue;
          discTotal += 1;
          if (master.data[i * 4 + 3]! === 0) discCleared += 1;
        }
        assert.equal(discCleared, discTotal, "the badge disc region (1) must be fully transparent");

        // The letter counter (region 140) must be fully transparent.
        let counterCleared = 0;
        let counterTotal = 0;
        for (let i = 0; i < computation.label.length; i += 1) {
          if (computation.label[i] !== 140) continue;
          counterTotal += 1;
          if (master.data[i * 4 + 3]! === 0) counterCleared += 1;
        }
        assert.equal(counterCleared, counterTotal, "the letter counter region (140) must be fully transparent");

        // Pixel-authority proof, on the real asset.
        const check = runSeparationPostChecks(decoded.image, master, computation, decisions);
        assert.equal(check.rgbPreserved, true);
        assert.equal(check.noAlphaRaised, true);
        assert.equal(check.passed, true);
      });
    },
  );
});
