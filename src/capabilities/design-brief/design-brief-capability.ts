import {
  UniqueConstraintViolationError,
  type ProjectRepository,
} from "@/lib/db/repository";
import { toDesignBriefSnapshotContent } from "@/lib/domain/brief-snapshot";
import type {
  DesignBriefSnapshotContent,
  DesignBriefVersion,
  GarmentSizeClass,
  PrintPlacement,
  TShirtDesignBrief,
} from "@/lib/domain/types";
import type { BriefPatchProposal } from "@/capabilities/shared/contracts";
import type { ProductionTreatmentSelection } from "@/capabilities/shared/production-treatment";

/**
 * Authoritative Design Brief capability.
 * All brief mutations must go through this boundary.
 */
export interface DesignBriefCapability {
  getWorkingBrief(designId: string): Promise<TShirtDesignBrief>;
  /**
   * Accept or reject an Intent Extraction proposal.
   * Sprint 1/2C: accepts any non-empty field patch (no per-field validation yet).
   */
  applyProposal(
    designId: string,
    proposal: BriefPatchProposal,
  ): Promise<TShirtDesignBrief>;
  /**
   * Live Acceptance Cleanup (Issue 5): records the customer's chosen
   * PRODUCTION print width, in inches — authoritative production intent.
   *
   * Separate from `applyProposal` on purpose. This is not an Intent
   * Extraction proposal about the design; it is a production specification,
   * and it is deliberately the one brief field excluded from
   * `DesignBriefSnapshotContent` (see `brief-snapshot.ts`) and from
   * `diffBriefSections`. That exclusion is what guarantees the property the
   * Constitution needs here: choosing a size can never approve a new brief
   * version, mark concepts stale, trigger a creative revision, or reach an
   * image provider. It only changes what the production pipeline is told to
   * produce.
   *
   * The caller is responsible for resolving/clamping the value against the
   * placement's printable band (`resolveProductionWidth`) — this boundary
   * persists an already-decided figure.
   */
  setIntendedPrintWidth(
    designId: string,
    widthIn: number | null,
  ): Promise<TShirtDesignBrief>;
  /**
   * Print'em All Phase 1 — RECORDS EXPLICIT HUMAN CONFIRMATION of the
   * physical production size, and is the only thing in the system that may.
   *
   * The single most important property of this method is that no other write
   * path can produce its effect. `setIntendedPrintWidth` records what someone
   * WANTS; this records what someone APPROVED, together with the exact size
   * they approved it for. That separation is the whole fix: a live Topaz
   * credit was spent against a width that was never anything more than a
   * default, and no inspection of a width column afterwards could have
   * distinguished that from a real decision.
   *
   * The confirmation is written as one unit — timestamp, width, and box
   * height together — so a half-written confirmation cannot exist. It also
   * writes `intendedPrintWidthIn`, keeping the working intent and the
   * confirmed authority in agreement rather than leaving two numbers to drift.
   *
   * Like `setIntendedPrintWidth`, it approves no brief version, marks no
   * concept stale, triggers no revision, and reaches no image provider.
   *
   * The caller is responsible for having normalized the width against the
   * placement's technical limit (`normalizeConfirmableWidth`); this boundary
   * persists an already-decided figure.
   */
  confirmProductionSize(
    designId: string,
    input: {
      /** The exact physical print width being confirmed, in inches. */
      widthIn: number;
      /** Containing-box height bound, or `null` when a width alone was confirmed. */
      boxMaxHeightIn: number | null;
      /** ISO timestamp of the confirmation. Supplied by the caller so this boundary stays clock-free. */
      confirmedAt: string;
    },
  ): Promise<TShirtDesignBrief>;
  /**
   * Print'em All Phase 1: WITHDRAWS a production-size confirmation, returning
   * the project to "no human has approved a size".
   *
   * Needed because a confirmation is about a specific physical size in a
   * specific context, and the context can move out from under it — most
   * obviously when the garment size class changes, which changes what the
   * recommended box is and therefore what the operator was agreeing to.
   * Silently keeping the old confirmation would let a 10.5in adult print ride
   * a garment-class change onto a youth tee without anyone re-approving it.
   *
   * Clears all three confirmation fields together, and deliberately leaves
   * `intendedPrintWidthIn` alone: the number is still a fine starting point
   * for the next confirmation, it just no longer carries anyone's consent.
   */
  withdrawProductionSizeConfirmation(
    designId: string,
  ): Promise<TShirtDesignBrief>;
  /**
   * Print'em All Phase 1: records the GARMENT SIZING CONTEXT a production box
   * should be recommended for.
   *
   * Withdraws any existing size confirmation as a side effect, for the reason
   * given on `withdrawProductionSizeConfirmation`. That coupling lives here,
   * at the boundary that owns both fields, rather than in each caller — a
   * caller that forgot it would produce exactly the silent cross-garment
   * carry-over this exists to prevent.
   *
   * Apparel-product sizing terminology only. Never an inference about a
   * person, and never a garment catalogue.
   */
  setGarmentSizeClass(
    designId: string,
    garmentSizeClass: GarmentSizeClass | null,
  ): Promise<TShirtDesignBrief>;
  /**
   * Print'em All Phase 2 — RECORDS AN EXPLICIT OPERATOR CHOICE of production
   * treatment, and is the only thing in the system that may.
   *
   * The property that matters is the same one `confirmProductionSize` has,
   * against a sharper failure mode. Standard raster honestly REFUSES artwork
   * it cannot reconstruct within the provider's proven ceiling; DTF halftone
   * can produce that same artwork at that same physical size, because it
   * generates dot geometry at final size rather than reconstructing detail.
   * So the chain that must never be constructible anywhere in this system is
   * "standard raster was refused, therefore halftone" — a machine deciding on
   * its own to change how a customer's artwork is printed.
   *
   * Nothing here can be reached from a validation outcome. A treatment is
   * written because a human chose it, and the timestamp is what keeps that
   * distinguishable forever afterwards.
   *
   * All three fields are written as ONE unit — treatment, settings, and the
   * timestamp that says a human chose it — so a half-written treatment cannot
   * exist. `resolveProductionTreatment` fails to standard raster on a partial
   * record anyway; the cheaper guarantee is never to write one.
   *
   * AUTHORIZATION IS NOT HERE. Phase 2 restricts this choice to internal
   * Print'em All operators, and that gate lives at the route boundary where
   * the session's entitlement is actually known (mirroring
   * `grantInternalEntitlement`: "authorization happens in the route, never
   * here"). Callers are responsible for having normalized the settings via
   * `normalizeHalftoneSettings` and for having checked eligibility; this
   * boundary persists an already-authorized decision.
   *
   * Like the size confirmation, it approves no brief version, marks no concept
   * stale, triggers no revision, and reaches no image provider.
   */
  selectProductionTreatment(
    designId: string,
    input: {
      selection: ProductionTreatmentSelection;
      /** ISO timestamp of the operator's choice. Supplied by the caller so this boundary stays clock-free. */
      selectedAt: string;
    },
  ): Promise<TShirtDesignBrief>;
  /**
   * Print'em All Phase 2: returns the project to standard raster.
   *
   * Retraction has to be as easy as selection. An operator who screens a
   * proof, looks at it, and decides the continuous-tone plate was better must
   * be able to say so — and the treatment being a mutable working-brief field
   * rather than an approved snapshot is precisely what makes that one call
   * instead of a new approval cycle.
   *
   * Clears all three fields together. The already-produced halftone plate is
   * NOT deleted: it remains immutable evidence of what those settings made,
   * and coming back to them reuses it rather than regenerating it.
   */
  clearProductionTreatment(designId: string): Promise<TShirtDesignBrief>;
  /**
   * Existing Artwork → Print Ready Phase 1: records the PRODUCTION CONTEXT an
   * uploaded-artwork customer states — what we're printing on, its colour,
   * and where the print goes.
   *
   * Separate from `applyProposal` for the same reason `setIntendedPrintWidth`
   * is: this is not an Intent Extraction interpretation of a conversational
   * message, and labelling it `source: "intent_extraction"` to reuse that
   * path would make the provenance a lie. The customer answered a direct
   * question with a direct value.
   *
   * It deliberately touches ONLY these three fields. `designDescription`,
   * `exactText`, `designStyle`, and every other creative field stay untouched
   * — for uploaded artwork the pixels are the design, and inventing a written
   * description of them would create a second, competing source of truth.
   *
   * `undefined` leaves a field alone; an explicit `null` clears it.
   */
  setUploadedArtworkContext(
    designId: string,
    input: {
      productSummary?: string | null;
      shirtColor?: string | null;
      printPlacement?: PrintPlacement | null;
    },
  ): Promise<TShirtDesignBrief>;
  /** Most recent durable approval, if any. */
  getLatestApprovedVersion(
    designId: string,
  ): Promise<DesignBriefVersion | null>;
  /**
   * Freezes the current working brief as a new immutable, durable version.
   *
   * Idempotency: if the latest approved version's content is identical to
   * the current working brief, that existing version is returned rather than
   * creating a duplicate. If a concurrent request already inserted the next
   * version number, the resulting unique-constraint violation is resolved by
   * refetching and returning the winning row instead of erroring.
   */
  approveWorkingBrief(designId: string): Promise<DesignBriefVersion>;
}

