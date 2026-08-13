/**
 * Failure classification for the design brief decision route.
 *
 * Split out of `route.ts` for the same reason as `schema.ts`: Next.js only
 * permits route handlers and segment config to be exported from a route
 * module, so anything that needs a direct unit test has to live beside it.
 *
 * The distinction that matters here is `Error` vs. not. The capability
 * layer signals domain refusals ("not found", "not ready", "Cannot ...")
 * by throwing `Error`s. Supabase/PostgREST, by contrast, rejects with a
 * plain `{ code, message, hint }` object — so an infrastructure failure is
 * reliably identifiable as "something that is not an `Error`", and must
 * never be reported as if the customer had done something wrong.
 */

const FALLBACK_MESSAGE = "Failed to submit decision";

/**
 * The message for the server log. A bare `console.error(error)` on a
 * PostgREST rejection buries the actual cause (a missing column, a
 * constraint violation) inside an unfamiliar object shape; this pulls it
 * out so the log line names the real failure.
 */
export function describeDecisionFailure(error: unknown): string {
  if (error instanceof Error) return error.message;

  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    const detail = error as { code?: unknown; message: string };
    return typeof detail.code === "string"
      ? `${detail.code}: ${detail.message}`
      : detail.message;
  }

  return FALLBACK_MESSAGE;
}

/**
 * The message for the customer. Domain refusals are written for a person
 * to read; anything else would leak schema, provider, or queue detail into
 * the chat UI, so it stays generic.
 */
export function customerFacingDecisionMessage(error: unknown): string {
  return error instanceof Error ? error.message : FALLBACK_MESSAGE;
}

/**
 * Only a domain refusal can be a 404/409. An infrastructure failure is a
 * server fault even when its text happens to contain a word this mapping
 * looks for.
 */
export function decisionFailureStatus(error: unknown): number {
  if (!(error instanceof Error)) return 500;
  if (error.message.includes("not found")) return 404;
  if (error.message.includes("not ready") || error.message.includes("Cannot ")) {
    return 409;
  }
  return 500;
}
