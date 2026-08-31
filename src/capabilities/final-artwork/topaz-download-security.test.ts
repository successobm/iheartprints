import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PNG } from "pngjs";

import { MAX_UPLOAD_BYTES } from "@/capabilities/artwork-preparation/upload-limits";

import {
  MAX_PROVIDER_RESULT_DOWNLOAD_BYTES,
  TopazTransparencyUpscaleProvider,
} from "./topaz-transparency-upscale-provider";

/**
 * S3A security patch: the provider-result DOWNLOAD boundary — the SECOND
 * fetch inside `download()`, to a URL returned in the provider's own JSON
 * response rather than one this process chose. Exercised here via the
 * public `produceSignReconstruction` entry point (Signs Phase S3A) because
 * it is the smallest, most direct call surface onto `download()`: no
 * alpha-trim/`PlacementSizingPolicy` arithmetic sits between the test and
 * the boundary under test. Every scenario below proves behavior shared by
 * BOTH the apparel `produce()` path and the sign path, since both call the
 * SAME private `download()` method.
 *
 * NO REAL NETWORK CALLS — every `fetchImpl` here is a local, synchronous
 * fake. `api.topazlabs.com` itself is never contacted.
 */

const PROCESS_ID = "fake-process-id";
const META_URL_SUBSTRING = "/download/";

function realPngBytes(width = 64, height = 64): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = 5;
    png.data[i * 4 + 1] = 5;
    png.data[i * 4 + 2] = 5;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface DownloadFakeOptions {
  /** The `url`/`download_url` field the `/download/{id}` metadata response carries. */
  resultUrl: string;
  /** Handler for the SECOND fetch — to `resultUrl` itself. Every scenario under test lives here. */
  resultFetch: (init?: RequestInit) => Promise<Response> | Response;
}

function buildDownloadFake(options: DownloadFakeOptions) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    if (url.endsWith("/tool/async")) {
      return jsonResponse(200, { process_id: PROCESS_ID });
    }
    if (url.includes("/status/")) {
      return jsonResponse(200, { status: "Completed" });
    }
    if (url.includes(META_URL_SUBSTRING)) {
      return jsonResponse(200, { url: options.resultUrl });
    }
    if (url === options.resultUrl) {
      return options.resultFetch(init);
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
  return { fetchImpl: impl, calls };
}

function noSleep(): Promise<void> {
  return Promise.resolve();
}

function buildProvider(fetchImpl: typeof fetch, overrides: Partial<ConstructorParameters<typeof TopazTransparencyUpscaleProvider>[0]> = {}) {
  return new TopazTransparencyUpscaleProvider({
    apiKey: "test-key",
    fetchImpl,
    sleepImpl: noSleep,
    pollIntervalMs: 1,
    ...overrides,
  });
}

async function dispatchOnce(provider: TopazTransparencyUpscaleProvider, requestedSize = 128) {
  return provider.produceSignReconstruction({
    sourceBytes: realPngBytes(32, 32),
    sourceContentType: "image/png",
    requestedWidthPx: requestedSize,
    requestedHeightPx: requestedSize,
  });
}

