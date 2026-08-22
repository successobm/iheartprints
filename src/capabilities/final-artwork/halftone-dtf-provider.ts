import { PNG } from "pngjs";

import type { HalftoneSettings } from "@/capabilities/shared/production-treatment";

import { applyHalftoneScreen } from "./halftone-screen";
import {
  encodeProductionPng,
  normalizeProductionRaster,
} from "./production-normalization";
import type {
  FinalArtworkProvider,
  FinalArtworkProviderInput,
  FinalArtworkProviderOutput,
} from "./provider";

const TRANSFORMATION_METHOD = "local_halftone_am_screen_v1";

/**
 * Print'em All Phase 2: the DTF halftone production treatment, behind the
 * same `FinalArtworkProvider` boundary every other production transform uses.
 *
 * WHY THIS IS A PROVIDER AND NOT A SECOND PIPELINE. Everything after the
 * transform — asset persistence, provenance, idempotency, authoritative Print
 * Validation, project status, delivery — is identical for a halftone plate
 * and a continuous-tone one, and duplicating any of it would mean two places
 * that can disagree about what a production deliverable is. What genuinely
 * differs is the transform and the checks that judge it, so those are the
 * only two things Phase 2 adds.
 *
 * LOCAL AND FREE (Goal 25). No network call, no external provider, no paid
 * credit — ever. This is economically the point: the artwork this treatment
 * exists for is exactly the artwork the reconstruction provider's 4x ceiling
 * refuses, so reaching for Topaz first and halftoning afterwards would spend
 * a credit to produce pixels the screen then throws away. Treatment selection
 * therefore happens BEFORE provider dispatch, in the worker.
 *
 * THE ORDER OF OPERATIONS IS THE CONTRACT (Goals 6, 17):
 *
 *     approved prepared transparent PNG
 *       -> normalizeProductionRaster   (alpha trim, safety margin, resample
 *                                       to the CONFIRMED final production
 *                                       pixel dimensions)
 *       -> applyHalftoneScreen         (dot lattice generated AT those
 *                                       dimensions)
 *       -> encodeProductionPng         (pHYs density for the target PPI)
 *
 * Screen last, and nothing resizes after it. A lattice generated small and
 * enlarged would print at LPI divided by the scale factor, so "generated at
 * final size" is not a preference — it is what makes the plate's stated line
 * frequency true. `HalftoneScreenMetadata.screenWidthPx/screenHeightPx`
 * record the dimensions the lattice was actually drawn across so production
 * validation can prove it rather than accept it.
 *
 * WHAT IT DOES NOT DO. It never removes a background (the prepared source is
 * immutable and already background-isolated — see Goal 26 / ARCHITECTURE.md),
 * never bakes the garment colour into the deliverable, never separates
 * channels, never builds an underbase, and never claims to have recovered
 * detail the source did not carry.
 */
export class HalftoneDtfProvider implements FinalArtworkProvider {
  readonly providerKey = "local_halftone_dtf";

  /**
   * The settings are constructor state rather than a field on
   * `FinalArtworkProviderInput` because they are THIS provider's mechanism.
   * The shared provider contract describes what every production transform
   * needs (source bytes, sizing policy, paid-request resumption); pushing one
   * implementation's controls into it would make every other provider carry a
   * parameter it must remember to ignore.
   *
   * The worker constructs one per job from the project's durable treatment
   * authority, so a plate's settings are never ambient process state.
   */
  constructor(private readonly settings: HalftoneSettings) {}

  async produce(
    input: FinalArtworkProviderInput,
  ): Promise<FinalArtworkProviderOutput> {
    if (input.sourceContentType !== "image/png") {
      throw new Error(
        `HalftoneDtfProvider only supports image/png source assets (got "${input.sourceContentType}").`,
      );
    }

    let source: PNG;
    try {
      source = PNG.sync.read(input.sourceBytes);
    } catch (error) {
      throw new Error(
        `Source asset bytes could not be decoded as a PNG: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Exactly the shared production transform every other provider runs, so
    // trim policy, safety margin, aspect preservation, physical sizing, and
    // density metadata are one implementation rather than a halftone-flavoured
    // copy of one.
    const normalized = normalizeProductionRaster(
      { width: source.width, height: source.height, data: source.data },
      input.sizing,
    );
    if (normalized.status === "no_visible_artwork") {
      throw new Error(normalized.reason);
    }

    const screened = applyHalftoneScreen(
      normalized.result.image,
      this.settings,
      normalized.result.metadata.targetPpi,
    );

    const encoded = encodeProductionPng({
      image: screened.image,
      metadata: normalized.result.metadata,
    });

    return {
      bytes: encoded.bytes,
      contentType: "image/png",
      widthPx: screened.image.width,
      heightPx: screened.image.height,
      hasTransparency: encoded.hasTransparency,
      nativeWidthPx: source.width,
      nativeHeightPx: source.height,
      // No provider-hosted reconstruction stage exists on this path at all —
      // that is the entire economic point of the treatment.
      reconstructedWidthPx: null,
      reconstructedHeightPx: null,
      // Goal 17: NOT "reconstructed". The plate's pixels are correct at 300
      // PPI because the dot lattice was drawn at 300 PPI, not because source
      // detail was recovered to fill them. Recording it as `reconstructed`
      // would claim continuous-tone detail this file does not have and was
      // never supposed to have; recording it as `interpolated_upscale` would
      // claim the pixels are fabricated padding, which is equally untrue of a
      // lattice generated at final size. It is its own provenance.
      resolutionProvenance: "halftone_generated",
      transformationMethod: TRANSFORMATION_METHOD,
      // Deliberately false, and not a judgement about fidelity. Screening
      // intentionally removes ink coverage, so the plate is NOT the pure
      // geometric transform that flag denotes — and no downstream code may
      // treat a previously recorded content verdict as still describing it.
      preservesApprovedContent: false,
      providerRequestId: null,
      normalization: normalized.result.metadata,
      halftone: screened.metadata,
    };
  }
}
