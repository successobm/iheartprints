/**
 * The 5-case machine-readable preservation model.
 *
 * `"pass"`             — source decodes P; candidate decodes P.
 * `"fail"`              — source decodes P; candidate does not decode at all.
 *                          iHeartPrints's own preparation lost functionality it had. BLOCKS.
 * `"hard_fail"`         — source decodes P; candidate decodes Q != P.
 *                          Worse than losing it — a customer's device would now be sent
 *                          somewhere the customer never encoded. BLOCKS.
 * `"review_required"`   — source does not decode reliably at all. Whatever the candidate
 *                          does or doesn't decode, NOTHING here can prove iHeartPrints
 *                          regressed anything — the source was never verified working.
 *                          NEVER treated as a failure, and NEVER automatically repaired
 *                          (there is no verified payload to repair FROM). Does not block
 *                          Print Ready by itself (Section R's own exact scoping: only a
 *                          POSITIVELY DECODED source that the candidate fails to reproduce
 *                          blocks) — it is a genuine open question for a human, not a
 *                          proven defect.
 * `"not_applicable"`    — no QR-shaped region detected anywhere in the source at all.
 *                          This artwork has nothing to preserve.
 *
 * SOURCE-OF-TRUTH RULE: the ONLY authorized payload for any automatic
 * restoration is a payload this module itself decoded from the customer's
 * OWN source pixels. Nothing here ever infers a payload from visible text,
 * a business name, a phone number, OCR, a filename, or any external
 * record.
 *
 * SECURITY: every payload handled here is untrusted customer data. This
 * module compares payloads for exact string equality and computes SHA-256
 * hashes of them for evidence — it never parses them as a URI, never
 * fetches/opens/resolves/executes them, and never logs the raw payload
 * text at a level broader than the narrowly-scoped restoration call chain
 * that legitimately needs it in memory (see `qr-restore.ts`).
 */

import { createHash } from "node:crypto";

import type {
  DecodedMachineReadableRegion,
  MachineReadablePreservationCase,
  MachineReadablePreservationInstance,
  MachineReadablePreservationReport,
} from "./contracts";
import { decodeQrCodes, scanForQrFinderCenters, scanForQrFinderPatterns, type RgbaImage } from "./qr-detect-decode";
import { deriveRegionKey } from "./qr-resolution";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Worst-case ordering, used both to pick one instance's result and to fold
 * multiple instances into `overall`. Index = severity rank, higher = worse.
 * `accepted_as_supplied` never appears in this function's OWN output (it
 * is a resolution-time transform — see `qr-resolution.ts`'s own copy of
 * this ordering) but must still be listed for TypeScript's exhaustiveness
 * check over `MachineReadablePreservationCase`; its rank matches the
 * shared ordering exactly (worse than `pass`, better than `review_required`).
 */
const CASE_SEVERITY: Record<MachineReadablePreservationCase, number> = {
  not_applicable: 0,
  pass: 1,
  accepted_as_supplied: 2,
  review_required: 3,
  fail: 4,
  hard_fail: 5,
};

function worstCase(cases: readonly MachineReadablePreservationCase[]): MachineReadablePreservationCase {
  let worst: MachineReadablePreservationCase = "not_applicable";
  for (const c of cases) {
    if (CASE_SEVERITY[c] > CASE_SEVERITY[worst]) worst = c;
  }
  return worst;
}

/**
 * Detects and decodes every QR in `source`, then attempts to find and
 * verify the same instance's counterpart in `candidate`, applying the
 * 5-case model to each. Matching a source instance to its candidate
 * counterpart is done by DECODE FIRST (if the candidate decodes the exact
 * same payload anywhere, that is obviously the match — CASE 1 regardless
 * of position), then by proportional position (see
 * `resolveCandidateRegionForSourceRegion` in `qr-restore.ts` for the
 * region-mapping half of this — this function only needs to know WHETHER
 * a plausible candidate counterpart exists, not exactly where, to decide
 * `"fail"` vs `"hard_fail"` vs `"review_required"`).
 *
 * Deliberately does not attempt cross-image geometric alignment beyond
 * "does the candidate contain a QR-shaped region at all" — the caller
 * (`qr-restore.ts`) is responsible for any transform-aware region mapping
 * needed for actual pixel repair; this function's job is only to produce
 * the truthful preservation VERDICT.
 */
