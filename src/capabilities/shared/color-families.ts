/**
 * Small, deterministic light/dark color classifier (Sprint 2G Part 3) used
 * only to suggest a contrasting alternative on a color-clash recommendation
 * card (e.g. "Use White" on a navy shirt). Intentionally coarse — good
 * enough for a one-click suggestion, not a color-theory engine.
 */
const DARK_COLORS = new Set([
  "black",
  "navy",
  "navy blue",
  "maroon",
  "charcoal",
  "forest green",
  "burgundy",
  "brown",
  "purple",
  "royal blue",
  "olive",
]);

/**
 * Ordinary color names, as a word-boundary pattern.
 *
 * Lives here with the rest of this module's color knowledge rather than as a
 * private list inside Prompt Translation. Needed because customers name
 * colors directly far more often than they say the word "color" — "make only
 * the word SALE red" is a styling request, and a rule that only recognized
 * the literal token `color` read it as a request to change the WORDING (see
 * `requestsWordingChange`).
 *
 * Deliberately common names plus print-relevant finishes, not a full color
 * space: it only has to be good enough to tell "this clause is about how
 * something looks" from "this clause is about what it says".
 */
export const COLOR_WORD_PATTERN =
  /\b(red|orange|yellow|green|blue|purple|violet|pink|magenta|cyan|teal|turquoise|brown|tan|beige|cream|ivory|black|white|grey|gray|silver|gold|golden|bronze|copper|navy|maroon|burgundy|crimson|scarlet|charcoal|olive|lime|mint|lavender|peach|coral|salmon|mustard|khaki|aqua|indigo|neon|pastel|monochrome|greyscale|grayscale|sepia)\b/i;

export function isDarkColor(color: string): boolean {
  return DARK_COLORS.has(color.trim().toLowerCase());
}

export function suggestContrastingColor(shirtColor: string): string {
  return isDarkColor(shirtColor) ? "white" : "navy";
}
