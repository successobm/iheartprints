/**
 * Signs Phase S4.2A: the safe, network-free default — mirrors
 * `PlaceholderConceptEvaluationProvider`'s own role exactly. Used by
 * `resolve-sign-preservation-semantic-provider.ts` whenever no real
 * provider is configured, and unconditionally forced by
 * `isAutomatedTestEnvironment()` regardless of ambient configuration.
 *
 * Answers every category `cannot_determine` — never `same`, so this can
 * never, by construction, produce `preservationStatus = preserved`. This
 * is the honest "we did not actually look" answer, not an optimistic
 * guess. Distinct from `FakeSignPreservationSemanticProvider`: that one is
 * a TEST-ONLY double with configurable scenarios and a dispatch counter,
 * constructed explicitly by test files; this one is the production-safe
 * fallback the resolver reaches for.
 */

import { SIGN_PRESERVATION_SEMANTIC_CATEGORIES } from "./contracts";
import type {
  SignPreservationSemanticProvider,
  SignPreservationSemanticProviderResult,
  SignPreservationSemanticRequest,
} from "./sign-preservation-semantic-provider";

export class PlaceholderSignPreservationSemanticProvider implements SignPreservationSemanticProvider {
  readonly providerKey = "placeholder_sign_preservation_semantic";
  readonly modelIdentity = "none";

  async compare(
    _request: SignPreservationSemanticRequest,
  ): Promise<SignPreservationSemanticProviderResult> {
    return {
      answers: SIGN_PRESERVATION_SEMANTIC_CATEGORIES.map((category) => ({
        category,
        answer: "cannot_determine" as const,
        reason: "No real semantic preservation provider is configured.",
        regionReference: null,
      })),
      providerRequestId: null,
      rawResponseSummary: null,
      tokenUsage: null,
    };
  }
}
