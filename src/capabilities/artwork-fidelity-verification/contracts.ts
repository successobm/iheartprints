import type { MarkClassificationProposal } from "@/capabilities/artwork-fidelity-proposal";

/**
 * Phase R5 (Section T of the audit report / Section 16 of the R4B task):
 * per-fact-class verification result for one reconstruction candidate.
 * Deliberately narrow — only wording gets an automatic pass/fail; marks are
 * ALWAYS advisory (R2/R3 proved automatic mark classification unreliable —
 * a reproducible ™->® substitution in 2/2 runs — so this type structurally
 * cannot claim an automatic mark verdict).
 */
export interface ReconstructionVerificationResult {
  /** `true` only when EVERY confirmed wording entry was found, exact match, in the candidate — never fuzzy. `null` means the verification provider itself was unavailable (never treated the same as a genuine failed match). */
  wordingVerified: boolean | null;
  /** Confirmed wording entries NOT found, exact match, in the candidate. */
  missingWording: string[];
  /** Advisory-only machine evidence for the customer's own mark review — NEVER an automatic verification verdict. `null` when the verification provider was unavailable. */
  advisoryMarks: MarkClassificationProposal[] | null;
}
