import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assembleUploadedPreserveProductionPrintValidationInput } from "./assemble-input";
import { createPrintValidationCapability } from "./print-validation-capability";
import type {
  HalftoneProductionEvidence,
  PrintValidationReport,
  PrintValidationInput,
  ProductionNormalizationSummary,
  UploadedPreserveEvidence,
} from "./contracts";

/**
 * DTF-R1 — THE LAUNDERING BOUNDARY, at the validation layer.
 *
 * `reconstruction_certification_evidence` exists because provider
 * super-resolution produces a pixel COUNT, not proven visual fidelity, and
 * no reconstruction-quality authority exists yet. It was written to read
 * two signals that both describe what THIS job's own transform did:
 * `asset.resolutionProvenance` and `evidence.enhancement`.
 *
 * DTF-R1 introduced a third way for provider-manufactured pixels to reach a
 * plate: as its SOURCE. A plate normalized from a Production-Qualified
 * Clean Master truthfully records `enhancement: "skipped"` and
 * `resolutionProvenance: "native"` — nothing was reconstructed in that job —
 * and would otherwise have sailed straight through to automatic Print
 * Ready. `UploadedPreserveEvidence.sourceAuthority` is what makes that
 * lineage visible.
 *
 * This suite pins the boundary in both directions: it must fire for a
 * clean-master plate under BOTH production representations, and it must
 * change nothing for any plate that could exist before the field did.
 */
