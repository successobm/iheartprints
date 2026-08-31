/**
 * Signs Phase S3D: bounded, deterministic canonicalization of a real
 * provider defect — a Topaz sign reconstruction returning an alpha channel
 * that is not uniformly 255 even when fed a source proven fully opaque.
 *
 * The real S3B Ruth acceptance run is what this exists for. Its 4096x6144
 * Topaz reconstruction, decoded and audited pixel-by-pixel outside any
 * production code path, showed:
 *
 *   - 83.9% of all 25,165,824 pixels at alpha=254 (one unit short of
 *     opaque), spread near-uniformly across the whole canvas — a global
 *     encode-time alpha quantization, not a local defect.
 *   - 10,239 pixels (0.04%) at alpha=0 — every single one of them on the
 *     exact 1px border ring (x=0, x=width-1, y=0, or y=height-1); zero
 *     interior alpha=0 pixels. The alpha value ramps smoothly from the
 *     border inward before plateauing at 254 — a classic edge-padding/
 *     feather artifact from the reconstruction model, not random data loss.
 *   - RGB beneath every audited low-alpha pixel (including every alpha=0
 *     sample) closely matched the proportionally-corresponding SOURCE
 *     pixel's own colour (orange stayed orange, blue stayed blue, black
 *     stayed black) — never flat zero/garbage/uninitialized data.
 *
 * That evidence is why this module ONLY ever touches the alpha byte. It
 * never composites, never invents colour, never inpaints, never resamples,
 * and never runs at all unless the AUTHORITATIVE SOURCE fed to the
 * provider was itself proven fully opaque (`hasAnyTransparentPixel` on the
 * pre-reconstruction input) — a source that legitimately carries
 * transparency is never auto-normalized; the existing strict opacity gate
 * governs it exactly as before this phase.
 *
 * This is provider-output CANONICALIZATION, not customer-approved creative
 * geometry — it restores a source invariant (verified opaque source ⇒
 * production raster stays fully opaque) that the reconstruction provider
 * itself broke, never something a `SignRepairPlan` step approved or
 * requested. No repair-plan schema change was needed or made for it.
 */

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { hasAnyTransparentPixel } from "@/capabilities/final-artwork/raster-transform";

export interface ProviderAlphaNormalizationEvidence {
  reason: "provider_introduced_alpha_on_verified_opaque_source";
  strategy: "force_opaque_preserve_rgb";
  /** Pixel count whose alpha byte was not already 255 before normalization. */
  affectedPixelCount: number;
  minAlphaBefore: number;
  maxAlphaBefore: number;
  /** Always 255/255 — normalization only ever forces full opacity. */
  minAlphaAfter: 255;
  maxAlphaAfter: 255;
  widthPx: number;
  heightPx: number;
  /** Always `false` — this operation never touches an R, G, or B byte. */
  rgbModified: false;
}

export interface ProviderAlphaNormalizationOutcome {
  image: RgbaImage;
  /**
   * `null` whenever nothing was admitted or nothing needed changing — the
   * ordinary, still-most-common case (an opaque source whose reconstruction
   * also came back fully opaque, or a source that itself was never proven
   * opaque). Never omit this distinction: `null` means "no normalization
   * occurred," not "normalization occurred and found zero affected pixels."
   */
  evidence: ProviderAlphaNormalizationEvidence | null;
}

/**
 * `authoritativeSourceImage` must be the EXACT bytes fed to the
 * reconstruction provider (the pre-reconstruction input) — never the
 * customer's original upload if any admitted step already ran ahead of
 * reconstruction, and never the reconstructed output itself.
 *
 * Admission (ALL required):
 *   - `authoritativeSourceImage` is proven fully opaque right now, by the
 *     same strict `hasAnyTransparentPixel` test the final opacity gate
 *     uses — never a persisted/stale diagnostic.
 *   - `reconstructedImage` actually carries some non-255 alpha (nothing to
 *     do otherwise).
 *
 * On admission, every pixel's alpha becomes exactly 255; every R/G/B byte
 * is copied unchanged. Dimensions never change. No compositing, no
 * resampling, no per-pixel threshold — every non-255 alpha byte is
 * corrected uniformly, whether it was 254 or 0, because the invariant being
 * restored is "the source was opaque," not "the source was almost opaque."
 */
export function normalizeProviderAlphaOnVerifiedOpaqueSource(
  authoritativeSourceImage: RgbaImage,
  reconstructedImage: RgbaImage,
): ProviderAlphaNormalizationOutcome {
  if (hasAnyTransparentPixel(authoritativeSourceImage)) {
    // The source itself legitimately carries transparency — never
    // auto-normalize. The existing strict opacity gate is untouched and
    // governs exactly as it did before this phase.
    return { image: reconstructedImage, evidence: null };
  }
  if (!hasAnyTransparentPixel(reconstructedImage)) {
    // Already fully opaque — nothing to do, nothing to claim.
    return { image: reconstructedImage, evidence: null };
  }

  const source = reconstructedImage.data;
  const normalized = Buffer.from(source); // never mutate the caller's buffer
  let affectedPixelCount = 0;
  let minAlphaBefore = 255;
  let maxAlphaBefore = 0;
  for (let i = 3; i < source.length; i += 4) {
    const alpha = source[i]!;
    if (alpha < minAlphaBefore) minAlphaBefore = alpha;
    if (alpha > maxAlphaBefore) maxAlphaBefore = alpha;
    if (alpha !== 255) {
      affectedPixelCount += 1;
      normalized[i] = 255;
    }
  }

  return {
    image: {
      width: reconstructedImage.width,
      height: reconstructedImage.height,
      data: normalized,
    },
    evidence: {
      reason: "provider_introduced_alpha_on_verified_opaque_source",
      strategy: "force_opaque_preserve_rgb",
      affectedPixelCount,
      minAlphaBefore,
      maxAlphaBefore,
      minAlphaAfter: 255,
      maxAlphaAfter: 255,
      widthPx: reconstructedImage.width,
      heightPx: reconstructedImage.height,
      rgbModified: false,
    },
  };
}
