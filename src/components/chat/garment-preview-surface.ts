/**
 * DTF Background-Removal Garment-Preview Contradiction Phase (live
 * acceptance defect): pure logic behind `SeparationReviewPanel`'s garment-
 * colour preview surface — extracted for the same reason
 * `region-review-workspace.ts` / `proposal-review-workspace.ts` /
 * `preview-image-commit.ts` were: this repo's test tooling is `node:test`
 * (no DOM, no React render), so this has to live somewhere a plain
 * function call can exercise it deterministically.
 *
 * THE DEFECT. A customer's own free-text garment colour (e.g. "Blue") was
 * passed straight through as the preview's initial `backgroundColor` — a
 * raw string the compositing ROUTE's `resolveGarmentColor` (server-side)
 * could not resolve, since the bare word "blue" had no matching table
 * entry (only qualified spellings like "Royal Blue" did — every OTHER
 * basic hue already had a bare-word entry). The route then silently fell
 * back to a hardcoded, unlabeled black, composited directly into the
 * returned preview PNG's own pixels — never a CSS artifact — making a
 * genuinely transparent area visually indistinguishable from real opaque
 * black artwork ink.
 *
 * THE FIX. `resolveInitialPreviewSurfaceHex` is the ONE place the preview
 * surface is ever seeded: it resolves the customer's own stated garment
 * colour through the SAME `resolveGarmentColor` the server route already
 * trusts (reused, never a second implementation — see also the new `blue`
 * table entry in `production-treatment.ts`, which is what makes a bare
 * "Blue" resolve correctly now), falling back to WHITE — never black — for
 * a colour the table genuinely cannot name. `describePreviewSurface` is the
 * matching label, so a customer is never left guessing which garment
 * colour (or the safe fallback) the preview is actually showing.
 */
import { resolveGarmentColor } from "@/capabilities/shared/production-treatment";

export interface GarmentInspectionSurface {
  readonly key: string;
  readonly hex: string;
  readonly label: string;
}

export const GARMENT_INSPECTION_SURFACES: readonly GarmentInspectionSurface[] = [
  { key: "black", hex: "#000000", label: "Black" },
  { key: "white", hex: "#FFFFFF", label: "White" },
  { key: "red", hex: "#B22234", label: "Red" },
  { key: "gray", hex: "#C8C8C8", label: "Gray" },
] as const;

/**
 * White, never black: a safe, neutral, already-offered surface, clearly
 * distinct from ink black rather than silently indistinguishable from it.
 */
export const FALLBACK_PREVIEW_SURFACE: GarmentInspectionSurface = {
  key: "fallback",
  hex: "#FFFFFF",
  label: "White",
};

/**
 * The ONE place the preview surface is ever seeded from the customer's own
 * stated garment colour. Always returns a `#RRGGBB` the compositing route
 * can resolve — never the raw, unvalidated input string.
 */
export function resolveInitialPreviewSurfaceHex(garmentColor: string): string {
  return resolveGarmentColor(garmentColor)?.hex ?? FALLBACK_PREVIEW_SURFACE.hex;
}

/**
 * What to call the CURRENTLY active preview surface, for the label next to
 * the swatch buttons. Checks the four fixed swatches first (their own
 * labels), then the customer's own stated colour (if it resolves to this
 * exact surface), then the fallback — so relabeling never happens for a
 * surface the customer explicitly chose via a swatch button, even one that
 * happens to coincide with their own garment colour's hex.
 */
export function describePreviewSurface(previewSurface: string, garmentColor: string): string {
  const swatch = GARMENT_INSPECTION_SURFACES.find((s) => s.hex === previewSurface);
  if (swatch) return swatch.label;
  const resolved = resolveGarmentColor(garmentColor);
  if (resolved && resolved.hex === previewSurface) return resolved.label;
  return FALLBACK_PREVIEW_SURFACE.label;
}
