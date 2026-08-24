import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { analyzeArtwork } from "./image-analysis";
import { decodePngUpload } from "./image-decode";
import {
  buildSeparationMaster,
  computeProposalHash,
  computeRegionMap,
  selectPreserveException,
  type ProposalAuthority,
} from "./region-separation";
import { isProposalStale, effectiveProposalDecision } from "./separation-review";
import { openLineArtFrameArtwork, openLineArtFrameGapDriftedArtwork, toPngBytes } from "./artwork-fixtures";
import type { PreserveExceptionOperation, SeparationDecisionSet } from "./region-separation-contracts";

/**
 * Phase 23B: OPEN-LINE-ART FALSIFICATION.
 *
 * `openLineArtFrameArtwork` (see `artwork-fixtures.ts` for the full
 * geometry doc) is genuine thin-stroke line art — not a filled block —
 * enclosing a background-colored interior connected to the true exterior
 * through one deliberate 30px gap, wide enough to defeat
 * `SILHOUETTE_RADIUS_PX`'s 6px gap-closing. It reproduces the EXACT class
 * of topology Phase 17 found silently, unconditionally removing real pixels
 * on the "STRIKINGLY INCREDIBLE" ribbon and the bowling-pin cluster.
 *
 * Every assertion here is modeled directly on Phase 17's exhaustive
 * real-asset proof and Phase 23's own provenance-accounting suite
 * (`proposal-authority.test.ts`) — this file exists only to anchor those
 * same guarantees to a fixture built specifically to falsify
 * "border-connected == safe" for genuine line art, the one gap Phase 23's
 * own checkpoint report flagged as untested.
 */

function computeFor(bytes: Buffer) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const { image } = decodePngUpload(bytes);
  const analysis = analyzeArtwork({
    image,
    format: "image/png",
    byteSize: bytes.length,
    declaresAlphaChannel: true,
    printPlacement: "full_front",
    intendedPrintWidthIn: null,
  });
  const computation = computeRegionMap(image, sha256, analysis.estimatedBackgroundColor, analysis.backgroundTolerance);
  return { image, sha256, computation };
}

describe("Phase 23B: open line art — historical failure reproduction (Section 3)", () => {
  it("the frame's ink fully encloses the interior (0 isolated consequential regions — this is purely an in-bounds-proposal case)", () => {
    const { computation } = computeFor(toPngBytes(openLineArtFrameArtwork()));
    assert.equal(computation.regionMap.consequentialRegions.length, 0);
  });

  it("the enclosed interior is silhouette-connected to the true exterior AND sits inside artworkBounds — exactly the conjunction the pre-Phase-23 code could not distinguish from safe", () => {
    const { image, computation } = computeFor(toPngBytes(openLineArtFrameArtwork()));
    const bounds = computation.regionMap.artworkBounds;
    const deepInteriorX = 130;
    const deepInteriorY = 130;
    const i = deepInteriorY * image.width + deepInteriorX;
    const insideBounds =
      deepInteriorX >= bounds.left &&
      deepInteriorX < bounds.left + bounds.width &&
      deepInteriorY >= bounds.top &&
      deepInteriorY < bounds.top + bounds.height;
    assert.equal(computation.silhouette[i], 0, "the deep interior must be flood-reachable from the border (silhouette-connected)");
    assert.equal(insideBounds, true, "the deep interior must sit inside artworkBounds (enclosed by the frame's own ink)");
  });

  it("a nonzero in-bounds proposal exists, and its pixel count is recorded — the exact set of pixels the old unconditional flood would have removed", () => {
    const { computation } = computeFor(toPngBytes(openLineArtFrameArtwork()));
    const proposal = computation.regionMap.inBoundsProposal;
    assert.ok(proposal, "openLineArtFrameArtwork must produce a nonzero in-bounds proposal");
    assert.ok(proposal!.pixelCount > 1000, `expected a substantial affected-pixel count, got ${proposal!.pixelCount}`);
    console.log(`Phase 23B: open-line-art in-bounds proposal pixel count = ${proposal!.pixelCount}`);
  });

  it("a nearby far corner is genuinely safe — silhouette-connected but OUTSIDE artworkBounds, unconditionally removable regardless of proposal decision", () => {
    const { image, computation } = computeFor(toPngBytes(openLineArtFrameArtwork()));
    const bounds = computation.regionMap.artworkBounds;
    for (const [x, y] of [[10, 10], [250, 250], [250, 10], [10, 250]] as const) {
      const i = y * image.width + x;
      const insideBounds = x >= bounds.left && x < bounds.left + bounds.width && y >= bounds.top && y < bounds.top + bounds.height;
      assert.equal(computation.silhouette[i], 0, `(${x},${y}) must be silhouette-connected`);
      assert.equal(insideBounds, false, `(${x},${y}) must be outside artworkBounds`);
    }
  });
});

