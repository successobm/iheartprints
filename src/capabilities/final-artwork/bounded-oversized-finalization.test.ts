import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PNG } from "pngjs";

import { PRINT_PLACEMENT_SIZING_POLICY } from "@/capabilities/shared/print-placement-dimensions";

import type { FinalArtworkProviderInput } from "./provider";
import { FINAL_ARTWORK_PROVIDER_STATUS } from "./provider";
import type { ProductionSizingRequest } from "./production-normalization";
import {
  resolveMaximalSinglePassRequest,
  TopazTransparencyUpscaleProvider,
} from "./topaz-transparency-upscale-provider";

/**
 * Memory-Bounded Oversized Provider Result Finalization (Repair #2).
 *
 * Repair #1 stopped the pre-durability decode. These tests pin the second
 * half: finalization and two-pass pass-1 planning must no longer decode an
 * oversized provider raster, must persist/submit the provider's own bytes,
 * and must leave provenance, pass identity and geometry untouched.
 *
 * NO REAL NETWORK CALLS.
 */

const PROCESS_ID = "bounded-finalize-process-id";
const PASS2_PROCESS_ID = "bounded-finalize-pass2-id";
const SIGNED_RESULT_URL = "https://cdn.example-provider.test/r?sig=T";

const SIZING: ProductionSizingRequest = {
  ...PRINT_PLACEMENT_SIZING_POLICY.full_back,
  targetWidthIn: 2,
  maxHeightIn: 4,
  targetPpi: 150,
};

