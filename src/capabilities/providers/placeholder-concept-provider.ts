import { randomUUID } from "crypto";

import { buildPlaceholderConcepts } from "@/lib/domain/concepts";
import type { TShirtDesignBrief } from "@/lib/domain/types";
import type {
  ConceptGenerationRequest,
  ConceptGenerationResult,
} from "@/capabilities/shared/contracts";
import type { ConceptGenerationProvider } from "./concept-generation-provider";

/**
 * Sprint 1 / 2C placeholder adapter. No external AI provider.
 * Translates brief fields into concept card drafts only.
 */
export class PlaceholderConceptProvider implements ConceptGenerationProvider {
  readonly providerKey = "placeholder";

  constructor(private readonly getBrief: (designId: string) => Promise<TShirtDesignBrief>) {}

  async generate(
    request: ConceptGenerationRequest,
  ): Promise<ConceptGenerationResult> {
    const brief = await this.getBrief(request.designId);
    const seeds = buildPlaceholderConcepts(brief).slice(0, request.conceptCount);

    return {
      jobId: randomUUID(),
      providerKey: "placeholder",
      concepts: seeds.map((seed) => ({
        ...seed,
        kind: "concept" as const,
      })),
    };
  }
}
