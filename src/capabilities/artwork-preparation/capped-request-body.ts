/**
 * Large Raster Upload Limit Audit: closes a documented, pre-existing gap
 * (`ARCHITECTURE.md` §23's customer-release ledger, item 2 — "Upload
 * Content-Length / body-buffering bypass"): `artwork-upload/route.ts`
 * rejected an oversized DECLARED `Content-Length`, but then called
 * `request.formData()` unconditionally, which buffers the ENTIRE body into
 * memory before any size is re-checked. A missing, lying, or chunked-
 * transfer-encoded request (no `Content-Length` at all) was bounded by
 * nothing — this is what made the pre-check cosmetic rather than
 * authoritative, regardless of what `MAX_UPLOAD_BYTES` was set to.
 *
 * `capRequestBodyBytes` wraps the request's own `ReadableStream` body so
 * the cap is enforced WHILE THE BODY IS BEING READ — the same
 * read-and-check-as-you-go discipline `topaz-transparency-upscale-
 * provider.ts`'s `download()` already uses for provider-result downloads
 * ("a response-size cap enforced while reading, never a full arrayBuffer()
 * first"). Once more than `maxBytes` has been read, the stream errors and
 * cancels the underlying reader — `formData()` (or any other consumer)
 * rejects immediately rather than continuing to buffer. Never trusts
 * `Content-Length`; the cap holds even when that header is absent, zero,
 * or an outright lie.
 */

export const REQUEST_BODY_TOO_LARGE_MESSAGE = "request_body_too_large";

/**
 * Returns a NEW `Request` whose body is capped, or the SAME request
 * unchanged when it has no body (e.g. malformed/bodyless requests — nothing
 * to cap). The returned request's `.formData()`/`.arrayBuffer()`/etc. reject
 * with an `Error` whose message is `REQUEST_BODY_TOO_LARGE_MESSAGE` once the
 * underlying stream has produced more than `maxBytes`.
 */
export function capRequestBodyBytes(request: Request, maxBytes: number): Request {
  if (!request.body) return request;

  const reader = request.body.getReader();
  let total = 0;

  const capped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        controller.error(new Error(REQUEST_BODY_TOO_LARGE_MESSAGE));
        await reader.cancel().catch(() => {});
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    // @ts-expect-error -- `duplex` is required by undici/Node's fetch
    // implementation for a streaming request body but is missing from the
    // current TypeScript DOM lib's RequestInit type.
    duplex: "half",
    body: capped,
  });
}

/** True for an error thrown by a stream `capRequestBodyBytes` capped. */
export function isRequestBodyTooLargeError(error: unknown): boolean {
  return error instanceof Error && error.message === REQUEST_BODY_TOO_LARGE_MESSAGE;
}
