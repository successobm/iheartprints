import type { ProjectRepository } from "@/lib/db/repository";
import {
  normalizeConfirmableWidth,
  resolveProductionSizeConfirmation,
} from "@/capabilities/shared/confirmed-production-size";
import {
  recommendProductionBox,
  sizingPolicyForProductionBox,
} from "@/capabilities/shared/garment-production-sizing";
import { PRINT_PLACEMENT_SIZING_POLICY } from "@/capabilities/shared/print-placement-dimensions";

/**
 * Print'em All Phase 1: gives a test project the explicit production-size
 * confirmation that production work now requires.
 *
 * WHY A HELPER RATHER THAN A FIXTURE FIELD
 *
 * Confirmation is deliberately not something a project can be born with — a
 * brand new brief has `productionSizeConfirmedAt = null`, and the whole point
 * of the column is that only a human act sets it. A test that wants to
 * exercise what happens AFTER the size is settled therefore has to perform
 * that act, exactly as a customer or operator does. This helper is that act,
 * written once.
 *
 * It also keeps the negative tests honest. Because confirmation must be
 * called for explicitly, a test that forgets it fails — which is precisely
 * the property the live incident needed and did not have. The scenarios that
 * assert "no provider is reached without confirmation" get that guarantee for
 * free, by simply not calling this.
 *
 * Test support only. Never imported by application code.
 */
export async function confirmProductionSizeForTests(
  repo: ProjectRepository,
  projectId: string,
  options: {
    /**
     * Confirm a specific width instead of the recommended box. Used by the
     * oversize and custom-size scenarios.
     */
    widthIn?: number;
    /**
     * Phase 28T: confirm a specific box max-height alongside `widthIn`,
     * instead of the `null` ("height follows aspect ratio, bounded only by
     * the placement's technical limit") a bare typed-in width normally
     * carries. Lets a test construct an exact effective production
     * ENVELOPE (width + height) directly — e.g. the two Phase 28T
     * regression envelopes, 10.5x10.5 vs 10.5x14 — without going through
     * `recommendProductionBox`. Ignored unless `widthIn` is also given.
     */
    boxMaxHeightIn?: number | null;
    /** Timestamp of the confirmation. Fixed by default so tests stay deterministic. */
    confirmedAt?: string;
  } = {},
): Promise<void> {
  const snapshot = await repo.getProject(projectId);
  if (!snapshot) throw new Error(`Project ${projectId} not found`);

  const placement = snapshot.brief.printPlacement;
  if (!placement) {
    throw new Error(
      `Project ${projectId} has no print placement, so there is no size to confirm`,
    );
  }

  const confirmedAt = options.confirmedAt ?? "2026-08-21T00:00:00.000Z";

  if (options.widthIn !== undefined) {
    const widthIn = normalizeConfirmableWidth(placement, options.widthIn);
    if (widthIn === null) {
      throw new Error(
        `${options.widthIn}in is outside what ${placement} can produce`,
      );
    }
    // A stated WIDTH carries no box height by default — height follows the
    // artwork's own aspect ratio, bounded by the placement's technical
    // limit. Exactly what `applyProductionPrintWidth` records for a typed-in
    // size, unless the caller explicitly asked for a specific box height too.
    await repo.updateBrief(projectId, {
      intendedPrintWidthIn: widthIn,
      productionSizeConfirmedWidthIn: widthIn,
      productionSizeConfirmedMaxHeightIn: options.boxMaxHeightIn ?? null,
      productionSizeConfirmedAt: confirmedAt,
    });
    return;
  }

  const recommendation = recommendProductionBox({
    placement,
    garmentSizeClass: snapshot.brief.garmentSizeClass,
  });
  if (!recommendation?.box) {
    throw new Error(
      `No recommended production box exists for ${recommendation?.garmentSizeClass ?? "unknown"} at ${placement} — confirm an explicit width instead`,
    );
  }

  await repo.updateBrief(projectId, {
    intendedPrintWidthIn: recommendation.box.maxWidthIn,
    productionSizeConfirmedWidthIn: recommendation.box.maxWidthIn,
    productionSizeConfirmedMaxHeightIn: recommendation.box.maxHeightIn,
    productionSizeConfirmedAt: confirmedAt,
  });
}

/**
 * The physical size a confirmed project will actually produce for artwork of
 * the given pixel proportions — derived through the SAME containment
 * arithmetic production uses, so a test asserting "10.5 x 9.1" is checking
 * the pipeline rather than restating a number.
 */
export async function expectedProductionSizeForTests(
  repo: ProjectRepository,
  projectId: string,
  artworkWidthPx: number,
  artworkHeightPx: number,
): Promise<{ widthIn: number; heightIn: number }> {
  const snapshot = await repo.getProject(projectId);
  if (!snapshot) throw new Error(`Project ${projectId} not found`);

  const confirmation = resolveProductionSizeConfirmation(snapshot.brief);
  if (!confirmation.confirmed) {
    throw new Error(`Project ${projectId} has no confirmed production size`);
  }

  const placement = snapshot.brief.printPlacement!;
  const policy = sizingPolicyForProductionBox(
    PRINT_PLACEMENT_SIZING_POLICY[placement],
    confirmation.size.widthIn,
    confirmation.size.boxMaxHeightIn,
  );

  const aspect = artworkHeightPx / artworkWidthPx;
  const widthPx = Math.round(policy.targetWidthIn * policy.targetPpi);
  let heightPx = Math.round(widthPx * aspect);
  let finalWidthPx = widthPx;
  const maxHeightPx = Math.round(policy.maxHeightIn * policy.targetPpi);
  if (heightPx > maxHeightPx) {
    heightPx = maxHeightPx;
    finalWidthPx = Math.round(heightPx / aspect);
  }

  return {
    widthIn: finalWidthPx / policy.targetPpi,
    heightIn: heightPx / policy.targetPpi,
  };
}
