import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import { createArtworkPreparationCapability } from "./artwork-preparation-capability";
import {
  CREAM_TEXT,
  bowlingStyleArtwork,
  foregroundRingArtwork,
  openLineArtFrameArtwork,
  openLineArtFrameGapDriftedArtwork,
  tallEventPosterArtwork,
  toPngBytes,
} from "./artwork-fixtures";
import { decodePngUpload } from "./image-decode";

/**
 * Phase 28C — THE FALSE-POSITIVE SEPARATION REVIEW FIX.
 *
 * A real customer order (a tall, portrait "Chili & Salsa Cook-Off / Rodeo /
 * Car Show" poster design) exposed a false-positive mandatory separation
 * review: the automatic background removal genuinely worked correctly
 * (exterior white gone, intentional interior text preserved), yet the
 * project still refused to approve it, demanding the customer complete a
 * separation review that could not change the outcome no matter how it was
 * answered.
 *
 * Root cause, traced with pixel-level evidence (not assumed): a TALL,
 * edge-to-edge design makes `artworkBounds` (the tight bounding box of ALL
 * ink) span nearly the whole canvas, which puts almost every removed
 * background pixel "in bounds" by pure geometry — regardless of whether
 * removing it could plausibly harm anything. The fix
 * (`InBoundsProposal.fullRemovalSafe`, `region-separation.ts`) computes,
 * once per region map, whether fully and automatically removing the ENTIRE
 * proposal — the worst case, zero preserve exceptions, zero region
 * decisions — would orphan any real ink pixel (reusing the EXISTING,
 * already-validated `runSeparationPostChecks`/`orphanedLightInkPixels`
 * safety net, Phase 6's own production-defect signal). Only when it would
 * NOT does a lone proposal stop forcing `review_not_required` away.
 *
 * Deliberately narrow: this affects ONLY the proposal axis. Consequential
 * regions (the Show Shirt / Print Ink / Not Sure decision) are completely
 * untouched — see `separation-review.test.ts`'s "Phase 28C" suite for the
 * pure state-machine proof, and the adversarial fixtures below for why that
 * caution is warranted (INCREDI-BOWLS, both open-line-art variants, and the
 * foreground ring must all remain exactly as conservative as before).
 */
