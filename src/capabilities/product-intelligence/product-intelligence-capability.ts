import { printPlacementLabel } from "@/lib/domain/print-placement";
import { deriveRequiredWording } from "@/lib/domain/required-wording";
import type { PrintPlacement, TShirtDesignBrief } from "@/lib/domain/types";
import { ALL_RULE_PACK_IDS } from "@/capabilities/shared/product-rule-packs";
import type {
  ProductionFinding,
  ProductionRulePackId,
} from "@/capabilities/shared/contracts";

/**
 * Reusable print knowledge. No UI, no generation, no brief mutation.
 *
 * Sprint 2G Part 1: first real rule pack (Sprint 2C/2E/2F left this as a
 * stub so the call path existed without changing behavior). Deliberately
 * scoped to what the Design Brief data model already captures — print
 * placement, required wording, design description — rather than
 * introducing a decoration-method field the interview doesn't collect. Per
 * the Constitution (§6.6 Hide Technical Complexity, §6.9 Production
 * Awareness), production method is a technical decision the shop
 * determines automatically, not something ordinary customers choose;
 * these rules reason from placement and content instead.
 *
 * Every finding here is a plain-language, dismissible nudge (§6.8 Product
 * Intelligence) surfaced through Interview Intelligence's "advise" act —
 * never a hard block. `severity: "blocking"` still is not the same as
 * refusing to proceed: Constitution §15 makes clear print-ready quality is
 * earned through validation and human review (PrintValidation, later in
 * the pipeline), not decided unilaterally pre-approval by this capability.
 *
 * Sprint 2G Part 2: rule packs are individually addressable
 * (`ProductionRulePackId`, declared with their Design Brief section
 * dependencies in `shared/product-rule-packs`) so Revision Intelligence can
 * say exactly which ones a change affects, and `evaluateBrief` can run only
 * those instead of the full set on every turn.
 */
export interface ProductIntelligenceCapability {
  /**
   * Evaluates the brief. When `affectedRulePacks` is omitted, every rule
   * pack runs (full evaluation — the correct default the first time a
   * brief is assessed, when there is no prior state to diff against). When
   * provided (typically from a `RevisionImpact`), only those rule packs run.
   */
  evaluateBrief(
    brief: TShirtDesignBrief,
    affectedRulePacks?: ProductionRulePackId[],
  ): ProductionFinding[];
  /** Future rule packs by method / product. */
  listSupportedMethods(): string[];
}

const SMALL_PLACEMENTS = new Set<PrintPlacement>(["sleeve", "left_chest"]);
const LARGE_PLACEMENTS = new Set<PrintPlacement>(["full_front", "full_back"]);

/** Small placements (chest/sleeve) start getting hard to read past this many words. */
const SMALL_PLACEMENT_WORDING_WARNING_THRESHOLD = 8;
/** Sleeve is the narrowest placement — past this it will not fit legibly, not just "risky". */
const SLEEVE_WORDING_BLOCKING_THRESHOLD = 15;
/** Even a full front/back print gets visually crowded past this. */
const LARGE_PLACEMENT_WORDING_INFO_THRESHOLD = 25;

const BUSY_GRAPHICS_PATTERN =
  /\b(covered|cluttered|busy|packed|full of|lots of|loaded with|many graphics|intricate|highly detailed|photorealistic)\b/i;

/** id → rule function. Each id's Design Brief dependencies live in `shared/product-rule-packs`. */
const RULE_PACKS: Record<
  ProductionRulePackId,
  (brief: TShirtDesignBrief) => ProductionFinding | null
> = {
  small_placement_long_wording: detectSmallPlacementWordingRisk,
  small_placement_dense_graphics: detectSmallPlacementGraphicDensity,
  full_placement_wall_of_text: detectLargePlacementWallOfText,
};

