/**
 * Memory-Bounded Oversized Provider Result Finalization (Repair #2, on top
 * of the Pre-Durability PNG Decode Removal).
 *
 * THE PROBLEM REPAIR #1 DID NOT SOLVE. Repair #1 stopped decoding the
 * provider result BEFORE persistence, so a paid Topaz result now becomes
 * durable cheaply. But finalization still had to turn that result into a
 * production plate, and `finalizeDownloadedResultBounded` did it by calling
 * `PNG.sync.read` on the whole thing. Measured on a representative Pedro
 * Back result (13220x4952, 4.000x the source canvas — what Topaz actually
 * returns regardless of requested output dimensions):
 *
 *   peak RSS 880.80 MiB · external 815.96 MiB · heapUsed 6.46 MiB · 1065 ms
 *
 * against a 512 MiB container. The OOM was not removed, only moved one
 * bounded step later.
 *
 * WHY STREAMING IS POSSIBLE AT ALL — the load-bearing observation. The
 * production resampler (`bilinearResample` in `raster-transform.ts`) reads
 * exactly TWO adjacent source rows per destination row (`y0` and
 * `y0 + 1`), and `y0` is non-decreasing as the destination row advances.
 * So the entire resample can be produced in ONE forward pass while holding
 * two source rows, never the whole raster. Nothing about the arithmetic
 * changes, so the output is BIT-IDENTICAL to the non-streaming path — that
 * equivalence is asserted directly in `png-stream.test.ts` rather than
 * assumed here.
 *
 * MEMORY. Both operations are O(destination + one row) rather than
 * O(source). For Pedro Back that is ~15 MiB of production raster plus a
 * 53 KB row, instead of ~800 MiB.
 *
 * WHAT THIS IS NOT. It is not a general PNG library. It handles the
 * non-interlaced truecolour encodings a reconstruction provider actually
 * returns (colour type 2 and 6, bit depth 8 and 16). Anything else is
 * reported as unsupported, and the CALLER decides what to do — for a small
 * raster the existing pngjs path is still perfectly safe, and only an
 * oversized unsupported encoding is refused. That policy lives at the call
 * site, deliberately, not here.
 */

import { createInflate } from "node:zlib";

import { inspectPngStructure } from "./png-structure";

/** Matches `DEFAULT_ALPHA_THRESHOLD` in `alpha-trim.ts`; re-stated by the caller, never guessed here. */
export interface PngStreamHeader {
  widthPx: number;
  heightPx: number;
  bitDepth: number;
  colorType: number;
  interlaced: boolean;
}

export type PngStreamSupport =
  | { supported: true; header: PngStreamHeader; channels: number; bytesPerSample: number }
  | { supported: false; reason: string; header: PngStreamHeader | null };

/** Truecolour (2) and truecolour+alpha (6) at 8 or 16 bits, non-interlaced. */
export function assessPngStreamSupport(bytes: Buffer): PngStreamSupport {
  const inspected = inspectPngStructure(bytes);
  if (inspected.status !== "ok") {
    return { supported: false, reason: inspected.reason, header: null };
  }
  const header: PngStreamHeader = {
    widthPx: inspected.widthPx,
    heightPx: inspected.heightPx,
    bitDepth: inspected.bitDepth,
    colorType: inspected.colorType,
    interlaced: inspected.interlaced,
  };
  if (header.interlaced) {
    return { supported: false, reason: "interlaced PNGs are not streamable by this reader", header };
  }
  if (header.colorType !== 2 && header.colorType !== 6) {
    return {
      supported: false,
      reason: `colour type ${header.colorType} is not streamable by this reader (only 2 and 6)`,
      header,
    };
  }
  if (header.bitDepth !== 8 && header.bitDepth !== 16) {
    return { supported: false, reason: `bit depth ${header.bitDepth} is not streamable by this reader`, header };
  }
  return {
    supported: true,
    header,
    channels: header.colorType === 6 ? 4 : 3,
    bytesPerSample: header.bitDepth === 16 ? 2 : 1,
  };
}

export class PngStreamError extends Error {}

/**
 * Feeds every scanline, already un-filtered and expanded to RGBA8, to
 * `onRow` in top-to-bottom order. `row` is REUSED between calls — a
 * consumer that needs to keep one must copy it. That reuse is the whole
 * point: it is what keeps this O(row) instead of O(image).
 *
 * 16-bit samples are reduced to 8 by taking the high byte, matching pngjs's
 * own default behaviour so a 16-bit provider result normalizes identically
 * either way.
 */
