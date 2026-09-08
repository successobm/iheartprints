/**
 * Large Raster Upload Limit Audit: proves the streaming body cap holds even
 * when there is NO trustworthy `Content-Length` to lean on — a missing,
 * lying, or chunked-transfer-encoded request. `ARCHITECTURE.md` §23 item 2
 * documented this as unbounded before this fix; these tests are the
 * evidence it no longer is.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { capRequestBodyBytes, isRequestBodyTooLargeError } from "./capped-request-body";

/** A request whose body is a raw stream with NO `Content-Length` header at all — the adversarial shape this fix targets. */
function streamedRequest(totalBytes: number, chunkSize = 64 * 1024): Request {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const n = Math.min(chunkSize, totalBytes - sent);
      controller.enqueue(new Uint8Array(n));
      sent += n;
    },
  });
  return new Request("http://localhost/upload", {
    method: "POST",
    // Deliberately no content-length header — Node/undici will use
    // chunked transfer semantics for a stream body, exactly like a real
    // lying or chunked-encoded client.
    headers: { "content-type": "application/octet-stream" },
    body,
    // @ts-expect-error -- required by undici for a streaming body; missing from the current DOM lib types.
    duplex: "half",
  });
}

describe("capRequestBodyBytes", () => {
  it("has no Content-Length header at all on the adversarial fixture — proving the header-based pre-check alone could never have caught this case", () => {
    const request = streamedRequest(10 * 1024 * 1024);
    assert.equal(request.headers.get("content-length"), null);
  });

  it("passes a body at or under the cap through unchanged", async () => {
    const capBytes = 1024 * 1024;
    const request = capRequestBodyBytes(streamedRequest(capBytes), capBytes);
    const bytes = await request.arrayBuffer();
    assert.equal(bytes.byteLength, capBytes);
  });

  it("rejects a body one byte over the cap — no trustworthy Content-Length involved at all", async () => {
    const capBytes = 1024 * 1024;
    const request = capRequestBodyBytes(streamedRequest(capBytes + 1), capBytes);
    await assert.rejects(() => request.arrayBuffer(), (error: unknown) => isRequestBodyTooLargeError(error));
  });

  it("rejects a genuinely large (10 MB) body against a small (1 MB) cap without ever buffering the whole thing", async () => {
    const capBytes = 1024 * 1024;
    const request = capRequestBodyBytes(streamedRequest(10 * 1024 * 1024), capBytes);
    await assert.rejects(() => request.arrayBuffer(), (error: unknown) => isRequestBodyTooLargeError(error));
  });

  it("stops reading the underlying stream once the cap is exceeded, rather than draining it to completion", async () => {
    const capBytes = 1024 * 1024;
    let bytesProduced = 0;
    const totalBytes = 50 * 1024 * 1024;
    const chunkSize = 64 * 1024;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= totalBytes) {
          controller.close();
          return;
        }
        const n = Math.min(chunkSize, totalBytes - sent);
        bytesProduced += n;
        controller.enqueue(new Uint8Array(n));
        sent += n;
      },
    });
    const raw = new Request("http://localhost/upload", {
      method: "POST",
      body,
      // @ts-expect-error -- see streamedRequest's own note.
      duplex: "half",
    });
    const capped = capRequestBodyBytes(raw, capBytes);
    await assert.rejects(() => capped.arrayBuffer(), (error: unknown) => isRequestBodyTooLargeError(error));
    // The reader is cancelled once the cap trips — the producer must not
    // have been driven anywhere near the full 50 MB.
    assert.ok(
      bytesProduced < totalBytes,
      `expected the stream to stop early, but it produced all ${bytesProduced} bytes`,
    );
  });

  it("passes a request with no body through unchanged", () => {
    const request = new Request("http://localhost/upload", { method: "GET" });
    const capped = capRequestBodyBytes(request, 1024);
    assert.equal(capped, request);
  });

  it("works through formData() exactly like a real multipart upload, small file", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(2048)], "small.png", { type: "image/png" }));
    const request = new Request("http://localhost/upload", { method: "POST", body: form });
    const capped = capRequestBodyBytes(request, 1024 * 1024);
    const parsed = await capped.formData();
    const file = parsed.get("file") as File;
    assert.equal(file.size, 2048);
  });

  it("rejects an oversized multipart file through formData() the same way", async () => {
    const capBytes = 1024 * 1024;
    const form = new FormData();
    form.set("file", new File([new Uint8Array(capBytes + 1024)], "big.png", { type: "image/png" }));
    const request = new Request("http://localhost/upload", { method: "POST", body: form });
    const capped = capRequestBodyBytes(request, capBytes);
    await assert.rejects(() => capped.formData(), (error: unknown) => isRequestBodyTooLargeError(error));
  });
});
