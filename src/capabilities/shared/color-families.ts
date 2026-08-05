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

export function isDarkColor(color: string): boolean {
  return DARK_COLORS.has(color.trim().toLowerCase());
}

export function suggestContrastingColor(shirtColor: string): string {
  return isDarkColor(shirtColor) ? "white" : "navy";
}
