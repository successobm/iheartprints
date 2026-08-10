import type {
  ConceptGenerationRequest,
  ConceptGenerationResult,
} from "@/capabilities/shared/contracts";

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
  generate(
    request: ConceptGenerationRequest,
  ): Promise<ConceptGenerationResult>;
}
