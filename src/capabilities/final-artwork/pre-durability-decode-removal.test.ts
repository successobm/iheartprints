import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PNG } from "pngjs";

import { PRINT_PLACEMENT_SIZING_POLICY } from "@/capabilities/shared/print-placement-dimensions";
import { ProviderError } from "@/capabilities/providers/provider-error";

import type { FinalArtworkProviderInput } from "./provider";
import { FINAL_ARTWORK_PROVIDER_STATUS } from "./provider";
import type { ProductionSizingRequest } from "./production-normalization";
import {
  resolveReconstructionRequest,
  TopazTransparencyUpscaleProvider,
} from "./topaz-transparency-upscale-provider";

/**
 * Pre-Durability PNG Decode Removal — the behavioural contract.
 *
 * Three production container deaths (Pedro Back `5ccc9d2f-…`, exit 128)
 * happened inside `PNG.sync.read` on a downloaded provider result, before
 * anything durable existed. These tests pin the repair: the pre-durability
 * path must no longer decode or re-encode the result, must persist the
 * provider's own bytes untouched, and must keep the SAME geometry policy,
 * the SAME error classification and the SAME network behaviour.
 *
 * NO REAL NETWORK CALLS — `fetchImpl` is a local fake.
 */

const PROCESS_ID = "decode-removal-process-id";
const SIGNED_RESULT_URL = "https://cdn.example-provider.test/results/x?sig=TOKEN";

/** Small target so fixtures stay fast; the real placement policy otherwise. */
const SIZING: ProductionSizingRequest = {
  ...PRINT_PLACEMENT_SIZING_POLICY.full_back,
  targetWidthIn: 2,
  maxHeightIn: 3,
  targetPpi: 150,
};

const SOURCE_W = 200;
const SOURCE_H = 150;

function pngOf(width: number, height: number, seed = 7): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    png.data[i * 4] = (i * seed) & 0xff;
    png.data[i * 4 + 1] = (i * 13) & 0xff;
    png.data[i * 4 + 2] = (i * 29) & 0xff;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

