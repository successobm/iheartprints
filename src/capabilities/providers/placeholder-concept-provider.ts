import { buildPlaceholderConcepts } from "@/lib/domain/concepts";
import type {
  ConceptGenerationRequest,
  ConceptGenerationResult,
} from "@/capabilities/shared/contracts";
import type { ConceptGenerationProvider } from "./concept-generation-provider";

/**
 * Sprint 1 / 2C placeholder adapter, updated in Sprint 2H Part 1 to take the
 * same provider-neutral `GenerationPromptRequest` a real provider does
 * (rather than re-fetching the brief itself) — it is now a pure function of
 * its request, with no repository or Design Brief access, exactly like any
 * other provider adapter. No external AI provider. Translates the prompt
 * request into concept card drafts only.
 */
export class PlaceholderConceptProvider implements ConceptGenerationProvider {
  readonly providerKey = "placeholder";
  /**
   * True Source-Image Targeted Revision: this stub produces no image bytes
   * at all, so a "source concept" here has no pixels to edit and no
   * fidelity to preserve. Declaring `false` keeps the worker from demanding
   * source artwork that, by this provider's own design, cannot exist —
   * without weakening the guarantee anywhere it matters, since this
   * provider is never reachable in a configured production environment.
   */
  readonly editsSourceArtwork = false;

  async generate(
    request: ConceptGenerationRequest,
  ): Promise<ConceptGenerationResult> {
    // Sprint 2G Live Acceptance Corrective Pass: `buildPlaceholderConcepts`
    // already returns exactly one seed when the request targets a specific
    // direction (a single-concept revision) — the `.slice` below is only a
    // defensive backstop for the ordinary three-direction case.
    const seeds = buildPlaceholderConcepts(request.prompt).slice(
      0,
      request.conceptCount,
    );

    return {
      jobId: request.idempotencyKey,
      providerKey: this.providerKey,
      concepts: seeds.map((seed) => ({
        ...seed,
        kind: request.prompt.targetConceptDirectionKey ? "revision" : "concept",
      })),
    };
  }
}
