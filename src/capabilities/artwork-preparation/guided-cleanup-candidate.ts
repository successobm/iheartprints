/**
 * Existing Artwork → Print Ready Phase 1.3: the opaque candidate a preview
 * returns, and the exact-region highlight the UI renders from it.
 *
 * A click must NOT mutate artwork. Preview identifies an eligible region,
 * returns a signed candidate token plus a highlight overlay built from the
 * SAME label map the mutation path uses, and only "Remove This Area" may
 * redeem that token. The token binds project, preparation, prepared asset,
 * region key, and click point so a stale or forged confirm cannot remove a
 * different region — or any region after the preparation has moved on.
 *
 * The highlight overlay is a cropped PNG whose opaque pixels are exactly the
 * candidate region. The UI never flood-fills; it only paints what the server
 * already decided.
 */

import { createHmac, timingSafeEqual } from "crypto";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

import type { ArtworkBounds } from "./contracts";
import type {
  GuidedRemovalCandidates,
  GuidedRemovalPoint,
  GuidedRemovalRegion,
} from "./guided-removal";
import { encodeRgbaToPng } from "./image-decode";

const DEV_FALLBACK_SECRET =
  "iheartprints-local-dev-guided-cleanup-candidate-secret-do-not-use-in-production";

/** Preview tokens expire so a tab left open overnight cannot confirm stale state. */
export const GUIDED_CLEANUP_CANDIDATE_TTL_MS = 15 * 60 * 1000;

export interface GuidedCleanupCandidateClaims {
  v: 1;
  projectId: string;
  preparationId: string;
  preparedAssetId: string;
  regionKey: string;
  point: GuidedRemovalPoint;
  pixelCount: number;
  /** How many guided removals existed when the preview was minted. */
  removalCount: number;
  exp: number;
}

export interface GuidedCleanupHighlight {
  bounds: ArtworkBounds;
  /** `data:image/png;base64,...` cropped to `bounds`. */
  overlayDataUrl: string;
}

function getSigningSecret(): string {
  return (
    process.env.GUIDED_CLEANUP_CANDIDATE_SECRET?.trim() ||
    process.env.ASSET_SIGNING_SECRET?.trim() ||
    DEV_FALLBACK_SECRET
  );
}

function signPayload(payload: string): string {
  return createHmac("sha256", getSigningSecret()).update(payload).digest("base64url");
}

/**
 * Mints an opaque token the browser can hold until the customer confirms.
 * Claims are signed, not encrypted — secrecy is not the goal; forgery and
 * cross-project reuse are.
 */
export function mintGuidedCleanupCandidateToken(
  claims: Omit<GuidedCleanupCandidateClaims, "v" | "exp"> & { exp?: number },
): string {
  const full: GuidedCleanupCandidateClaims = {
    v: 1,
    projectId: claims.projectId,
    preparationId: claims.preparationId,
    preparedAssetId: claims.preparedAssetId,
    regionKey: claims.regionKey,
    point: {
      x: Math.floor(claims.point.x),
      y: Math.floor(claims.point.y),
    },
    pixelCount: claims.pixelCount,
    removalCount: claims.removalCount,
    exp: claims.exp ?? Date.now() + GUIDED_CLEANUP_CANDIDATE_TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(full), "utf8").toString("base64url");
  return `${payload}.${signPayload(payload)}`;
}

/**
 * Verifies signature and expiry. Returns `null` for anything malformed,
 * expired, or tampered — callers treat all of those as a stale preview.
 */
export function verifyGuidedCleanupCandidateToken(
  token: string,
): GuidedCleanupCandidateClaims | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  if (!payload || !signature) return null;

  const expected = Buffer.from(signPayload(payload), "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }

  let claims: GuidedCleanupCandidateClaims;
  try {
    claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as GuidedCleanupCandidateClaims;
  } catch {
    return null;
  }

  if (
    claims?.v !== 1 ||
    typeof claims.projectId !== "string" ||
    typeof claims.preparationId !== "string" ||
    typeof claims.preparedAssetId !== "string" ||
    typeof claims.regionKey !== "string" ||
    typeof claims.pixelCount !== "number" ||
    typeof claims.removalCount !== "number" ||
    typeof claims.exp !== "number" ||
    !Number.isFinite(claims.exp) ||
    Date.now() > claims.exp ||
    !Number.isInteger(claims.point?.x) ||
    !Number.isInteger(claims.point?.y)
  ) {
    return null;
  }

  return claims;
}

/**
 * Builds the cropped highlight overlay for one canonical region key, using
 * the same label map the removal path uses. Returns `null` when the key is
 * unknown (should not happen for an eligible resolution).
 *
 * The fill is a two-tone hatch so selection is not communicated by colour
 * alone — the confirmation copy and controls carry the rest of the meaning.
 */
export function buildGuidedRemovalHighlight(
  candidates: GuidedRemovalCandidates,
  regionKey: string,
): GuidedCleanupHighlight | null {
  const labelIndex = candidates.keys.indexOf(regionKey);
  if (labelIndex < 0) return null;

  const region = candidates.regions[labelIndex];
  if (!region) return null;

  const { bounds } = region;
  const overlay: RgbaImage = {
    width: bounds.width,
    height: bounds.height,
    data: Buffer.alloc(bounds.width * bounds.height * 4),
  };

  for (let y = bounds.top; y < bounds.bottom; y += 1) {
    for (let x = bounds.left; x < bounds.right; x += 1) {
      const pixel = y * candidates.width + x;
      if (candidates.labels[pixel] !== labelIndex) continue;

      const localX = x - bounds.left;
      const localY = y - bounds.top;
      const idx = (localY * bounds.width + localX) * 4;
      // Diagonal hatch: amber vs near-black, both semi-opaque.
      const hatch = (localX + localY) % 4 < 2;
      if (hatch) {
        overlay.data[idx] = 245;
        overlay.data[idx + 1] = 158;
        overlay.data[idx + 2] = 11;
        overlay.data[idx + 3] = 170;
      } else {
        overlay.data[idx] = 28;
        overlay.data[idx + 1] = 25;
        overlay.data[idx + 2] = 23;
        overlay.data[idx + 3] = 150;
      }
    }
  }

  const png = encodeRgbaToPng(overlay);
  return {
    bounds: { ...bounds },
    overlayDataUrl: `data:image/png;base64,${png.toString("base64")}`,
  };
}

/** Look up a still-present eligible region by its canonical key. */
export function findGuidedRemovalRegionByKey(
  candidates: GuidedRemovalCandidates,
  regionKey: string,
  applied: readonly { regionKey: string }[] = [],
): GuidedRemovalRegion | null {
  const labelIndex = candidates.keys.indexOf(regionKey);
  if (labelIndex < 0) return null;
  if (candidates.removedByAutomatic[labelIndex]) return null;
  if (applied.some((record) => record.regionKey === regionKey)) return null;

  const region = candidates.regions[labelIndex];
  if (!region) return null;

  return {
    regionKey,
    bounds: region.bounds,
    pixelCount: region.pixelCount,
  };
}
