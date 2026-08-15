import type {
  ConceptGenerationRequest,
  ConceptGenerationResult,
} from "@/capabilities/shared/contracts";
import type { ConceptDirectionKey } from "@/lib/domain/types";

/**
 * Provider port for concept generation.
 * Domain and capabilities depend on this interface only — never concrete vendors.
 */
export interface ConceptGenerationProvider {
  readonly providerKey: string;
  /**
   * True Source-Image Targeted Revision: whether this adapter performs a
   * targeted revision as a real EDIT of the selected source artwork.
   *
   * When `true`, `GenerationWorkerCapability` must resolve and supply
   * `ConceptGenerationRequest.sourceArtwork` for every targeted revision,
   * and MUST fail the job if it cannot — never degrade to text-to-image.
   *
   * `false` only for adapters that produce no real artwork at all (the
   * placeholder stub, the unavailable stub). Those have no source pixels to
   * edit and no image to preserve, so there is no fidelity to lose; they
   * are never reachable in a configured production environment. Any adapter
   * that DOES call an image model must declare `true` — and independently
   * refuse a targeted revision that arrives without source artwork, so the
   * guarantee never rests on the worker alone.
   */
  readonly editsSourceArtwork: boolean;
  /**
   * Sprint A4 Correction 3: LOCAL readiness to attempt an external request.
   *
   * WHAT IT ANSWERS
   *
   *   "Is this adapter configured well enough that calling `generate` would
   *    actually put a request on the wire?"
   *
   * WHAT IT DOES NOT ANSWER, and must never be read as answering:
   *
   *   - whether the remote provider is up
   *   - whether a request will succeed
   *   - whether anything will be, or has been, billed
   *
   * MUST NOT make a network call of any kind — no probe request, no test
   * generation, no health endpoint. A preflight that talks to the provider
   * would either cost money or turn a remote hiccup into a refusal to
   * attempt work the customer is waiting for. It checks credentials,
   * enablement, and local configuration, and nothing else.
   *
   * Throws (conventionally `GenerationUnavailableError`) when it cannot.
   * Returning normally is a statement about THIS PROCESS only.
   *
   * WHY IT EXISTS: the paid-image executor claims a durable physical
   * dispatch immediately before calling `generate`, and for the acquisition
   * free concept that claim is the customer's ONLY attempt. Without this,
   * an adapter that fails on configuration — `UnavailableConceptGenerationProvider`
   * is exactly that — consumed the attempt while making zero external
   * requests: a definite local failure charged to the customer.
   *
   * OPTIONAL. An adapter that has no configuration to get wrong (the
   * placeholder stub, the fakes tests are written against) can omit it, and
   * absence is read as "ready" — which is true of them.
   */
  assertReadyToDispatch?(): Promise<void> | void;
  generate(
    request: ConceptGenerationRequest,
  ): Promise<ConceptGenerationResult>;
  /**
   * Phase 2C0.5: generate EXACTLY ONE catalog direction.
   *
   * Why this exists: `generate` produces the whole three-direction batch in
   * one call, which meant the platform could not durably record that Bold
   * and Soft had already been paid for until Minimal also finished. A
   * worker reclaim after a late failure therefore re-billed images the
   * platform already owned. Driving the loop from
   * `GenerationWorkerCapability` — one paid provider dispatch per call —
   * is what lets each direction be checkpointed the moment it succeeds.
   *
   * OPTIONAL on purpose. An adapter that produces no real artwork (the
   * placeholder and unavailable stubs) has no paid unit to split apart, and
   * neither do the fake providers existing tests are written against.
   * Where this is absent the worker treats the whole batch as ONE logical
   * paid intent — still durable, still at-most-once, just coarser. Any
   * adapter that actually spends money should implement it.
   *
   * Must produce exactly one concept, in `directionKey`, and must apply the
   * same retry/error-classification rules as `generate`.
   */
  generateDirection?(
    request: ConceptGenerationRequest,
    directionKey: ConceptDirectionKey,
  ): Promise<ConceptGenerationResult>;
}