describe("Phase 23B: pending — the critical safe-default assertion (Section 4)", () => {
  it("exhaustive: safe exterior removed, open interior retained, RGB unchanged, alpha never raised, UNEXPLAINED = 0", () => {
    const { image, computation } = computeFor(toPngBytes(openLineArtFrameArtwork()));
    const authority: ProposalAuthority = { decision: "pending", preserveOperations: [] };
    const master = buildSeparationMaster(image, computation, [], authority);

    const proposalMask = computation.proposalMask!;
    const bounds = computation.regionMap.artworkBounds;
    let totalAlphaLowered = 0;
    let safeExteriorLowered = 0;
    let unexplained = 0;
    let alphaRaised = 0;
    let rgbMismatchAmongRetained = 0;

    for (let i = 0; i < image.width * image.height; i += 1) {
      const x = i % image.width;
      const y = (i / image.width) | 0;
      const origA = image.data[i * 4 + 3]!;
      const newA = master.data[i * 4 + 3]!;
      const insideBounds = x >= bounds.left && x < bounds.left + bounds.width && y >= bounds.top && y < bounds.top + bounds.height;

      if (newA > origA) alphaRaised += 1;

      if (newA < origA) {
        totalAlphaLowered += 1;
        if (computation.silhouette[i] === 0 && !insideBounds) safeExteriorLowered += 1;
        else unexplained += 1; // "pending" must never lower a proposal pixel, isolated region, or ordinary ink pixel.
        continue;
      }

      // Retained pixel (newA === origA): RGB must be byte-identical.
      if (
        master.data[i * 4] !== image.data[i * 4] ||
        master.data[i * 4 + 1] !== image.data[i * 4 + 1] ||
        master.data[i * 4 + 2] !== image.data[i * 4 + 2]
      ) {
        rgbMismatchAmongRetained += 1;
      }
    }

    assert.ok(safeExteriorLowered > 0, "the true exterior outside artworkBounds must still be automatically removed");
    assert.equal(unexplained, 0, "no proposal pixel, isolated region, or ordinary ink pixel may lose alpha under pending");
    assert.equal(alphaRaised, 0, "alpha must never be raised");
    assert.equal(rgbMismatchAmongRetained, 0, "RGB among retained pixels must be byte-identical to the original");

    // The deep interior specifically, not just "some" proposal pixel.
    const deepInteriorIdx = 130 * image.width + 130;
    assert.equal(master.data[deepInteriorIdx * 4 + 3], 255, "the deep open-interior pixel must remain opaque under pending");

    // Zero proposal pixels removed, exhaustively.
    for (let i = 0; i < proposalMask.length; i += 1) {
      if (proposalMask[i]) assert.equal(master.data[i * 4 + 3], 255, `proposal pixel ${i} must remain opaque under pending`);
    }
  });
});

describe("Phase 23B: preserve_all (Section 5)", () => {
  it("the open interior remains preserved; safe exterior outside artworkBounds is still removed", () => {
    const { image, computation } = computeFor(toPngBytes(openLineArtFrameArtwork()));
    const master = buildSeparationMaster(image, computation, [], { decision: "preserve_all", preserveOperations: [] });
    const proposalMask = computation.proposalMask!;

    for (let i = 0; i < proposalMask.length; i += 1) {
      if (proposalMask[i]) assert.equal(master.data[i * 4 + 3], 255, `proposal pixel ${i} must remain opaque under preserve_all`);
    }
    for (const [x, y] of [[10, 10], [250, 250]] as const) {
      const i = y * image.width + x;
      assert.equal(master.data[i * 4 + 3], 0, `safe exterior (${x},${y}) must still be removed under preserve_all`);
    }

    // preserve_all is pixel-identical to pending — same as the sibling
    // curvedBandWithGapArtwork proof in proposal-authority.test.ts.
    const pending = buildSeparationMaster(image, computation, [], { decision: "pending", preserveOperations: [] });
    assert.ok(pending.data.equals(master.data));
  });
});

