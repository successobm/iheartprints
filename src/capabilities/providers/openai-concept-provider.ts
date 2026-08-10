import { withRetry } from "@/capabilities/shared/retry";
import type {
  ConceptGenerationRequest,
  ConceptGenerationResult,
  GeneratedConceptDraft,
  SourceArtworkImage,
} from "@/capabilities/shared/contracts";
import {
  CONCEPT_DIRECTIONS,
  describeConceptDirection,
  resolveConceptDirection,
  type ConceptDirection,
} from "@/lib/domain/concept-directions";
import type { GenerationPromptRequest } from "@/lib/domain/types";
import type { ConceptGenerationProvider } from "./concept-generation-provider";
import { isRetryableProviderError, ProviderError } from "./provider-error";

const MAX_ATTEMPTS_PER_IMAGE = 3;
const IMAGE_SIZE = "1024x1024";
const OPENAI_IMAGES_ENDPOINT = "https://api.openai.com/v1/images/generations";
/**
 * True Source-Image Targeted Revision: the EDIT endpoint. Distinct from
 * `/generations` in the one way that matters — it takes an input image, so
 * the result is a modification of the customer's actual selected concept
 * rather than a fresh interpretation of the brief.
 */
const OPENAI_IMAGE_EDITS_ENDPOINT = "https://api.openai.com/v1/images/edits";

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
 *
 * True Source-Image Targeted Revision: this adapter now serves TWO
 * genuinely different operations, and never confuses them.
 *
 *   INITIAL GENERATION / "show me alternatives"
 *     brief → text-to-image (`/v1/images/generations`) → 3 directions
 *
 *   TARGETED REVISION
 *     selected source artwork + explicit delta + preservation contract
 *       → image edit (`/v1/images/edits`) → exactly 1 revised concept
 *
 * A targeted revision with no source image is a hard error, never a
 * downgrade to the text-to-image path — see `generateTargetedRevision`.
 */
export class OpenAIConceptGenerationProvider
  implements ConceptGenerationProvider
{
  readonly providerKey = "openai";
  /** Targeted revisions go to `/v1/images/edits` with the real source pixels. */
  readonly editsSourceArtwork = true;

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
    // Sprint 2G Live Acceptance Corrective Pass: a targeted single-concept
    // revision generates exactly one image, in the SAME direction the
    // customer already selected — never a fresh three-direction
    // exploration (Constitution §14: a revision continues the same design
    // relationship).
    if (request.prompt.targetConceptDirectionKey) {
      return this.generateTargetedRevision(
        request,
        resolveConceptDirection(request.prompt.targetConceptDirectionKey),
      );
    }

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
        directionKey: direction.key,
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

  /**
   * True Source-Image Targeted Revision.
   *
   * REVISED ARTWORK = SELECTED SOURCE ARTWORK + CUSTOMER'S REQUESTED DELTA.
   *
   * Exactly one image, produced by EDITING `request.sourceArtwork`. There
   * is intentionally no `else` branch that falls back to `requestImage`:
   * a revision that quietly becomes a text-to-image generation is precisely
   * the defect this path exists to eliminate, and it is far worse than a
   * failure because it looks like a success.
   */
  private async generateTargetedRevision(
    request: ConceptGenerationRequest,
    direction: ConceptDirection,
  ): Promise<ConceptGenerationResult> {
    const source = request.sourceArtwork ?? null;
    if (!source || source.imageBytes.length === 0) {
      throw new ProviderError(
        "invalid_request",
        "A targeted revision requires the selected concept's artwork image.",
      );
    }

    const prompt = buildEditPrompt(request.prompt);
    const image = await withRetry(() => this.requestImageEdit(prompt, source), {
      attempts: MAX_ATTEMPTS_PER_IMAGE,
      isRetryable: isRetryableProviderError,
      delayMs: (attempt) => 250 * attempt,
      sleep: this.sleepImpl,
    });

    return {
      jobId: request.idempotencyKey,
      providerKey: this.providerKey,
      concepts: [
        {
          versionNumber: 1,
          title: direction.title,
          summary: describeConceptDirection(direction, request.prompt),
          placeholderLabel: direction.placeholderLabel,
          accentColor: direction.accentColor,
          kind: "revision",
          directionKey: direction.key,
          asset: {
            imageBytes: image.bytes,
            contentType: "image/png",
            widthPx: image.widthPx,
            heightPx: image.heightPx,
            hasTransparency: true,
            providerMetadata: image.metadata,
          },
        },
      ],
    };
  }

  private async requestImage(prompt: string): Promise<OpenAIImageResult> {
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

    return readImageResponse(response);
  }

  /**
   * True Source-Image Targeted Revision: the multipart image-edit call.
   *
   * Configured for the strongest source preservation the current model/API
   * supports:
   *   - `image`            the customer's actual selected concept
   *   - `input_fidelity`   "high" where the model supports it — the single
   *                        most important knob for keeping the untouched
   *                        parts of the artwork recognizably identical
   *   - `output_format`    png, and `background: transparent`, because the
   *                        print pipeline downstream requires a transparent
   *                        PNG (a revision must not silently gain a
   *                        background the original never had)
   *   - `n: 1`             a revision produces ONE revised concept, never a
   *                        fresh set of alternatives
   *
   * `content-type` is deliberately not set: `fetch` must generate the
   * multipart boundary itself. Retry/timeout/error classification are
   * shared verbatim with the text-to-image path.
   */
  private async requestImageEdit(
    prompt: string,
    source: SourceArtworkImage,
  ): Promise<OpenAIImageResult> {
    const form = new FormData();
    form.append("model", this.model);
    form.append("prompt", prompt);
    form.append("size", IMAGE_SIZE);
    form.append("background", "transparent");
    form.append("output_format", "png");
    form.append("n", "1");
    if (supportsInputFidelity(this.model)) {
      form.append("input_fidelity", "high");
    }
    form.append(
      "image",
      new Blob([new Uint8Array(source.imageBytes)], { type: source.contentType }),
      `source${extensionForContentType(source.contentType)}`,
    );

    let response: Response;
    try {
      response = await this.fetchImpl(OPENAI_IMAGE_EDITS_ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: form,
      });
    } catch {
      throw new ProviderError(
        "network",
        "The artwork provider could not be reached.",
      );
    }

    return readImageResponse(response);
  }
}

