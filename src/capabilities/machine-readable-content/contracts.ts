/**
 * SIGNS QR / MACHINE-READABLE CONTENT PRESERVATION.
 *
 * A QR code (or any future machine-readable region — barcodes, data matrix
 * codes) is not an ordinary decorative image region: it is SEMANTIC content
 * a customer's own device reads. Visual similarity between a source QR and
 * a reconstructed one is NOT equivalent to functional equivalence — the
 * preservation invariant this module exists to prove is:
 *
 *   SOURCE QR PAYLOAD  ==  FINAL QR PAYLOAD
 *
 * when the source QR is actually decodable. This module is deliberately
 * narrow: QR is Phase 1 (`MachineReadableRegionKind` is a closed union of
 * one member today), and the region/decode/compare shapes below are
 * written so a second kind (a 1D barcode, say) could be added later
 * without reshaping this module — but nothing beyond QR is built now.
 *
 * FAIL-CLOSED DISCIPLINE (see `qr-preservation.ts`'s own doc for the full
 * 5-case model): the payload used for any automatic restoration is NEVER
 * guessed, inferred from nearby text/OCR/business records, or invented —
 * it is always the exact bytes decoded from the customer's own source QR.
 * When the source cannot be reliably decoded, this module never proposes
 * automatic repair; it reports `"review_required"` and stops.
 *
 * SECURITY: a decoded payload is untrusted customer data throughout this
 * module and everything that calls it. Nothing here ever fetches, opens,
 * resolves, or executes a decoded payload — it is compared for byte/string
 * equality and nothing else. See `qr-preservation.ts`'s own doc.
 */

/** Phase 1: QR only. A future barcode/data-matrix kind would extend this union. */
export type MachineReadableRegionKind = "qr";

/** A bounding box in the coordinate space of whichever image it was measured on (source pixels, or candidate pixels — never conflated). */
export interface MachineReadableRegionBounds {
  xPx: number;
  yPx: number;
  widthPx: number;
  heightPx: number;
}

/**
 * One instance actually located AND decoded in an image. `payload` is the
 * exact decoded string — untrusted, never fetched/executed, compared only
 * for equality (Section T's own security rule, restated at every layer
 * that touches it).
 */
export interface DecodedMachineReadableRegion {
  kind: MachineReadableRegionKind;
  payload: string;
  bounds: MachineReadableRegionBounds;
}

/**
 * A region that LOOKS machine-readable (matched the deterministic
 * finder-pattern signature — see `qr-detect-decode.ts`'s
 * `scanForQrFinderPatterns`) but did not successfully decode. This is the
 * evidence that distinguishes CASE 2 ("something is there, but we can't
 * verify it") from CASE 5 ("nothing is there at all") — see
 * `qr-preservation.ts`.
 */
export interface UndecodedMachineReadableRegion {
  kind: MachineReadableRegionKind;
  bounds: MachineReadableRegionBounds;
}

/**
 * The preservation/resolution model:
 *
 *   "pass"                 — either (a) source decoded P, candidate decodes
 *                             P (preserved), or (b) the source could not be
 *                             decoded but a user-confirmed destination D was
 *                             established and the candidate now provably
 *                             decodes exactly D — see `provenance` on
 *                             `MachineReadablePreservationInstance` to tell
 *                             these apart. NEVER blocking.
 *   "fail"                  — source decoded P, candidate does not decode at all.
 *   "hard_fail"              — source decoded P, candidate decodes a DIFFERENT payload Q.
 *   "review_required"       — source did not decode reliably AND no
 *                             resolution has been recorded yet. THIS IS AN
 *                             UNRESOLVED PRODUCTION ISSUE — blocking, exactly
 *                             like `fail`/`hard_fail`, until a customer or
 *                             operator either confirms a destination (which,
 *                             once the candidate provably encodes it,
 *                             becomes `"pass"`) or explicitly accepts the
 *                             artwork as supplied (`"accepted_as_supplied"`).
 *                             NEVER automatically repaired from source alone
 *                             — there is no verified source payload to
 *                             repair FROM (Section I's source-of-truth rule
 *                             is unchanged: only a CONFIRMED destination, an
 *                             explicit act, can ever become authority here).
 *   "accepted_as_supplied"   — an explicit, recorded acknowledgment that no
 *                             functioning QR is required for this region —
 *                             NEVER blocking, but explicitly NOT "pass":
 *                             this state never claims the artwork's QR
 *                             (if any) actually scans.
 *   "not_applicable"         — no machine-readable region detected in the source
 *                             at all.
 *
 * Only `"fail"`/`"hard_fail"`/`"review_required"` represent an unresolved or
 * proven-regressed state — see Section R's exact blocking rule, mirrored in
 * `print-validation-capability.ts`'s use of this result.
 */
