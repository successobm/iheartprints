/**
 * Signs Phase S4.2A: a mocked/fake `SignPreservationSemanticProvider` test
 * double — no network access, ever. Exists purely to prove the
 * capability's own dispatch, composition, idempotency, and failure-mode
 * behavior WITHOUT spending a real semantic-provider credit, mirroring
 * `FakeSignReconstructionProvider`'s established S3A convention exactly
 * (`dispatchCount`, injectable `behavior`).
 */

import { ProviderError } from "@/capabilities/providers/provider-error";

import { SIGN_PRESERVATION_SEMANTIC_CATEGORIES, type SignPreservationSemanticAnswer } from "./contracts";
import type {
  SignPreservationSemanticProvider,
  SignPreservationSemanticProviderResult,
  SignPreservationSemanticRequest,
} from "./sign-preservation-semantic-provider";

export type FakeSignPreservationSemanticBehavior =
  | { kind: "all_same" }
  | { kind: "changed_price" }
  | { kind: "changed_numeral" }
  | { kind: "changed_wording" }
  | { kind: "changed_face" }
  | { kind: "missing_object" }
  | { kind: "invented_object" }
  | { kind: "crop_loss" }
  | { kind: "cannot_determine" }
  | { kind: "all_not_applicable" }
  /** Returns structurally invalid answers (a missing category) WITHOUT throwing — proves the ORCHESTRATOR's own `validateSemanticAnswers` catches this, not just providers that self-report failure. */
  | { kind: "malformed_result" }
  | { kind: "provider_timeout" };

const CHANGED_CATEGORY_FOR_BEHAVIOR: Partial<
  Record<FakeSignPreservationSemanticBehavior["kind"], (typeof SIGN_PRESERVATION_SEMANTIC_CATEGORIES)[number]>
> = {
  changed_price: "numerals_prices",
  changed_numeral: "numerals_prices",
  changed_wording: "wording",
  changed_face: "people_faces",
  missing_object: "meaningful_objects",
  invented_object: "added_removed_invented",
  crop_loss: "meaningful_crop_loss",
};

export class FakeSignPreservationSemanticProvider implements SignPreservationSemanticProvider {
  readonly providerKey = "fake_sign_preservation_semantic_v1";
  /** Overridable only via the constructor — a test proving identity changes across model versions constructs a second instance with a different value, never a subclass. */
  readonly modelIdentity: string;

  /** Number of `compare()` invocations this instance has actually made — mirrors `FakeSignReconstructionProvider.dispatchCount` exactly. */
  dispatchCount = 0;

  behavior: FakeSignPreservationSemanticBehavior = { kind: "all_same" };

  private sequence = 0;

  constructor(modelIdentity = "fake-model-v1") {
    this.modelIdentity = modelIdentity;
  }

  async compare(
    _request: SignPreservationSemanticRequest,
  ): Promise<SignPreservationSemanticProviderResult> {
    this.dispatchCount += 1;
    const behavior = this.behavior;

    if (behavior.kind === "provider_timeout") {
      throw new ProviderError("unavailable", "The fake semantic provider timed out.");
    }

    const providerRequestId = `fake-sign-preservation-semantic-${++this.sequence}`;

    if (behavior.kind === "malformed_result") {
      // Deliberately drops one required category — structurally invalid,
      // but no exception thrown, so this exercises the ORCHESTRATOR's own
      // validation rather than a provider-level error path.
      const incompleteAnswers = SIGN_PRESERVATION_SEMANTIC_CATEGORIES.slice(0, -1).map(
        (category): SignPreservationSemanticAnswer => ({
          category,
          answer: "same",
          reason: "fake: malformed result fixture",
          regionReference: null,
        }),
      );
      return {
        answers: incompleteAnswers,
        providerRequestId,
        rawResponseSummary: { fixture: "malformed_result" },
        tokenUsage: null,
      };
    }

    if (behavior.kind === "all_not_applicable") {
      return {
        answers: SIGN_PRESERVATION_SEMANTIC_CATEGORIES.map((category) => ({
          category,
          answer: "not_applicable" as const,
          reason: "fake: nothing of this category is present in this artwork",
          regionReference: null,
        })),
        providerRequestId,
        rawResponseSummary: { fixture: "all_not_applicable" },
        tokenUsage: { inputTokens: 1000, outputTokens: 50 },
      };
    }

    if (behavior.kind === "cannot_determine") {
      return {
        answers: SIGN_PRESERVATION_SEMANTIC_CATEGORIES.map((category) => ({
          category,
          answer: category === "wording" ? ("cannot_determine" as const) : ("same" as const),
          reason:
            category === "wording"
              ? "fake: text too small/blurred to confidently compare"
              : "fake: unchanged",
          regionReference: null,
        })),
        providerRequestId,
        rawResponseSummary: { fixture: "cannot_determine" },
        tokenUsage: { inputTokens: 1000, outputTokens: 60 },
      };
    }

    const changedCategory = CHANGED_CATEGORY_FOR_BEHAVIOR[behavior.kind];
    if (changedCategory) {
      return {
        answers: SIGN_PRESERVATION_SEMANTIC_CATEGORIES.map((category) => ({
          category,
          answer: category === changedCategory ? ("changed" as const) : ("same" as const),
          reason:
            category === changedCategory
              ? `fake: ${behavior.kind} fixture — this category was deliberately marked changed`
              : "fake: unchanged",
          regionReference: category === changedCategory ? "grid cell (col 1, row 1)" : null,
        })),
        providerRequestId,
        rawResponseSummary: { fixture: behavior.kind },
        tokenUsage: { inputTokens: 1000, outputTokens: 70 },
      };
    }

    // "all_same" — the default, and the base case every other behavior
    // above is a controlled deviation from.
    return {
      answers: SIGN_PRESERVATION_SEMANTIC_CATEGORIES.map((category) => ({
        category,
        answer: "same" as const,
        reason: "fake: unchanged",
        regionReference: null,
      })),
      providerRequestId,
      rawResponseSummary: { fixture: "all_same" },
      tokenUsage: { inputTokens: 1000, outputTokens: 55 },
    };
  }
}