describe("DTF-R1 — clean-master certification boundary", () => {
  const printValidation = createPrintValidationCapability();

  const NORMALIZATION: ProductionNormalizationSummary = {
    strategy: "width_constrained_preserve_aspect",
    alphaBBoxWidthPx: 1800,
    alphaBBoxHeightPx: 800,
    trimmedWidthPx: 1800,
    trimmedHeightPx: 800,
    artworkOccupancy: 1,
    targetWidthIn: 4,
    widthToleranceIn: 0.05,
    targetPpi: 300,
    intendedWidthIn: 4,
    intendedHeightIn: 1.78,
    constrainedBy: "width",
    densityPixelsPerMetre: 11811,
  };

  function lineage(
    overrides: Partial<UploadedPreserveEvidence> = {},
  ): UploadedPreserveEvidence {
    return {
      preparedArtworkVersionId: "artwork-1",
      preparedAssetId: "source-asset-1",
      originalAssetId: "original-asset-1",
      sourceBytesSha256: "a".repeat(64),
      sourceAlphaBBoxWidthPx: 1800,
      sourceAlphaBBoxHeightPx: 800,
      enhancement: "skipped",
      ...overrides,
    };
  }

  /** The screen a real halftone plate at this geometry would record. */
  function halftoneEvidence(): HalftoneProductionEvidence {
    return {
      algorithmVersion: "halftone_v1",
      lpi: 30,
      angleDeg: 22.5,
      dotShape: "round",
      midtone: 1,
      chokePx: 0,
      garmentHex: "#000000",
      targetPpi: 300,
      cellPx: 10,
      achievedLpi: 30,
      minDotRadiusPx: 1,
      screenWidthPx: 1200,
      screenHeightPx: 534,
      visiblePixelCount: 640800,
      inkedPixelFraction: 0.5,
    };
  }

  function input(options: {
    uploadedPreserve: UploadedPreserveEvidence;
    halftone?: boolean;
    resolutionProvenance?: "native" | "reconstructed" | "halftone_generated";
  }): PrintValidationInput {
    return assembleUploadedPreserveProductionPrintValidationInput({
      artworkVersionId: "artwork-1",
      printPlacement: "left_chest",
      productSummary: "tshirts",
      intendedPrintWidthIn: 4,
      requestedProductionOutput: "production_png",
      asset: {
        contentType: "image/png",
        widthPx: 1200,
        heightPx: 534,
        hasTransparency: true,
        resolutionProvenance:
          options.resolutionProvenance ??
          (options.halftone ? "halftone_generated" : "native"),
        nativeWidthPx: 1800,
        nativeHeightPx: 800,
      },
      normalization: NORMALIZATION,
      uploadedPreserve: options.uploadedPreserve,
      productionTreatment: options.halftone ? "halftone_dtf" : "standard_raster",
      halftone: options.halftone ? halftoneEvidence() : null,
    });
  }

  function certificationCheck(report: PrintValidationReport) {
    return report.checks.find(
      (check) => check.check === "reconstruction_certification_evidence",
    ) as { check: string; status: string; severity: string; reason: string } | undefined;
  }

  // --- it must FIRE for a clean-master plate -------------------------------

  it("withholds Print Ready for a continuous-tone plate built from a clean master", async () => {
    const report = printValidation.validateArtwork(
      input({
        uploadedPreserve: lineage({
          sourceAuthority: "production_qualified_clean_master",
        }),
      }),
    );

    const check = certificationCheck(report);
    assert.ok(check, "the certification question must be asked");
    assert.equal(check!.status, "fail");
    assert.equal(check!.severity, "blocking");
    assert.match(check!.reason, /recovered clean master/);
    assert.notEqual(report.status, "ready", "Print Ready must be withheld");
    assert.ok(report.requiredTransformations.includes("require_human_review"));
  });

  /**
   * THE GAP THE FIRST IMPLEMENTATION SHIPPED WITH NO TEST FOR.
   *
   * "Halftone is out of scope for the False Print-Ready Guard" was a
   * statement about provider super-resolution — a screen drawn at final
   * size genuinely does not depend on it. It was never a statement about a
   * plate whose SOURCE pixels were manufactured: screening an uncertified
   * master renders uncertified artwork faithfully, and the lattice's own
   * correctness says nothing about that.
   *
   * Reachable in practice: standard raster reaches `print_ready` before
   * recovery begins, recovery then resolves, and a halftone request passes
   * the raster-first gate on that earlier plate while running against the
   * master.
   */
  it("withholds Print Ready for a HALFTONE plate built from a clean master", async () => {
    const report = printValidation.validateArtwork(
      input({
        uploadedPreserve: lineage({
          sourceAuthority: "production_qualified_clean_master",
          enhancement: "halftone_screened",
        }),
        halftone: true,
      }),
    );

    const check = certificationCheck(report);
    assert.ok(check, "a screened clean master must still be asked the question");
    assert.equal(check!.status, "fail");
    assert.equal(check!.severity, "blocking");
    assert.notEqual(report.status, "ready", "Print Ready must be withheld");
    assert.ok(report.requiredTransformations.includes("require_human_review"));
  });

  // --- it must change NOTHING for anything that existed before -------------

  it("leaves a halftone plate with no recorded source authority exactly as it was", async () => {
    const withoutField = printValidation.validateArtwork(
      input({ uploadedPreserve: lineage({ enhancement: "halftone_screened" }), halftone: true }),
    );
    const explicitPrepared = printValidation.validateArtwork(
      input({
        uploadedPreserve: lineage({
          enhancement: "halftone_screened",
          sourceAuthority: "prepared_upload",
        }),
        halftone: true,
      }),
    );

    // Absent and `"prepared_upload"` are the same claim — every plate
    // produced before this field existed had exactly one possible source.
    assert.deepEqual(
      withoutField.checks.map((check) => check.check),
      explicitPrepared.checks.map((check) => check.check),
      "no check is added, removed, or reordered for a pre-DTF-R1 plate",
    );
    assert.equal(withoutField.status, explicitPrepared.status);
    assert.equal(
      certificationCheck(withoutField),
      undefined,
      "the guard still does not run for an ordinary halftone plate",
    );
  });

  it("leaves an ordinary continuous-tone prepared-upload plate print_ready", async () => {
    const report = printValidation.validateArtwork(
      input({ uploadedPreserve: lineage() }),
    );
    assert.equal(certificationCheck(report)!.status, "pass");
    assert.equal(report.status, "ready");
  });

  it("still withholds for a plate this pipeline reconstructed itself", async () => {
    const report = printValidation.validateArtwork(
      input({
        uploadedPreserve: lineage({ enhancement: "reconstructed" }),
        resolutionProvenance: "reconstructed",
      }),
    );
    assert.equal(certificationCheck(report)!.status, "fail");
    assert.notEqual(report.status, "ready", "Print Ready must be withheld");
  });

  it("refuses a lineage whose recorded source authority cannot be read", async () => {
    const report = printValidation.validateArtwork(
      input({
        uploadedPreserve: lineage({
          sourceAuthority: "something_nobody_wrote" as never,
        }),
      }),
    );
    const sourceLineage = report.checks.find((check) => check.check === "source_lineage");
    assert.equal(sourceLineage!.status, "fail");
    assert.match(sourceLineage!.reason, /unrecognized source authority/);
    assert.notEqual(report.status, "ready", "Print Ready must be withheld");
  });
});
