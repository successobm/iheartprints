import { createHmac, timingSafeEqual } from "crypto";

/**
 * Sprint 2H Part 2A: signs short-lived access tokens for the local
 * filesystem storage backend's asset route, mirroring what a real signed
 * URL from Supabase Storage/S3 provides (an expiring, unguessable
 * reference) without needing real cloud infrastructure for local dev.
 */

const DEV_FALLBACK_SECRET =
  "iheartprints-local-dev-asset-signing-secret-do-not-use-in-production";

function getSigningSecret(): string {
  return process.env.ASSET_SIGNING_SECRET?.trim() || DEV_FALLBACK_SECRET;
}

export function signAssetToken(objectKey: string, expiresAtMs: number): string {
  return createHmac("sha256", getSigningSecret())
    .update(`${objectKey}:${expiresAtMs}`)
    .digest("hex");
}

export function verifyAssetToken(
  objectKey: string,
  expiresAtMs: number,
  token: string,
): boolean {
  if (!Number.isFinite(expiresAtMs) || Date.now() > expiresAtMs) return false;

  const expected = Buffer.from(signAssetToken(objectKey, expiresAtMs), "hex");
  let actual: Buffer;
  try {
    actual = Buffer.from(token, "hex");
  } catch {
    return false;
  }
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
