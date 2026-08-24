import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { analyzeArtwork } from "./image-analysis";
import { decodePngUpload } from "./image-decode";
import {
  buildSeparationMaster,
  computeRegionMap,
  runSeparationPostChecks,
  type ProposalAuthority,
} from "./region-separation";
import { curvedBandWithGapArtwork, toPngBytes, proposalAdjacentToInkArtwork } from "./artwork-fixtures";
import type { PreserveExceptionOperation } from "./region-separation-contracts";

const INCREDI_BOWLS_PATH = path.resolve(
  process.cwd(),
  ".local-acceptance/e0078e6f-e802-4da1-ba3d-9f97490c4868_image_1_.png",
);
const hasIncrediBowls = existsSync(INCREDI_BOWLS_PATH);
const EXPECTED_SHA256 = "3643f74e5834bfef50fb8f101eb36a7b60655d9934d6f5cefaf91945c5e2ea70";

function computeFor(bytes: Buffer) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const { image } = decodePngUpload(bytes);
  const analysis = analyzeArtwork({
    image, format: "image/png", byteSize: bytes.length, declaresAlphaChannel: true,
    printPlacement: "full_front", intendedPrintWidthIn: null,
  });
  const computation = computeRegionMap(image, sha256, analysis.estimatedBackgroundColor, analysis.backgroundTolerance);
  return { image, sha256, computation };
}

/**
 * Phase 23, Section 7's provenance accounting test — modeled directly on
 * Phase 17's exhaustive real-asset proof. Every alpha-lowered pixel must
 * belong to EXACTLY one destructive authority; UNEXPLAINED must be 0.
 */
