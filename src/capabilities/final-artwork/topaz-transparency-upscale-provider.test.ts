import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PNG } from "pngjs";

import { PRINT_PLACEMENT_SIZING_POLICY } from "@/capabilities/shared/print-placement-dimensions";

import { TopazTransparencyUpscaleProvider } from "./topaz-transparency-upscale-provider";
import type { FinalArtworkProviderInput } from "./provider";

/** A real PNG: opaque colored square centered on a fully transparent canvas. */
function buildFixturePng(size: number): Buffer {
  const png = new PNG({ width: size, height: size });
  const margin = Math.floor(size * 0.1);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const idx = (size * y + x) << 2;
      const inside = x >= margin && x < size - margin && y >= margin && y < size - margin;
      png.data[idx] = 5;
      png.data[idx + 1] = 5;
      png.data[idx + 2] = 5;
      png.data[idx + 3] = inside ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

/**
 * Deliberately the smallest placement (sleeve, 3in at 300 PPI = 900px) rather
 * than full-back — these tests exercise submit/poll/download/error handling,
 * not the production sizing math (covered directly in
 * `production-normalization.test.ts`, and end to end by the worker-level K/L
 * test in `final-artwork-worker-capability.test.ts`). The resulting plate is
 * still distinct from both the 1024px source and the 4096px reconstruction,
 * which is all Goal 4/5's "three distinct measurements" needs here, and it
 * keeps this file's `pngjs` resample cost low.
 */
function baseInput(overrides: Partial<FinalArtworkProviderInput> = {}): FinalArtworkProviderInput {
  return {
    sourceBytes: buildFixturePng(1024),
    sourceContentType: "image/png",
    sizing: PRINT_PLACEMENT_SIZING_POLICY.sleeve,
    existingProviderRequest: null,
    onProviderRequestSubmitted: async () => {},
    ...overrides,
  };
}

function noSleep(): Promise<void> {
  return Promise.resolve();
}

interface FakeFetchOptions {
  submitStatus?: number;
  submitBody?: unknown;
  /** Sequence of status-poll responses; the last one repeats once exhausted. */
  statusSequence?: string[];
  statusHttpStatus?: number;
  downloadMetaStatus?: number;
  downloadMetaBody?: unknown;
  downloadBytes?: Buffer;
  downloadContentType?: string;
}

function buildFakeFetch(options: FakeFetchOptions = {}) {
  const calls: { url: string; method: string }[] = [];
  let statusCallIndex = 0;
  const statusSequence = options.statusSequence ?? ["Completed"];

  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    calls.push({ url, method });

    if (url.endsWith("/tool/async")) {
      const status = options.submitStatus ?? 200;
      const body = options.submitBody ?? { process_id: "fake-process-id" };
      return jsonResponse(status, body);
    }
    if (url.includes("/status/")) {
      const status = options.statusHttpStatus ?? 200;
      const idx = Math.min(statusCallIndex, statusSequence.length - 1);
      statusCallIndex += 1;
      return jsonResponse(status, { status: statusSequence[idx] });
    }
    if (url.includes("/download/")) {
      const status = options.downloadMetaStatus ?? 200;
      const body = options.downloadMetaBody ?? { url: "https://cdn.example.com/output.png" };
      return jsonResponse(status, body);
    }
    if (url === "https://cdn.example.com/output.png") {
      const bytes = options.downloadBytes ?? buildFixturePng(4096);
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { "content-type": options.downloadContentType ?? "image/png" },
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;

  return { fetchImpl: impl, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("TopazTransparencyUpscaleProvider (Sprint 2M Phase 2E)", () => {
  // --- C: successful submit → poll → download ------------------------------
  it("C: submits, polls to Completed, downloads, and returns genuine reconstructed provenance", async () => {
    const { fetchImpl, calls } = buildFakeFetch({
      statusSequence: ["Processing", "Processing", "Completed"],
    });
    const provider = new TopazTransparencyUpscaleProvider({
      apiKey: "test-key",
      fetchImpl,
      sleepImpl: noSleep,
      pollIntervalMs: 1,
    });

    const output = await provider.produce(baseInput());

    assert.equal(output.resolutionProvenance, "reconstructed");
    assert.equal(output.nativeWidthPx, 1024);
    assert.equal(output.nativeHeightPx, 1024);
    assert.equal(output.reconstructedWidthPx, 4096);
    assert.equal(output.reconstructedHeightPx, 4096);
    // L: the normalized production plate is a THIRD, distinct measurement —
    // never collapsed into source or reconstructed dimensions.
    assert.equal(output.widthPx, 900, "3in sleeve at 300 PPI");
    assert.equal(output.heightPx, 900);
    // Print-Ready Normalization Phase 1: the plate is normalized from the
    // RECONSTRUCTED raster, and reports its own measured geometry.
    assert.equal(output.normalization.sourceWidthPx, 4096);
    assert.equal(output.normalization.intendedWidthIn, 3);
    assert.equal(output.normalization.targetPpi, 300);
    assert.ok(output.normalization.artworkOccupancy > 0.9);
    assert.equal(output.preservesApprovedContent, false);
    assert.equal(output.providerRequestId, "fake-process-id");

    const submitCalls = calls.filter((c) => c.url.endsWith("/tool/async"));
    assert.equal(submitCalls.length, 1, "exactly one paid submission");
  });

  // --- D: auth failure -------------------------------------------------------
  it("D: HTTP 401 on submission classifies as a non-retryable auth failure, never exposes the key", async () => {
    const { fetchImpl } = buildFakeFetch({ submitStatus: 401, submitBody: { error: "unauthorized" } });
    const provider = new TopazTransparencyUpscaleProvider({
      apiKey: "super-secret-value",
      fetchImpl,
      sleepImpl: noSleep,
    });

    await assert.rejects(
      () => provider.produce(baseInput()),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /super-secret-value/);
        return true;
      },
    );
  });

  // --- E: insufficient credits ------------------------------------------------
  it("E: HTTP 412 classifies as insufficient credits, fails closed", async () => {
    const { fetchImpl } = buildFakeFetch({ submitStatus: 412 });
    const provider = new TopazTransparencyUpscaleProvider({
      apiKey: "test-key",
      fetchImpl,
      sleepImpl: noSleep,
    });

    await assert.rejects(() => provider.produce(baseInput()), /cannot afford/i);
  });

  // --- F: polling timeout ------------------------------------------------------
  it("F: bounded polling times out rather than waiting forever", async () => {
    const { fetchImpl } = buildFakeFetch({ statusSequence: ["Processing"] });
    const provider = new TopazTransparencyUpscaleProvider({
      apiKey: "test-key",
      fetchImpl,
      sleepImpl: noSleep,
      pollIntervalMs: 1,
      pollTimeoutMs: 5,
    });

    await assert.rejects(() => provider.produce(baseInput()), /did not complete within/i);
  });

  // --- G: provider failed state ------------------------------------------------
  it("G: a provider-reported Failed status is a distinct, non-retryable classification", async () => {
    const { fetchImpl } = buildFakeFetch({ statusSequence: ["Processing", "Failed"] });
    const provider = new TopazTransparencyUpscaleProvider({
      apiKey: "test-key",
      fetchImpl,
      sleepImpl: noSleep,
      pollIntervalMs: 1,
    });

    await assert.rejects(() => provider.produce(baseInput()), /reported this request as "Failed"/);
  });

  // --- H: malformed provider response ------------------------------------------
  it("H: a submission response with no process_id is a malformed-response failure", async () => {
    const { fetchImpl } = buildFakeFetch({ submitBody: { unexpected: true } });
    const provider = new TopazTransparencyUpscaleProvider({
      apiKey: "test-key",
      fetchImpl,
      sleepImpl: noSleep,
    });

    await assert.rejects(() => provider.produce(baseInput()), /did not include a request id/i);
  });

  // --- I: invalid downloaded PNG ------------------------------------------------
  it("I: bytes that don't decode as a PNG fail with a malformed-response classification", async () => {
    const { fetchImpl } = buildFakeFetch({ downloadBytes: Buffer.from("not a png") });
    const provider = new TopazTransparencyUpscaleProvider({
      apiKey: "test-key",
      fetchImpl,
      sleepImpl: noSleep,
      pollIntervalMs: 1,
    });

    await assert.rejects(() => provider.produce(baseInput()), /could not be decoded as a PNG/i);
  });

  // --- J: unexpected reconstruction dimensions -----------------------------
  it("J: reconstructed dimensions that don't match the request fail validation rather than being silently accepted", async () => {
    const { fetchImpl } = buildFakeFetch({ downloadBytes: buildFixturePng(2048) });
    const provider = new TopazTransparencyUpscaleProvider({
      apiKey: "test-key",
      fetchImpl,
      sleepImpl: noSleep,
      pollIntervalMs: 1,
    });

    await assert.rejects(() => provider.produce(baseInput()), /unexpected dimensions/i);
  });

  // --- N: idempotent resume — never a second paid submission ------------------
  it("N/U: resuming an existing provider request never submits a second paid request", async () => {
    const { fetchImpl, calls } = buildFakeFetch({ statusSequence: ["Completed"] });
    const provider = new TopazTransparencyUpscaleProvider({
      apiKey: "test-key",
      fetchImpl,
      sleepImpl: noSleep,
      pollIntervalMs: 1,
    });

    const onProviderRequestSubmitted = async () => {
      throw new Error("must not be called when resuming an existing request");
    };

    const output = await provider.produce(
      baseInput({
        existingProviderRequest: {
          providerKey: "topaz_transparency_upscale",
          providerRequestId: "already-submitted-id",
          providerStatus: "submitted",
        },
        onProviderRequestSubmitted,
      }),
    );

    assert.equal(output.providerRequestId, "already-submitted-id");
    const submitCalls = calls.filter((c) => c.url.endsWith("/tool/async"));
    assert.equal(submitCalls.length, 0, "resuming must never re-submit");
  });

  it("a prior request from a DIFFERENT provider is never resumed — a fresh submission happens instead", async () => {
    const { fetchImpl, calls } = buildFakeFetch({ statusSequence: ["Completed"] });
    const provider = new TopazTransparencyUpscaleProvider({
      apiKey: "test-key",
      fetchImpl,
      sleepImpl: noSleep,
      pollIntervalMs: 1,
    });

    const output = await provider.produce(
      baseInput({
        existingProviderRequest: {
          providerKey: "some_other_provider",
          providerRequestId: "unrelated-id",
          providerStatus: "submitted",
        },
      }),
    );

    assert.notEqual(output.providerRequestId, "unrelated-id");
    const submitCalls = calls.filter((c) => c.url.endsWith("/tool/async"));
    assert.equal(submitCalls.length, 1);
  });

  it("rejects a non-PNG source content type", async () => {
    const provider = new TopazTransparencyUpscaleProvider({ apiKey: "test-key" });
    await assert.rejects(
      () => provider.produce(baseInput({ sourceContentType: "image/jpeg" })),
      /only supports image\/png/i,
    );
  });

  it("sends the API key only via the X-API-Key header, never as a form field or query param", async () => {
    const seenHeaders: (string | null)[] = [];
    const { fetchImpl } = buildFakeFetch({ statusSequence: ["Completed"] });
    const wrappedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seenHeaders.push(headers.get("X-API-Key"));
      const url = typeof input === "string" ? input : input.toString();
      assert.doesNotMatch(url, /super-secret-value/);
      return fetchImpl(input, init);
    }) as typeof fetch;
    const provider = new TopazTransparencyUpscaleProvider({
      apiKey: "super-secret-value",
      fetchImpl: wrappedFetch,
      sleepImpl: noSleep,
      pollIntervalMs: 1,
    });
    await provider.produce(baseInput());
    assert.ok(seenHeaders.every((h) => h === "super-secret-value" || h === null));
    assert.ok(seenHeaders.some((h) => h === "super-secret-value"));
  });
});
