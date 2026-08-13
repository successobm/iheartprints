/**
 * Live Acceptance Cleanup (Issue 5): recognizing a PRODUCTION-SIZE request
 * in ordinary customer language, and — just as importantly — refusing to
 * recognize one where none was made.
 *
 * "Make the print 12 inches wide" changes the production specification. It
 * must never regenerate the design, create an `ArtworkVersion`, call an image
 * provider, or count as a creative revision. "Make the car larger" is the
 * opposite: a creative revision of the artwork itself, which must keep
 * working exactly as it does today.
 *
 * The two are separated by an explicit PRINT-SUBJECT requirement: a size
 * request only counts when the customer named the print/artwork/design/image
 * itself, or said "make it N inches wide" (a physical measurement of the
 * whole deliverable — never a description of one element inside it). A bare
 * "make it smaller" stays a creative revision, deliberately: the cost of
 * mistaking a creative instruction for a size change (silently ignoring what
 * the customer asked for) is far higher than the cost of the reverse, where
 * the customer simply restates it more explicitly.
 *
 * Pure — no I/O, no clock, no model call, no product nouns.
 */

/** What the deliverable itself can be called. Never an element inside it. */
const PRINT_SUBJECT_PATTERN =
  /\b(print(?:ed|out)?|printing|artwork|art\s?work|design|graphic|image|logo|transfer|decal)\b/i;

/**
 * An explicit physical width. Requires an inch unit — a bare number is
 * always ambiguous ("make it 3" could be three of something).
 */
const INCH_MEASUREMENT_PATTERN =
  /(\d+(?:\.\d+)?)\s*(?:''|"|”|\bin\b|\binch\b|\binches\b)/i;

/** Words that make a measurement about WIDTH rather than another dimension. */
const WIDTH_WORD_PATTERN = /\b(wide|width|across|wide\s+by)\b/i;

/** Explicit "bigger"/"smaller" without a number. */
const LARGER_PATTERN =
  /\b(larger|bigger|wider|scale\s+it\s+up|size\s+it\s+up|blow\s+it\s+up)\b/i;
const SMALLER_PATTERN =
  /\b(smaller|tinier|narrower|scale\s+it\s+down|size\s+it\s+down|shrink)\b/i;

/** A size word paired with the deliverable — "the print size", "how big the design prints". */
const SIZE_NOUN_PATTERN = /\b(size|sized|sizing|dimensions?|scale)\b/i;

/**
 * How far a "make it a little bigger/smaller" step moves the production
 * width, in inches. One quarter inch is the smallest change a print shop can
 * meaningfully hold and matches `resolveProductionWidth`'s own rounding;
 * 1.5" is a visible but non-drastic step for an adult garment.
 */
export const RELATIVE_SIZE_STEP_IN = 1.5;

export type ProductionSizeIntent =
  | { kind: "absolute"; widthIn: number }
  | { kind: "relative"; direction: "larger" | "smaller" };

/**
 * Returns the production-size request in `message`, or `null` when the
 * message is not (unambiguously) one.
 *
 * Callers must additionally decide WHEN this is even asked — see
 * `ConversationCapability`, which only consults it once the customer has
 * confirmed their final direction, i.e. at the "Use This Design → Prepare
 * Print-Ready" boundary where production size is the live question.
 */
export function detectProductionSizeIntent(
  message: string,
): ProductionSizeIntent | null {
  const text = message.trim();
  if (!text) return null;

  const namesPrint = PRINT_SUBJECT_PATTERN.test(text);
  const measurement = INCH_MEASUREMENT_PATTERN.exec(text);

  if (measurement) {
    const widthIn = Number.parseFloat(measurement[1]!);
    if (!Number.isFinite(widthIn) || widthIn <= 0) return null;
    // A measurement counts when it is about the deliverable, or when it is
    // explicitly a width ("make it 12 inches wide" — nothing inside a design
    // is described that way).
    if (namesPrint || WIDTH_WORD_PATTERN.test(text)) {
      return { kind: "absolute", widthIn };
    }
    return null;
  }

  // No number: only a request that explicitly names the print (or its size)
  // may be read as a production-size change. "Make it smaller" alone stays a
  // creative revision.
  if (!namesPrint && !SIZE_NOUN_PATTERN.test(text)) return null;
  if (!namesPrint) return null;

  if (LARGER_PATTERN.test(text)) return { kind: "relative", direction: "larger" };
  if (SMALLER_PATTERN.test(text)) return { kind: "relative", direction: "smaller" };
  return null;
}