function sourcePng(): Buffer {
  const png = new PNG({ width: SOURCE_W, height: SOURCE_H });
  const mx = Math.floor(SOURCE_W * 0.1);
  const my = Math.floor(SOURCE_H * 0.1);
  for (let y = 0; y < SOURCE_H; y += 1) {
    for (let x = 0; x < SOURCE_W; x += 1) {
      const i = (SOURCE_W * y + x) << 2;
      const inside = x >= mx && x < SOURCE_W - mx && y >= my && y < SOURCE_H - my;
      png.data[i] = 5;
      png.data[i + 1] = 5;
      png.data[i + 2] = 5;
      png.data[i + 3] = inside ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

function requiredGeometry(sourceBytes: Buffer): { widthPx: number; heightPx: number } {
  const png = PNG.sync.read(sourceBytes);
  const resolved = resolveReconstructionRequest(
    { width: png.width, height: png.height, data: png.data },
    SIZING,
  );
  if (resolved.status !== "resolved") throw new Error("fixture could not resolve");
  return { widthPx: resolved.request.widthPx, heightPx: resolved.request.heightPx };
}

function resumeInput(sourceBytes: Buffer): FinalArtworkProviderInput {
  return {
    sourceBytes,
    sourceContentType: "image/png",
    sizing: SIZING,
    existingProviderRequest: {
      providerKey: "topaz_transparency_upscale",
      providerRequestId: PROCESS_ID,
      providerStatus: FINAL_ARTWORK_PROVIDER_STATUS.resultReady,
    },
    onProviderRequestSubmitted: async () => {
      throw new Error("a resume-download run must never submit a paid request");
    },
  };
}

function fetchFake(resultBytes: Buffer) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    if (url.includes("/download/")) {
      return new Response(JSON.stringify({ url: SIGNED_RESULT_URL }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === SIGNED_RESULT_URL) {
      return new Response(new Uint8Array(resultBytes), {
        status: 200,
        headers: { "content-type": "image/png", "content-length": String(resultBytes.length) },
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
  return { impl, calls };
}

function buildProvider(impl: typeof fetch) {
  return new TopazTransparencyUpscaleProvider({
    apiKey: "test-key",
    fetchImpl: impl,
    sleepImpl: () => Promise.resolve(),
    pollIntervalMs: 1,
  });
}

/** Counts every pngjs decode/encode, recording the byte length each saw. */
function withPngSpy<T>(run: () => Promise<T>): Promise<{ result: T; reads: number[]; writes: number[] }> {
  const realRead = PNG.sync.read;
  const realWrite = PNG.sync.write;
  const reads: number[] = [];
  const writes: number[] = [];
  PNG.sync.read = ((buf: Buffer, opts?: unknown) => {
    reads.push(buf.length);
    return realRead.call(PNG.sync, buf, opts as never);
  }) as typeof PNG.sync.read;
  PNG.sync.write = ((png: PNG, opts?: unknown) => {
    const out = realWrite.call(PNG.sync, png, opts as never);
    writes.push(out.length);
    return out;
  }) as typeof PNG.sync.write;
  return run()
    .then((result) => ({ result, reads, writes }))
    .finally(() => {
      PNG.sync.read = realRead;
      PNG.sync.write = realWrite;
    });
}

describe("pre-durability decode removal — bounded provider download step", () => {
  it("returns the provider's ORIGINAL bytes, byte-for-byte, with no re-encode", async () => {
    const sourceBytes = sourcePng();
    const geo = requiredGeometry(sourceBytes);
    const resultBytes = pngOf(geo.widthPx, geo.heightPx);
    const { impl } = fetchFake(resultBytes);

    const result = await buildProvider(impl).produceBounded(resumeInput(sourceBytes));

    assert.equal(result.status, "downloaded");
    if (result.status !== "downloaded") throw new Error("unreachable");
    assert.equal(
      Buffer.compare(result.bytes, resultBytes),
      0,
      "persisted bytes must be the provider's own, not a pngjs re-encode",
    );
    assert.equal(result.widthPx, geo.widthPx);
    assert.equal(result.heightPx, geo.heightPx);
    assert.equal(result.providerRequestId, PROCESS_ID);
    assert.equal(result.nativeWidthPx, SOURCE_W);
    assert.equal(result.nativeHeightPx, SOURCE_H);
  });

  it("never decodes or re-encodes the RESULT bytes in the pre-durability path", async () => {
    const sourceBytes = sourcePng();
    const geo = requiredGeometry(sourceBytes);
    const resultBytes = pngOf(geo.widthPx, geo.heightPx);
    const { impl } = fetchFake(resultBytes);

    const { reads, writes } = await withPngSpy(() =>
      buildProvider(impl).produceBounded(resumeInput(sourceBytes)),
    );

    // The SOURCE is still decoded — that is required to plan the request and
    // is bounded by the customer upload limit, not by the 4x provider result.
    assert.deepEqual(reads, [sourceBytes.length], "exactly one decode, and it is the source");
    assert.equal(
      reads.includes(resultBytes.length),
      false,
      "the provider result must never be decoded before persistence",
    );
    assert.deepEqual(writes, [], "nothing may be re-encoded merely to persist it");
  });

  it("keeps the geometry policy unchanged: an oversized PROPORTIONAL result is still accepted", async () => {
    const sourceBytes = sourcePng();
    // Topaz's documented real behaviour: 4.000x of the SOURCE CANVAS,
    // ignoring the requested output dimensions entirely.
    const resultBytes = pngOf(SOURCE_W * 4, SOURCE_H * 4);
    const { impl } = fetchFake(resultBytes);

    const result = await buildProvider(impl).produceBounded(resumeInput(sourceBytes));

    assert.equal(result.status, "downloaded");
    if (result.status !== "downloaded") throw new Error("unreachable");
    assert.equal(result.widthPx, SOURCE_W * 4);
    assert.equal(result.heightPx, SOURCE_H * 4);
    assert.equal(Buffer.compare(result.bytes, resultBytes), 0);
  });

  it("still rejects an UNDERSIZED result, with the same classification", async () => {
    const sourceBytes = sourcePng();
    const resultBytes = pngOf(40, 30); // proportional but far too small
    const { impl } = fetchFake(resultBytes);

    await assert.rejects(
      () => buildProvider(impl).produceBounded(resumeInput(sourceBytes)),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.classification, "malformed_response");
        assert.match(error.message, /insufficient dimensions/);
        return true;
      },
    );
  });

  it("still rejects a WRONG-ASPECT result, with the same classification", async () => {
    const sourceBytes = sourcePng();
    const resultBytes = pngOf(SOURCE_W * 4, SOURCE_H * 2); // 2.67 vs 1.33
    const { impl } = fetchFake(resultBytes);

    await assert.rejects(
      () => buildProvider(impl).produceBounded(resumeInput(sourceBytes)),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.classification, "malformed_response");
        assert.match(error.message, /proportions do not match/);
        return true;
      },
    );
  });

  it("still catches a TRUNCATED result — the corruption check is not lost", async () => {
    const sourceBytes = sourcePng();
    const geo = requiredGeometry(sourceBytes);
    const full = pngOf(geo.widthPx, geo.heightPx);
    const truncated = full.subarray(0, Math.floor(full.length * 0.6));
    const { impl } = fetchFake(truncated);

    await assert.rejects(
      () => buildProvider(impl).produceBounded(resumeInput(sourceBytes)),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.classification, "malformed_response");
        assert.equal(error.stage, "download");
        assert.match(error.message, /not a valid PNG/);
        return true;
      },
    );
  });

  it("still catches a CORRUPTED result (single flipped bit) via chunk CRC", async () => {
    const sourceBytes = sourcePng();
    const geo = requiredGeometry(sourceBytes);
    const corrupted = pngOf(geo.widthPx, geo.heightPx);
    const at = Math.floor(corrupted.length * 0.6);
    corrupted[at] = corrupted[at]! ^ 0x01;
    const { impl } = fetchFake(corrupted);

    await assert.rejects(
      () => buildProvider(impl).produceBounded(resumeInput(sourceBytes)),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.classification, "malformed_response");
        assert.match(error.message, /CRC/i);
        return true;
      },
    );
  });

  it("still catches a non-PNG body", async () => {
    const sourceBytes = sourcePng();
    const { impl } = fetchFake(Buffer.from("this is definitely not a png"));

    await assert.rejects(
      () => buildProvider(impl).produceBounded(resumeInput(sourceBytes)),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.classification, "malformed_response");
        return true;
      },
    );
  });

  it("makes exactly the same two network calls, and never a paid submission", async () => {
    const sourceBytes = sourcePng();
    const geo = requiredGeometry(sourceBytes);
    const { impl, calls } = fetchFake(pngOf(geo.widthPx, geo.heightPx));

    await buildProvider(impl).produceBounded(resumeInput(sourceBytes));

    assert.equal(calls.length, 2);
    assert.ok(calls[0]!.includes("/download/"));
    assert.equal(calls[1], SIGNED_RESULT_URL);
    assert.equal(calls.some((u) => u.endsWith("/tool/async")), false);
  });

  it("round-trips: the persisted original bytes still decode downstream", async () => {
    const sourceBytes = sourcePng();
    const geo = requiredGeometry(sourceBytes);
    const resultBytes = pngOf(geo.widthPx, geo.heightPx);
    const { impl } = fetchFake(resultBytes);

    const downloaded = await buildProvider(impl).produceBounded(resumeInput(sourceBytes));
    assert.equal(downloaded.status, "downloaded");
    if (downloaded.status !== "downloaded") throw new Error("unreachable");

    // What `finalizeDownloadedResultBounded` will later do against the
    // DURABLE intermediate — proving the un-re-encoded bytes stay usable.
    const decoded = PNG.sync.read(downloaded.bytes);
    assert.equal(decoded.width, geo.widthPx);
    assert.equal(decoded.height, geo.heightPx);
  });
});