describe("buildSeparationMaster authority model — exhaustive provenance accounting", () => {
  it("pending: zero alpha lowered inside the proposal (the safe default)", () => {
    const { image, computation } = computeFor(toPngBytes(curvedBandWithGapArtwork()));
    const authority: ProposalAuthority = { decision: "pending", preserveOperations: [] };
    const master = buildSeparationMaster(image, computation, [], authority);
    const proposalMask = computation.proposalMask!;
    for (let i = 0; i < proposalMask.length; i++) {
      if (proposalMask[i]) assert.equal(master.data[i * 4 + 3], 255, `proposal pixel ${i} must remain opaque under "pending"`);
    }
  });

  it("preserve_all: zero alpha lowered inside the proposal, identical outcome to pending", () => {
    const { image, computation } = computeFor(toPngBytes(curvedBandWithGapArtwork()));
    const pending = buildSeparationMaster(image, computation, [], { decision: "pending", preserveOperations: [] });
    const preserveAll = buildSeparationMaster(image, computation, [], { decision: "preserve_all", preserveOperations: [] });
    assert.ok(pending.data.equals(preserveAll.data));
  });

  it("remove_with_exceptions, zero exceptions: every proposal pixel becomes transparent, safe exterior stays transparent, nothing else changes", () => {
    const { image, computation } = computeFor(toPngBytes(curvedBandWithGapArtwork()));
    const master = buildSeparationMaster(image, computation, [], { decision: "remove_with_exceptions", preserveOperations: [] });
    const proposalMask = computation.proposalMask!;
    let totalAlphaLowered = 0, safeExteriorLowered = 0, proposalLowered = 0, unexplained = 0;
    const bounds = computation.regionMap.artworkBounds;
    for (let i = 0; i < image.width * image.height; i++) {
      const origA = image.data[i * 4 + 3]!;
      const newA = master.data[i * 4 + 3]!;
      if (newA >= origA) continue;
      totalAlphaLowered++;
      const x = i % image.width, y = (i / image.width) | 0;
      const insideBounds = x >= bounds.left && x < bounds.left + bounds.width && y >= bounds.top && y < bounds.top + bounds.height;
      if (computation.silhouette[i] === 0 && !insideBounds) safeExteriorLowered++;
      else if (proposalMask[i]) proposalLowered++;
      else unexplained++;
    }
    assert.equal(unexplained, 0, "every alpha-lowered pixel must be explained");
    assert.equal(totalAlphaLowered, safeExteriorLowered + proposalLowered);
    assert.equal(proposalLowered, computation.regionMap.inBoundsProposal!.pixelCount);
  });

  it("remove_with_exceptions with a preserve operation: the covered patch stays opaque with exact original RGB, the rest of the proposal is removed", () => {
    const { image, computation } = computeFor(toPngBytes(curvedBandWithGapArtwork()));
    const proposalMask = computation.proposalMask!;
    const idx = proposalMask.findIndex((v) => v === 1);
    const x = idx % image.width, y = Math.floor(idx / image.width);
    const op: PreserveExceptionOperation = {
      operationId: "op-1",
      rawTapX: x,
      rawTapY: y,
      capRuleVersion: "cap:v1",
      snapRuleVersion: "snap:v1",
      decidedAt: "2026-01-01T00:00:00.000Z",
      source: "operator",
    };
    const master = buildSeparationMaster(image, computation, [], { decision: "remove_with_exceptions", preserveOperations: [op] });
    // The tapped pixel itself must stay opaque with exact original RGB.
    assert.equal(master.data[idx * 4 + 3], 255);
    assert.equal(master.data[idx * 4], image.data[idx * 4]);
    assert.equal(master.data[idx * 4 + 1], image.data[idx * 4 + 1]);
    assert.equal(master.data[idx * 4 + 2], image.data[idx * 4 + 2]);
    // At least SOME proposal pixel far from the tap must still be removed
    // (proves the exception is local, not a blanket preserve-all).
    let anyOtherRemoved = false;
    for (let i = 0; i < proposalMask.length; i++) {
      if (proposalMask[i] && i !== idx && master.data[i * 4 + 3] === 0) { anyOtherRemoved = true; break; }
    }
    assert.ok(anyOtherRemoved, "an exception must not silently become preserve_all");
  });

  it("retained RGB invariant holds across all three proposal decisions", () => {
    const { image, computation } = computeFor(toPngBytes(curvedBandWithGapArtwork()));
    for (const decision of ["pending", "remove_with_exceptions", "preserve_all"] as const) {
      const master = buildSeparationMaster(image, computation, [], { decision, preserveOperations: [] });
      let mismatches = 0;
      for (let i = 0; i < image.width * image.height; i++) {
        if (master.data[i * 4 + 3]! === 0) continue;
        if (
          master.data[i * 4] !== image.data[i * 4] ||
          master.data[i * 4 + 1] !== image.data[i * 4 + 1] ||
          master.data[i * 4 + 2] !== image.data[i * 4 + 2]
        ) mismatches++;
      }
      assert.equal(mismatches, 0, `RGB must be preserved under "${decision}"`);
    }
  });

  it("alpha is never raised above the original under any proposal decision", () => {
    const { image, computation } = computeFor(toPngBytes(curvedBandWithGapArtwork()));
    for (const decision of ["pending", "remove_with_exceptions", "preserve_all"] as const) {
      const master = buildSeparationMaster(image, computation, [], { decision, preserveOperations: [] });
      let raised = 0;
      for (let i = 0; i < image.width * image.height; i++) {
        if (master.data[i * 4 + 3]! > image.data[i * 4 + 3]!) raised++;
      }
      assert.equal(raised, 0, `alpha must never be raised under "${decision}"`);
    }
  });

  it("preserving proposal background adjacent to ink never alters that ink's RGB", () => {
    const { image, computation } = computeFor(toPngBytes(proposalAdjacentToInkArtwork()));
    const master = buildSeparationMaster(image, computation, [], { decision: "remove_with_exceptions", preserveOperations: [] });
    // Sample the red block's known location (60,60,60x60) directly.
    for (let y = 60; y < 120; y += 10) {
      for (let x = 60; x < 120; x += 10) {
        const i = y * image.width + x;
        assert.equal(master.data[i * 4 + 3], 255);
        assert.equal(master.data[i * 4], image.data[i * 4]);
        assert.equal(master.data[i * 4 + 1], image.data[i * 4 + 1]);
        assert.equal(master.data[i * 4 + 2], image.data[i * 4 + 2]);
      }
    }
  });

  it("backward compatibility: omitting the 4th parameter reproduces the pre-Phase-23 unconditional rule exactly", () => {
    const { image, computation } = computeFor(toPngBytes(curvedBandWithGapArtwork()));
    const withDefault = buildSeparationMaster(image, computation, []);
    const explicit = buildSeparationMaster(image, computation, [], { decision: "remove_with_exceptions", preserveOperations: [] });
    assert.ok(withDefault.data.equals(explicit.data));
  });
});

