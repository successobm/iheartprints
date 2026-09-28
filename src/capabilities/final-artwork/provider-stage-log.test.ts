import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PNG } from "pngjs";

import { PRINT_PLACEMENT_SIZING_POLICY } from "@/capabilities/shared/print-placement-dimensions";

import type { FinalArtworkProviderInput } from "./provider";
import { FINAL_ARTWORK_PROVIDER_STATUS } from "./provider";
import type { ProductionSizingRequest } from "./production-normalization";
import {
  resolveReconstructionRequest,
  TopazTransparencyUpscaleProvider,
} from "./topaz-transparency-upscale-provider";

/**
 * Download Crash-Boundary Diagnostics (Pedro Back `5ccc9d2f-…`, two
 * reproducible container deaths at DigitalOcean exit code 128).
 *
 * These tests do not assert that the instrumentation is USEFUL — that is
 * what the next production attempt is for. They assert the two properties
 * that make it safe to deploy at all:
 *
 *   1. it cannot leak a secret or a signed URL, and
 *   2. it does not change what the provider does.
 *
 * NO REAL NETWORK CALLS — `fetchImpl` is a local fake. `api.topazlabs.com`
 * is never contacted.
 */

const PROCESS_ID = "stage-log-process-id";
const API_KEY = "super-secret-topaz-key-must-never-be-logged";
const SIGNED_RESULT_URL =
  "https://cdn.example-provider.test/results/abc?signature=SIGNED-SECRET-TOKEN&expires=99";

function sourcePng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  const marginX = Math.floor(width * 0.1);
  const marginY = Math.floor(height * 0.1);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (width * y + x) << 2;
      const inside = x >= marginX && x < width - marginX && y >= marginY && y < height - marginY;
      png.data[idx] = 5;
      png.data[idx + 1] = 5;
      png.data[idx + 2] = 5;
      png.data[idx + 3] = inside ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

function opaquePng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    png.data[i * 4] = 5;
    png.data[i * 4 + 1] = 5;
    png.data[i * 4 + 2] = 5;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

/**
 * A deliberately small production target. The real `full_back` policy
 * (10.5in @ 300ppi = 3150px) would force a multi-megapixel fixture through
 * `PNG.sync.write` on every one of these runs for no added coverage — the
 * boundaries under test are identical at any scale. Everything else is the
 * real placement policy, so the real resolver arithmetic still runs.
 */
const SIZING: ProductionSizingRequest = {
  ...PRINT_PLACEMENT_SIZING_POLICY.full_back,
  targetWidthIn: 2,
  maxHeightIn: 3,
  targetPpi: 150,
};

/** The exact geometry the provider will demand back, computed with the real resolver. */
function expectedResultGeometry(sourceBytes: Buffer): { widthPx: number; heightPx: number } {
  const png = PNG.sync.read(sourceBytes);
  const resolved = resolveReconstructionRequest(
    { width: png.width, height: png.height, data: png.data },
    SIZING,
  );
  assert.equal(resolved.status, "resolved");
  if (resolved.status !== "resolved") throw new Error("unreachable");
  return { widthPx: resolved.request.widthPx, heightPx: resolved.request.heightPx };
}

function buildResumeInput(sourceBytes: Buffer): FinalArtworkProviderInput {
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

function buildFetchFake(resultBytes: Buffer, declareContentLength: boolean) {
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
      const headers: Record<string, string> = { "content-type": "image/png" };
      if (declareContentLength) headers["content-length"] = String(resultBytes.length);
      return new Response(new Uint8Array(resultBytes), { status: 200, headers });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
  return { impl, calls };
}

/** Captures `console.info` for the duration of `run`, always restoring it. */
async function captureConsoleInfo<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const original = console.info;
  const lines: string[] = [];
  console.info = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    const result = await run();
    return { result, lines };
  } finally {
    console.info = original;
  }
}

async function runBoundedDownload(declareContentLength = true) {
  const sourceBytes = sourcePng(200, 150);
  const geometry = expectedResultGeometry(sourceBytes);
  const resultBytes = opaquePng(geometry.widthPx, geometry.heightPx);
  const { impl, calls } = buildFetchFake(resultBytes, declareContentLength);
  const provider = new TopazTransparencyUpscaleProvider({
    apiKey: API_KEY,
    fetchImpl: impl,
    sleepImpl: () => Promise.resolve(),
    pollIntervalMs: 1,
  });
  const captured = await captureConsoleInfo(() => provider.produceBounded(buildResumeInput(sourceBytes)));
  return { ...captured, calls, geometry, sourceBytes };
}

function stagesFrom(lines: string[]): string[] {
  return lines
    .filter((line) => line.startsWith("[final-artwork-provider] stage"))
    .map((line) => {
      const match = /"stage":"([a-z_]+)"/.exec(line);
      assert.ok(match, `stage line had no parseable stage: ${line}`);
      return match![1]!;
    });
}

