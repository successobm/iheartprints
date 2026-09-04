/**
 * SIGNS QR DESTINATION RESOLUTION.
 *
 * `review_required` (a detected QR-like region whose source cannot be
 * reliably decoded) is now an UNRESOLVED PRODUCTION ISSUE, not a mere
 * warning — it blocks Print Ready until a customer or operator makes one
 * of two explicit decisions:
 *
 *   CONFIRM DESTINATION   — provide the intended payload; iHeartPrints
 *                           generates and inserts a valid replacement QR,
 *                           and the CANDIDATE must provably decode exactly
 *                           that confirmed value before this instance can
 *                           read `"pass"`.
 *   PRINT AS SUPPLIED     — an explicit acknowledgment that no functioning
 *                           QR is required. Never becomes `"pass"` — see
 *                           `"accepted_as_supplied"` in `contracts.ts`.
 *
 * This module is the PURE combination logic only: given a raw preservation
 * report (from `compareMachineReadableContent`) and the durable resolution
 * records for this preparation, produce the FINAL, resolution-aware report.
 * It performs NO I/O — deciding whether a `confirmed_destination` record's
 * candidate actually needs a fresh deterministic correction (and running
 * one) is the caller's job (`sign-qr-preservation-service.ts`), which then
 * re-runs this same combination after any correction to get the true final
 * state. Kept this way so the truthful RESULT-COMBINING rules are testable
 * in isolation, exactly like `qr-preservation.ts`'s own `compare` function.
 */

import { createHash } from "node:crypto";

import type {
  MachineReadablePreservationInstance,
  MachineReadablePreservationReport,
  MachineReadableRegionBounds,
} from "./contracts";

/**
 * A durable, per-region resolution decision. Persisted on
 * `SignPreparation.qrResolutions` (see the migration's own schema-discipline
 * audit for why this is a jsonb array on the existing row, mirroring
 * `edgeIntentClassifications`).
 *
 * Binds itself to the EXACT source it was resolved against
 * (`sourceAssetId`/`sourceSha256`) — a record whose source no longer
 * matches the preparation's CURRENT immutable source is never applied
 * (Section L: "Do not allow a confirmation for stale QR evidence to
 * silently apply to a different source/candidate").
 */
export interface SignQrResolutionRecord {
  sourceAssetId: string;
  sourceSha256: string;
  /** See `MachineReadablePreservationInstance.regionKey`'s own doc. */
  regionKey: string;
  state: "confirmed_destination" | "print_as_supplied";
  /**
   * The EXACT confirmed payload — never normalized, never re-derived
   * (Section N: "the exact confirmed payload is authority"). `null` iff
   * `state === "print_as_supplied"`.
   */
  confirmedPayload: string | null;
  confirmedBy: "customer" | "operator";
  confirmedAt: string;
}

/**
 * Deterministic, reproducible identity for a source region — a short
 * digest of its own bounds, rounded to the nearest 8px so trivial
 * sub-pixel jitter between repeated detection runs against the SAME
 * immutable source image can never mint a "new" region for what is
 * plainly the same one. Never derived from pixel CONTENT (content is
 * exactly what may be unreadable) and never from detection ORDER (jsQR/
 * the finder-pattern scanner impose no stable ordering across runs).
 */
export function deriveRegionKey(bounds: MachineReadableRegionBounds): string {
  const round = (n: number) => Math.round(n / 8) * 8;
  const canonical = `${round(bounds.xPx)}:${round(bounds.yPx)}:${round(bounds.widthPx)}:${round(bounds.heightPx)}`;
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}

/**
 * Finds the resolution record (if any) that legitimately governs
 * `instance` — matched by `regionKey` AND bound to the SAME source asset
 * identity the instance was actually measured against. A record whose
 * `sourceAssetId`/`sourceSha256` no longer matches `currentSource` is
 * treated as if it did not exist (fail closed — Section L).
 */