export function createProductIntelligenceCapability(): ProductIntelligenceCapability {
  return {
    evaluateBrief(brief, affectedRulePacks) {
      const idsToRun = affectedRulePacks ?? ALL_RULE_PACK_IDS;
      const findings: ProductionFinding[] = [];

      for (const id of idsToRun) {
        const finding = RULE_PACKS[id](brief);
        if (finding) findings.push(finding);
      }

      return findings;
    },
    listSupportedMethods() {
      return [
        "screen_print",
        "dtf",
        "dtg",
        "embroidery",
        "sublimation",
        "signage",
        "engraving",
      ];
    },
  };
}

/**
 * Chest/sleeve placements are physically small. Required wording that's
 * fine on a full front print can be illegible or forced into a tiny font
 * there. Sleeve — the narrowest of the four placements — escalates from a
 * warning to blocking once the wording is long enough that it plainly will
 * not fit, rather than just being "harder to read".
 */
function detectSmallPlacementWordingRisk(
  brief: TShirtDesignBrief,
): ProductionFinding | null {
  const placement = brief.printPlacement;
  if (!placement || !SMALL_PLACEMENTS.has(placement)) return null;

  const wording = deriveRequiredWording(brief).text;
  if (!wording) return null;

  const wordCount = countWords(wording);
  if (wordCount <= SMALL_PLACEMENT_WORDING_WARNING_THRESHOLD) return null;

  const label = printPlacementLabel(placement) ?? "that placement";
  const blocking =
    placement === "sleeve" && wordCount > SLEEVE_WORDING_BLOCKING_THRESHOLD;

  return {
    code: "small_placement_long_wording",
    method: "unknown",
    severity: blocking ? "blocking" : "warning",
    message: `Required wording is ${wordCount} words for a ${label} print.`,
    plainLanguage: blocking
      ? `That much text won't fit legibly on a ${label} print — it really needs to be shorter, or moved to a bigger placement. Want me to suggest a shorter version, or switch placements?`
      : `That's a fair amount of text for a ${label} print — smaller placements can make longer wording hard to read. Want to shorten it, or use a bigger placement like the full front?`,
  };
}

/**
 * Fine visual detail gets lost at small print sizes regardless of stated
 * style — a different concern than BriefEvaluation's minimalist-style
 * self-consistency check, which fires even on a full front print.
 */
function detectSmallPlacementGraphicDensity(
  brief: TShirtDesignBrief,
): ProductionFinding | null {
  const placement = brief.printPlacement;
  if (!placement || !SMALL_PLACEMENTS.has(placement)) return null;

  const description = brief.designDescription?.trim();
  if (!description || !BUSY_GRAPHICS_PATTERN.test(description)) return null;

  const label = printPlacementLabel(placement) ?? "that placement";

  return {
    code: "small_placement_dense_graphics",
    method: "unknown",
    severity: "warning",
    message: `Design description reads as detailed for a ${label} print.`,
    plainLanguage: `That's a lot of visual detail for a ${label} print — fine detail tends to get lost at that size. Should I simplify the design, or would a larger placement work better?`,
  };
}

/**
 * Even a full front/back print has a practical limit before wording feels
 * crowded. Informational only — worth knowing, not worth interrupting the
 * interview over.
 */
function detectLargePlacementWallOfText(
  brief: TShirtDesignBrief,
): ProductionFinding | null {
  const placement = brief.printPlacement;
  if (!placement || !LARGE_PLACEMENTS.has(placement)) return null;

  const wording = deriveRequiredWording(brief).text;
  if (!wording) return null;

  const wordCount = countWords(wording);
  if (wordCount <= LARGE_PLACEMENT_WORDING_INFO_THRESHOLD) return null;

  return {
    code: "full_placement_wall_of_text",
    method: "unknown",
    severity: "info",
    message: `Required wording is ${wordCount} words — long even for a full placement.`,
    plainLanguage:
      "That's quite a lot of text for the design — it may end up feeling crowded. Want me to keep it as-is, or trim it down a bit?",
  };
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