export function createDesignBriefCapability(
  repo: ProjectRepository,
): DesignBriefCapability {
  return {
    async getWorkingBrief(designId) {
      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new Error("Project not found");
      return snapshot.brief;
    },

    async applyProposal(designId, proposal) {
      if (Object.keys(proposal.fields).length === 0) {
        return this.getWorkingBrief(designId);
      }
      return repo.updateBrief(designId, proposal.fields);
    },

    async setIntendedPrintWidth(designId, widthIn) {
      return repo.updateBrief(designId, { intendedPrintWidthIn: widthIn });
    },

    async confirmProductionSize(designId, input) {
      return repo.updateBrief(designId, {
        // Written together, always. `resolveProductionSizeConfirmation` fails
        // closed on a partial record, but the cheaper guarantee is simply
        // never to write one.
        intendedPrintWidthIn: input.widthIn,
        productionSizeConfirmedWidthIn: input.widthIn,
        productionSizeConfirmedMaxHeightIn: input.boxMaxHeightIn,
        productionSizeConfirmedAt: input.confirmedAt,
      });
    },

    async selectProductionTreatment(designId, input) {
      return repo.updateBrief(
        designId,
        input.selection.treatment === "halftone_dtf"
          ? {
              productionTreatment: "halftone_dtf",
              halftoneSettings: input.selection.halftone,
              productionTreatmentSelectedAt: input.selectedAt,
            }
          : {
              productionTreatment: "standard_raster",
              // Cleared, never left behind. Settings that outlive the
              // treatment they belong to are settings a future reader can
              // mistake for the current screen.
              halftoneSettings: null,
              productionTreatmentSelectedAt: input.selectedAt,
            },
      );
    },

    async clearProductionTreatment(designId) {
      return repo.updateBrief(designId, {
        productionTreatment: "standard_raster",
        halftoneSettings: null,
        productionTreatmentSelectedAt: null,
      });
    },

    async withdrawProductionSizeConfirmation(designId) {
      return repo.updateBrief(designId, {
        productionSizeConfirmedAt: null,
        productionSizeConfirmedWidthIn: null,
        productionSizeConfirmedMaxHeightIn: null,
      });
    },

    async setGarmentSizeClass(designId, garmentSizeClass) {
      // One write, so the class change and the withdrawal cannot land apart —
      // a crash between two writes would leave a 10.5in adult confirmation
      // attached to a youth garment, which is the exact state this coupling
      // exists to make unreachable.
      return repo.updateBrief(designId, {
        garmentSizeClass,
        productionSizeConfirmedAt: null,
        productionSizeConfirmedWidthIn: null,
        productionSizeConfirmedMaxHeightIn: null,
      });
    },

    async setUploadedArtworkContext(designId, input) {
      const patch: Partial<TShirtDesignBrief> = {};
      if (input.productSummary !== undefined) {
        patch.productSummary = normalizeOptionalText(input.productSummary);
      }
      if (input.shirtColor !== undefined) {
        patch.shirtColor = normalizeOptionalText(input.shirtColor);
      }
      if (input.printPlacement !== undefined) {
        patch.printPlacement = input.printPlacement;
      }

      if (Object.keys(patch).length === 0) return this.getWorkingBrief(designId);
      return repo.updateBrief(designId, patch);
    },

    async getLatestApprovedVersion(designId) {
      return repo.getLatestDesignBriefVersion(designId);
    },

    async approveWorkingBrief(designId) {
      const brief = await this.getWorkingBrief(designId);
      const content = toDesignBriefSnapshotContent(brief);
      const existing = await repo.getLatestDesignBriefVersion(designId);

      if (existing && contentEquals(existing.content, content)) {
        return existing;
      }

      const nextVersionNumber = (existing?.versionNumber ?? 0) + 1;

      try {
        return await repo.approveDesignBrief(designId, {
          briefId: brief.id,
          versionNumber: nextVersionNumber,
          content,
        });
      } catch (error) {
        if (error instanceof UniqueConstraintViolationError) {
          const latest = await repo.getLatestDesignBriefVersion(designId);
          if (latest) return latest;
        }
        throw error;
      }
    },
  };
}

function contentEquals(
  a: DesignBriefSnapshotContent,
  b: DesignBriefSnapshotContent,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whitespace-only input is "not answered", never a stored empty string. */
function normalizeOptionalText(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