function findGoverningResolution(
  instance: MachineReadablePreservationInstance,
  resolutions: readonly SignQrResolutionRecord[],
  currentSource: { assetId: string; sha256: string },
): SignQrResolutionRecord | null {
  if (!instance.regionKey) return null;
  return (
    resolutions.find(
      (r) =>
        r.regionKey === instance.regionKey &&
        r.sourceAssetId === currentSource.assetId &&
        r.sourceSha256 === currentSource.sha256,
    ) ?? null
  );
}

export interface ApplyQrResolutionsResult {
  report: MachineReadablePreservationReport;
  /**
   * Instances that have a `"confirmed_destination"` resolution recorded but
   * whose CANDIDATE does not yet provably encode that confirmed payload —
   * i.e. a deterministic correction is still needed. The caller
   * (`sign-qr-preservation-service.ts`) is responsible for attempting that
   * correction and re-running this combination afterward; this module never
   * performs it (no I/O).
   */
  pendingCorrections: { instance: MachineReadablePreservationInstance; resolution: SignQrResolutionRecord }[];
}

/**
 * Combines a raw preservation report with durable resolution records into
 * the FINAL truthful report. Only ever touches `"review_required"`
 * instances — every other result (`"pass"`, `"fail"`, `"hard_fail"`,
 * `"not_applicable"`) already reflects a fully-proven state from the
 * automatic source/candidate comparison alone and is passed through
 * unchanged (with `provenance: "verified_from_source_qr"` stamped onto a
 * `"pass"` produced that way, since that is the ONLY way `compare
 * MachineReadableContent` itself ever produces `"pass"`).
 */
export function applyQrResolutions(
  raw: MachineReadablePreservationReport,
  resolutions: readonly SignQrResolutionRecord[],
  currentSource: { assetId: string; sha256: string },
): ApplyQrResolutionsResult {
  const pendingCorrections: ApplyQrResolutionsResult["pendingCorrections"] = [];

  const instances = raw.instances.map((instance): MachineReadablePreservationInstance => {
    if (instance.result === "pass") {
      return { ...instance, provenance: "verified_from_source_qr" };
    }
    if (instance.result !== "review_required") {
      return instance;
    }

    const resolution = findGoverningResolution(instance, resolutions, currentSource);
    if (!resolution) return instance; // Still genuinely unresolved — blocking.

    if (resolution.state === "print_as_supplied") {
      return { ...instance, result: "accepted_as_supplied", provenance: "print_as_supplied" };
    }

    // "confirmed_destination": pass ONLY if the candidate has ALREADY been
    // proven (by a prior correction pass) to decode exactly the confirmed
    // payload. `compareMachineReadableContent` only ever calls a source
    // instance "review_required" when the SOURCE didn't decode — it never
    // independently checks a review_required instance's candidate against
    // an external confirmed payload (that is this module's job, not the
    // raw comparator's). So this module checks it directly here.
    if (instance.candidateDecodable && instance.candidatePayloadSha256 === sha256Hex(resolution.confirmedPayload!)) {
      return { ...instance, result: "pass", provenance: "confirmed_by_user" };
    }

    pendingCorrections.push({ instance, resolution });
    return instance; // Still review_required until the correction is applied and re-verified.
  });

  const overall = worstCase(instances.map((i) => i.result));
  return { report: { instances, overall }, pendingCorrections };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const CASE_SEVERITY: Record<MachineReadablePreservationInstance["result"], number> = {
  not_applicable: 0,
  pass: 1,
  accepted_as_supplied: 2,
  review_required: 3,
  fail: 4,
  hard_fail: 5,
};

function worstCase(
  cases: readonly MachineReadablePreservationInstance["result"][],
): MachineReadablePreservationInstance["result"] {
  let worst: MachineReadablePreservationInstance["result"] = "not_applicable";
  for (const c of cases) {
    if (CASE_SEVERITY[c] > CASE_SEVERITY[worst]) worst = c;
  }
  return worst;
}