export async function streamPngRows(
  bytes: Buffer,
  onRow: (row: Buffer, y: number) => void,
): Promise<PngStreamHeader> {
  const support = assessPngStreamSupport(bytes);
  if (!support.supported) throw new PngStreamError(support.reason);
  const { header, channels, bytesPerSample } = support;
  const { widthPx, heightPx } = header;

  const bpp = channels * bytesPerSample; // filter unit, per PNG spec 9.2
  const rawRowBytes = widthPx * bpp;
  const prev = Buffer.alloc(rawRowBytes);
  const cur = Buffer.alloc(rawRowBytes);
  const rgba = Buffer.alloc(widthPx * 4);

  let prevRow = prev;
  let curRow = cur;
  let filled = 0; // bytes of the current raw row already assembled
  let filterType = -1; // -1 = still waiting for this row's filter byte
  let y = 0;

  const unfilterAndEmit = () => {
    // PNG spec 9.2 reconstruction, in place on `curRow`.
    switch (filterType) {
      case 0:
        break;
      case 1:
        for (let i = bpp; i < rawRowBytes; i += 1) curRow[i] = (curRow[i]! + curRow[i - bpp]!) & 0xff;
        break;
      case 2:
        for (let i = 0; i < rawRowBytes; i += 1) curRow[i] = (curRow[i]! + prevRow[i]!) & 0xff;
        break;
      case 3:
        for (let i = 0; i < rawRowBytes; i += 1) {
          const left = i >= bpp ? curRow[i - bpp]! : 0;
          curRow[i] = (curRow[i]! + ((left + prevRow[i]!) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < rawRowBytes; i += 1) {
          const a = i >= bpp ? curRow[i - bpp]! : 0;
          const b = prevRow[i]!;
          const c = i >= bpp ? prevRow[i - bpp]! : 0;
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          curRow[i] = (curRow[i]! + pred) & 0xff;
        }
        break;
      default:
        throw new PngStreamError(`unknown PNG filter type ${filterType} on row ${y}`);
    }

    // Expand to RGBA8.
    if (channels === 4 && bytesPerSample === 1) {
      curRow.copy(rgba, 0, 0, widthPx * 4);
    } else {
      for (let x = 0; x < widthPx; x += 1) {
        const s = x * bpp;
        const d = x * 4;
        rgba[d] = curRow[s]!;
        rgba[d + 1] = curRow[s + bytesPerSample]!;
        rgba[d + 2] = curRow[s + 2 * bytesPerSample]!;
        rgba[d + 3] = channels === 4 ? curRow[s + 3 * bytesPerSample]! : 255;
      }
    }
    onRow(rgba, y);

    const swap = prevRow;
    prevRow = curRow;
    curRow = swap;
    filled = 0;
    filterType = -1;
    y += 1;
  };

  const inflate = createInflate();
  const done = new Promise<void>((resolve, reject) => {
    inflate.on("data", (chunk: Buffer) => {
      let offset = 0;
      try {
        while (offset < chunk.length) {
          if (y >= heightPx) return; // ignore any trailing data past the last row
          if (filterType < 0) {
            filterType = chunk[offset]!;
            offset += 1;
            continue;
          }
          const need = rawRowBytes - filled;
          const take = Math.min(need, chunk.length - offset);
          chunk.copy(curRow, filled, offset, offset + take);
          filled += take;
          offset += take;
          if (filled === rawRowBytes) unfilterAndEmit();
        }
      } catch (error) {
        reject(error instanceof Error ? error : new PngStreamError(String(error)));
      }
    });
    inflate.on("end", () => resolve());
    inflate.on("error", (error) => reject(new PngStreamError(`IDAT inflate failed: ${error.message}`)));
  });

  // Walk the chunk table and feed IDAT payloads as SUBARRAYS (views, never
  // copies), so no concatenated copy of the compressed stream is made.
  let offset = 8;
  while (offset < bytes.length) {
    const dataLength = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (type === "IDAT") inflate.write(bytes.subarray(offset + 8, offset + 8 + dataLength));
    if (type === "IEND") break;
    offset += 12 + dataLength;
  }
  inflate.end();
  await done;

  if (y < heightPx) {
    throw new PngStreamError(`IDAT ended after ${y} of ${heightPx} rows`);
  }
  return header;
}

export interface PngAlphaScan {
  header: PngStreamHeader;
  /** `null` when no pixel reaches the threshold — mirrors `computeAlphaBounds`. */
  bbox: { left: number; top: number; right: number; bottom: number; width: number; height: number } | null;
  /** Mirrors `hasAnySubThresholdPixel` — needed for `sourceFullyOpaque`. */
  hasAnySubThresholdPixel: boolean;
}

/**
 * Streaming equivalent of `computeAlphaBounds` + `hasAnySubThresholdPixel`,
 * with identical semantics (`right`/`bottom` exclusive, same threshold
 * comparison). O(row) memory.
 */
export async function scanPngAlphaBounds(bytes: Buffer, threshold: number): Promise<PngAlphaScan> {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = -1;
  let bottom = -1;
  let anySubThreshold = false;

  const header = await streamPngRows(bytes, (row, y) => {
    const width = row.length >> 2;
    for (let x = 0; x < width; x += 1) {
      const a = row[x * 4 + 3]!;
      if (a < threshold) {
        anySubThreshold = true;
        continue;
      }
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  });

  if (right < 0 || bottom < 0) {
    return { header, bbox: null, hasAnySubThresholdPixel: anySubThreshold };
  }
  return {
    header,
    bbox: {
      left,
      top,
      right: right + 1,
      bottom: bottom + 1,
      width: right + 1 - left,
      height: bottom + 1 - top,
    },
    hasAnySubThresholdPixel: anySubThreshold,
  };
}

export interface StreamingResampleRequest {
  /** Crop window in SOURCE coordinates — exactly the window `trimToAlphaBounds` would have copied out. */
  cropLeft: number;
  cropTop: number;
  cropWidth: number;
  cropHeight: number;
  destWidth: number;
  destHeight: number;
}

/**
 * Streaming, bit-identical equivalent of
 * `resampleExact(trimToAlphaBounds(...).image, destWidth, destHeight)`.
 *
 * Reproduces `bilinearResample`'s arithmetic exactly — same `srcXf`/`srcYf`
 * derivation, same clamping, same per-channel interpolation, same
 * `Math.round`. It only reorders WHEN rows are read, never HOW pixels are
 * computed, which is why the result is byte-for-byte the same.
 *
 * Holds two crop rows plus the destination raster; never the source image.
 */
export async function resamplePngRegionStreaming(
  bytes: Buffer,
  request: StreamingResampleRequest,
): Promise<Buffer> {
  const { cropLeft, cropTop, cropWidth, cropHeight, destWidth, destHeight } = request;
  if (destWidth <= 0 || destHeight <= 0) throw new PngStreamError("Target dimensions must be positive.");
  if (cropWidth <= 0 || cropHeight <= 0) throw new PngStreamError("Source dimensions must be positive.");

  const dest = Buffer.alloc(destWidth * destHeight * 4);
  const scaleX = cropWidth / destWidth;
  const scaleY = cropHeight / destHeight;

  // Destination rows in crop-row order. Each needs crop rows y0 and y1=y0+1,
  // and y0 never decreases, so one forward pass suffices.
  const plan: { destY: number; y0: number; y1: number; yFrac: number }[] = [];
  for (let destY = 0; destY < destHeight; destY += 1) {
    const srcYf = Math.min(cropHeight - 1, Math.max(0, (destY + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(srcYf);
    plan.push({ destY, y0, y1: Math.min(cropHeight - 1, y0 + 1), yFrac: srcYf - y0 });
  }

  // Horizontal sampling is row-independent — precompute once.
  const xs = new Int32Array(destWidth * 2);
  const xFracs = new Float64Array(destWidth);
  for (let destX = 0; destX < destWidth; destX += 1) {
    const srcXf = Math.min(cropWidth - 1, Math.max(0, (destX + 0.5) * scaleX - 0.5));
    const x0 = Math.floor(srcXf);
    xs[destX * 2] = x0;
    xs[destX * 2 + 1] = Math.min(cropWidth - 1, x0 + 1);
    xFracs[destX] = srcXf - x0;
  }

  const rowA = Buffer.alloc(cropWidth * 4);
  const rowB = Buffer.alloc(cropWidth * 4);
  let rowAIndex = -1;
  let rowBIndex = -1;
  let planCursor = 0;

  const emitReadyRows = () => {
    while (planCursor < plan.length) {
      const { destY, y0, y1, yFrac } = plan[planCursor]!;
      const top = y0 === rowAIndex ? rowA : y0 === rowBIndex ? rowB : null;
      const bottom = y1 === rowAIndex ? rowA : y1 === rowBIndex ? rowB : null;
      if (!top || !bottom) return;
      const destRow = destY * destWidth * 4;
      for (let destX = 0; destX < destWidth; destX += 1) {
        const x0 = xs[destX * 2]! * 4;
        const x1 = xs[destX * 2 + 1]! * 4;
        const xFrac = xFracs[destX]!;
        const d = destRow + destX * 4;
        for (let c = 0; c < 4; c += 1) {
          const p00 = top[x0 + c]!;
          const p10 = top[x1 + c]!;
          const p01 = bottom[x0 + c]!;
          const p11 = bottom[x1 + c]!;
          const t = p00 * (1 - xFrac) + p10 * xFrac;
          const b = p01 * (1 - xFrac) + p11 * xFrac;
          dest[d + c] = Math.round(t * (1 - yFrac) + b * yFrac);
        }
      }
      planCursor += 1;
    }
  };

  await streamPngRows(bytes, (row, y) => {
    const cropY = y - cropTop;
    if (cropY < 0 || cropY >= cropHeight) return;
    // Keep the two most recent crop rows, alternating buffers.
    const target = cropY % 2 === 0 ? rowA : rowB;
    row.copy(target, 0, cropLeft * 4, (cropLeft + cropWidth) * 4);
    if (cropY % 2 === 0) rowAIndex = cropY;
    else rowBIndex = cropY;
    emitReadyRows();
  });
  emitReadyRows();

  if (planCursor !== plan.length) {
    throw new PngStreamError(`resample produced ${planCursor} of ${plan.length} rows`);
  }
  return dest;
}
