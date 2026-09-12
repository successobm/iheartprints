/**
 * Phase R5: `ArtworkFidelityVerificationCapability` — the smallest v1
 * post-reconstruction fidelity verification authority (Section 16 of the
 * R4B audit / Section T of this phase's own report).
 *
 * WHY THIS REUSES `ArtworkFidelityProposalProvider` (the PORT, not the
 * PERSISTING `ArtworkFidelityProposalCapability`): that provider is already
 * a stateless, pure "bytes in, wording/marks facts out" analyzer with no
 * knowledge of projects, contracts, or persistence — exactly the shape
 * this verification needs, run a SECOND time against the reconstructed
 * candidate instead of the original source. Going through
 * `ArtworkFidelityProposalCapability` instead would wrongly imply the
 * candidate is a new source of TRUTH to persist a contract for — it is
 * something to verify AGAINST existing confirmed truth, never a new
 * proposal to confirm. This module therefore takes the provider PORT
 * directly (same interface, same resolver
 * `resolveArtworkFidelityProposalProvider` the proposal capability itself
 * uses), never the higher persistence-oriented capability.
 *
 * WORDING: exact-match only, never fuzzy — mirrors the SAME
 * normalize-then-compare discipline `openai-concept-evaluation-provider
 * .ts`'s own `wordingMatches`/`normalizeWordingText` established (a small,
 * deliberate LOCAL duplication rather than importing a private, unexported
 * function across a capability boundary — the same "duplicating ~12 lines
 * here is cheaper than a cross-capability dependency" precedent
 * `artwork-fidelity-contract-identity.ts`'s own `stableStringify` already
 * set). This is exactly what catches the historical R1/R2 regression:
 * "ESTABLISHED PROVISIONS" reconstructed as "ESTABLISHED PRODUCTS" fails
 * this check.
 *
 * MARKS: NEVER an automatic verdict. R2/R3's own regression proof (™
 * became ® in 2/2 independent reconstructions) is exactly why this
 * capability exposes mark evidence as ADVISORY ONLY — the customer's own
 * explicit approval (`RasterReconstructionCapability.approveCandidate`,
 * gated by the UI on an explicit mark confirmation) is what a machine
 * verdict alone must never be allowed to satisfy.
 */

import type { ArtworkFidelityProposalProvider } from "@/capabilities/artwork-fidelity-proposal";

import type { ReconstructionVerificationResult } from "./contracts";

/**
 * Mirrors `openai-concept-evaluation-provider.ts`'s own
 * `normalizeWordingText`/`wordingMatches` exactly (lowercase, punctuation
 * collapsed to spaces, whitespace collapsed) — deliberately not a
 * fuzzy/substring match: required wording must appear exactly, so a
 * missing plural or an invented extra word both count as a miss.
 */
function normalizeWordingText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function wordingMatches(required: string, detected: string): boolean {
  const normalizedRequired = normalizeWordingText(required);
  if (!normalizedRequired) return true;
  return normalizedRequired === normalizeWordingText(detected);
}

export interface ArtworkFidelityVerificationCapability {
  /**
   * Never throws for a provider failure — degrades to `wordingVerified:
   * null`/`advisoryMarks: null` (never silently "verified", and never
   * confused with a genuine failed match) exactly like
   * `ArtworkFidelityProposalCapability`'s own advisory-only discipline.
   */
  verifyReconstructionWording(
    candidateBytes: Buffer,
    candidateContentType: string,
    confirmedWording: string[],
  ): Promise<ReconstructionVerificationResult>;
}

export function createArtworkFidelityVerificationCapability(
  provider: ArtworkFidelityProposalProvider,
): ArtworkFidelityVerificationCapability {
  return {
    async verifyReconstructionWording(candidateBytes, candidateContentType, confirmedWording) {
      let result;
      try {
        result = await provider.propose({
          bytes: candidateBytes,
          contentType: candidateContentType,
        });
      } catch {
        return { wordingVerified: null, missingWording: [...confirmedWording], advisoryMarks: null };
      }
      if (!result.analyzed) {
        return { wordingVerified: null, missingWording: [...confirmedWording], advisoryMarks: null };
      }

      const detectedTexts = result.wording
        .map((entry) => entry.text)
        .filter((text): text is string => typeof text === "string" && text.length > 0);

      const missingWording = confirmedWording.filter(
        (required) => !detectedTexts.some((detected) => wordingMatches(required, detected)),
      );

      return {
        wordingVerified: missingWording.length === 0,
        missingWording,
        advisoryMarks: result.protectedMarks.map((mark) => mark.classification),
      };
    },
  };
}
