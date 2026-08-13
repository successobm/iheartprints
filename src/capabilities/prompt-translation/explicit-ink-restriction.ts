/**
 * Phase 2C.3A — Explicit literal ink restriction (pure derivation).
 *
 * Distinguishes:
 *   A. preferred design colors / contrast guidance (advisory)
 *   B. customer language that literally restricts printable ink
 *
 * High precision by design. False negatives are preferred over spending
 * money on an inferred restriction the customer never made.
 *
 * No migration — reads existing brief text fields only.
 */

import type { DesignBriefSnapshotContent } from "@/lib/domain/types";

export type ExplicitInkRestrictionKind = "white_ink_only" | "no_black_ink";

export interface ExplicitInkRestriction {
  kind: ExplicitInkRestrictionKind;
  /**
   * Which brief field contributed the matching phrase (diagnostics only).
   * Multiple fields may be scanned; this records the first match.
   */
  sourceField:
    | "additionalInstructions"
    | "exclusions"
    | "designDescription";
  /** Normalized phrase fragment that matched (never full customer PII dumps). */
  matchedPhrase: string;
}

type BriefInkFields = Pick<
  DesignBriefSnapshotContent,
  "additionalInstructions" | "exclusions" | "designDescription"
>;

/**
 * Patterns that DO qualify as explicit production ink restrictions.
 * Order matters: more specific "white ink only" before generic "no black".
 */
const WHITE_INK_ONLY_PATTERNS: ReadonlyArray<{
  re: RegExp;
  phrase: string;
}> = [
  {
    re: /\bone[\s-]?color\s+white(?:\s+ink)?\s+only\b/i,
    phrase: "one color white ink only",
  },
  {
    re: /\bwhite\s+ink\s+only\b/i,
    phrase: "white ink only",
  },
  {
    re: /\b(?:use\s+)?only\s+white\s+ink\b/i,
    phrase: "only white ink",
  },
  {
    re: /\bonly\s+use\s+white(?:\s+ink)?(?:\s+for\s+the\s+printed\s+design)?\b/i,
    phrase: "only use white ink",
  },
  {
    re: /\buse\s+only\s+white(?:\s+ink)?\b/i,
    phrase: "use only white ink",
  },
];

const NO_BLACK_INK_PATTERNS: ReadonlyArray<{
  re: RegExp;
  phrase: string;
}> = [
  {
    re: /\bno\s+black\s+ink\b/i,
    phrase: "no black ink",
  },
  {
    re: /\bdo\s+not\s+use\s+black(?:\s+ink)?\b/i,
    phrase: "do not use black ink",
  },
  {
    re: /\bdon't\s+use\s+black(?:\s+ink)?\b/i,
    phrase: "don't use black ink",
  },
  {
    re: /\bdo\s+not\s+print\s+black\b/i,
    phrase: "do not print black",
  },
  {
    re: /\bdon't\s+print\s+black\b/i,
    phrase: "don't print black",
  },
  {
    re: /\b(?:no|never)\s+black\s+(?:ink\s+)?(?:allowed|permitted)\b/i,
    phrase: "no black ink allowed",
  },
];

/**
 * Derive an explicit ink restriction from existing brief text.
 * Returns null unless restrictive language is present.
 *
 * Intentionally does NOT treat preferredColors, shirtColor, or subject
 * color words ("black Harley", "use white so it shows") as restrictions.
 */
export function deriveExplicitInkRestriction(
  content: BriefInkFields,
): ExplicitInkRestriction | null {
  const fields: Array<{
    field: ExplicitInkRestriction["sourceField"];
    text: string;
  }> = [
    {
      field: "additionalInstructions",
      text: content.additionalInstructions?.trim() ?? "",
    },
    { field: "exclusions", text: content.exclusions?.trim() ?? "" },
    {
      field: "designDescription",
      text: content.designDescription?.trim() ?? "",
    },
  ];

  for (const { field, text } of fields) {
    if (!text) continue;
    for (const pattern of WHITE_INK_ONLY_PATTERNS) {
      if (pattern.re.test(text)) {
        return {
          kind: "white_ink_only",
          sourceField: field,
          matchedPhrase: pattern.phrase,
        };
      }
    }
    for (const pattern of NO_BLACK_INK_PATTERNS) {
      if (pattern.re.test(text)) {
        return {
          kind: "no_black_ink",
          sourceField: field,
          matchedPhrase: pattern.phrase,
        };
      }
    }
  }

  return null;
}
