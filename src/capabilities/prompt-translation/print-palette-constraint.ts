/**
 * Phase 2A — Print palette vs subject-color separation.
 *
 * Garment color, subject/object colors (real-world identity in the design
 * description), and the rendered print/artwork palette are three distinct
 * production concepts. This module derives a generation-facing enforcement
 * level from the approved brief — no new persistence, no migration.
 *
 * HARD — preferredColors must be treated as a required print/render palette
 * that overrides literal subject-object color where the two conflict
 * (typical after an explicit contrast-conflict resolution, or whenever the
 * subject names object colors that differ from the print palette).
 *
 * SOFT — casual preferred-color preference; still conveyed, but not as a
 * hard production override of subject semantics.
 *
 * NONE — no artwork palette preference on the brief (or colors deferred).
 */

import { COLOR_WORD_PATTERN } from "@/capabilities/shared/color-families";
import type {
  DesignBriefSnapshotContent,
  PrintPaletteEnforcement,
} from "@/lib/domain/types";

export type { PrintPaletteEnforcement };

export interface DerivedPrintPalette {
  colors: string[];
  garmentColor: string | null;
  enforcement: PrintPaletteEnforcement;
  /**
   * Color words named in the subject description that are NOT part of the
   * print palette — real-world object attributes that must not be mistaken
   * for required ink. Empty when enforcement is not hard or none apply.
   */
  subjectOnlyColors: string[];
}

/**
 * Deterministic brief → print-palette contract. Pure — never I/O, never
 * mutates the brief.
 */
export function derivePrintPalette(
  content: Pick<
    DesignBriefSnapshotContent,
    "shirtColor" | "preferredColors" | "designDescription" | "deferredSections"
  >,
): DerivedPrintPalette {
  const deferred = new Set(content.deferredSections);
  const garmentColor = content.shirtColor?.trim() || null;

  if (deferred.has("colors")) {
    return {
      colors: [],
      garmentColor,
      enforcement: "none",
      subjectOnlyColors: [],
    };
  }

  const colors = content.preferredColors
    .map((c) => c.trim())
    .filter(Boolean);
  if (colors.length === 0) {
    return {
      colors: [],
      garmentColor,
      enforcement: "none",
      subjectOnlyColors: [],
    };
  }

  const garmentNorm = garmentColor?.toLowerCase() ?? null;
  const paletteNorms = new Set(colors.map((c) => c.toLowerCase()));
  const contrasting = colors.filter((c) => c.toLowerCase() !== garmentNorm);

  // Customer kept artwork colors matching the garment (accepted low contrast).
  // That is still a preference, never a hard "use contrasting ink" resolution.
  if (contrasting.length === 0) {
    return {
      colors,
      garmentColor,
      enforcement: "soft",
      subjectOnlyColors: [],
    };
  }

  const subject = content.designDescription?.trim() || "";
  const subjectColorWords = extractSubjectColorWords(subject);
  const subjectOnlyColors = subjectColorWords.filter((c) => !paletteNorms.has(c));

  // Conflict-resolution pattern: subject still names the garment color as an
  // object attribute while preferredColors already contrast with the garment.
  const subjectMentionsGarment =
    garmentNorm !== null &&
    (subjectOnlyColors.includes(garmentNorm) ||
      subjectMentionsColorPhrase(subject, garmentColor!));

  // Subject names object colors outside the print palette — semantic object
  // color ≠ rendered ink (e.g. red motorcycle + white print palette).
  const subjectHasForeignObjectColors = subjectOnlyColors.some(
    (c) => c !== garmentNorm,
  );

  const enforcement: PrintPaletteEnforcement =
    subjectMentionsGarment || subjectHasForeignObjectColors ? "hard" : "soft";

  return {
    colors,
    garmentColor,
    enforcement,
    subjectOnlyColors: enforcement === "hard" ? subjectOnlyColors : [],
  };
}

function extractSubjectColorWords(subject: string): string[] {
  if (!subject) return [];
  const found = new Set<string>();
  const pattern = new RegExp(COLOR_WORD_PATTERN.source, "gi");
  for (const match of subject.matchAll(pattern)) {
    const word = match[0]?.trim().toLowerCase();
    if (word) found.add(word);
  }
  return [...found];
}

function subjectMentionsColorPhrase(subject: string, color: string): boolean {
  const trimmed = color.trim();
  if (!trimmed) return false;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(subject);
}
