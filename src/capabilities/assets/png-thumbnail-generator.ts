import { PNG } from "pngjs";

import type {
  ThumbnailGenerator,
  ThumbnailInput,
  ThumbnailOutput,
} from "./thumbnail-generator";

/** Longest edge of a generated thumbnail — "smaller dimensions, fast preview". */
const DEFAULT_MAX_DIMENSION = 256;

/**
 * Sprint 2H Part 2A: a real, dependency-light (pure-JS, no native binary)
 * thumbnail generator for the one content type our generation pipeline
 * actually produces today (`image/png` — the OpenAI provider always
 * requests a transparent PNG). Nearest-neighbor downscale: simple, fast,
 * and fully sufficient for a "fast preview" thumbnail; a higher-quality
 * resampling filter is a reasonable future improvement (see Sprint 2H Part
 * 2A's "Remaining Limitations"). Any other content type, or a payload that
 * doesn't actually decode as a PNG, is treated as "no thumbnail available"
 * rather than a hard failure.
 */
export class PngThumbnailGenerator implements ThumbnailGenerator {
  constructor(private readonly maxDimension = DEFAULT_MAX_DIMENSION) {}

  async generate(input: ThumbnailInput): Promise<ThumbnailOutput | null> {
    if (input.contentType !== "image/png") return null;

    let source: PNG;
    try {
      source = PNG.sync.read(input.bytes);
    } catch {
      return null;
    }

    const scale = Math.min(
      1,
      this.maxDimension / Math.max(source.width, source.height),
    );

    if (scale >= 1) {
      // Already at or below the target size — the thumbnail is a distinct
      // stored asset either way, just not a resize.
      return {
        bytes: PNG.sync.write(source),
        contentType: "image/png",
        widthPx: source.width,
        heightPx: source.height,
      };
    }

    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    const output = new PNG({ width, height });

    for (let y = 0; y < height; y += 1) {
      const sourceY = Math.min(source.height - 1, Math.floor(y / scale));
      for (let x = 0; x < width; x += 1) {
        const sourceX = Math.min(source.width - 1, Math.floor(x / scale));
        const sourceIdx = (source.width * sourceY + sourceX) << 2;
        const destIdx = (width * y + x) << 2;
        source.data.copy(output.data, destIdx, sourceIdx, sourceIdx + 4);
      }
    }

    return {
      bytes: PNG.sync.write(output),
      contentType: "image/png",
      widthPx: width,
      heightPx: height,
    };
  }
}