describe("Phase 23B: remove_with_exceptions (Section 6)", () => {
  it("zero exceptions: the in-bounds proposal becomes removable ONLY because of explicit operator authority — safe exterior removal is the SAME mechanism either way", () => {
    const { image, computation } = computeFor(toPngBytes(openLineArtFrameArtwork()));
    const proposalMask = computation.proposalMask!;
    const bounds = computation.regionMap.artworkBounds;

    const master = buildSeparationMaster(image, computation, [], { decision: "remove_with_exceptions", preserveOperations: [] });

    let totalAlphaLowered = 0;
    let safeExteriorLowered = 0;
    let proposalLowered = 0;
    let unexplained = 0;
    for (let i = 0; i < image.width * image.height; i += 1) {
      const origA = image.data[i * 4 + 3]!;
      const newA = master.data[i * 4 + 3]!;
      if (newA >= origA) continue;
      totalAlphaLowered += 1;
      const x = i % image.width;
      const y = (i / image.width) | 0;
      const insideBounds = x >= bounds.left && x < bounds.left + bounds.width && y >= bounds.top && y < bounds.top + bounds.height;
      if (computation.silhouette[i] === 0 && !insideBounds) safeExteriorLowered += 1;
      else if (proposalMask[i]) proposalLowered += 1;
      else unexplained += 1;
    }
    assert.equal(unexplained, 0);
    assert.equal(totalAlphaLowered, safeExteriorLowered + proposalLowered);
    assert.equal(proposalLowered, computation.regionMap.inBoundsProposal!.pixelCount, "with zero exceptions, EVERY proposal pixel is removed");
  });

  it("with a preserve tap inside the open interior: snap succeeds, the capped selection stays entirely inside the proposal, selected pixels stay opaque, the rest of the proposal is removed, safe exterior stays removed, retained RGB is byte-identical", () => {
    const { image, computation } = computeFor(toPngBytes(openLineArtFrameArtwork()));
    const proposalMask = computation.proposalMask!;

    // A tap deep inside the open interior — well clear of the frame's ink.
    const tapX = 130;
    const tapY = 130;
    const selection = selectPreserveException(proposalMask, image.width, image.height, tapX, tapY, "cap:v1", "snap:v1");
    assert.equal(selection.outcome, "eligible", "the tap must land directly on the proposal — no snap needed");
    assert.ok(selection.pixelCount > 0);
    for (let i = 0; i < selection.mask.length; i += 1) {
      if (selection.mask[i]) assert.equal(proposalMask[i], 1, `every selected pixel (${i}) must itself be a proposal pixel`);
    }

    const op: PreserveExceptionOperation = {
      operationId: "op-open-line-art-1",
      rawTapX: tapX,
      rawTapY: tapY,
      capRuleVersion: "cap:v1",
      snapRuleVersion: "snap:v1",
      decidedAt: "2026-01-01T00:00:00.000Z",
      source: "operator",
    };
    const master = buildSeparationMaster(image, computation, [], { decision: "remove_with_exceptions", preserveOperations: [op] });

    // The tapped pixel and its whole selection stay opaque with exact RGB.
    for (let i = 0; i < selection.mask.length; i += 1) {
      if (!selection.mask[i]) continue;
      assert.equal(master.data[i * 4 + 3], 255, `selected pixel ${i} must remain opaque`);
      assert.equal(master.data[i * 4], image.data[i * 4]);
      assert.equal(master.data[i * 4 + 1], image.data[i * 4 + 1]);
      assert.equal(master.data[i * 4 + 2], image.data[i * 4 + 2]);
    }

    // Proposal pixels NOT covered by the selection are genuinely removed.
    let coveredAndOpaque = 0;
    let uncoveredAndRemoved = 0;
    let uncoveredAndStillOpaque = 0;
    for (let i = 0; i < proposalMask.length; i += 1) {
      if (!proposalMask[i]) continue;
      const opaque = master.data[i * 4 + 3] === 255;
      if (selection.mask[i]) {
        if (opaque) coveredAndOpaque += 1;
      } else if (opaque) {
        uncoveredAndStillOpaque += 1;
      } else {
        uncoveredAndRemoved += 1;
      }
    }
    assert.ok(coveredAndOpaque > 0, "the preserved patch must be nonempty");
    assert.ok(uncoveredAndRemoved > 0, "some other proposal pixels must genuinely be removed");
    assert.equal(uncoveredAndStillOpaque, 0, "no proposal pixel outside the selection may remain opaque");

    // Safe exterior remains removed regardless of the tap.
    for (const [x, y] of [[10, 10], [250, 250]] as const) {
      const i = y * image.width + x;
      assert.equal(master.data[i * 4 + 3], 0, `safe exterior (${x},${y}) must remain removed`);
    }
  });
});

