import { withRetry } from "@/capabilities/shared/retry";
import type {
  ConceptGenerationRequest,
  ConceptGenerationResult,
  GeneratedConceptDraft,
} from "@/capabilities/shared/contracts";
import {
  CONCEPT_DIRECTIONS,
  describeConceptDirection,
  type ConceptDirection,
} from "@/lib/domain/concept-directions";
import type { GenerationPromptRequest } from "@/lib/domain/types";
import type { ConceptGenerationProvider } from "./concept-generation-provider";
import { isRetryableProviderError, ProviderError } from "./provider-error";

const MAX_ATTEMPTS_PER_IMAGE = 3;
const IMAGE_SIZE = "1024x1024";
const OPENAI_IMAGES_ENDPOINT = "https://api.openai.com/v1/images/generations";

export interface OpenAIProviderConfig {
  apiKey: string;
  model: string;
  /** Injectable for tests — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests — defaults to a real timer. */
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * Sprint 2H Part 1: the first real (non-placeholder) generation provider.
 * Receives only the provider-neutral `GenerationPromptRequest` — never the
 * raw Design Brief — and owns 100% of the OpenAI-specific prompt dialect,
 * request shape, and response parsing internally. None of that ever leaves
 * this file: it is not exported, not logged to a customer-visible surface,
 * and not persisted onto the Design Brief.
 */
export class OpenAIConceptGenerationProvider
  implements ConceptGenerationProvider
{
  readonly providerKey = "openai";

  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(config: OpenAIProviderConfig) {
    if (!config.apiKey) {
      throw new Error("OpenAIConceptGenerationProvider requires an API key");
    }
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.sleepImpl = config.sleepImpl ?? defaultSleep;
  }

  async generate(
    request: ConceptGenerationRequest,
  ): Promise<ConceptGenerationResult> {
    const directions = CONCEPT_DIRECTIONS.slice(0, request.conceptCount);
    const concepts: GeneratedConceptDraft[] = [];

    for (const [index, direction] of directions.entries()) {
      const prompt = buildPrompt(request.prompt, direction);
      const image = await withRetry(() => this.requestImage(prompt), {
        attempts: MAX_ATTEMPTS_PER_IMAGE,
        isRetryable: isRetryableProviderError,
        delayMs: (attempt) => 250 * attempt,
        sleep: this.sleepImpl,
      });

      concepts.push({
        versionNumber: index + 1,
        title: direction.title,
        summary: describeConceptDirection(direction, request.prompt),
        placeholderLabel: direction.placeholderLabel,
        accentColor: direction.accentColor,
        kind: "concept",
        asset: {
          imageBytes: image.bytes,
          contentType: "image/png",
          widthPx: image.widthPx,
          heightPx: image.heightPx,
          hasTransparency: true,
          providerMetadata: image.metadata,
        },
      });
    }

    return {
      jobId: request.idempotencyKey,
      providerKey: this.providerKey,
      concepts,
    };
  }

  private async requestImage(prompt: string): Promise<{
    bytes: Buffer;
    widthPx: number;
    heightPx: number;
    metadata: Record<string, unknown>;
  }> {
    let response: Response;
    try {
      response = await this.fetchImpl(OPENAI_IMAGES_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          prompt,
          size: IMAGE_SIZE,
          background: "transparent",
          n: 1,
        }),
      });
    } catch {
      throw new ProviderError(
        "network",
        "The artwork provider could not be reached.",
      );
    }

    if (response.status === 429) {
      throw new ProviderError(
        "rate_limited",
        "The artwork provider is rate-limiting requests right now.",
      );
    }
    if (response.status >= 500) {
      throw new ProviderError(
        "unavailable",
        "The artwork provider is temporarily unavailable.",
      );
    }
    if (!response.ok) {
      throw new ProviderError(
        "malformed_response",
        `The artwork provider returned an unexpected status (${response.status}).`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ProviderError(
        "malformed_response",
        "The artwork provider returned an unreadable response.",
      );
    }

    const image = extractImage(payload);
    if (!image) {
      throw new ProviderError(
        "malformed_response",
        "The artwork provider response did not include image data.",
      );
    }

    const [widthPx, heightPx] = IMAGE_SIZE.split("x").map(Number) as [
      number,
      number,
    ];
    return {
      bytes: Buffer.from(image.b64, "base64"),
      widthPx,
      heightPx,
      // Sanitized: intentionally excludes the provider's echoed/revised
      // prompt text — never store prompt language anywhere downstream.
      metadata: {
        generatedAt: new Date().toISOString(),
        sizeRequested: IMAGE_SIZE,
      },
    };
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Provider-specific prompt dialect lives only here. Never exported, never
 * persisted, never shown to a customer.
 *
 * Sprint 2K Phase 3: `direction` supplies the plain-language differentiation
 * content (Goal 5 — composition/typography/illustration density/iconography
 * /layout/hierarchy) from the shared, provider-neutral catalog; only the
 * OpenAI-dialect phrasing that stitches it together lives here.
 * `prompt.inspirationReferences` and `prompt.allowAdditionalText` carry the
 * Goal 4/7 guardrails through from Prompt Translation.
 */
function buildPrompt(
  prompt: GenerationPromptRequest,
  direction: ConceptDirection,
): string {
  const parts = [
    `Print-ready apparel graphic for ${prompt.product}.`,
    `Subject: ${prompt.subject}.`,
    `Creative direction — ${direction.title}: ${direction.composition}.`,
    `Typography: ${direction.typographyEmphasis}.`,
    `Illustration density: ${direction.illustrationDensity}.`,
    `Iconography: ${direction.iconography}.`,
    `Layout: ${direction.layout}.`,
    `Visual hierarchy: ${direction.visualHierarchy}.`,
  ];
  if (prompt.style) parts.push(`Style: ${prompt.style}.`);
  if (prompt.colors.length > 0) {
    parts.push(`Preferred colors: ${prompt.colors.join(", ")}.`);
  }
  if (prompt.productColor) {
    parts.push(
      `Will be printed on a ${prompt.productColor} garment — keep contrast strong against it.`,
    );
  }
  if (prompt.requiredWording) {
    parts.push(
      `Include this exact wording, spelled correctly, and no other wording: "${prompt.requiredWording}".`,
    );
  }
  // Sprint 2K Phase 3 (Goal 7): explicit, deterministic instruction against
  // inventing text — driven by the provider-neutral `allowAdditionalText`
  // flag rather than being a one-off OpenAI-only afterthought.
  if (!prompt.allowAdditionalText) {
    parts.push(
      "Do not add any other text, letters, words, dates, or slogans beyond the exact wording specified above.",
    );
  }
  // Sprint 2K Phase 3 (Goal 4): a stylistic/era/pop-culture reference the
  // customer gave is inspiration for visual language only — never an
  // instruction to depict the referenced people, characters, or logos.
  if (prompt.inspirationReferences.length > 0) {
    parts.push(
      `Style inspiration only (do not depict as literal content): ${prompt.inspirationReferences.join("; ")}.`,
      "Do not depict recognizable real people, TV/movie characters, sports mascots, band members, or any copyrighted logo or artwork from a referenced work — reinterpret only the general era, mood, and graphic language.",
    );
  }
  if (prompt.exclusions) {
    parts.push(`Avoid: ${prompt.exclusions}.`);
  }
  parts.push(
    "Clean vector-style illustration, transparent background, centered composition, no watermark, no mockup, no photograph of a shirt — artwork only.",
  );
  return parts.join(" ");
}

function extractImage(payload: unknown): { b64: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0];
  if (!first || typeof first !== "object") return null;
  const b64 = (first as { b64_json?: unknown }).b64_json;
  if (typeof b64 === "string" && b64.length > 0) return { b64 };
  return null;
}
