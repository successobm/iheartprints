import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PNG } from "pngjs";

import { PRINT_PLACEMENT_SIZING_POLICY } from "@/capabilities/shared/print-placement-dimensions";

import {
  resolveReconstructionRequest,
  validateReconstructedGeometry,
  planStandardRasterReconstruction,
  resolveMaximalSinglePassRequest,
  MAX_TWO_PASS_RECONSTRUCTION_SCALE,
  TopazTransparencyUpscaleProvider,
} from "./topaz-transparency-upscale-provider";
import type { FinalArtworkProviderInput, FinalArtworkProviderIntermediateReconstruction } from "./provider";
import type { ProductionSizingRequest } from "./production-normalization";

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
 * Phase 28R: a RECTANGULAR fixture, for the tests that exercise aspect-ratio
 * geometry — `buildFixturePng`'s square shape can never distinguish "wrong
 * aspect ratio" from "wrong size" (a square stays square under any uniform
 * or per-axis scale up to rounding). Same opaque-content-with-margin shape,
 * a different canvas per axis. Mirrors the real portrait car-show source
 * (1024x1536, see Phase 28Q/28R) proportionally.
 */
function buildRectFixturePng(width: number, height: number): Buffer {
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

/**
 * Phase 28V — like `buildRectFixturePng`, but with a caller-chosen margin
 * fraction, so a test can shrink the VISIBLE alpha bbox relative to the
 * canvas without changing the canvas's own dimensions. Used only to prove
 * test M (a second reconstruction pass whose OWN visible content shrank
 * relative to its canvas can still, correctly, be found insufficient) —
 * `validateReconstructedGeometry` only ever checks canvas dimensions, never
 * how much of the canvas is visible content, so this is the one lever that
 * can exercise that path without an implausibly large fixture.
 */
function buildMarginedRectFixturePng(width: number, height: number, marginFraction: number): Buffer {
  const png = new PNG({ width, height });
  const marginX = Math.floor(width * marginFraction);
  const marginY = Math.floor(height * marginFraction);
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

/**
 * Deliberately the smallest placement (sleeve, 3in at 300 PPI = 900px) rather
 * than full-back — these tests exercise submit/poll/download/error handling,
 * not the production sizing math (covered directly in
 * `production-normalization.test.ts`, and end to end by the worker-level K/L
 * test in `final-artwork-worker-capability.test.ts`). The resulting plate is
 * still distinct from both the 1024px source and the reconstruction size the
 * resolver derives, which is all Goal 4/5's "three distinct measurements"
 * needs here, and it keeps this file's `pngjs` resample cost low.
 *
 * Print'em All Phase 0: that reconstruction size is now DERIVED (see
 * `expectedRequest`), so this fixture also demonstrates the down-side of the
 * change — sleeve needs ~1.12x, and the old constant would have bought 4x.
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

/**
 * Print'em All Phase 0: the reconstruction size is no longer a constant, so
 * these tests no longer hard-code one. They ask the SAME resolver the adapter
 * uses what this fixture and this placement require, which is what keeps the
 * fake provider's response consistent with the real request — and stops a
 * magic number from re-entering the suite through the back door.
 */
function expectedRequest(
  sourceSize = 1024,
  sizing: ProductionSizingRequest = PRINT_PLACEMENT_SIZING_POLICY.sleeve,
) {
  const png = PNG.sync.read(buildFixturePng(sourceSize));
  const outcome = resolveReconstructionRequest(
    { width: png.width, height: png.height, data: png.data },
    sizing,
  );
  if (outcome.status !== "resolved") {
    throw new Error(`fixture is not reconstructible: ${outcome.status}`);
  }
  return outcome.request;
}

/** Phase 28R: the rectangular-fixture counterpart to `expectedRequest`. */
function expectedRectRequest(
  sourceWidth: number,
  sourceHeight: number,
  sizing: ProductionSizingRequest,
) {
  const png = PNG.sync.read(buildRectFixturePng(sourceWidth, sourceHeight));
  const outcome = resolveReconstructionRequest(
    { width: png.width, height: png.height, data: png.data },
    sizing,
  );
  if (outcome.status !== "resolved") {
    throw new Error(`fixture is not reconstructible: ${outcome.status}`);
  }
  return outcome.request;
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
      const bytes = options.downloadBytes ?? buildFixturePng(expectedRequest().widthPx);
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

/**
 * Phase 28V — `buildFakeFetch` models exactly ONE submit/poll/download
 * cycle (a single fixed `process_id`, a single download URL). A two-pass
 * reconstruction needs to model TWO independent cycles with their own
 * process ids and their own downloaded bytes. Each new `/tool/async`
 * submission consumes the next `PassFakeSpec` in order; polling/downloading
 * is routed by the process id embedded in the URL, so resuming an
 * out-of-order request (Section 8's idempotency tests) works exactly like
 * the real API.
 */
interface PassFakeSpec {
  processId: string;
  statusSequence?: string[];
  downloadBytes: Buffer;
}

/**
 * `specs` describes every process id this test may poll/download, keyed by
 * id. `submissionOrder` (defaults to every spec, in order) describes only
 * the FRESH `/tool/async` submissions this run is expected to make — an
 * idempotency test resuming an existing request passes a `submissionOrder`
 * that omits it, proving no `/tool/async` call happens for it while still
 * letting polling/downloading that same id work exactly like the real API.
 */
function buildTwoPassFakeFetch(specs: PassFakeSpec[], submissionOrder: string[] = specs.map((s) => s.processId)) {
  const calls: { url: string; method: string }[] = [];
  let submitIndex = 0;
  const statusCallIndexByProcessId = new Map<string, number>();

  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    calls.push({ url, method });

    if (url.endsWith("/tool/async")) {
      const processId = submissionOrder[submitIndex];
      submitIndex += 1;
      if (!processId) throw new Error("unexpected extra submission — test expected fewer paid calls");
      return jsonResponse(200, { process_id: processId });
    }
    if (url.includes("/status/")) {
      const processId = url.split("/status/")[1]!;
      const spec = specs.find((p) => p.processId === processId);
      if (!spec) throw new Error(`unexpected status poll for unknown process id ${processId}`);
      const sequence = spec.statusSequence ?? ["Completed"];
      const seen = statusCallIndexByProcessId.get(processId) ?? 0;
      statusCallIndexByProcessId.set(processId, seen + 1);
      return jsonResponse(200, { status: sequence[Math.min(seen, sequence.length - 1)] });
    }
    if (url.includes("/download/")) {
      const processId = url.split("/download/")[1]!;
      const spec = specs.find((p) => p.processId === processId);
      if (!spec) throw new Error(`unexpected download for unknown process id ${processId}`);
      return jsonResponse(200, { url: `https://cdn.example.com/${processId}.png` });
    }
    const match = specs.find((p) => url === `https://cdn.example.com/${p.processId}.png`);
    if (match) {
      return new Response(new Uint8Array(match.downloadBytes), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;

  return { fetchImpl: impl, calls };
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
    // Phase 0: sized from the production requirement, not a constant. For this
    // square 1024px fixture at sleeve (a 900px plate) that resolves to ~1.12x
    // — direct proof the adapter no longer over-requests a fixed 4x when
    // production needs far less than that.
    assert.equal(output.reconstructedWidthPx, expectedRequest().widthPx);
    assert.equal(output.reconstructedHeightPx, expectedRequest().heightPx);
    assert.ok(
      expectedRequest().widthPx < 4096,
      "the removed fixed 4x would have requested 4096px for a 900px plate",
    );
    // L: the normalized production plate is a THIRD, distinct measurement —
    // never collapsed into source or reconstructed dimensions.
    assert.equal(output.widthPx, 900, "3in sleeve at 300 PPI");
    assert.equal(output.heightPx, 900);
    // Print-Ready Normalization Phase 1: the plate is normalized from the
    // RECONSTRUCTED raster, and reports its own measured geometry.
    assert.equal(output.normalization.sourceWidthPx, expectedRequest().widthPx);
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

  // --- Phase 28R: sufficiency + geometry replaces exact-equality ----------
  //
  // Phase 28Q proved the real `01a049d2-90ea-7cfa-88b4-ad1067497820` Topaz
  // request (source 1024x1536, requested 2192x3288) returned a valid,
  // structurally sound 4096x6144 reconstruction — exactly 4.000x of the
  // SOURCE canvas, MORE than production needed, and the OLD exact-equality
  // check discarded it as `malformed_response`. These tests prove the
  // replacement contract directly against `validateReconstructedGeometry`
  // (fast, exact-number tests — matrix items A/C/D/E/F) and then end to end
  // through the real `produce()` pipeline (item B, the actual regression
  // case, plus H/I for what happens downstream of acceptance). Item G
  // (malformed/undecodable provider output) is unchanged, pre-existing
  // behavior — see "I: bytes that don't decode as a PNG..." above; this
  // phase does not touch that path.
  describe("Phase 28R — validateReconstructedGeometry (pure)", () => {
    // Mirrors the real car-show request: source 1024x1536, requested
    // 2192x3288 (see Phase 28Q's independent recomputation of that exact
    // pair from the real prepared asset).
    const base = { sourceWidthPx: 1024, sourceHeightPx: 1536, targetWidthPx: 2192, targetHeightPx: 3288 };

    it("A: exact requested dimensions are accepted", () => {
      const result = validateReconstructedGeometry({ ...base, actualWidthPx: 2192, actualHeightPx: 3288 });
      assert.equal(result.valid, true);
    });

    it("B (pure): a proportionally oversized response — the exact real regression case — is accepted", () => {
      // 4096x6144 = 1024x1536 x4 exactly — the real Topaz response.
      const result = validateReconstructedGeometry({ ...base, actualWidthPx: 4096, actualHeightPx: 6144 });
      assert.equal(result.valid, true);
    });

    it("C: undersized width alone is rejected", () => {
      const result = validateReconstructedGeometry({ ...base, actualWidthPx: 2000, actualHeightPx: 4000 });
      assert.equal(result.valid, false);
      if (!result.valid) assert.match(result.reason, /insufficient dimensions/i);
    });

    it("D: undersized height alone is rejected", () => {
      const result = validateReconstructedGeometry({ ...base, actualWidthPx: 3000, actualHeightPx: 3000 });
      assert.equal(result.valid, false);
      if (!result.valid) assert.match(result.reason, /insufficient dimensions/i);
    });

    it("E: both axes undersized is rejected", () => {
      const result = validateReconstructedGeometry({ ...base, actualWidthPx: 1500, actualHeightPx: 2000 });
      assert.equal(result.valid, false);
      if (!result.valid) assert.match(result.reason, /insufficient dimensions/i);
    });

    it("F: large on both axes but the wrong aspect ratio (distorted/wrong-cropped) is rejected", () => {
      // Exceeds BOTH requested axes (5000 > 2192, 3300 > 3288) but its aspect
      // ratio (1.515) is nothing like the source's (1024/1536 = 0.667) — a
      // naive ">= only" check would wrongly accept this.
      const result = validateReconstructedGeometry({ ...base, actualWidthPx: 5000, actualHeightPx: 3300 });
      assert.equal(result.valid, false);
      if (!result.valid) assert.match(result.reason, /proportions do not match/i);
    });

    it("exact match at the tolerance boundary is still accepted (rounding safety)", () => {
      // 1% over target width, aspect held constant -- within RECONSTRUCTION_ASPECT_TOLERANCE.
      const result = validateReconstructedGeometry({
        ...base,
        actualWidthPx: 2192,
        actualHeightPx: Math.round(2192 / (1024 / 1536)),
      });
      assert.equal(result.valid, true);
    });
  });

  describe("Phase 28R — end to end through produce()", () => {
    function baseRectInput(overrides: Partial<FinalArtworkProviderInput> = {}): FinalArtworkProviderInput {
      return {
        sourceBytes: buildRectFixturePng(1024, 1536),
        sourceContentType: "image/png",
        sizing: { ...PRINT_PLACEMENT_SIZING_POLICY.full_front, targetWidthIn: 10.5, maxHeightIn: 10.5 },
        existingProviderRequest: null,
        onProviderRequestSubmitted: async () => {},
        ...overrides,
      };
    }

    it("B: the real regression case — a proportionally oversized Topaz response is accepted and produces real output", async () => {
      // The request this sizing/source pair actually resolves to. Note this
      // fixture's synthetic 10% content margin means its own alpha bbox
      // (and therefore its own required scale) differs from the REAL
      // 1011x1525-bbox car-show asset's — the exact real request Phase 28Q
      // recomputed (2192x3288) is proven directly against
      // `validateReconstructedGeometry` above ("A"/"B (pure)"), using the
      // real numbers. What THIS test proves is the real shape of the bug
      // end to end: whatever this fixture legitimately requires, the real
      // observed Topaz behavior — returning exactly 4x of the SOURCE
      // CANVAS, not the requested size — must still be accepted here.
      const request = expectedRectRequest(1024, 1536, {
        ...PRINT_PLACEMENT_SIZING_POLICY.full_front,
        targetWidthIn: 10.5,
        maxHeightIn: 10.5,
      });
      assert.ok(request.scale < 4, "fixture must need less than the 4x this test relies on Topaz over-delivering");

      const { fetchImpl } = buildFakeFetch({ downloadBytes: buildRectFixturePng(4096, 6144) });
      const provider = new TopazTransparencyUpscaleProvider({
        apiKey: "test-key",
        fetchImpl,
        sleepImpl: noSleep,
        pollIntervalMs: 1,
      });

      const output = await provider.produce(baseRectInput());
      assert.equal(output.reconstructedWidthPx, 4096);
      assert.equal(output.reconstructedHeightPx, 6144);
    });

    it("H: transparency survives normalization for the accepted oversized result", async () => {
      const { fetchImpl } = buildFakeFetch({ downloadBytes: buildRectFixturePng(4096, 6144) });
      const provider = new TopazTransparencyUpscaleProvider({
        apiKey: "test-key",
        fetchImpl,
        sleepImpl: noSleep,
        pollIntervalMs: 1,
      });

      const output = await provider.produce(baseRectInput());
      assert.equal(output.hasTransparency, true);
    });

    it("I: the accepted oversized result is downsampled to the EXACT confirmed production target, not left at the raw provider size", async () => {
      const { fetchImpl } = buildFakeFetch({ downloadBytes: buildRectFixturePng(4096, 6144) });
      const provider = new TopazTransparencyUpscaleProvider({
        apiKey: "test-key",
        fetchImpl,
        sleepImpl: noSleep,
        pollIntervalMs: 1,
      });

      const output = await provider.produce(baseRectInput());
      // The final deliverable must be the production plate's own size — a
      // 300 PPI interpretation of the confirmed 10.5x10.5in box, height-bound
      // for this portrait source — never the raw 4096x6144 reconstruction.
      assert.notEqual(output.widthPx, 4096);
      assert.notEqual(output.heightPx, 6144);
      // Height-bound at 10.5in @ 300 PPI = 3150px exactly.
      assert.equal(output.heightPx, 3150);
      assert.ok(output.widthPx < output.heightPx, "portrait source must stay portrait");
    });
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

/**
 * Phase 28V — controlled two-pass Topaz reconstruction for a Standard
 * Raster request whose total need exceeds `PROVIDER_MAX_RECONSTRUCTION_SCALE`
 * (4x) but not `MAX_TWO_PASS_RECONSTRUCTION_SCALE` (8x). The real, evidenced
 * case this exists for: a 562x486 visible source needing 3150x2736px
 * (≈5.63x) — see the Phase 28V report's real INCREDI-BOWLS acceptance.
 */
describe("Phase 28V — two-pass reconstruction", () => {
  /** Mirrors the real INCREDI-BOWLS confirmed size (10.5x9.12in @ 300 PPI). */
  const REAL_LIKE_SIZING: ProductionSizingRequest = {
    ...PRINT_PLACEMENT_SIZING_POLICY.full_back,
    targetWidthIn: 10.5,
    maxHeightIn: 9.12,
    targetPpi: 300,
    minWidthIn: 4,
    maxWidthIn: 14,
  };

  describe("planStandardRasterReconstruction (pure)", () => {
    it("A: a <=4x need routes to single_pass — unchanged Phase 28R territory", () => {
      const png = PNG.sync.read(buildFixturePng(1024));
      const plan = planStandardRasterReconstruction(
        { width: png.width, height: png.height, data: png.data },
        PRINT_PLACEMENT_SIZING_POLICY.sleeve,
      );
      assert.deepEqual(plan, { kind: "single_pass" });
    });

    it("B: a real-like ~5.63x need routes to two_pass, pass 1 asking for the provider's proven 4x ceiling", () => {
      const png = PNG.sync.read(buildRectFixturePng(562, 486));
      const plan = planStandardRasterReconstruction(
        { width: png.width, height: png.height, data: png.data },
        REAL_LIKE_SIZING,
      );
      assert.equal(plan.kind, "two_pass");
      if (plan.kind === "two_pass") {
        assert.equal(plan.pass1.scale, 4);
        assert.equal(plan.pass1.widthPx, 2248);
        assert.equal(plan.pass1.heightPx, 1944);
      }
    });

    it("Q: a need beyond the two-pass ceiling is refused pre-dispatch, honestly, at zero cost", () => {
      // Same canvas as the real case, but a much smaller VISIBLE region
      // relative to it — pushes required total scale past 8x.
      const png = PNG.sync.read(buildMarginedRectFixturePng(562, 486, 0.35));
      const plan = planStandardRasterReconstruction(
        { width: png.width, height: png.height, data: png.data },
        REAL_LIKE_SIZING,
      );
      assert.equal(plan.kind, "insufficient");
      if (plan.kind === "insufficient") {
        assert.match(plan.reason, new RegExp(`${MAX_TWO_PASS_RECONSTRUCTION_SCALE}x maximum`));
      }
    });

    it("no visible artwork is reported as such, never mistaken for a scale problem", () => {
      const png = new PNG({ width: 200, height: 200 }); // fully transparent
      const plan = planStandardRasterReconstruction(
        { width: png.width, height: png.height, data: png.data },
        REAL_LIKE_SIZING,
      );
      assert.equal(plan.kind, "no_visible_artwork");
    });
  });

  describe("resolveMaximalSinglePassRequest (pure)", () => {
    it("requests exactly the provider's proven 4x ceiling for an ordinary source", () => {
      assert.deepEqual(resolveMaximalSinglePassRequest({ width: 562, height: 486 }), {
        widthPx: 2248,
        heightPx: 1944,
        scale: 4,
      });
    });

    it("never requests below MIN_RECONSTRUCTION_DIM_PX even for a tiny source", () => {
      const req = resolveMaximalSinglePassRequest({ width: 40, height: 40 });
      assert.ok(req.widthPx >= 256 && req.heightPx >= 256);
    });

    it("never requests above MAX_RECONSTRUCTION_DIM_PX even for a huge source", () => {
      const req = resolveMaximalSinglePassRequest({ width: 3000, height: 3000 });
      assert.ok(req.widthPx <= 8192 && req.heightPx <= 8192);
    });
  });

  describe("produce() — end to end", () => {
    function realLikeInput(overrides: Partial<FinalArtworkProviderInput> = {}): FinalArtworkProviderInput {
      return {
        sourceBytes: buildRectFixturePng(562, 486),
        sourceContentType: "image/png",
        sizing: REAL_LIKE_SIZING,
        existingProviderRequest: null,
        onProviderRequestSubmitted: async () => {},
        ...overrides,
      };
    }

    it("B: a real-like >4x request completes via exactly two Topaz submissions, normalized to the exact target", async () => {
      const { fetchImpl, calls } = buildTwoPassFakeFetch([
        { processId: "pass1-id", downloadBytes: buildRectFixturePng(2248, 1944) },
        { processId: "pass2-id", downloadBytes: buildRectFixturePng(4019, 3475) },
      ]);
      const provider = new TopazTransparencyUpscaleProvider({
        apiKey: "test-key",
        fetchImpl,
        sleepImpl: noSleep,
        pollIntervalMs: 1,
      });

      const captured: { intermediate: FinalArtworkProviderIntermediateReconstruction | null } = {
        intermediate: null,
      };
      const output = await provider.produce(
        realLikeInput({
          onIntermediateReconstructionProduced: async (result) => {
            captured.intermediate = result;
          },
        }),
      );

      const submitCalls = calls.filter((c) => c.url.endsWith("/tool/async"));
      assert.equal(submitCalls.length, 2, "exactly two paid submissions — Section 14/N");

      assert.ok(captured.intermediate, "pass 1 must be durably persisted before pass 2 is submitted");
      assert.equal(captured.intermediate.providerRequestId, "pass1-id");
      assert.equal(captured.intermediate.widthPx, 2248);
      assert.equal(captured.intermediate.heightPx, 1944);

      // The FINAL deliverable's own provider request id is pass 2's — the
      // pass that actually produced the reconstructed bytes used.
      assert.equal(output.providerRequestId, "pass2-id");
      assert.equal(output.reconstructedWidthPx, 4019);
      assert.equal(output.reconstructedHeightPx, 3475);
      // I: normalized to the exact canonical target, never left at either
      // raw provider size.
      assert.equal(output.widthPx, 3150);
      assert.ok(Math.abs(output.heightPx - 2727) <= 2);
      assert.equal(output.resolutionProvenance, "reconstructed");
      assert.equal(output.nativeWidthPx, 562);
      assert.equal(output.nativeHeightPx, 486);
    });

    it("G/H: transparency survives both passes and the final normalization", async () => {
      const { fetchImpl } = buildTwoPassFakeFetch([
        { processId: "pass1-id", downloadBytes: buildRectFixturePng(2248, 1944) },
        { processId: "pass2-id", downloadBytes: buildRectFixturePng(4019, 3475) },
      ]);
      const provider = new TopazTransparencyUpscaleProvider({
        apiKey: "test-key",
        fetchImpl,
        sleepImpl: noSleep,
        pollIntervalMs: 1,
      });
      const output = await provider.produce(realLikeInput());
      assert.equal(output.hasTransparency, true);
    });

    it("C: pass 1 alone unexpectedly sufficient — stops after one pass and never persists an intermediate", async () => {
      // Proportionally oversized (same aspect ratio as the 562x486 source,
      // so it still passes pass 1's own geometry check) and large enough
      // that its own visible bounds already meet the production target —
      // no second pass would buy anything.
      const { fetchImpl, calls } = buildTwoPassFakeFetch(
        [{ processId: "pass1-only-id", downloadBytes: buildRectFixturePng(4496, 3888) }],
        ["pass1-only-id"],
      );
      const provider = new TopazTransparencyUpscaleProvider({
        apiKey: "test-key",
        fetchImpl,
        sleepImpl: noSleep,
        pollIntervalMs: 1,
      });

      let intermediateCalled = false;
      const output = await provider.produce(
        realLikeInput({
          onIntermediateReconstructionProduced: async () => {
            intermediateCalled = true;
          },
        }),
      );

      const submitCalls = calls.filter((c) => c.url.endsWith("/tool/async"));
      assert.equal(submitCalls.length, 1, "never submit a pass 2 that would buy nothing");
      assert.equal(intermediateCalled, false, "pass 1 IS the final reconstruction stage here — no intermediate to persist");
      assert.equal(output.providerRequestId, "pass1-only-id");
      assert.equal(output.reconstructedWidthPx, 4496);
      assert.equal(output.reconstructedHeightPx, 3888);
    });

    it("D: pass 1's request already exists — resumed, never resubmitted; pass 2 still gets a fresh submission", async () => {
      const { fetchImpl, calls } = buildTwoPassFakeFetch(
        [
          { processId: "pass1-id", downloadBytes: buildRectFixturePng(2248, 1944) },
          { processId: "pass2-id", downloadBytes: buildRectFixturePng(4019, 3475) },
        ],
        ["pass2-id"], // only pass 2 is a fresh submission
      );
      const provider = new TopazTransparencyUpscaleProvider({
        apiKey: "test-key",
        fetchImpl,
        sleepImpl: noSleep,
        pollIntervalMs: 1,
      });

      const submitted: string[] = [];
      const output = await provider.produce(
        realLikeInput({
          existingProviderRequest: {
            providerKey: "topaz_transparency_upscale",
            providerRequestId: "pass1-id",
            providerStatus: "submitted",
          },
          onProviderRequestSubmitted: async (id) => {
            submitted.push(id);
          },
        }),
      );

      const submitCalls = calls.filter((c) => c.url.endsWith("/tool/async"));
      assert.equal(submitCalls.length, 1, "pass 1 resumed, only pass 2 is a real submission");
      assert.deepEqual(submitted, ["pass2-id"], "never notified of a submission for the resumed pass 1");
      assert.equal(output.providerRequestId, "pass2-id");
    });

    it("E: pass 1 complete and durably persisted, pass 2's request already exists — resumed, zero new submissions", async () => {
      const { fetchImpl, calls } = buildTwoPassFakeFetch(
        [{ processId: "pass2-id", downloadBytes: buildRectFixturePng(4019, 3475) }],
        [], // nothing freshly submitted at all
      );
      const provider = new TopazTransparencyUpscaleProvider({
        apiKey: "test-key",
        fetchImpl,
        sleepImpl: noSleep,
        pollIntervalMs: 1,
      });

      const output = await provider.produce(
        realLikeInput({
          existingIntermediateReconstruction: {
            bytes: buildRectFixturePng(2248, 1944),
            widthPx: 2248,
            heightPx: 1944,
            providerRequestId: "pass1-id",
          },
          existingProviderRequest: {
            providerKey: "topaz_transparency_upscale",
            providerRequestId: "pass2-id",
            providerStatus: "submitted",
          },
          onProviderRequestSubmitted: async () => {
            throw new Error("must not submit anything — both passes already exist");
          },
        }),
      );

      const submitCalls = calls.filter((c) => c.url.endsWith("/tool/async"));
      assert.equal(submitCalls.length, 0, "never resubmit pass 1 or pass 2");
      assert.equal(output.providerRequestId, "pass2-id");
    });

    it("J: pass 1 returning the wrong geometry fails safely — no pass 2 submission", async () => {
      const { fetchImpl, calls } = buildTwoPassFakeFetch([
        // Exceeds the requested canvas but with a distorted aspect ratio.
        { processId: "pass1-id", downloadBytes: buildRectFixturePng(3000, 3000) },
      ]);
      const provider = new TopazTransparencyUpscaleProvider({
        apiKey: "test-key",
        fetchImpl,
        sleepImpl: noSleep,
        pollIntervalMs: 1,
      });

      await assert.rejects(() => provider.produce(realLikeInput()), /First reconstruction pass.*proportions do not match/i);
      const submitCalls = calls.filter((c) => c.url.endsWith("/tool/async"));
      assert.equal(submitCalls.length, 1, "only pass 1 was ever attempted");
    });

    it("K: pass 1 undersized/unusable fails safely — no pass 2 submission", async () => {
      const { fetchImpl, calls } = buildTwoPassFakeFetch([
        { processId: "pass1-id", downloadBytes: buildRectFixturePng(1000, 866) }, // below the 2248x1944 requested
      ]);
      const provider = new TopazTransparencyUpscaleProvider({
        apiKey: "test-key",
        fetchImpl,
        sleepImpl: noSleep,
        pollIntervalMs: 1,
      });

      await assert.rejects(() => provider.produce(realLikeInput()), /First reconstruction pass.*insufficient dimensions/i);
      const submitCalls = calls.filter((c) => c.url.endsWith("/tool/async"));
      assert.equal(submitCalls.length, 1);
    });

    it("L: pass 2 returning the wrong geometry fails safely, after both passes were genuinely attempted", async () => {
      const { fetchImpl, calls } = buildTwoPassFakeFetch([
        { processId: "pass1-id", downloadBytes: buildRectFixturePng(2248, 1944) },
        // Exceeds pass 2's requested canvas but with a distorted aspect ratio.
        { processId: "pass2-id", downloadBytes: buildRectFixturePng(5000, 3475) },
      ]);
      const provider = new TopazTransparencyUpscaleProvider({
        apiKey: "test-key",
        fetchImpl,
        sleepImpl: noSleep,
        pollIntervalMs: 1,
      });

      await assert.rejects(() => provider.produce(realLikeInput()), /Second reconstruction pass.*proportions do not match/i);
      const submitCalls = calls.filter((c) => c.url.endsWith("/tool/async"));
      assert.equal(submitCalls.length, 2, "both passes were genuinely attempted — pass 1 succeeded, pass 2's response was invalid");
    });

    it("M: pass 2 still insufficient after a genuine pass 1 — an honest terminal verdict, never a third pass", async () => {
      const { fetchImpl, calls } = buildTwoPassFakeFetch([
        // Correct CANVAS size (passes pass 1's own geometry check) but a much
        // smaller VISIBLE region than a well-behaved reconstruction would
        // carry — `validateReconstructedGeometry` only ever checks canvas
        // size, so this is what a "structurally valid but content-thin"
        // pass 1 response looks like.
        { processId: "pass1-id", downloadBytes: buildMarginedRectFixturePng(2248, 1944, 0.35) },
      ]);
      const provider = new TopazTransparencyUpscaleProvider({
        apiKey: "test-key",
        fetchImpl,
        sleepImpl: noSleep,
        pollIntervalMs: 1,
      });

      await assert.rejects(
        () => provider.produce(realLikeInput()),
        /Even a second reconstruction pass is not enough/i,
      );
      const submitCalls = calls.filter((c) => c.url.endsWith("/tool/async"));
      assert.equal(submitCalls.length, 1, "no third pass — pass 1 ran once, pass 2 was correctly never attempted");
    });
  });
});