describe("provider stage logging — crash-boundary diagnostics", () => {
  it("emits every boundary marker, in execution order, across a resume-download run", async () => {
    const { lines, result } = await runBoundedDownload();

    assert.equal(result.status, "downloaded");
    assert.deepEqual(stagesFrom(lines), [
      "source_png_decode_started",
      "source_png_decode_completed",
      "reconstruction_plan_started",
      "reconstruction_plan_completed",
      "reconstruction_request_resolve_started",
      "reconstruction_request_resolve_completed",
      "download_metadata_fetch_started",
      "download_metadata_fetch_responded",
      "download_result_bytes_fetch_started",
      "download_result_bytes_headers_received",
      "download_result_body_buffering_started",
      "download_result_body_buffering_completed",
      // Pre-Durability PNG Decode Removal: the full `PNG.sync.read` +
      // `PNG.sync.write` pair that used to sit here is gone. Geometry now
      // comes from the IHDR, and the provider's bytes are persisted as-is,
      // so this path no longer decodes or re-encodes the result at all.
      "result_header_inspect_started",
      "result_header_inspect_completed",
      "result_geometry_validation_started",
      "result_geometry_validation_completed",
    ]);
  });

  it("never logs the API key, the signed result URL, or any part of either", async () => {
    const { lines } = await runBoundedDownload();
    const blob = lines.join("\n");

    assert.ok(lines.length > 0, "expected stage lines to have been captured");
    assert.equal(blob.includes(API_KEY), false, "the provider API key must never be logged");
    assert.equal(blob.includes(SIGNED_RESULT_URL), false, "the signed result URL must never be logged");
    assert.equal(blob.includes("SIGNED-SECRET-TOKEN"), false, "no part of a signed URL may be logged");
    assert.equal(blob.includes("signature="), false);
    assert.equal(blob.toLowerCase().includes("authorization"), false);
    assert.equal(blob.toLowerCase().includes("x-api-key"), false);
    // The provider's own host/endpoint is not a secret, but there is no
    // reason for any URL to appear in a stage line — assert none does.
    assert.equal(blob.includes("https://"), false, "no URL of any kind belongs in a stage line");
  });

  it("logs counts and statuses only — never artwork bytes", async () => {
    const { lines, sourceBytes } = await runBoundedDownload();
    const blob = lines.join("\n");

    // A base64/latin1 slice of the real artwork must not appear anywhere.
    assert.equal(blob.includes(sourceBytes.subarray(0, 64).toString("base64")), false);
    assert.equal(blob.includes("data:image"), false);
    // The markers that carry payload carry NUMBERS.
    assert.match(blob, /"httpStatus":200/);
    assert.match(blob, /"byteCount":\d+/);
    assert.match(blob, /"widthPx":\d+/);
  });

  it("tolerates a missing content-length without changing the emitted boundary sequence", async () => {
    const withHeader = await runBoundedDownload(true);
    const withoutHeader = await runBoundedDownload(false);

    assert.deepEqual(stagesFrom(withoutHeader.lines), stagesFrom(withHeader.lines));
    assert.match(withHeader.lines.join("\n"), /"declaredContentLengthBytes":\d+/);
    assert.match(withoutHeader.lines.join("\n"), /"declaredContentLengthBytes":null/);
  });

  it("does not change provider behavior: same result, same fetches, no submission", async () => {
    const first = await runBoundedDownload();
    const second = await runBoundedDownload();

    // Identical outcome across runs — the instrumentation is not stateful.
    assert.equal(first.result.status, "downloaded");
    assert.equal(second.result.status, "downloaded");
    if (first.result.status !== "downloaded" || second.result.status !== "downloaded") {
      throw new Error("unreachable");
    }
    assert.equal(first.result.providerRequestId, PROCESS_ID);
    assert.equal(first.result.widthPx, first.geometry.widthPx);
    assert.equal(first.result.heightPx, first.geometry.heightPx);
    assert.equal(Buffer.compare(first.result.bytes, second.result.bytes), 0);
    assert.deepEqual(first.result, second.result);

    // Exactly the two fetches this path has always made — metadata, then
    // the signed result. No extra network call was introduced, and the
    // paid-submission endpoint was never touched (`onProviderRequestSubmitted`
    // throws if called).
    assert.equal(first.calls.length, 2);
    assert.ok(first.calls[0]!.includes("/download/"));
    assert.equal(first.calls[1], SIGNED_RESULT_URL);
    assert.equal(
      first.calls.some((url) => url.endsWith("/tool/async")),
      false,
      "a resume-download run must never reach the paid submit endpoint",
    );
  });

  it("leaves error handling untouched: a malformed result still throws the same ProviderError", async () => {
    const sourceBytes = sourcePng(200, 150);
    const { impl } = buildFetchFake(Buffer.from("not a png at all"), true);
    const provider = new TopazTransparencyUpscaleProvider({
      apiKey: API_KEY,
      fetchImpl: impl,
      sleepImpl: () => Promise.resolve(),
      pollIntervalMs: 1,
    });

    const { lines } = await captureConsoleInfo(async () => {
      await assert.rejects(
        () => provider.produceBounded(buildResumeInput(sourceBytes)),
        /not a valid PNG image/,
      );
    });

    // The boundary markers still bracket the work up to the failing step,
    // and stop there — which is exactly the diagnostic signal this exists
    // to provide.
    const stages = stagesFrom(lines);
    assert.ok(stages.includes("download_result_body_buffering_completed"));
    // The magic-byte check inside `download()` rejects this before the
    // header inspector is ever reached, so the trail stops exactly there.
    assert.equal(stages.includes("result_header_inspect_started"), false);
    assert.equal(stages.includes("result_png_decode_started"), false);
  });
});
