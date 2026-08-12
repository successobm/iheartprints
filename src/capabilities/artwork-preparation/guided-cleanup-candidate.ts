/**
 * Existing Artwork → Print Ready Phase 1.3 / 1.7: the opaque candidate a
 * preview returns, and the exact-region highlight the UI renders from it.
 *
 * A click must NOT mutate artwork. Preview identifies an eligible selection,
 * returns a signed candidate token plus a highlight overlay built from the
 * SAME mask the mutation path uses, and only confirm may redeem that token.
 *
 * Phase 1.7 extends claims for Magic Select (`v: 2`, connected-only).
 * Phase 1.7B mints `v: 3` with a resolved `selectionMode` so magnetic
 * previews cannot be confirmed as connected (and vice versa).
 * Region tokens remain `v: 1`.
 */

import { createHmac, timingSafeEqual } from "crypto";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

import type { ArtworkBounds, RgbColor } from "./contracts";
import type { MagicSelectionMode } from "./magic-color-selection";
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

export interface GuidedRegionCandidateClaims {
  v: 1;
  tool?: "region";
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

/** Phase 1.7 connected-only Magic Select token. Still verified on confirm. */
export interface GuidedMagicSelectCandidateClaimsV2 {
  v: 2;
  tool: "magic_select";
  projectId: string;
  preparationId: string;
  preparedAssetId: string;
  point: GuidedRemovalPoint;
  tolerance: number;
  connectedOnly: true;
  referenceColor: RgbColor;
  selectionKey: string;
  pixelCount: number;
  removalCount: number;
  exp: number;
}

/** Phase 1.7B Magic Select token — binds the resolved selection mode. */
export interface GuidedMagicSelectCandidateClaimsV3 {
  v: 3;
  tool: "magic_select";
  projectId: string;
  preparationId: string;
  preparedAssetId: string;
  point: GuidedRemovalPoint;
  tolerance: number;
  selectionMode: MagicSelectionMode;
  ruleVersion: string;
  referenceColor: RgbColor;
  selectionKey: string;
  pixelCount: number;
  removalCount: number;
  exp: number;
}

export type GuidedMagicSelectCandidateClaims =
  | GuidedMagicSelectCandidateClaimsV2
  | GuidedMagicSelectCandidateClaimsV3;

export type GuidedCleanupCandidateClaims =
  | GuidedRegionCandidateClaims
  | GuidedMagicSelectCandidateClaims;

/** @deprecated Prefer GuidedRegionCandidateClaims — kept for call-site clarity. */
export type GuidedCleanupCandidateClaimsV1 = GuidedRegionCandidateClaims;

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
  claims: Omit<GuidedRegionCandidateClaims, "v" | "exp" | "tool"> & {
    exp?: number;
  },
): string {
  const full: GuidedRegionCandidateClaims = {
    v: 1,
    tool: "region",
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

export function mintMagicSelectCandidateToken(
  claims: Omit<GuidedMagicSelectCandidateClaimsV3, "v" | "exp" | "tool"> & {
    exp?: number;
  },
): string {
  const full: GuidedMagicSelectCandidateClaimsV3 = {
    v: 3,
    tool: "magic_select",
    projectId: claims.projectId,
    preparationId: claims.preparationId,
    preparedAssetId: claims.preparedAssetId,
    point: {
      x: Math.floor(claims.point.x),
      y: Math.floor(claims.point.y),
    },
    tolerance: claims.tolerance,
    selectionMode: claims.selectionMode,
    ruleVersion: claims.ruleVersion,
    referenceColor: {
      r: claims.referenceColor.r,
      g: claims.referenceColor.g,
      b: claims.referenceColor.b,
    },
    selectionKey: claims.selectionKey,
    pixelCount: claims.pixelCount,
    removalCount: claims.removalCount,
    exp: claims.exp ?? Date.now() + GUIDED_CLEANUP_CANDIDATE_TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(full), "utf8").toString("base64url");
  return `${payload}.${signPayload(payload)}`;
}

/** Phase 1.7 connected-only token — used to prove v2 cannot mint magnetic confirms. */
export function mintLegacyConnectedMagicSelectCandidateToken(
  claims: Omit<GuidedMagicSelectCandidateClaimsV2, "v" | "exp" | "tool" | "connectedOnly"> & {
    exp?: number;
  },
): string {
  const full: GuidedMagicSelectCandidateClaimsV2 = {
    v: 2,
    tool: "magic_select",
    projectId: claims.projectId,
    preparationId: claims.preparationId,
    preparedAssetId: claims.preparedAssetId,
    point: {
      x: Math.floor(claims.point.x),
      y: Math.floor(claims.point.y),
    },
    tolerance: claims.tolerance,
    connectedOnly: true,
    referenceColor: {
      r: claims.referenceColor.r,
      g: claims.referenceColor.g,
      b: claims.referenceColor.b,
    },
    selectionKey: claims.selectionKey,
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
    typeof claims?.projectId !== "string" ||
    typeof claims.preparationId !== "string" ||
    typeof claims.preparedAssetId !== "string" ||
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

  if (claims.v === 3) {
    const magic = claims as GuidedMagicSelectCandidateClaimsV3;
    if (
      magic.tool !== "magic_select" ||
      typeof magic.selectionKey !== "string" ||
      typeof magic.tolerance !== "number" ||
      !Number.isInteger(magic.tolerance) ||
      (magic.selectionMode !== "connected" && magic.selectionMode !== "similar") ||
      typeof magic.ruleVersion !== "string" ||
      magic.ruleVersion.length === 0 ||
      !Number.isInteger(magic.referenceColor?.r) ||
      !Number.isInteger(magic.referenceColor?.g) ||
      !Number.isInteger(magic.referenceColor?.b)
    ) {
      return null;
    }
    return magic;
  }

  if (claims.v === 2) {
    const magic = claims as GuidedMagicSelectCandidateClaimsV2;
    if (
      magic.tool !== "magic_select" ||
      typeof magic.selectionKey !== "string" ||
      typeof magic.tolerance !== "number" ||
      !Number.isInteger(magic.tolerance) ||
      magic.connectedOnly !== true ||
      !Number.isInteger(magic.referenceColor?.r) ||
      !Number.isInteger(magic.referenceColor?.g) ||
      !Number.isInteger(magic.referenceColor?.b)
    ) {
      return null;
    }
    return magic;
  }

  if (claims.v !== 1 || typeof (claims as GuidedRegionCandidateClaims).regionKey !== "string") {
    return null;
  }

  return claims as GuidedRegionCandidateClaims;
}

export function isMagicSelectCandidateClaims(
  claims: GuidedCleanupCandidateClaims,
): claims is GuidedMagicSelectCandidateClaims {
  return claims.v === 2 || claims.v === 3;
}

export function isMagicSelectCandidateClaimsV3(
  claims: GuidedCleanupCandidateClaims,
): claims is GuidedMagicSelectCandidateClaimsV3 {
  return claims.v === 3;
}

/**
 * Builds the cropped highlight overlay for one canonical region key, using
 * the same label map the removal path uses. Returns `null` when the key is
 * unknown (should not happen for an eligible resolution).
 *
 * Region fills use a two-tone hatch so selection is not communicated by
 * colour alone. Magic Select uses a solid amber fill so scattered 1px
 * islands stay visible on White, Gray, and Black QA.
 */
export function buildGuidedRemovalHighlight(
  candidates: GuidedRemovalCandidates,
  regionKey: string,
): GuidedCleanupHighlight | null {
  const labelIndex = candidates.keys.indexOf(regionKey);
  if (labelIndex < 0) return null;

  const region = candidates.regions[labelIndex];
  if (!region) return null;

  const mask = new Uint8Array(candidates.width * candidates.height);
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    if (candidates.labels[pixel] === labelIndex) mask[pixel] = 1;
  }
  return buildSelectionHighlight(mask, candidates.width, candidates.height, region.bounds, "hatch");
}

export type SelectionHighlightFill = "hatch" | "solid";

/**
 * Exact-pixel highlight from an authoritative selection mask.
 * `solid` is the Magic Select treatment — every selected pixel is amber.
 */
export function buildSelectionHighlight(
  mask: Uint8Array,
  width: number,
  height: number,
  bounds: ArtworkBounds,
  fill: SelectionHighlightFill = "hatch",
): GuidedCleanupHighlight {
  const overlay: RgbaImage = {
    width: bounds.width,
    height: bounds.height,
    data: Buffer.alloc(bounds.width * bounds.height * 4),
  };

  for (let y = bounds.top; y < bounds.bottom; y += 1) {
    for (let x = bounds.left; x < bounds.right; x += 1) {
      const pixel = y * width + x;
      if (mask[pixel] !== 1) continue;

      const localX = x - bounds.left;
      const localY = y - bounds.top;
      const idx = (localY * bounds.width + localX) * 4;
      if (fill === "solid") {
        overlay.data[idx] = 245;
        overlay.data[idx + 1] = 158;
        overlay.data[idx + 2] = 11;
        overlay.data[idx + 3] = 210;
        continue;
      }
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