export function compareMachineReadableContent(
  source: RgbaImage,
  candidate: RgbaImage,
): MachineReadablePreservationReport {
  const sourceDecoded = decodeQrCodes(source);
  const sourceUndecoded =
    sourceDecoded.length === 0 ? scanForQrFinderPatterns(source) : [];

  if (sourceDecoded.length === 0 && sourceUndecoded.length === 0) {
    // CASE 5 — nothing detected in the source at all.
    return { instances: [], overall: "not_applicable" };
  }

  const candidateDecoded = decodeQrCodes(candidate);
  const instances: MachineReadablePreservationInstance[] = [];

  // One instance per DECODED source QR (the common, and only fully
  // trustworthy, case) — matched against the candidate's own decoded set
  // by consuming the first still-unclaimed candidate decode. Order is not
  // semantically meaningful (jsQR imposes no stable ordering across
  // instances) — `id` is assigned by discovery order purely for a stable
  // per-report identity, never as a claim about which physical region is
  // "first".
  const claimedCandidateIndices = new Set<number>();
  let ordinal = 0;
  for (const src of sourceDecoded) {
    ordinal += 1;
    const id = `qr-${ordinal}`;
    const matchIndex = candidateDecoded.findIndex(
      (c, i) => !claimedCandidateIndices.has(i) && c.payload === src.payload,
    );
    if (matchIndex >= 0) {
      claimedCandidateIndices.add(matchIndex);
      instances.push(
        buildInstance(id, src, candidateDecoded[matchIndex], "pass"),
      );
      continue;
    }

    // No candidate decoded the SAME payload. Is there an unclaimed
    // candidate decode at all (a different payload — hard fail), or none
    // (fail)?
    const anyUnclaimedIndex = candidateDecoded.findIndex(
      (_, i) => !claimedCandidateIndices.has(i),
    );
    if (anyUnclaimedIndex >= 0) {
      claimedCandidateIndices.add(anyUnclaimedIndex);
      instances.push(
        buildInstance(id, src, candidateDecoded[anyUnclaimedIndex], "hard_fail"),
      );
      continue;
    }

    instances.push(buildInstance(id, src, null, "fail"));
  }

  // Source instances that were DETECTED (finder-pattern signature) but not
  // decoded at all — review_required regardless of the candidate's own
  // state, per this module's own doc above (the SOURCE was never verified,
  // so nothing about the candidate can prove preservation here). Candidate
  // decode info is still recorded on the instance (position-blind, same
  // "claim from the remaining pool" pattern the decoded-source loop above
  // uses) purely as evidence — `qr-resolution.ts`'s `applyQrResolutions`
  // is what actually decides whether that happens to already match a
  // customer-confirmed destination; this function makes no such judgment.
  // QR LOCALIZATION V3: `scanForQrFinderPatterns` only ever reports 0 or 1
  // undecoded region per source image (an existing, pre-dating limitation
  // — see that function's own doc), so the individual confirmed finder
  // centers computed here always belong to `sourceUndecoded[0]` when it
  // exists. Computed once per source, not per-instance.
  const sourceFinderCenters = sourceUndecoded.length > 0 ? scanForQrFinderCenters(source) : [];

  for (const undecoded of sourceUndecoded) {
    ordinal += 1;
    const matchIndex = candidateDecoded.findIndex((_, i) => !claimedCandidateIndices.has(i));
    const candidateMatch = matchIndex >= 0 ? candidateDecoded[matchIndex] : null;
    if (matchIndex >= 0) claimedCandidateIndices.add(matchIndex);
    instances.push({
      id: `qr-${ordinal}`,
      kind: undecoded.kind,
      sourceBounds: undecoded.bounds,
      sourceDecodable: false,
      sourcePayloadSha256: null,
      candidateBounds: candidateMatch?.bounds ?? null,
      candidateDecodable: candidateMatch !== null,
      candidatePayloadSha256: candidateMatch ? sha256Hex(candidateMatch.payload) : null,
      result: "review_required",
      provenance: null,
      regionKey: deriveRegionKey(undecoded.bounds),
      sourceLocalizationConfidence: undecoded.localizationConfidence,
      sourceFinderCenters,
    });
  }

  return { instances, overall: worstCase(instances.map((i) => i.result)) };
}

function buildInstance(
  id: string,
  source: DecodedMachineReadableRegion,
  candidate: DecodedMachineReadableRegion | null,
  result: MachineReadablePreservationCase,
): MachineReadablePreservationInstance {
  return {
    id,
    kind: source.kind,
    sourceBounds: source.bounds,
    sourceDecodable: true,
    sourcePayloadSha256: sha256Hex(source.payload),
    candidateBounds: candidate?.bounds ?? null,
    candidateDecodable: candidate !== null,
    candidatePayloadSha256: candidate ? sha256Hex(candidate.payload) : null,
    result,
    // A decoded SOURCE (this function is only ever called for one) is the
    // only path `compareMachineReadableContent` itself produces `"pass"`
    // through — always the automatic, verified-from-source path. See
    // `qr-resolution.ts`'s own doc for the OTHER way `"pass"` can arise
    // (a confirmed destination, applied downstream of this function).
    provenance: result === "pass" ? "verified_from_source_qr" : null,
    regionKey: deriveRegionKey(source.bounds),
    // A DECODED source's bounds come from jsQR's own precise located
    // corners — a fundamentally different, more trustworthy kind of
    // evidence the low/high confidence concept doesn't apply to.
    sourceLocalizationConfidence: null,
    sourceFinderCenters: [],
  };
}
