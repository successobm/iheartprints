import { PNG } from "pngjs";

import {
  hasAnyTransparentPixel,
  resampleContainWithTransparentPadding,
} from "./raster-transform";
import type {
  FinalArtworkProvider,
  FinalArtworkProviderInput,
  FinalArtworkProviderOutput,
} from "./provider";

const TRANSFORMATION_METHOD = "local_raster_contain_resample_v1";

/**
 * Sprint 2M Phase 2C (Goal 5 Option C / Goal 6): the chosen Phase 2C
 * production-raster strategy — a local, deterministic, provider-neutral
 * geometric resample. Pure JS (`pngjs`), no native binary, no network call,
 * no paid provider (Goal 20).
 *
 * This is honest, bounded "production-preparation," never presented as
 * having created new detail: `produce()` always reports true
 * `nativeWidthPx`/`nativeHeightPx` and `resolutionProvenance` so
 * `PrintValidationCapability` can refuse to treat an enlarged pixel count
 * as evidence of production-quality artwork (see ARCHITECTURE.md's
 * "Upscaling Truthfulness" section — the entire reason this class exists
 * separately from `PrintValidationCapability` deciding readiness).
 *
 * Content-preserving by construction (Goal 7): the output is a pure
 * geometric transform of the exact same source pixels — same composition,
 * same wording, same colors, same everything, just resampled and padded.
 * This is what lets `FinalArtworkWorkerCapability` honestly reuse Concept
 * Evaluation's already-persisted `required_wording` verdict instead of
 * re-running text verification (Goal 8) — a provider-reconstruction
 * strategy would not get to make that same claim.
 */
export class LocalRasterInterpolationProvider implements FinalArtworkProvider {
  readonly providerKey = "local_raster_interpolation";

  async produce(
    input: FinalArtworkProviderInput,
  ): Promise<FinalArtworkProviderOutput> {
    if (input.sourceContentType !== "image/png") {
      throw new Error(
        `LocalRasterInterpolationProvider only supports image/png source assets (got "${input.sourceContentType}").`,
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

    const result = resampleContainWithTransparentPadding(
      { width: source.width, height: source.height, data: source.data },
      input.targetWidthPx,
      input.targetHeightPx,
      input.marginFraction,
    );

    const output = new PNG({ width: result.image.width, height: result.image.height });
    result.image.data.copy(output.data);
    const bytes = PNG.sync.write(output);

    return {
      bytes,
      contentType: "image/png",
      widthPx: result.image.width,
      heightPx: result.image.height,
      hasTransparency: hasAnyTransparentPixel(result.image),
      nativeWidthPx: source.width,
      nativeHeightPx: source.height,
      // Sprint 2M Phase 2E: this provider never performs a distinct
      // reconstruction stage — it resamples straight from source to the
      // final canvas, so there is no separate "reconstructed" size to
      // report (see `FinalArtworkProviderOutput`'s doc).
      reconstructedWidthPx: null,
      reconstructedHeightPx: null,
      // `contentScale <= 1` means the source content was only ever shrunk
      // or kept 1:1 to fit the frame — no pixel was fabricated. `> 1` means
      // the content had to be stretched beyond native density.
      resolutionProvenance: result.contentScale > 1 ? "interpolated_upscale" : "native",
      transformationMethod: TRANSFORMATION_METHOD,
      // A pure geometric resample never redraws content — always true for
      // this provider (see class doc comment's Goal 7/8 reasoning).
      preservesApprovedContent: true,
      // Sprint 2M Phase 2E: no paid/network request — nothing to identify.
      providerRequestId: null,
    };
  }
}