describe("Phase 28C: a tall, edge-to-edge poster with a genuinely-safe background removal reaches approval without a forced separation review", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-phase28c-false-positive-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function harness() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const capability = createArtworkPreparationCapability(repo, assets, createDesignBriefCapability(repo));
    return { repo, assets, capability };
  }

  async function seeded(fixtureBytes: Buffer) {
    const { repo, assets, capability } = await harness();
    const projectId = (await repo.createProject()).project.id;
    await capability.uploadOriginal(projectId, {
      bytes: fixtureBytes,
      declaredContentType: "image/png",
      filename: "event-poster.png",
    });
    await capability.setProductionContext(projectId, {
      productSummary: "T-shirts",
      productColor: "White",
      printPlacement: "full_front",
    });
    return { repo, assets, capability, projectId };
  }

  it("A: automatic background removal is offered (not NEEDS_REVIEW) and reaches review_not_required -- no mandatory separation review for a genuinely safe removal", async () => {
    const { capability, projectId } = await seeded(toPngBytes(tallEventPosterArtwork()));
    const preparation = await capability.getPreparation(projectId);
    // Not NEEDS_REVIEW -- the small fixture's own pixel count also trips the
    // (unrelated, orthogonal) enhancement-needed flag against a real
    // full_front placement, which is expected and not what this test is
    // about; only the background-removal classification matters here.
    assert.notEqual(preparation!.classification, "NEEDS_REVIEW");
    assert.equal(preparation!.customer.canPrepare, true);

    await capability.prepareBackground(projectId);
    const review = await capability.getSeparationReview(projectId);
    assert.equal(review.state, "review_not_required");
  });

  it("A: approvePreparedArtwork succeeds directly -- no separation review ever blocks it for this artwork", async () => {
    const { capability, projectId } = await seeded(toPngBytes(tallEventPosterArtwork()));
    await capability.prepareBackground(projectId);
    const view = await capability.approvePreparedArtwork(projectId);
    assert.equal(view.approved, true);
  });

  it("B/C: the intentional cream text survives, byte-exact, in the approved prepared artwork -- the fix affects only the review GATE, never a pixel decision", async () => {
    const { repo, assets, capability, projectId } = await seeded(toPngBytes(tallEventPosterArtwork()));
    await capability.prepareBackground(projectId);
    await capability.approvePreparedArtwork(projectId);

    const preparation = await repo.getArtworkPreparation(projectId);
    const bytes = await assets.downloadAssetBytes(preparation!.preparedAssetId!);
    const decoded = decodePngUpload(bytes!.bytes).image;

    // Sample a pixel inside the top badge's cream text block (fixture
    // coordinates: fillRect(image, 30, 20, 140, 20, CREAM_TEXT)).
    const x = 60;
    const y = 28;
    const i = (y * decoded.width + x) * 4;
    assert.equal(decoded.data[i], CREAM_TEXT.r);
    assert.equal(decoded.data[i + 1], CREAM_TEXT.g);
    assert.equal(decoded.data[i + 2], CREAM_TEXT.b);
    assert.equal(decoded.data[i + 3], 255, "the intentional cream text must remain fully opaque -- never treated as background");
  });

  it("also proves the true exterior white margin WAS actually removed -- this is a fix to a false BLOCK, never a weakening of the removal itself", async () => {
    const { repo, assets, capability, projectId } = await seeded(toPngBytes(tallEventPosterArtwork()));
    await capability.prepareBackground(projectId);
    await capability.approvePreparedArtwork(projectId);

    const preparation = await repo.getArtworkPreparation(projectId);
    const bytes = await assets.downloadAssetBytes(preparation!.preparedAssetId!);
    const decoded = decodePngUpload(bytes!.bytes).image;

    // A true exterior corner, and a plain white margin strip well inside the
    // canvas but outside any ink -- both must be transparent.
    for (const [x, y] of [[2, 2], [2, 350]] as const) {
      const i = (y * decoded.width + x) * 4;
      assert.equal(decoded.data[i + 3], 0, `pixel (${x},${y}) must be removed background, not retained`);
    }
  });

  it("D (state-machine level): a genuinely disconnected consequential region on the SAME fixture shape still forces review -- proven directly against separation-review.ts's pure state machine in separation-review.test.ts's own 'Phase 28C' suite; here we confirm the capability-level review state is unaffected by fullRemovalSafe once a real region exists", async () => {
    // Reuses INCREDI-BOWLS (bowlingStyleArtwork) below for the full
    // capability-level proof rather than duplicating a second bespoke
    // fixture -- it already has real consequential regions and must stay
    // gated exactly as before.
    const { capability, projectId } = await seeded(toPngBytes(bowlingStyleArtwork()));
    await capability.prepareBackground(projectId);
    const review = await capability.getSeparationReview(projectId);
    assert.notEqual(review.state, "review_not_required");
  });
});

/**
 * E/F/G/H: the adversarial regression set. Every one of these fixtures
 * already has a real production concern the fix must not paper over --
 * confirmed here at the full capability level, not just the pure
 * `separation-review.ts` unit tests, since the false-positive fix touches
 * `computeRegionMap` (`region-separation.ts`) itself.
 */
describe("Phase 28C regression: existing difficult-artwork fixtures remain exactly as conservative as before", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-phase28c-adversarial-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function harness() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const capability = createArtworkPreparationCapability(repo, assets, createDesignBriefCapability(repo));
    return { repo, assets, capability };
  }

  async function reviewStateFor(fixture: () => ReturnType<typeof bowlingStyleArtwork>) {
    const { repo, capability } = await harness();
    const projectId = (await repo.createProject()).project.id;
    await capability.uploadOriginal(projectId, {
      bytes: toPngBytes(fixture()),
      declaredContentType: "image/png",
      filename: "artwork.png",
    });
    await capability.setProductionContext(projectId, {
      productSummary: "T-shirts",
      productColor: "White",
      printPlacement: "full_front",
    });
    await capability.prepareBackground(projectId);
    return capability.getSeparationReview(projectId);
  }

  it("E: INCREDI-BOWLS remains gated -- its consequential regions are real, decidable ambiguity, untouched by fullRemovalSafe", async () => {
    const review = await reviewStateFor(bowlingStyleArtwork);
    assert.notEqual(review.state, "review_not_required");
  });

  it("F: the open-line-art frame fixture remains gated", async () => {
    const review = await reviewStateFor(openLineArtFrameArtwork);
    assert.notEqual(review.state, "review_not_required");
  });

  it("F: the gap-drifted open-line-art frame fixture remains gated", async () => {
    const review = await reviewStateFor(openLineArtFrameGapDriftedArtwork);
    assert.notEqual(review.state, "review_not_required");
  });

  it("G: the foreground ring fixture remains gated", async () => {
    const review = await reviewStateFor(foregroundRingArtwork);
    assert.notEqual(review.state, "review_not_required");
  });
});