describe("Topaz provider-result download security boundary (Signs Phase S3A)", () => {
  it("0: the customer-upload limit and the provider-result download cap are independent constants", () => {
    // S3B.1: S3A originally coupled these (the provider cap WAS
    // `MAX_UPLOAD_BYTES`) — a real live Ruth acceptance run proved that
    // wrong (a genuine, already-paid-for Topaz result at ~34.6MB was
    // rejected by the 25MB customer-upload cap). This asserts the
    // decoupling: the customer-upload limit is untouched at 25MB, and the
    // provider cap is a materially different, independently-set value.
    assert.equal(MAX_UPLOAD_BYTES, 25 * 1024 * 1024, "customer upload limit remains 25 MB, unchanged");
    assert.equal(MAX_PROVIDER_RESULT_DOWNLOAD_BYTES, 64 * 1024 * 1024, "provider result cap is 64 MiB");
    assert.notEqual(
      MAX_PROVIDER_RESULT_DOWNLOAD_BYTES,
      MAX_UPLOAD_BYTES,
      "the two caps must never be the same value/reference again",
    );
  });

  it("1: an HTTPS admitted provider-result URL is accepted", async () => {
    const { fetchImpl } = buildDownloadFake({
      resultUrl: "https://cdn.example.com/output.png",
      resultFetch: () =>
        new Response(new Uint8Array(realPngBytes()), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    });
    const provider = buildProvider(fetchImpl);
    const output = await dispatchOnce(provider, 64);
    assert.equal(output.widthPx, 64);
    assert.equal(output.heightPx, 64);
  });

  it("2: an http: provider-result URL is rejected before download", async () => {
    let resultFetchCalled = false;
    const { fetchImpl } = buildDownloadFake({
      resultUrl: "http://cdn.example.com/output.png",
      resultFetch: () => {
        resultFetchCalled = true;
        return new Response(new Uint8Array(realPngBytes()), { status: 200 });
      },
    });
    const provider = buildProvider(fetchImpl);
    await assert.rejects(() => dispatchOnce(provider), /disallowed scheme/i);
    assert.equal(resultFetchCalled, false, "the disallowed-scheme URL must never actually be fetched");
  });

  it("3a: a file: provider-result URL is rejected before download", async () => {
    const { fetchImpl } = buildDownloadFake({
      resultUrl: "file:///etc/passwd",
      resultFetch: () => {
        throw new Error("must never be fetched");
      },
    });
    const provider = buildProvider(fetchImpl);
    await assert.rejects(() => dispatchOnce(provider), /disallowed scheme/i);
  });

  it("3b: a data: provider-result URL is rejected before download", async () => {
    const { fetchImpl } = buildDownloadFake({
      resultUrl: `data:image/png;base64,${realPngBytes().toString("base64")}`,
      resultFetch: () => {
        throw new Error("must never be fetched");
      },
    });
    const provider = buildProvider(fetchImpl);
    await assert.rejects(() => dispatchOnce(provider), /disallowed scheme/i);
  });

  it("3c: an ftp: provider-result URL is rejected before download", async () => {
    const { fetchImpl } = buildDownloadFake({
      resultUrl: "ftp://cdn.example.com/output.png",
      resultFetch: () => {
        throw new Error("must never be fetched");
      },
    });
    const provider = buildProvider(fetchImpl);
    await assert.rejects(() => dispatchOnce(provider), /disallowed scheme/i);
  });

  it("4/5: no host allowlist is established — documented scope limitation, not silently untested", async () => {
    // STEP 1 of this patch could not establish a stable, documented, or
    // fixture-proven Topaz result-download HOST from anything in this
    // repository (API docs excerpts, the Phase 2D bake-off report/script,
    // both live-incident write-ups) — `url`/`download_url` is a signed,
    // provider-generated link, and inventing an allowlisted host set would
    // be a guess, not a control (explicitly disallowed by this phase's
    // instructions). This test documents that scope choice: an HTTPS URL
    // on a host with NO relation to "topazlabs" is still accepted, exactly
    // as it was before this patch — only scheme, redirects, size, and
    // content are enforced. A future phase that observes a real result
    // host during S3B live acceptance should add a real allowlist and
    // convert this test into a rejection test for a lookalike/unexpected
    // host.
    const { fetchImpl } = buildDownloadFake({
      resultUrl: "https://totally-unrelated-cdn.example.net/output.png",
      resultFetch: () =>
        new Response(new Uint8Array(realPngBytes()), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    });
    const provider = buildProvider(fetchImpl);
    const output = await dispatchOnce(provider, 64);
    assert.equal(output.widthPx, 64);
  });

  it("6/7: a redirect response is rejected — zero redirects are ever followed", async () => {
    let resultFetchCallCount = 0;
    const { fetchImpl } = buildDownloadFake({
      resultUrl: "https://cdn.example.com/output.png",
      resultFetch: () => {
        resultFetchCallCount += 1;
        return new Response(null, {
          status: 302,
          headers: { location: "https://attacker.example.org/evil.png" },
        });
      },
    });
    const provider = buildProvider(fetchImpl);
    await assert.rejects(() => dispatchOnce(provider), /redirect/i);
    // `redirect: "manual"` means the redirect target is never itself
    // fetched — the fake only ever answers ONE call for the result URL.
    assert.equal(resultFetchCallCount, 1);
  });

  it("8: an oversized response is rejected before being fully buffered", async () => {
    const capBytes = MAX_PROVIDER_RESULT_DOWNLOAD_BYTES;
    let bytesProducedBeforeAbort = 0;
    const { fetchImpl } = buildDownloadFake({
      resultUrl: "https://cdn.example.com/output.png",
      resultFetch: () => {
        const chunkSize = 1024 * 1024;
        const totalChunks = Math.ceil(capBytes / chunkSize) + 4; // deliberately exceeds the cap
        // No Content-Length header — exercises the STREAMING enforcement
        // path (the pre-check in test 8b below is a distinct code path),
        // exactly a chunked/unknown-length response would.
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (bytesProducedBeforeAbort >= totalChunks * chunkSize) {
              controller.close();
              return;
            }
            const chunk = new Uint8Array(chunkSize);
            bytesProducedBeforeAbort += chunk.byteLength;
            controller.enqueue(chunk);
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "image/png" } });
      },
    });
    const provider = buildProvider(fetchImpl, { downloadTimeoutMs: 30_000 });
    await assert.rejects(() => dispatchOnce(provider), /exceeded the .*-byte limit/i);
    // The generator is aborted well before it could ever produce the FULL
    // (cap + 4MB) body — proves the cap is enforced DURING reading, not by
    // buffering everything first and checking the length afterward.
    assert.ok(
      bytesProducedBeforeAbort < capBytes + 4 * 1024 * 1024,
      "reading must stop before the full oversized body is produced",
    );
  });

  it("8b: a declared Content-Length over the provider cap is rejected before the size-capped read begins", async () => {
    // Note: a `ReadableStream`'s `pull` callback fires eagerly to fill its
    // internal queue as soon as the stream is constructed, independent of
    // whether anything ever calls `.getReader().read()` — so "was pull
    // invoked" is not a meaningful signal of whether THIS CODE read the
    // body. What actually matters, and is what this asserts, is that the
    // declared-oversize rejection happens via the Content-Length pre-check
    // path (a distinct code path from the streaming cap in test 8 above),
    // proven by its message.
    const { fetchImpl } = buildDownloadFake({
      resultUrl: "https://cdn.example.com/output.png",
      resultFetch: () => {
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": String(MAX_PROVIDER_RESULT_DOWNLOAD_BYTES + 1),
          },
        });
      },
    });
    const provider = buildProvider(fetchImpl);
    await assert.rejects(() => dispatchOnce(provider), /declared \d+ bytes, exceeding the .*-byte limit/i);
  });

  it("8c: the exact real-world S3B byte count (36,324,544) clears the size gates that wrongly rejected it pre-fix", async () => {
    // The exact failure mode observed in the live S3B Ruth acceptance run:
    // a genuine, successfully-completed Topaz reconstruction reported
    // 36,324,544 bytes, which the pre-S3B.1 coupled cap (== MAX_UPLOAD_BYTES
    // == 25MB) rejected via the Content-Length pre-check before ever
    // reading the body. This proves that EXACT byte count now clears both
    // size gates (Content-Length pre-check and streaming enforcement) —
    // the declared length matches the streamed length, and the stream
    // itself is bounded/synchronous (never actually allocating 34.6MB in
    // this test process), so what's proven is specifically "the size gates
    // let this exact count through", isolated from PNG decode (a stub,
    // non-image body is used deliberately — decode is a separate concern
    // covered by tests 9-12b).
    const realWorldObservedBytes = 36_324_544;
    assert.ok(realWorldObservedBytes > MAX_UPLOAD_BYTES, "sanity: this size WOULD have tripped the old coupled cap");
    assert.ok(
      realWorldObservedBytes < MAX_PROVIDER_RESULT_DOWNLOAD_BYTES,
      "sanity: this size must fit under the new provider cap",
    );
    const { fetchImpl } = buildDownloadFake({
      resultUrl: "https://cdn.example.com/output.png",
      resultFetch: () => {
        let produced = 0;
        const chunkSize = 1024 * 1024;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (produced >= realWorldObservedBytes) {
              controller.close();
              return;
            }
            const size = Math.min(chunkSize, realWorldObservedBytes - produced);
            produced += size;
            controller.enqueue(new Uint8Array(size));
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "image/png", "content-length": String(realWorldObservedBytes) },
        });
      },
    });
    const provider = buildProvider(fetchImpl, { downloadTimeoutMs: 30_000 });
    // Passes the size gates, then correctly fails PNG decode (stub bytes,
    // not a real image) — proving the rejection this test cares about
    // (size) did NOT happen, while a genuinely different, later check did.
    await assert.rejects(() => dispatchOnce(provider), /not a valid PNG image/i);
  });

  it("8d: exactly at the 64 MiB provider cap is admitted; one byte over is rejected", async () => {
    const atCap = MAX_PROVIDER_RESULT_DOWNLOAD_BYTES;
    const overCap = MAX_PROVIDER_RESULT_DOWNLOAD_BYTES + 1;

    async function attemptWithDeclaredLength(declaredLength: number) {
      const { fetchImpl } = buildDownloadFake({
        resultUrl: "https://cdn.example.com/output.png",
        resultFetch: () => {
          const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(1024));
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "content-type": "image/png", "content-length": String(declaredLength) },
          });
        },
      });
      const provider = buildProvider(fetchImpl);
      return dispatchOnce(provider);
    }

    // At-cap must NOT be refused by the Content-Length pre-check (`>`, not
    // `>=`) — it fails later on decode (the stub body is only 1024 bytes,
    // not a real image at that declared length), which proves the
    // pre-check itself let it through rather than rejecting it for size.
    await assert.rejects(() => attemptWithDeclaredLength(atCap), /not a valid PNG image/i);
    // One byte over IS refused by the pre-check specifically.
    await assert.rejects(() => attemptWithDeclaredLength(overCap), /declared \d+ bytes, exceeding the .*-byte limit/i);
  });

  it("9: a valid supported Content-Type with genuine PNG bytes is accepted", async () => {
    const { fetchImpl } = buildDownloadFake({
      resultUrl: "https://cdn.example.com/output.png",
      resultFetch: () =>
        new Response(new Uint8Array(realPngBytes(80, 80)), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    });
    const provider = buildProvider(fetchImpl);
    const output = await dispatchOnce(provider, 80);
    assert.equal(output.widthPx, 80);
  });

  it("10: an unsupported Content-Type is rejected even with genuine PNG bytes", async () => {
    const { fetchImpl } = buildDownloadFake({
      resultUrl: "https://cdn.example.com/output.png",
      resultFetch: () =>
        new Response(new Uint8Array(realPngBytes()), {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    });
    const provider = buildProvider(fetchImpl);
    await assert.rejects(() => dispatchOnce(provider), /unexpected content type/i);
  });

  it("11: a missing Content-Type is permitted ONLY because magic-byte validation still proves a real PNG", async () => {
    const { fetchImpl } = buildDownloadFake({
      resultUrl: "https://cdn.example.com/output.png",
      resultFetch: () => new Response(new Uint8Array(realPngBytes(48, 48)), { status: 200 }),
    });
    const provider = buildProvider(fetchImpl);
    const output = await dispatchOnce(provider, 48);
    assert.equal(output.widthPx, 48, "absent header must not block a genuine, magic-byte-verified PNG");
  });

  it("12: fake image bytes are rejected despite a plausible Content-Type", async () => {
    const { fetchImpl } = buildDownloadFake({
      resultUrl: "https://cdn.example.com/output.png",
      resultFetch: () =>
        new Response(new Uint8Array(Buffer.from("this is definitely not a png")), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    });
    const provider = buildProvider(fetchImpl);
    await assert.rejects(() => dispatchOnce(provider), /not a valid PNG image/i);
  });

  it("12b: a missing Content-Type with fake bytes is still rejected by magic-byte validation", async () => {
    const { fetchImpl } = buildDownloadFake({
      resultUrl: "https://cdn.example.com/output.png",
      resultFetch: () => new Response(new Uint8Array(Buffer.from("no header, still fake")), { status: 200 }),
    });
    const provider = buildProvider(fetchImpl);
    await assert.rejects(() => dispatchOnce(provider), /not a valid PNG image/i);
  });

  it("13: the download timeout remains bounded and distinctly classified", async () => {
    const { fetchImpl } = buildDownloadFake({
      resultUrl: "https://cdn.example.com/output.png",
      resultFetch: (init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    });
    const provider = buildProvider(fetchImpl, { downloadTimeoutMs: 20 });
    await assert.rejects(() => dispatchOnce(provider), /did not finish transferring in time/i);
  });

  it("14: a download-security failure after provider completion never creates a second paid dispatch on retry", async () => {
    let submitCount = 0;
    let firstAttemptShouldFail = true;
    const calls: string[] = [];
    const impl = (async (input: string | URL | Request, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      if (url.endsWith("/tool/async")) {
        submitCount += 1;
        return jsonResponse(200, { process_id: PROCESS_ID });
      }
      if (url.includes("/status/")) {
        return jsonResponse(200, { status: "Completed" });
      }
      if (url.includes("/download/") && url.includes(PROCESS_ID)) {
        return jsonResponse(200, { url: "https://cdn.example.com/output.png" });
      }
      if (url === "https://cdn.example.com/output.png") {
        if (firstAttemptShouldFail) {
          return new Response(new Uint8Array(Buffer.from("garbage, not a png")), {
            status: 200,
            headers: { "content-type": "image/png" },
          });
        }
        return new Response(new Uint8Array(realPngBytes()), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const provider = buildProvider(impl);
    let submittedRequestId: string | null = null;

    await assert.rejects(
      () =>
        provider.produceSignReconstruction({
          sourceBytes: realPngBytes(32, 32),
          sourceContentType: "image/png",
          requestedWidthPx: 64,
          requestedHeightPx: 64,
          onProviderRequestSubmitted: async (id) => {
            submittedRequestId = id;
          },
        }),
      /not a valid PNG image/i,
    );
    assert.equal(submitCount, 1);
    assert.ok(submittedRequestId, "the paid submission must be durably recorded before the download failure");

    // Recovery: resume the SAME provider request (mirrors the worker's own
    // `existingProviderRequest` contract) — never a second `/tool/async` call.
    firstAttemptShouldFail = false;
    const recovered = await provider.produceSignReconstruction({
      sourceBytes: realPngBytes(32, 32),
      sourceContentType: "image/png",
      requestedWidthPx: 64,
      requestedHeightPx: 64,
      existingProviderRequest: {
        providerKey: provider.providerKey,
        providerRequestId: submittedRequestId!,
        providerStatus: "submitted",
      },
    });
    assert.equal(submitCount, 1, "a download-security rejection must never trigger a second paid submission");
    assert.equal(recovered.providerRequestId, submittedRequestId);
  });

  it("14b: the ACTUAL S3B failure mode (oversized real result) preserves provider identity/billed semantics and never resubmits", async () => {
    // Mirrors the real live S3B Ruth acceptance run exactly: the paid
    // submission succeeded, Topaz completed the reconstruction, but the
    // download was rejected for size (pre-S3B.1: wrongly, at 25MB;
    // post-fix, this fixture is set safely below the new 64MiB cap so the
    // scenario proves general oversized-rejection recovery, not this
    // specific fix — see test 8c for the exact incident value).
    let submitCount = 0;
    let firstAttemptOversized = true;
    const oversizedBytes = MAX_PROVIDER_RESULT_DOWNLOAD_BYTES + 1;
    const impl = (async (input: string | URL | Request, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/tool/async")) {
        submitCount += 1;
        return jsonResponse(200, { process_id: PROCESS_ID });
      }
      if (url.includes("/status/")) {
        return jsonResponse(200, { status: "Completed" });
      }
      if (url.includes("/download/") && url.includes(PROCESS_ID)) {
        return jsonResponse(200, { url: "https://cdn.example.com/output.png" });
      }
      if (url === "https://cdn.example.com/output.png") {
        if (firstAttemptOversized) {
          return new Response(null, {
            status: 200,
            headers: { "content-type": "image/png", "content-length": String(oversizedBytes) },
          });
        }
        return new Response(new Uint8Array(realPngBytes()), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const provider = buildProvider(impl);
    let submittedRequestId: string | null = null;

    await assert.rejects(
      () =>
        provider.produceSignReconstruction({
          sourceBytes: realPngBytes(32, 32),
          sourceContentType: "image/png",
          requestedWidthPx: 64,
          requestedHeightPx: 64,
          onProviderRequestSubmitted: async (id) => {
            submittedRequestId = id;
          },
        }),
      /exceeding the .*-byte limit/i,
    );
    assert.equal(submitCount, 1, "the real paid submission occurred exactly once");
    assert.ok(submittedRequestId, "the paid submission's identity was durably recorded before the download failure");

    // A separately-authorized resume run, later, must resume — not resubmit.
    firstAttemptOversized = false;
    const recovered = await provider.produceSignReconstruction({
      sourceBytes: realPngBytes(32, 32),
      sourceContentType: "image/png",
      requestedWidthPx: 64,
      requestedHeightPx: 64,
      existingProviderRequest: {
        providerKey: provider.providerKey,
        providerRequestId: submittedRequestId!,
        providerStatus: "submitted",
      },
    });
    assert.equal(submitCount, 1, "an oversized-download rejection must never trigger a second paid submission");
    assert.equal(recovered.providerRequestId, submittedRequestId);
  });

  it("15: existing apparel Topaz download behavior remains compatible (via TopazTransparencyUpscaleProvider.produce)", async () => {
    // A minimal, direct exercise of `produce()`'s own download path with a
    // genuine HTTPS/PNG response — full apparel-path regression coverage
    // lives in `topaz-transparency-upscale-provider.test.ts` (45 tests,
    // unaffected by this patch except one updated message assertion); this
    // is a smoke check that the SAME hardened `download()` still serves it.
    const { PRINT_PLACEMENT_SIZING_POLICY } = await import("@/capabilities/shared/print-placement-dimensions");
    const png = new PNG({ width: 1024, height: 1024 });
    for (let i = 0; i < 1024 * 1024; i++) {
      const inside = true;
      png.data[i * 4] = 5;
      png.data[i * 4 + 1] = 5;
      png.data[i * 4 + 2] = 5;
      png.data[i * 4 + 3] = inside ? 255 : 0;
    }
    const sourceBytes = PNG.sync.write(png);

    const { fetchImpl } = buildDownloadFake({
      resultUrl: "https://cdn.example.com/output.png",
      resultFetch: () =>
        new Response(new Uint8Array(realPngBytes(1200, 1200)), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    });
    const provider = buildProvider(fetchImpl);
    const output = await provider.produce({
      sourceBytes,
      sourceContentType: "image/png",
      sizing: PRINT_PLACEMENT_SIZING_POLICY.sleeve,
      existingProviderRequest: null,
      onProviderRequestSubmitted: async () => {},
    });
    assert.equal(output.resolutionProvenance, "reconstructed");
  });
});
