/**
 * Signs Phase S4.2A: the pluggable semantic (multimodal) preservation
 * verification boundary — a narrow port mirroring `ConceptEvaluationProvider`
 * ís own shape (`providerKey` + one async method + provider-neutral
 * request/result), never a generic "vision judge" abstraction (none exists
 * in this repository; none is invented beyond what this task needs).
 *
 * Implementations own 100% of their own prompt dialect, request shape, and
 * response parsing internally — the capability layer never sees provider-
 * specific request/response shapes, only this contract.
 */

export interface SignPreservationSemanticImageInput {
  /** A self-contained `data:image/png;base64,...` URI — never a signed/expiring URL, since crops are DERIVED in-process, not read from asset storage. */
  dataUri: string;
  /** Bounded, human-readable label for prompt/debugging use only (e.g. "source overview", "reconstruction grid cell 1,2") — never persisted with the request payload itself. */
  label: string;
}

export interface SignPreservationSemanticRequest {
  sourceOverview: SignPreservationSemanticImageInput;
  reconstructionOverview: SignPreservationSemanticImageInput;
  /** Exactly `SIGN_PRESERVATION_GRID_COLUMNS * SIGN_PRESERVATION_GRID_ROWS` entries, source-resolution native crops, grid order. */
  sourceCrops: SignPreservationSemanticImageInput[];
  /** Same grid order/count as `sourceCrops` — reconstruction-resolution native crops of the geometrically corresponding region, never downsampled. */
  reconstructionCrops: SignPreservationSemanticImageInput[];
  /**
   * Deterministic, caller-computed identity for this exact comparison
   * (never provider-generated) — implementations MAY use it for their own
   * request-level dedupe, but the platform's own idempotency
   * (`unique(final_asset_id, verification_algorithm_version)`) is what
   * actually guards duplicate persistence.
   */
  idempotencyKey: string;
}

export interface SignPreservationSemanticProviderResult {
  /** Exactly one answer per `SIGN_PRESERVATION_SEMANTIC_CATEGORIES` entry — validated by the ORCHESTRATOR (`validateSemanticAnswers`), never trusted as pre-validated by the provider. */
  answers: import("./contracts").SignPreservationSemanticAnswer[];
  /** The provider's own request/response identifier, when it has one — never fabricated. */
  providerRequestId: string | null;
  /** Bounded, already-summarized diagnostic data — never the full raw payload, never image bytes. */
  rawResponseSummary: Record<string, unknown> | null;
  tokenUsage: { inputTokens: number | null; outputTokens: number | null } | null;
}

/**
 * A provider capable of comparing two artwork representations against the
 * seven fixed closed questions. Implementations MUST throw a
 * `ProviderError` (never resolve with a malformed/partial result) for any
 * transport, timeout, rate-limit, or schema failure — see
 * `sign-preservation-capability.ts` §9 for the exact "completed vs
 * incomplete attempt" distinction this depends on.
 */
export interface SignPreservationSemanticProvider {
  readonly providerKey: string;
  /**
   * The exact model identity component included in the combined
   * verification-algorithm-version string (e.g. a real adapter's pinned
   * model id/snapshot; a fixed literal for a fake/placeholder). MUST
   * change whenever the underlying model or its behavior changes.
   */
  readonly modelIdentity: string;
  compare(
    request: SignPreservationSemanticRequest,
  ): Promise<SignPreservationSemanticProviderResult>;
}