interface OpenAIImageResult {
  bytes: Buffer;
  widthPx: number;
  heightPx: number;
  metadata: Record<string, unknown>;
}

/**
 * Shared status classification + response parsing for both the generation
 * and the edit endpoint — identical failure semantics on both paths.
 */
async function readImageResponse(response: Response): Promise<OpenAIImageResult> {
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

/**
 * `input_fidelity` is a GPT Image capability, not a universal one. Gated by
 * model so a future/cheaper model that rejects the parameter degrades to a
 * normal edit (still a real edit of the source image) rather than failing
 * the whole request — the source image itself is never conditional.
 */
function supportsInputFidelity(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized.startsWith("gpt-image-1") && !normalized.includes("mini");
}

function extensionForContentType(contentType: string): string {
  const normalized = contentType.trim().toLowerCase();
  if (normalized === "image/jpeg") return ".jpg";
  if (normalized === "image/webp") return ".webp";
  return ".png";
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
 *
 * True Source-Image Targeted Revision: this is now the INITIAL-generation
 * dialect only (text-to-image, three directions). It is intentionally left
 * byte-for-byte as it was — a targeted revision uses `buildEditPrompt`,
 * which is a fundamentally different instruction ("edit this", not
 * "imagine this").
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

/**
 * True Source-Image Targeted Revision: the EDIT dialect.
 *
 * Deliberately NOT the three-direction concept prompt with a sentence
 * bolted on. That prompt asks the model to imagine a design from a creative
 * direction; this one asks it to modify a specific image it can see. Those
 * are different instructions, and reusing the first is exactly why
 * "revisions" used to come back as unrelated reinterpretations.
 *
 * The contract it establishes, in order:
 *   1. You are editing the supplied artwork, not reinterpreting it.
 *   2. Apply ONLY the enumerated requested changes.
 *   3. Preserve everything else — enumerated explicitly, because "keep the
 *      rest the same" alone is far too weak a preservation signal.
 *
 * No creative-direction descriptors appear here at all: the supplied image
 * IS the creative direction, and restating the catalog direction would
 * actively invite the model to redraw toward it.
 *
 * Every product noun comes from the request. Nothing about badges, shields,
 * vehicles, or any other subject is hardcoded.
 */
function buildEditPrompt(prompt: GenerationPromptRequest): string {
  const revision = prompt.revision ?? null;
  const requestedChanges = revision?.requestedChanges ?? [];

  const sections: string[] = [
    "You are editing the artwork image supplied with this request. This is a revision of a design the customer has already chosen — it is not a new interpretation, a redraw, or a fresh concept.",
    "Apply ONLY the changes listed under CHANGE. Everything else in the supplied image must survive the edit unchanged.",
    // Live Acceptance Cleanup: the "everything else" failure was never a
    // whole-design redraw — it was ONE unrequested element changing
    // alongside the requested one ("make the 3 SONS text red" also turned
    // "MY" red). Scope has to be stated per element, not just per image.
    "Each change applies ONLY to the specific element it names. If a change names particular words, only those exact words change — every other word keeps its current color, size, weight, capitalization, and position. If a change names one object, only that object changes. Never apply a change to a similar, nearby, or related element as a side effect, and never make an unrequested element match one you were asked to change.",
  ];

  sections.push(
    requestedChanges.length > 0
      ? `CHANGE (the customer's requested changes, and nothing beyond them):\n${requestedChanges
          .map((change) => `- ${change}`)
          .join("\n")}`
      : "CHANGE: apply the customer's requested refinement to this artwork while keeping everything else identical.",
  );

  // The customer said "everything else stays the same" out loud. That is
  // the strongest preservation signal a revision can carry, so it gets its
  // own statement rather than being left implicit in the list below.
  if (revision?.preserveEverythingElse) {
    sections.push(
      "The customer explicitly asked for everything else to stay exactly the same. Treat every element not named under CHANGE as locked: same words, same colors, same sizes, same weights, same shapes, same positions. If you are unsure whether something was meant to change, leave it exactly as it is.",
    );
  }

  // Required wording is the highest-stakes thing in print artwork: a
  // "close enough" respelling is a reprint, not a nuance. It is stated in
  // BOTH directions — as a change when the customer asked for one, and as
  // a hard lock when they did not.
  if (revision?.wordingChangeRequested && prompt.requiredWording) {
    sections.push(
      `The wording in the finished artwork must read exactly, and only: "${prompt.requiredWording}". Keep the existing typography style, size relationships, and placement while changing what it says.`,
    );
  }

  const preserve: string[] = [
    "the overall composition and layout",
    "the typography style, weight, and lettering treatment",
  ];
  if (revision?.lockedWording) {
    preserve.push(
      `the exact wording "${revision.lockedWording}" — same spelling, same capitalization, same words, in the same position and at the same size`,
    );
  } else if (!revision?.wordingChangeRequested && prompt.requiredWording) {
    preserve.push(
      `the exact wording "${prompt.requiredWording}" and where it sits in the design`,
    );
  }
  preserve.push(
    "the identity, placement, scale, and proportions of every subject already in the artwork",
    // Stated per element rather than as one blanket "the existing colors":
    // a CHANGE that recolors one element is otherwise read as licence to
    // restyle whatever else looked related to it.
    "the exact current color of every element the CHANGE list does not name — including elements that sit next to, overlap, or visually belong with something that is changing",
    "every other word, letter, and line of text in the artwork exactly as it appears now — its wording, color, size, weight, capitalization, and position; only wording the CHANGE list explicitly names may change in any way",
    "every graphical element the CHANGE list does not mention",
    "the overall design style and visual hierarchy",
    "the transparent background and existing edge treatment",
  );
  for (const item of revision?.preserve ?? []) {
    preserve.push(item);
  }

  sections.push(
    `PRESERVE EXACTLY (unless a CHANGE above explicitly says otherwise):\n${preserve
      .map((item) => `- ${item}`)
      .join("\n")}`,
  );

  const avoid = revision?.avoid ?? [];
  if (avoid.length > 0) {
    sections.push(`Must not appear: ${avoid.join("; ")}.`);
  }

  // The information-loss fix: `notes` used to be assembled by Prompt
  // Translation and then silently dropped at this boundary. On the edit
  // path it is real customer context and is consumed.
  if (prompt.notes) {
    sections.push(`Additional customer context: ${prompt.notes}`);
  }

  if (!prompt.allowAdditionalText) {
    sections.push(
      "Do not add any text, letters, words, dates, or slogans that are not already in the supplied image or explicitly requested above.",
    );
  }

  sections.push(
    "Do not redraw, re-stylize, re-crop, re-center, or re-scale the design. Do not change the aspect of anything you were not asked to change. Return the supplied artwork with only the requested changes applied, as a print-ready graphic on a transparent background — artwork only, no mockup, no photograph of a shirt, no watermark.",
  );

  return sections.join("\n\n");
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
