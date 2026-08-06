import { createHash, timingSafeEqual } from "crypto";

import { getWorkerSecret, isWorkerSecretRequired } from "@/lib/config/worker-config";

/**
 * Sprint 2H Part 2B: authentication for the protected worker endpoint.
 *
 * Mirrors `capabilities/asset-storage/signed-url-token.ts`'s dev-fallback
 * pattern: outside production, an unset `WORKER_SECRET` falls back to a
 * well-known constant rather than disabling auth entirely, so the
 * comparison path (and its constant-time guarantee) is exercised the same
 * way in every environment, and a developer can still exercise the worker
 * endpoint locally without configuring anything. Production never falls
 * back — `WORKER_SECRET` is required there (see `isWorkerSecretRequired`).
 */
const DEV_FALLBACK_WORKER_SECRET =
  "iheartprints-local-dev-worker-secret-do-not-use-in-production";

export type WorkerAuthResult =
  | { authorized: true }
  | {
      authorized: false;
      /** Internal-only classification — never surfaced in an HTTP response body. */
      reason: "not_configured" | "missing_secret" | "invalid_secret";
    };

/** Fixed-length digest comparison — never branches on the raw secret's length. */
function secretsMatch(expected: string, provided: string): boolean {
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const providedDigest = createHash("sha256").update(provided, "utf8").digest();
  return timingSafeEqual(expectedDigest, providedDigest);
}

/**
 * Verifies a caller-supplied worker secret against configuration.
 * Constant-time; never logs the provided or expected secret.
 */
export function verifyWorkerSecret(provided: string | null): WorkerAuthResult {
  const configured = getWorkerSecret();

  if (!configured && isWorkerSecretRequired()) {
    // Production must never run unauthenticated, and must never fall back
    // to a well-known development secret — fail closed even before
    // looking at what the caller sent.
    return { authorized: false, reason: "not_configured" };
  }

  if (!provided) {
    return { authorized: false, reason: "missing_secret" };
  }

  const expected = configured ?? DEV_FALLBACK_WORKER_SECRET;
  if (!secretsMatch(expected, provided)) {
    return { authorized: false, reason: "invalid_secret" };
  }

  return { authorized: true };
}
