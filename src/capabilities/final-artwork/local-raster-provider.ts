import { PNG } from "pngjs";

import {
  encodeProductionPng,
  normalizeProductionRaster,
} from "./production-normalization";
import type {
  FinalArtworkProvider,
  FinalArtworkProviderInput,
  FinalArtworkProviderOutput,
} from "./provider";

const TRANSFORMATION_METHOD = "local_raster_normalized_resample_v2";

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
 * same wording, same colors, same everything, just alpha-trimmed to the
 * artwork's own bounds and resampled to the production size (no creative
 * content is ever added, removed, or redrawn; trimming only ever discards
 * transparent canvas outside the artwork).
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

    const normalized = normalizeProductionRaster(
      { width: source.width, height: source.height, data: source.data },
      input.sizing,
    );
    if (normalized.status === "no_visible_artwork") {
      throw new Error(normalized.reason);
    }

    const encoded = encodeProductionPng(normalized.result);

    return {
      bytes: encoded.bytes,
      contentType: "image/png",
      widthPx: normalized.result.image.width,
      heightPx: normalized.result.image.height,
      hasTransparency: encoded.hasTransparency,
      nativeWidthPx: source.width,
      nativeHeightPx: source.height,
      // Sprint 2M Phase 2E: this provider never performs a distinct
      // reconstruction stage — it normalizes straight from the source
      // pixels, so there is no separate "reconstructed" size to report (see
      // `FinalArtworkProviderOutput`'s doc).
      reconstructedWidthPx: null,
      reconstructedHeightPx: null,
      // `contentScale <= 1` means the TRIMMED artwork was only ever shrunk
      // or kept 1:1 — no pixel was fabricated. `> 1` means it had to be
      // stretched beyond its own density to reach the production size.
      // Measured against the trimmed artwork, never the padded source: that
      // is the whole point of Print-Ready Normalization Phase 1 (a 1024px
      // concept whose artwork occupies 820px cannot honestly claim to be
      // native at 3" x 300 PPI).
      resolutionProvenance:
        normalized.result.metadata.contentScale > 1 ? "interpolated_upscale" : "native",
      transformationMethod: TRANSFORMATION_METHOD,
      // A pure geometric resample never redraws content — always true for
      // this provider (see class doc comment's Goal 7/8 reasoning).
      preservesApprovedContent: true,
      // Sprint 2M Phase 2E: no paid/network request — nothing to identify.
      providerRequestId: null,
      normalization: normalized.result.metadata,
    };
  }
}