describe("Phase 23B: staleness (Section 7)", () => {
  it("moving the frame's gap to a different wall changes the proposalHash even though the overall bounds/footprint are similar", () => {
    const original = computeFor(toPngBytes(openLineArtFrameArtwork()));
    const drifted = computeFor(toPngBytes(openLineArtFrameGapDriftedArtwork()));
    const originalProposal = original.computation.regionMap.inBoundsProposal!;
    const driftedProposal = drifted.computation.regionMap.inBoundsProposal!;

    // Deliberately similar summary shape — same overall frame footprint
    // (the ink itself never moved, only which wall has the gap) and a
    // similar proposal pixel count, which is exactly why
    // `computeProposalHash` hashes the canonical mask rather than trusting
    // bounds/pixelCount as identity (Phase 22B Issue 1). The proposal's own
    // (gap-dependent) bounding box legitimately differs by a few pixels —
    // it is `artworkBounds`, the ink's own footprint, that stays identical.
    assert.deepEqual(original.computation.regionMap.artworkBounds, drifted.computation.regionMap.artworkBounds);
    assert.ok(
      Math.abs(originalProposal.pixelCount - driftedProposal.pixelCount) < originalProposal.pixelCount * 0.1,
      `pixel counts should be similar: ${originalProposal.pixelCount} vs ${driftedProposal.pixelCount}`,
    );
    assert.notEqual(originalProposal.proposalHash, driftedProposal.proposalHash);
  });

  it("a preserve operation computed against the OLD gap position never silently replays as authority against the drifted geometry — staleness fails closed and PRESERVES rather than destroys", () => {
    const original = computeFor(toPngBytes(openLineArtFrameArtwork()));
    const drifted = computeFor(toPngBytes(openLineArtFrameGapDriftedArtwork()));

    // A decision set genuinely decided against the ORIGINAL proposal...
    const staleDecisionSet: SeparationDecisionSet = {
      sourceAssetSha256: original.sha256,
      regionMapHash: original.computation.regionMap.regionMapHash,
      algorithmVersion: original.computation.regionMap.algorithmVersion,
      decisions: [],
      proposalDecision: "remove_with_exceptions",
      proposalDecisionAt: "2026-01-01T00:00:00.000Z",
      proposalHash: original.computation.regionMap.inBoundsProposal!.proposalHash,
      proposalPreserveOps: [
        {
          operationId: "op-1",
          rawTapX: 130,
          rawTapY: 130,
          capRuleVersion: "cap:v1",
          snapRuleVersion: "snap:v1",
          decidedAt: "2026-01-01T00:00:00.000Z",
          source: "operator",
        },
      ],
      approvedAt: null,
      approvedAssetId: null,
      postCheckAtApproval: null,
    };

    // ...but read against the DRIFTED regionMap.
    assert.equal(isProposalStale(drifted.computation.regionMap, staleDecisionSet), true);
    assert.equal(
      effectiveProposalDecision(drifted.computation.regionMap, staleDecisionSet),
      "pending",
      "a stale proposal decision must fail closed to pending, never silently apply the old operation's authority",
    );

    // Rebuilding the master against the DRIFTED computation using the
    // fail-closed EFFECTIVE decision (pending) — never the raw stale
    // "remove_with_exceptions" — must retain the drifted proposal entirely.
    // This is the concrete "failure preserves rather than destroys" proof:
    // compare against what would have happened had the stale
    // "remove_with_exceptions" + old operation been trusted directly.
    const failClosedMaster = buildSeparationMaster(drifted.image, drifted.computation, [], {
      decision: effectiveProposalDecision(drifted.computation.regionMap, staleDecisionSet)!,
      preserveOperations: [],
    });
    const driftedProposalMask = drifted.computation.proposalMask!;
    let retainedCount = 0;
    for (let i = 0; i < driftedProposalMask.length; i += 1) {
      if (!driftedProposalMask[i]) continue;
      if (failClosedMaster.data[i * 4 + 3] === 255) retainedCount += 1;
    }
    assert.equal(retainedCount, drifted.computation.regionMap.inBoundsProposal!.pixelCount, "every drifted-proposal pixel must be retained under the fail-closed read");

    // Contrast: if the stale write HAD been trusted directly (the bug this
    // guards against), it would have used "remove_with_exceptions" with an
    // operation whose (130,130) seed happens to still land inside the
    // drifted proposal too (same coordinate, both fixtures are open at the
    // center) — removing everything else in the DRIFTED shape the old
    // operation doesn't happen to cover. Confirming that UNSAFE outcome
    // would genuinely destroy pixels is what proves the fail-closed guard
    // above is load-bearing, not vacuous.
    const untrustedMaster = buildSeparationMaster(drifted.image, drifted.computation, [], {
      decision: staleDecisionSet.proposalDecision,
      preserveOperations: staleDecisionSet.proposalPreserveOps,
    });
    let untrustedRemoved = 0;
    for (let i = 0; i < driftedProposalMask.length; i += 1) {
      if (!driftedProposalMask[i]) continue;
      if (untrustedMaster.data[i * 4 + 3] === 0) untrustedRemoved += 1;
    }
    assert.ok(untrustedRemoved > 0, "sanity: trusting the stale write directly would genuinely have destroyed drifted-proposal pixels — proving the guard above is necessary");
  });
});