export type MachineReadablePreservationCase =
  | "pass"
  | "fail"
  | "hard_fail"
  | "review_required"
  | "accepted_as_supplied"
  | "not_applicable";

/**
 * How a `"pass"` (or `"accepted_as_supplied"`) result was actually
 * established — the SAME truthful distinction Section J requires never be
 * blurred:
 *
 *   `"verified_from_source_qr"` — the payload is exactly what this
 *     codebase itself decoded from the customer's own source QR. The
 *     automatic preservation path — never a customer/operator decision.
 *   `"confirmed_by_user"`        — the source QR could not be decoded; a
 *     customer or operator explicitly confirmed the intended destination,
 *     and the candidate now provably encodes exactly that confirmed value.
 *     A DIFFERENT authority than source-decoded payload — never silently
 *     merged with it (Section J: "Never mix these authorities silently").
 *   `"print_as_supplied"`        — an explicit acknowledgment that no
 *     functioning QR is required; pairs only with
 *     `"accepted_as_supplied"`, never `"pass"`.
 *
 * `null` for every case where no resolution/verification act applies
 * (`"fail"`, `"hard_fail"`, `"review_required"`, `"not_applicable"`).
 */
export type MachineReadablePreservationProvenance =
  | "verified_from_source_qr"
  | "confirmed_by_user"
  | "print_as_supplied"
  | null;

/**
 * One tracked machine-readable region's full evidence trail, source through
 * candidate. `id` is a stable identity for this instance across the source
 * and candidate images (Section J: 0..N regions, each independently
 * tracked) — derived from the region's ordinal position among detected
 * regions plus its kind, never from pixel content (content is exactly what
 * may have changed).
 */
export interface MachineReadablePreservationInstance {
  id: string;
  kind: MachineReadableRegionKind;
  sourceBounds: MachineReadableRegionBounds | null;
  sourceDecodable: boolean;
  /**
   * SHA-256 of the decoded source payload, hex-encoded — never the raw
   * payload itself in evidence that might be logged/persisted broadly
   * (Section T). The raw payload is carried separately, only where an
   * operator-facing restoration actually needs it in memory — see
   * `qr-restore.ts`.
   */
  sourcePayloadSha256: string | null;
  candidateBounds: MachineReadableRegionBounds | null;
  candidateDecodable: boolean;
  candidatePayloadSha256: string | null;
  result: MachineReadablePreservationCase;
  /** See `MachineReadablePreservationProvenance`'s own doc. `null` unless `result` is `"pass"` or `"accepted_as_supplied"`. */
  provenance: MachineReadablePreservationProvenance;
  /**
   * Deterministic, reproducible identity for this SOURCE region within its
   * one immutable source image — a digest of the region's own rounded
   * bounds (see `deriveRegionKey` in `qr-resolution.ts`). Stable across
   * repeated detection runs against the SAME source, which is what lets a
   * durably-recorded resolution (`SignQrResolutionRecord.regionKey`)
   * continue to bind to "the same QR-like region" without needing a
   * persisted detection-run identity. `null` when `sourceBounds` is `null`
   * (nothing was detected in the source at all for this instance).
   */
  regionKey: string | null;
}

export interface MachineReadablePreservationReport {
  instances: MachineReadablePreservationInstance[];
  /** The worst case across all instances — see `qr-preservation.ts`'s `worstCase` ordering. `"not_applicable"` iff `instances` is empty. */
  overall: MachineReadablePreservationCase;
}
