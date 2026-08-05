import type { TShirtDesignBrief } from "./types";

/**
 * Sprint 2F: provider-neutral explicit state for required wording.
 *
 * Transitional representation (documented migration path below) rather than
 * a new persisted column/type: `TShirtDesignBrief.exactText` keeps its
 * existing `string | null` shape so no Design Brief schema change is
 * required and Sprint 2D data remains readable as-is. This module is the
 * single place that interprets that field's three real states, so nothing
 * else needs to re-derive the mapping:
 *
 *   - `exactText === null`               → "unknown" (never answered)
 *   - `exactText === ""` (trimmed empty)  → "none" (customer explicitly said
 *                                           there is no required wording)
 *   - otherwise                          → "provided" (the trimmed text)
 *
 * Migration path if this ever needs to become its own column/type: add a
 * `required_wording_mode` enum column, backfill it from the rule above
 * (`null`→'unknown', `''`→'none', else→'provided'), then have
 * `deriveRequiredWording` read the new column directly. No customer-facing
 * behavior would change — only the storage representation.
 */
export type RequiredWordingMode = "unknown" | "provided" | "none";

export interface RequiredWording {
  mode: RequiredWordingMode;
  text: string | null;
}

export function deriveRequiredWording(
  brief: Pick<TShirtDesignBrief, "exactText">,
): RequiredWording {
  if (brief.exactText === null) {
    return { mode: "unknown", text: null };
  }

  const trimmed = brief.exactText.trim();
  if (trimmed.length === 0) {
    return { mode: "none", text: null };
  }

  return { mode: "provided", text: trimmed };
}

/**
 * The only value that may ever be written to `exactText` to mean "explicit
 * absence of required wording." Extraction must never write `""` unless it
 * is confident the customer meant this — malformed/uncertain extraction
 * must not collapse into confirmed absence.
 */
export const EXPLICIT_NO_WORDING_VALUE = "";
