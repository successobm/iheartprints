import type { PrintPlacement } from "@/lib/domain/types";

import {
  sizingPolicyForProductionBox,
  type ProductionBox,
} from "./garment-production-sizing";
import {
  PRINT_PLACEMENT_SIZING_POLICY,
  roundToQuarterInch,
  technicalLimitForPlacement,
  type PlacementSizingPolicy,
} from "./print-placement-dimensions";

/**
 * Print'em All Phase 1 — CONCEPT B, THE PRODUCTION AUTHORITY.
 *
 * The one question this module answers: *has a human explicitly confirmed the
 * physical size this project prints at, and what is it?*
 *
 * WHY IT HAD TO BECOME A SEPARATE FACT
 *
 * A live Print'em All job spent a Topaz reconstruction credit while
 * `intended_print_width_in` was `null`. Nothing was broken in the sense of a
 * crash: the pipeline read the width, found nothing, fell back to the
 * placement default, and produced a plate — for a physical size that no
 * person had ever chosen or seen.
 *
 * The root cause is not a missing null check. It is that a NUMBER CANNOT
 * CARRY CONSENT. Once a default fills in, "10.5 because the customer said so"
 * and "10.5 because nobody said anything" are the same value, and no amount
 * of inspecting that value afterwards can separate them. Any gate built on
 * "do we have a width?" therefore passes in exactly the case it exists to
 * catch.
 *
 * So confirmation is persisted as its own fact, and it is SELF-DESCRIBING: it
 * records WHEN a human confirmed and WHICH physical size they confirmed.
 * Another writer of `intendedPrintWidthIn` — a chat instruction, a future
 * brief extractor, a migration — cannot inherit somebody else's consent,
 * because the confirmation names the size it approved and a mismatch reads as
 * unconfirmed.
 *
 * WHAT MAY BE BUILT ON THIS
 *
 * Paid provider dispatch, and nothing less. A recommendation is not spend
 * authority; a default is not spend authority; a value typed into a field and
 * never submitted is not spend authority. Only `{ confirmedAt, widthIn }`
 * agreeing with the project's current placement is.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * No backfill, no inference, no "treat legacy defaults as confirmed". A
 * historical project whose size came from a default is honestly unconfirmed,
 * and confirming it costs one click. Manufacturing consent retroactively for
 * every project in the database in order to save that click would recreate
 * the exact failure this module exists to prevent — and would be
 * indistinguishable, forever afterwards, from a real decision.
 *
 * Pure — no repository, no capability, no I/O, no clock.
 */

/** Widths closer than this are the same physical size, not a size change. */
export const PRODUCTION_WIDTH_EPSILON_IN = 1e-6;

/**
 * What both workflows say when production work is asked for before anyone has
 * confirmed a physical size.
 *
 * Phrased as a next step, not as an error, because nothing has gone wrong: a
 * decision simply has not been made yet, and the remedy is one click on the
 * surface the reader is already looking at. Deliberately free of provider
 * jargon — "Topaz", "reconstruction", "upscale", and "credit" are internal
 * words, and a customer being asked to confirm how large their design prints
 * has no use for any of them.
 */
export const PRODUCTION_SIZE_CONFIRMATION_REQUIRED_MESSAGE =
  "Confirm the print size before preparation.";

/**
 * What a human actually approved.
 *
 * `boxMaxHeightIn` is what makes this a CONTAINING BOX rather than a bare
 * width. Confirming a 10.5x10.5 recommendation must contain a 2:3 portrait to
 * 7.0x10.5 — a width alone cannot express that, and forcing the portrait to
 * 10.5in wide would be exactly the "10.5 is universal" mistake in a new
 * place. `null` means the operator stated a width alone, so height simply
 * follows the artwork's aspect ratio, bounded only by the placement's
 * technical limit.
 *
 * Both axes always move together. There is no independent X/Y scale anywhere
 * on this path, so no operator surface can distort artwork.
 */
export interface ConfirmedProductionSize {
  widthIn: number;
  boxMaxHeightIn: number | null;
  /** ISO timestamp of the explicit human confirmation. */
  confirmedAt: string;
}

/** Why a project has no confirmed production size. Internal — never customer copy. */
export type ProductionSizeUnconfirmedReason =
  /** No print placement yet, so there is no size to confirm against. */
  | "placement_unknown"
  /** Nobody ever confirmed. Includes every project that only ever had a default. */
  | "never_confirmed"
  /**
   * A confirmation exists but no longer describes something this placement
   * can produce — e.g. 10.5in confirmed for a full back, then the placement
   * changed to a left chest whose technical limit tops out at 5in.
   *
   * Deliberately UNCONFIRMED rather than silently clamped: clamping would
   * spend money on a size nobody approved, which is the whole failure mode.
   */
  | "outside_technical_limit";

export type ProductionSizeConfirmation =
  | { confirmed: true; size: ConfirmedProductionSize }
  | { confirmed: false; reason: ProductionSizeUnconfirmedReason };

/**
 * The persisted confirmation fields, exactly as they sit on
 * `TShirtDesignBrief`. Taken as a loose shape rather than the brief itself so
 * the worker, the capability, and the view layer can all call this without
 * reconstructing a whole brief.
 */
