/**
 * Deploy identity for the read-only `GET /api/version` endpoint. Pure and
 * side-effect-free (reads `process.env` only), mirroring `worker-config.ts`.
 *
 * `GIT_SHA` is never set by a developer or by DigitalOcean directly — it is
 * written into `.env.production.local` at build time by
 * `scripts/generate-build-info.mjs` (an npm `prebuild` hook), which Next.js
 * loads into `process.env` when the production server starts. See that
 * script for why a build-time file, not a runtime-supplied variable, and
 * DEPLOYMENT.md for the deployment assumption behind it.
 */

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * The exact commit the running build was built from, or `null` when that
 * couldn't be determined at build time OR when `GIT_SHA` holds something
 * other than a full 40-character hex SHA. Validated here too, not only at
 * generation time — this function must never trust `process.env.GIT_SHA`'s
 * shape blindly, since anything could end up writing a malformed value into
 * `.env.production.local`. Callers must treat `null` as "unavailable" —
 * never substitute a placeholder like `"unknown"` or `"latest"`, which
 * would make an unverified build look like a proven one.
 */
export function getBuildGitSha(): string | null {
  const raw = process.env.GIT_SHA?.trim();
  if (!raw) return null;
  return GIT_SHA_PATTERN.test(raw) ? raw : null;
}

/** `NODE_ENV`, defaulting to `"development"` when unset (matches Next.js's own default outside `next build`/`next start`). */
export function getRuntimeEnvironment(): string {
  return process.env.NODE_ENV ?? "development";
}