function artwork(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  const mx = Math.max(1, Math.floor(width * 0.1));
  const my = Math.max(1, Math.floor(height * 0.1));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (width * y + x) << 2;
      const inside = x >= mx && x < width - mx && y >= my && y < height - my;
      png.data[i] = (x * 3) & 0xff;
      png.data[i + 1] = (y * 5) & 0xff;
      png.data[i + 2] = (x ^ y) & 0xff;
      png.data[i + 3] = inside ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

/** Counts pngjs decodes/encodes and the byte length each saw. */
async function withPngSpy<T>(run: () => Promise<T>) {
  const realRead = PNG.sync.read;
  const realWrite = PNG.sync.write;
  const reads: number[] = [];
  const writes: number[] = [];
  PNG.sync.read = ((b: Buffer, o?: unknown) => {
    reads.push(b.length);
    return realRead.call(PNG.sync, b, o as never);
  }) as typeof PNG.sync.read;
  PNG.sync.write = ((p: PNG, o?: unknown) => {
    const out = realWrite.call(PNG.sync, p, o as never);
    writes.push(out.length);
    return out;
  }) as typeof PNG.sync.write;
  try {
    return { result: await run(), reads, writes };
  } finally {
    PNG.sync.read = realRead;
    PNG.sync.write = realWrite;
  }
}

function provider(fetchImpl: typeof fetch) {
  return new TopazTransparencyUpscaleProvider({
    apiKey: "k",
    fetchImpl,
    sleepImpl: () => Promise.resolve(),
    pollIntervalMs: 1,
  });
}

const neverFetch = (async () => {
  throw new Error("no network expected on this path");
}) as typeof fetch;

describe("bounded oversized finalization — single pass", () => {
  it("finalizes a durable intermediate without ever decoding it with pngjs", async () => {
    const sourceBytes = artwork(200, 150);
    const resultBytes = artwork(800, 600); // 4x of source: the real Topaz shape
    const input: FinalArtworkProviderInput = {
      sourceBytes,
      sourceContentType: "image/png",
      sizing: SIZING,
      existingDownloadedResult: {
        bytes: resultBytes,
        widthPx: 800,
        heightPx: 600,
        nativeWidthPx: 200,
        nativeHeightPx: 150,
        providerRequestId: PROCESS_ID,
      },
    };

    const { result, reads } = await withPngSpy(() => provider(neverFetch).produceBounded(input));

    assert.equal(result.status, "completed");
    if (result.status !== "completed") throw new Error("unreachable");
    assert.equal(
      reads.includes(resultBytes.length),
      false,
      "the oversized provider result must never reach PNG.sync.read",
    );
    // Provenance: the provider's OWN result dimensions, not a post-processing size.
    assert.equal(result.reconstructedWidthPx, 800);
    assert.equal(result.reconstructedHeightPx, 600);
    assert.equal(result.nativeWidthPx, 200);
    assert.equal(result.nativeHeightPx, 150);
    assert.equal(result.providerRequestId, PROCESS_ID);
    assert.equal(result.resolutionProvenance, "reconstructed");
    assert.equal(result.contentType, "image/png");
  });

  it("produces exactly the output the in-memory path would have produced", async () => {
    const sourceBytes = artwork(200, 150);
    const resultBytes = artwork(800, 600);
    const base: FinalArtworkProviderInput = {
      sourceBytes,
      sourceContentType: "image/png",
      sizing: SIZING,
      existingDownloadedResult: {
        bytes: resultBytes,
        widthPx: 800,
        heightPx: 600,
        nativeWidthPx: 200,
        nativeHeightPx: 150,
        providerRequestId: PROCESS_ID,
      },
    };

    const streamed = await provider(neverFetch).produceBounded(base);
    // The in-memory reference: same normalization, reached via the public
    // `normalizeProductionRaster` + `encodeProductionPng` pair.
    const { normalizeProductionRaster, encodeProductionPng } = await import("./production-normalization");
    const decoded = PNG.sync.read(resultBytes);
    const normalized = normalizeProductionRaster(
      { width: decoded.width, height: decoded.height, data: decoded.data },
      SIZING,
    );
    assert.equal(normalized.status, "normalized");
    if (normalized.status !== "normalized" || streamed.status !== "completed") throw new Error("unreachable");
    const reference = encodeProductionPng(normalized.result);

    assert.equal(streamed.widthPx, normalized.result.image.width);
    assert.equal(streamed.heightPx, normalized.result.image.height);
    assert.equal(streamed.hasTransparency, reference.hasTransparency);
    assert.equal(
      Buffer.compare(streamed.bytes, reference.bytes),
      0,
      "the production PNG must be byte-identical to the in-memory path",
    );
    assert.deepEqual(streamed.normalization, normalized.result.metadata);
  });

  it("still decodes an ordinary SMALL input identically (no behavioural change)", async () => {
    const sourceBytes = artwork(80, 60);
    const resultBytes = artwork(320, 240);
    const result = await provider(neverFetch).produceBounded({
      sourceBytes,
      sourceContentType: "image/png",
      sizing: SIZING,
      existingDownloadedResult: {
        bytes: resultBytes,
        widthPx: 320,
        heightPx: 240,
        nativeWidthPx: 80,
        nativeHeightPx: 60,
        providerRequestId: PROCESS_ID,
      },
    });
    assert.equal(result.status, "completed");
    if (result.status !== "completed") throw new Error("unreachable");
    assert.ok(result.widthPx > 0 && result.heightPx > 0);
    assert.equal(result.reconstructedWidthPx, 320);
  });

  it("fails deterministically on a corrupt durable intermediate", async () => {
    const resultBytes = artwork(800, 600);
    const corrupt = Buffer.from(resultBytes);
    corrupt[Math.floor(corrupt.length * 0.7)] ^= 0xff;
    await assert.rejects(() =>
      provider(neverFetch).produceBounded({
        sourceBytes: artwork(200, 150),
        sourceContentType: "image/png",
        sizing: SIZING,
        existingDownloadedResult: {
          bytes: corrupt,
          widthPx: 800,
          heightPx: 600,
          nativeWidthPx: 200,
          nativeHeightPx: 150,
          providerRequestId: PROCESS_ID,
        },
      }),
    );
  });
});

describe("bounded oversized finalization — two pass", () => {
  /** A source needing more than one 4x pass to reach the target. */
  function twoPassInput(overrides: Partial<FinalArtworkProviderInput> & { sourceBytes: Buffer }): FinalArtworkProviderInput {
    return {
      sourceContentType: "image/png",
      sizing: { ...SIZING, targetWidthIn: 6, maxHeightIn: 8, targetPpi: 150 },
      ...overrides,
    };
  }

  it("plans pass 2 from an ADOPTED pass-1 intermediate without decoding it, and re-submits its own bytes", async () => {
    const source = artwork(190, 140);
    const pass1Request = resolveMaximalSinglePassRequest(PNG.sync.read(source));
    const pass1Bytes = artwork(pass1Request.widthPx, pass1Request.heightPx);

    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      calls.push(u);
      if (u.endsWith("/tool/async")) {
        void init;
        return new Response(JSON.stringify({ process_id: PASS2_PROCESS_ID }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("/status/")) {
        return new Response(JSON.stringify({ status: "Processing" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as typeof fetch;

    const submitted: string[] = [];
    const { result, reads, writes } = await withPngSpy(() =>
      provider(fetchImpl).produceBounded(
        twoPassInput({
          sourceBytes: source,
          existingIntermediateReconstruction: {
            bytes: pass1Bytes,
            widthPx: pass1Request.widthPx,
            heightPx: pass1Request.heightPx,
            providerRequestId: PROCESS_ID,
          },
          onProviderRequestSubmitted: async (id) => {
            submitted.push(id);
          },
        }),
      ),
    );

    assert.equal(result.status, "pending", "pass 2 was submitted and is not finished yet");
    assert.equal(
      reads.includes(pass1Bytes.length),
      false,
      "the pass-1 intermediate must not be decoded to plan pass 2",
    );
    assert.equal(writes.length, 0, "pass 1 must not be re-encoded for pass-2 submission");
    // Exactly ONE pass-2 submission, and pass 1 was never re-submitted.
    assert.deepEqual(submitted, [PASS2_PROCESS_ID]);
    assert.equal(calls.filter((u) => u.endsWith("/tool/async")).length, 1);
  });

  it("persists a freshly downloaded pass-1 result BEFORE any pixel-heavy work, exactly once", async () => {
    const source = artwork(190, 140);
    const pass1Request = resolveMaximalSinglePassRequest(PNG.sync.read(source));
    const pass1Bytes = artwork(pass1Request.widthPx, pass1Request.heightPx);

    const fetchImpl = (async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/download/")) {
        return new Response(JSON.stringify({ url: SIGNED_RESULT_URL }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u === SIGNED_RESULT_URL) {
        return new Response(new Uint8Array(pass1Bytes), {
          status: 200,
          headers: { "content-type": "image/png", "content-length": String(pass1Bytes.length) },
        });
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as typeof fetch;

    const persisted: { bytes: Buffer; providerRequestId: string }[] = [];
    const { result, reads } = await withPngSpy(() =>
      provider(fetchImpl).produceBounded(
        twoPassInput({
          sourceBytes: source,
          existingProviderRequest: {
            providerKey: "topaz_transparency_upscale",
            providerRequestId: PROCESS_ID,
            providerStatus: FINAL_ARTWORK_PROVIDER_STATUS.resultReady,
          },
          onIntermediateReconstructionProduced: async (i) => {
            persisted.push({ bytes: i.bytes, providerRequestId: i.providerRequestId });
          },
        }),
      ),
    );

    assert.equal(result.status, "pending");
    assert.equal(persisted.length, 1, "pass 1 persisted exactly once");
    assert.equal(persisted[0]!.providerRequestId, PROCESS_ID, "pass identity preserved");
    assert.equal(
      Buffer.compare(persisted[0]!.bytes, pass1Bytes),
      0,
      "the persisted pass-1 intermediate must be the provider's own bytes",
    );
    assert.equal(
      reads.includes(pass1Bytes.length),
      false,
      "pass 1 must become durable without a full decode",
    );
  });
});