export interface ProductionSizeConfirmationInput {
  printPlacement: PrintPlacement | null;
  productionSizeConfirmedAt: string | null;
  productionSizeConfirmedWidthIn: number | null;
  productionSizeConfirmedMaxHeightIn: number | null;
}

/**
 * Resolves the project's confirmed production authority.
 *
 * Fails CLOSED in every ambiguous case. A half-written confirmation (a
 * timestamp with no width, or a width with no timestamp) is not a
 * confirmation — it is a bug or a partial write, and reading it as consent
 * would authorize spend on a size nobody stated.
 */
export function resolveProductionSizeConfirmation(
  input: ProductionSizeConfirmationInput,
): ProductionSizeConfirmation {
  if (!input.printPlacement) {
    return { confirmed: false, reason: "placement_unknown" };
  }

  const confirmedAt = input.productionSizeConfirmedAt;
  const widthIn = input.productionSizeConfirmedWidthIn;
  if (
    !confirmedAt ||
    widthIn === null ||
    !Number.isFinite(widthIn) ||
    widthIn <= 0
  ) {
    return { confirmed: false, reason: "never_confirmed" };
  }

  const limit = technicalLimitForPlacement(input.printPlacement);
  if (!limit) return { confirmed: false, reason: "placement_unknown" };
  if (widthIn < limit.minWidthIn || widthIn > limit.maxWidthIn) {
    return { confirmed: false, reason: "outside_technical_limit" };
  }

  const boxMaxHeightIn = input.productionSizeConfirmedMaxHeightIn;
  return {
    confirmed: true,
    size: {
      widthIn,
      boxMaxHeightIn:
        boxMaxHeightIn !== null &&
        Number.isFinite(boxMaxHeightIn) &&
        boxMaxHeightIn > 0
          ? boxMaxHeightIn
          : null,
      confirmedAt,
    },
  };
}

/** Convenience predicate for the many call sites that only need the boolean. */
export function productionSizeIsConfirmed(
  input: ProductionSizeConfirmationInput,
): boolean {
  return resolveProductionSizeConfirmation(input).confirmed;
}

/**
 * The sizing policy production must use for a CONFIRMED size.
 *
 * Reuses `sizingPolicyForProductionBox` — and therefore
 * `resolveWidthConstrainedSizing` — so the confirmed box, the recommended
 * box, and the production transform are all the same containment arithmetic.
 * Nothing here scales an axis on its own.
 */
export function sizingPolicyForConfirmedSize(
  placement: PrintPlacement,
  size: ConfirmedProductionSize,
): PlacementSizingPolicy {
  return sizingPolicyForProductionBox(
    PRINT_PLACEMENT_SIZING_POLICY[placement],
    size.widthIn,
    size.boxMaxHeightIn,
  );
}

/**
 * Whether a size a job was enqueued for is still the size the project's
 * confirmed authority names.
 *
 * The stale-width fence's one piece of arithmetic (Goal 12). An unconfirmed
 * project matches NOTHING, so a job enqueued under an earlier confirmation
 * that has since been withdrawn is stale rather than silently current.
 */
export function confirmedSizeMatchesJobWidth(
  confirmation: ProductionSizeConfirmation,
  jobProductionWidthIn: number | null,
): boolean {
  if (!confirmation.confirmed) return false;
  if (jobProductionWidthIn === null) return false;
  return (
    Math.abs(confirmation.size.widthIn - jobProductionWidthIn) <
    PRODUCTION_WIDTH_EPSILON_IN
  );
}

/**
 * Normalizes a size a human is about to confirm.
 *
 * Rounds through `roundToQuarterInch` — the SAME rounding
 * `resolveProductionWidth` applies — so a confirmed width can never differ
 * from the width the pipeline resolves by a rounding artifact and fence its
 * own job out as stale.
 *
 * Returns `null` when the request is outside what the placement can produce.
 * Refused, deliberately, rather than clamped: a clamp would record a
 * confirmation for a size the operator did not choose, and a confirmation is
 * the one value in this system that must mean exactly what it says. Callers
 * tell the operator the printable band instead.
 */
export function normalizeConfirmableWidth(
  placement: PrintPlacement | null,
  requestedWidthIn: number,
): number | null {
  const limit = technicalLimitForPlacement(placement);
  if (!limit) return null;
  if (!Number.isFinite(requestedWidthIn) || requestedWidthIn <= 0) return null;
  const widthIn = roundToQuarterInch(requestedWidthIn);
  if (widthIn < limit.minWidthIn || widthIn > limit.maxWidthIn) return null;
  return widthIn;
}

/**
 * The box a "use the recommendation" confirmation records, or `null` when
 * this (garment class, placement) has no authoritative recommendation and the
 * operator must therefore state a size themselves.
 */
export function confirmableSizeFromBox(
  placement: PrintPlacement | null,
  box: ProductionBox | null,
): { widthIn: number; boxMaxHeightIn: number } | null {
  if (!box) return null;
  const widthIn = normalizeConfirmableWidth(placement, box.maxWidthIn);
  if (widthIn === null) return null;
  return { widthIn, boxMaxHeightIn: box.maxHeightIn };
}