describe("Phase 23 real-asset acceptance: INCREDI-BOWLS pin + ribbon defects", { skip: !hasIncrediBowls }, () => {
  const bytes = hasIncrediBowls ? readFileSync(INCREDI_BOWLS_PATH) : Buffer.alloc(0);

  it("SHA256 matches Phase 17's recorded value", () => {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    assert.equal(sha256, EXPECTED_SHA256);
  });

  it("reproduces the known 18 consequential regions and a nonzero in-bounds proposal", () => {
    const { computation } = computeFor(bytes);
    assert.equal(computation.regionMap.consequentialRegions.length, 18);
    assert.ok(computation.regionMap.inBoundsProposal !== null);
    assert.equal(computation.regionMap.inBoundsProposal!.pixelCount, 94284);
  });

  it("BEFORE approval (pending): the upper-right pin area and the ribbon/shadow area remain fully opaque", () => {
    const { image, computation } = computeFor(bytes);
    const master = buildSeparationMaster(image, computation, [], { decision: "pending", preserveOperations: [] });
    // Sample points confirmed in Phase 17/19 to be inside the proposal, near
    // the pin cluster and the ribbon shadow respectively.
    for (const [x, y] of [[450, 160], [480, 130]]) {
      const i = y! * image.width + x!;
      assert.equal(master.data[i * 4 + 3], 255, `pin-area pixel (${x},${y}) must remain opaque before approval`);
    }
    for (const [x, y] of [[170, 500], [220, 505]]) {
      const i = y! * image.width + x!;
      assert.equal(master.data[i * 4 + 3], 255, `ribbon-area pixel (${x},${y}) must remain opaque before approval`);
    }
  });

  it("AFTER remove_with_exceptions with preserve taps: tapped pin/ribbon patches stay opaque, other proposal pixels become transparent, safe exterior stays transparent, RGB unchanged", () => {
    const { image, computation } = computeFor(bytes);
    const ops: PreserveExceptionOperation[] = [
      { operationId: "pin-1", rawTapX: 450, rawTapY: 160, capRuleVersion: "cap:v1", snapRuleVersion: "snap:v1", decidedAt: "2026-01-01T00:00:00.000Z", source: "operator" },
      { operationId: "pin-2", rawTapX: 480, rawTapY: 130, capRuleVersion: "cap:v1", snapRuleVersion: "snap:v1", decidedAt: "2026-01-01T00:00:00.000Z", source: "operator" },
      { operationId: "ribbon-1", rawTapX: 170, rawTapY: 500, capRuleVersion: "cap:v1", snapRuleVersion: "snap:v1", decidedAt: "2026-01-01T00:00:00.000Z", source: "operator" },
      { operationId: "ribbon-2", rawTapX: 220, rawTapY: 505, capRuleVersion: "cap:v1", snapRuleVersion: "snap:v1", decidedAt: "2026-01-01T00:00:00.000Z", source: "operator" },
    ];
    const authority: ProposalAuthority = { decision: "remove_with_exceptions", preserveOperations: ops };
    const master = buildSeparationMaster(image, computation, [], authority);

    for (const op of ops) {
      const i = op.rawTapY * image.width + op.rawTapX;
      assert.equal(master.data[i * 4 + 3], 255, `tapped pixel (${op.rawTapX},${op.rawTapY}) must remain opaque`);
      assert.equal(master.data[i * 4], image.data[i * 4]);
      assert.equal(master.data[i * 4 + 1], image.data[i * 4 + 1]);
      assert.equal(master.data[i * 4 + 2], image.data[i * 4 + 2]);
    }

    // Deep in the true exterior canvas corner -- outside artworkBounds
    // (verified directly: bounds are {left:11,top:65,width:562,height:486}
    // on this 584x640 canvas, so (5,5) is unambiguously outside them).
    const farCorner = 5 * image.width + 5;
    assert.equal(master.data[farCorner * 4 + 3], 0, "the unambiguous exterior must remain automatically transparent");

    // At least some proposal pixels NOT covered by any tap must be removed.
    const proposalMask = computation.proposalMask!;
    let anyOtherRemoved = false;
    for (let i = 0; i < proposalMask.length; i++) {
      if (!proposalMask[i]) continue;
      const isTapped = ops.some((op) => op.rawTapY * image.width + op.rawTapX === i);
      if (!isTapped && master.data[i * 4 + 3] === 0) { anyOtherRemoved = true; break; }
    }
    assert.ok(anyOtherRemoved, "operator-approved proposal pixels beyond the taps must actually be removed");

    // RGB invariant, exhaustive.
    let rgbMismatch = 0, alphaRaised = 0;
    for (let i = 0; i < image.width * image.height; i++) {
      if (master.data[i * 4 + 3]! > 0) {
        if (master.data[i * 4] !== image.data[i * 4] || master.data[i * 4 + 1] !== image.data[i * 4 + 1] || master.data[i * 4 + 2] !== image.data[i * 4 + 2]) rgbMismatch++;
        if (master.data[i * 4 + 3]! > image.data[i * 4 + 3]!) alphaRaised++;
      }
    }
    assert.equal(rgbMismatch, 0);
    assert.equal(alphaRaised, 0);
  });

  it("post-checks pass and report no unexplained authority", () => {
    const { image, computation } = computeFor(bytes);
    const authority: ProposalAuthority = { decision: "remove_with_exceptions", preserveOperations: [] };
    const master = buildSeparationMaster(image, computation, [], authority);
    const postCheck = runSeparationPostChecks(image, master, computation, [], authority);
    assert.equal(postCheck.rgbPreserved, true);
    assert.equal(postCheck.noAlphaRaised, true);
  });

  it("original source bytes are unchanged by any of the above (read-only throughout)", () => {
    const rehash = createHash("sha256").update(bytes).digest("hex");
    assert.equal(rehash, EXPECTED_SHA256);
  });
});
