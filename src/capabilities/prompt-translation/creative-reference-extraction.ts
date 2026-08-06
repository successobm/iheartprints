/**
 * Sprint 2K Phase 3 (Goal 4) — Inspiration vs. content.
 *
 * A customer describing what they want often mixes two different things in
 * the same sentence:
 *
 *   - content: what the artwork must actually depict
 *   - inspiration: a stylistic/era/mood reference that should shape *how*
 *     the artwork looks, not *what* it literally shows
 *
 * "its a retro design spin off from the old tv show my 3 sons, but i want
 * it bowling themed" is a real example: "spin off from the old tv show My 3
 * Sons" is a reference to an aesthetic/era, not an instruction to draw the
 * show's cast. Left undistinguished, a downstream generation provider can
 * (and, per this sprint's motivating live test, did) interpret it far too
 * literally — rendering recognizable sitcom-cast-style faces instead of a
 * bowling logo.
 *
 * This module is deliberately general — cue-phrase detection, not a
 * bowling-specific rule — and deliberately simple: a fixed list of
 * reference cue phrases ("inspired by", "spin off from", "like an old
 * ...", "in the style of", ...), each capturing the phrase that follows as
 * an inspiration reference and removing it from the content text. No LLM,
 * fully deterministic. A phrase this module doesn't recognize is left
 * exactly where it was — under-detection just means a reference is treated
 * as ordinary content, never the reverse.
 */

interface ReferenceCue {
  pattern: RegExp;
}

// Order matters only in that a longer/more specific cue should be tried
// before a shorter one it could be a substring of — none currently overlap,
// but keeping this ordered and documented makes future additions safe.
const REFERENCE_CUES: ReferenceCue[] = [
  { pattern: /\bspin[- ]?offs?\s+(?:of|from)\s+([^,.;!?]+)/gi },
  { pattern: /\binspired by\s+([^,.;!?]+)/gi },
  { pattern: /\breminiscent of\s+([^,.;!?]+)/gi },
  { pattern: /\bin the style of\s+([^,.;!?]+)/gi },
  { pattern: /\bstyled after\s+([^,.;!?]+)/gi },
  { pattern: /\ba nod to\s+([^,.;!?]+)/gi },
  { pattern: /\ban? homage to\s+([^,.;!?]+)/gi },
  { pattern: /\bthrowback to\s+([^,.;!?]+)/gi },
  // Requires an explicit era/style qualifier right after "like a/an" so an
  // ordinary request ("I'd like a black shirt") is never mistaken for a
  // reference cue — only a framing like "like an old travel poster" is.
  { pattern: /\blike an? ((?:old|classic|vintage|retro|\d{2,4}s?)\s+[^,.;!?]+)/gi },
];

export interface CreativeReferenceExtraction {
  /** The remaining text with every recognized reference clause removed. */
  content: string;
  /** Reference phrases pulled out — style/era/mood inspiration only. */
  inspirations: string[];
}

/** Collapses leftover whitespace/punctuation artifacts from removing a clause. */
function cleanupAfterRemoval(text: string): string {
  return text
    .replace(/\s+,/g, ",")
    .replace(/,\s*,/g, ",")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,]+|[\s,]+$/g, "")
    .trim();
}

/**
 * Splits `text` into content (what must be depicted) and a list of
 * inspiration references (style/era/mood only). Safe to call on empty or
 * reference-free text — returns it unchanged with no inspirations.
 */
export function extractCreativeReferences(text: string): CreativeReferenceExtraction {
  const trimmed = text.trim();
  if (!trimmed) return { content: trimmed, inspirations: [] };

  let content = trimmed;
  const inspirations: string[] = [];

  for (const { pattern } of REFERENCE_CUES) {
    content = content.replace(pattern, (_full, captured: string) => {
      const value = captured?.trim();
      if (value) inspirations.push(value);
      return "";
    });
  }

  return { content: cleanupAfterRemoval(content), inspirations };
}
