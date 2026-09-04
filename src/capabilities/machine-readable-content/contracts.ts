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
 * The 5-case preservation model (Section S of the originating task,
 * restated in full in `qr-preservation.ts`'s own doc):
 *
 *   "pass"             — source decoded P, candidate decodes P. Preserved.
 *   "fail"              — source decoded P, candidate does not decode at all.
 *   "hard_fail"         — source decoded P, candidate decodes a DIFFERENT payload Q.
 *   "review_required"   — source did not decode reliably (candidate's own
 *                          state is irrelevant — there is nothing proven to
 *                          have regressed). NEVER automatically repaired.
 *   "not_applicable"    — no machine-readable region detected in the source
 *                          at all.
 *
 * Only `"fail"`/`"hard_fail"` represent a PROVEN regression iHeartPrints's
 * own preparation caused — see Section R's exact blocking rule, mirrored in
 * `print-validation-capability.ts`'s use of this result.
 */
export type MachineReadablePreservationCase =
  | "pass"
  | "fail"
  | "hard_fail"
  | "review_required"
  | "not_applicable";

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
}

export interface MachineReadablePreservationReport {
  instances: MachineReadablePreservationInstance[];
  /** The worst case across all instances — see `qr-preservation.ts`'s `worstCase` ordering. `"not_applicable"` iff `instances` is empty. */
  overall: MachineReadablePreservationCase;
}
