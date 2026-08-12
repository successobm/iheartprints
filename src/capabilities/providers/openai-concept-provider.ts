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
  resolveDirectionTreatment,
  type ConceptDirection,
} from "@/lib/domain/concept-directions";
import { analyzeDesignContent } from "@/lib/domain/design-content-contract";
import type { GenerationPromptRequest } from "@/lib/domain/types";
import {
  DEFAULT_OPENAI_CONCEPT_IMAGE_QUALITY,
  type OpenAIConceptImageQuality,
} from "@/lib/config/openai-concept-image-quality";
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
  /**
   * Phase 2C0: explicit OpenAI image quality. Required for predictable
   * unit economics — never omit (OpenAI defaults omitted quality to `auto`).
   * Defaults to `medium` when the constructor omits it (tests / older
   * call sites); production resolution always passes an explicit value
   * from `OPENAI_CONCEPT_IMAGE_QUALITY`.
   */
  quality?: OpenAIConceptImageQuality;
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
  private readonly quality: OpenAIConceptImageQuality;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(config: OpenAIProviderConfig) {
    if (!config.apiKey) {
      throw new Error("OpenAIConceptGenerationProvider requires an API key");
    }
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.quality = config.quality ?? DEFAULT_OPENAI_CONCEPT_IMAGE_QUALITY;
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
      const image = await withRetry(
        (attempt) =>
          this.requestImage(prompt, {
            purpose: "initial_generation",
            directionKey: direction.key,
            designId: request.designId,
            attempt,
          }),
        {
          attempts: MAX_ATTEMPTS_PER_IMAGE,
          isRetryable: isRetryableProviderError,
          delayMs: (attempt) => 250 * attempt,
          sleep: this.sleepImpl,
        },
      );

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
    const image = await withRetry(
      (attempt) =>
        this.requestImageEdit(prompt, source, {
          purpose: "targeted_revision",
          directionKey: direction.key,
          designId: request.designId,
          attempt,
        }),
      {
        attempts: MAX_ATTEMPTS_PER_IMAGE,
        isRetryable: isRetryableProviderError,
        delayMs: (attempt) => 250 * attempt,
        sleep: this.sleepImpl,
      },
    );

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

  private async requestImage(
    prompt: string,
    context: PaidImageCallContext,
  ): Promise<OpenAIImageResult> {
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
          quality: this.quality,
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

    return readImageResponse(response, {
      model: this.model,
      quality: this.quality,
      size: IMAGE_SIZE,
      ...context,
    });
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
    context: PaidImageCallContext,
  ): Promise<OpenAIImageResult> {
    const form = new FormData();
    form.append("model", this.model);
    form.append("prompt", prompt);
    form.append("size", IMAGE_SIZE);
    form.append("quality", this.quality);
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

    return readImageResponse(response, {
      model: this.model,
      quality: this.quality,
      size: IMAGE_SIZE,
      ...context,
    });
  }
}

interface PaidImageCallContext {
  purpose: "initial_generation" | "targeted_revision";
  directionKey: string;
  designId: string;
  attempt: number;
}

interface OpenAIImageResult {
  bytes: Buffer;
  widthPx: number;
  heightPx: number;
  metadata: Record<string, unknown>;
}

interface ImageResponseContext extends PaidImageCallContext {
  model: string;
  quality: OpenAIConceptImageQuality;
  size: string;
}

/**
 * Shared status classification + response parsing for both the generation
 * and the edit endpoint — identical failure semantics on both paths.
 */
async function readImageResponse(
  response: Response,
  context: ImageResponseContext,
): Promise<OpenAIImageResult> {
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

  const usage = extractUsage(payload);
  const providerRequestId =
    response.headers.get("x-request-id") ??
    response.headers.get("x-openai-request-id") ??
    null;

  // Phase 2C0: safe structured observability — never logs API keys,
  // authorization headers, prompts, or artwork bytes.
  console.info("[concept-generation] paid-image-call", {
    purpose: context.purpose,
    designId: context.designId,
    directionKey: context.directionKey,
    model: context.model,
    quality: context.quality,
    size: context.size,
    attempt: context.attempt,
    providerRequestId,
    usage,
  });

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
      model: context.model,
      quality: context.quality,
      purpose: context.purpose,
      directionKey: context.directionKey,
      attempt: context.attempt,
      providerRequestId,
      usage,
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
 * True Source-Image Targeted Revision: this is the INITIAL-generation
 * dialect only (text-to-image, three directions). A targeted revision uses
 * `buildEditPrompt`, which is a fundamentally different instruction ("edit
 * this", not "imagine this").
 *
 * Detailed-Description Fidelity (Phase 1), part C — the prompt is now
 * SECTIONED by priority rather than being one flat run-on sentence, because
 * the audit proved the flat form gave "Subject: …" no more weight than
 * "Iconography: one simple, direct supporting graphic, not a scene". Those
 * two are not peers, and the prompt never said so. Priority, highest first:
 *
 *   1. REQUIRED WORDING and exclusions   (exact, unnegotiable)
 *   2. REQUIRED DESIGN CONTENT + COMPOSITION (the customer's description)
 *   3. the customer's own style/color preferences
 *   4. STYLE / CREATIVE TREATMENT        (this concept's direction)
 *   5. provider defaults                 (e.g. centered composition)
 *
 * and the prompt states that ordering explicitly, so a direction can never
 * be read as licence to drop a required element.
 *
 * The customer's `subject` — the faithfully preserved `designDescription` —
 * is the authoritative content contract. There is no structured element
 * list, and this function deliberately does not invent one: the COMPOSITION
 * bullets are the customer's OWN clauses, selected, never synthesized.
 */
function buildPrompt(
  prompt: GenerationPromptRequest,
  direction: ConceptDirection,
): string {
  const contract = analyzeDesignContent(prompt.subject, {
    additionalContext: prompt.notes,
  });
  // Phase 1.1: explicit no-text is precedence tier 1 — it is resolved before
  // anything else here and every later section branches on it.
  const noText = prompt.wordingMode === "none";
  const treatment = resolveDirectionTreatment(direction, contract, {
    wordingMode: prompt.wordingMode,
  });

  const sections: string[] = [
    `Print-ready apparel graphic for ${prompt.product}.`,
    `REQUIRED DESIGN CONTENT — this is the customer's own description of what the artwork must show. Every subject, object, count, and relationship in it is a requirement, not inspiration: ${endWithPeriod(
      prompt.subject,
    )}`,
  ];

  if (contract.compositionStatements.length > 0) {
    sections.push(
      `COMPOSITION — the customer stated these placements and relationships. Honor them as written; they outrank any layout, framing, or centering guidance below:\n${contract.compositionStatements
        .map((statement) => `- ${statement}`)
        .join("\n")}`,
    );
  }

  // Phase 1.1: the two wording states are mutually exclusive customer
  // intents, and exactly one of these blocks can ever appear. The third
  // state — the customer has not answered yet — deliberately produces
  // neither: an unanswered question is not a no-text request.
  if (noText) {
    sections.push(
      "NO TEXT — the customer explicitly asked for a design with no wording. This design must contain no text of any kind. Do not render any words, letters, numbers, typography, labels, captions, titles, signage, monograms, dates, slogans, decorative lettering, or invented brand text anywhere in the artwork — including inside or around badges, banners, ribbons, crests, borders, and on any object, sign, or surface depicted in the scene. Depict lettering-free objects: if something would normally carry a name or label, draw it blank.",
    );
  } else if (prompt.requiredWording) {
    sections.push(
      `REQUIRED WORDING — include this exact wording, spelled correctly, and no other wording: "${prompt.requiredWording}".`,
    );
  }

  const styleLines = [
    `Creative direction — ${direction.title}: ${treatment.composition}.`,
  ];
  // A design that must contain no lettering has no typography guidance to
  // give. Emitting the direction's typography line anyway — even a
  // "restrained typography" one — reads as permission to letter.
  if (treatment.typographyEmphasis) {
    styleLines.push(`Typography: ${treatment.typographyEmphasis}.`);
  }
  styleLines.push(
    `Illustration density: ${treatment.illustrationDensity}.`,
    `Iconography: ${treatment.iconography}.`,
    `Layout: ${treatment.layout}.`,
    `Visual hierarchy: ${treatment.visualHierarchy}.`,
  );
  if (prompt.style) styleLines.push(`Style: ${prompt.style}.`);
  // Phase 2A: soft palette stays inside STYLE; hard palette is a dedicated
  // production section below so creative direction cannot dilute it.
  if (prompt.colors.length > 0 && prompt.printPaletteEnforcement === "soft") {
    styleLines.push(`Preferred colors: ${prompt.colors.join(", ")}.`);
  }
  if (prompt.productColor && prompt.printPaletteEnforcement !== "hard") {
    styleLines.push(
      `Will be printed on a ${prompt.productColor} garment — keep contrast strong against it.`,
    );
  }
  sections.push(
    `STYLE / CREATIVE TREATMENT — this governs HOW the required content is rendered, never what is included or left out:\n${styleLines.join(
      "\n",
    )}`,
  );

  if (prompt.printPaletteEnforcement === "hard" && prompt.colors.length > 0) {
    sections.push(buildHardPrintPaletteSection(prompt));
  }

  // Sprint 2K Phase 3 (Goal 7): explicit, deterministic instruction against
  // inventing text — driven by the provider-neutral `allowAdditionalText`
  // flag rather than being a one-off OpenAI-only afterthought.
  //
  // Phase 1.1: this sentence used to be emitted unconditionally, and its
  // trailing "beyond the exact wording specified above" pointed at a
  // REQUIRED WORDING block that, for a no-text design, does not exist. A
  // dangling exception is worse than no sentence: it implies some wording
  // was authorized somewhere. Each of the three wording states now gets a
  // sentence that is actually true of it.
  if (!prompt.allowAdditionalText) {
    if (noText) {
      // The NO TEXT block above is already absolute; anything more here
      // would only reintroduce the idea that some text might be allowed.
    } else if (prompt.requiredWording) {
      sections.push(
        "Do not add any other text, letters, words, dates, or slogans beyond the exact wording specified above.",
      );
    } else {
      sections.push(
        "The customer has not specified any wording for this design. Do not invent words, letters, dates, or slogans they did not ask for.",
      );
    }
  }
  // Sprint 2K Phase 3 (Goal 4): a stylistic/era/pop-culture reference the
  // customer gave is inspiration for visual language only — never an
  // instruction to depict the referenced people, characters, or logos.
  if (prompt.inspirationReferences.length > 0) {
    sections.push(
      `Style inspiration only (do not depict as literal content): ${prompt.inspirationReferences.join("; ")}.`,
      "Do not depict recognizable real people, TV/movie characters, sports mascots, band members, or any copyrighted logo or artwork from a referenced work — reinterpret only the general era, mood, and graphic language.",
    );
  }
  if (prompt.exclusions) {
    sections.push(`Avoid: ${prompt.exclusions}.`);
  }
  // Detailed-Description Fidelity (Phase 1): the customer's additional
  // instructions used to be assembled by Prompt Translation and then dropped
  // on this path (only the edit path consumed them). "Make it like the
  // actual area" routinely lands here, and silently discarding it is exactly
  // the pre-provider information loss this change exists to stop.
  if (prompt.notes) {
    sections.push(`Additional customer context: ${prompt.notes}`);
  }
  // Real-world geography, answered honestly. Phase 1 has no reference
  // grounding, so the request is neither dropped nor over-claimed.
  if (contract.requestsRealWorldReference) {
    sections.push(
      "The customer has asked for this to resemble a real place. Approximate the arrangement only from the customer's own description above — no map, aerial photograph, or other external geographic reference is available for this request. Do not invent landmarks that were not described, and do not attempt to imply survey or map accuracy.",
    );
  }

  sections.push(
    // "collapse … to one lone symbol" rather than "to an emblem": the
    // Minimal Badge direction legitimately asks for an emblem, and an
    // instruction that reads as forbidding its own creative direction is
    // just a different contradiction.
    "DO NOT OMIT: every subject, object, count, and spatial relationship named in REQUIRED DESIGN CONTENT and COMPOSITION must be present in the finished artwork. Do not drop a named element, merge several named elements into one, replace the described arrangement with a generic one, or reduce the design to one lone symbol in order to satisfy the creative direction.",
    buildPriorityLine(prompt, noText),
    buildCreativeFreedomLine(prompt, noText),
  );

  // Centered composition is a provider DEFAULT — the lowest priority thing
  // in this prompt. When the customer has said where things go, asserting it
  // anyway is a direct contradiction of a higher-priority requirement.
  const closing = contract.hasExplicitComposition
    ? "Clean vector-style illustration, transparent background, arranged to match the customer's stated composition above, no watermark, no mockup, no photograph of a shirt — artwork only."
    : "Clean vector-style illustration, transparent background, centered composition, no watermark, no mockup, no photograph of a shirt — artwork only.";
  sections.push(
    noText
      ? `${closing.slice(0, -1)}, and no text or lettering of any kind.`
      : closing,
  );

  return sections.join("\n\n");
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

  // Phase 2A: a hard print palette survives targeted revision unless the
  // customer's CHANGE list itself recolors the design.
  if (prompt.printPaletteEnforcement === "hard" && prompt.colors.length > 0) {
    sections.push(buildHardPrintPaletteSection(prompt));
  }

  sections.push(
    "Do not redraw, re-stylize, re-crop, re-center, or re-scale the design. Do not change the aspect of anything you were not asked to change. Return the supplied artwork with only the requested changes applied, as a print-ready graphic on a transparent background — artwork only, no mockup, no photograph of a shirt, no watermark.",
  );

  return sections.join("\n\n");
}

/** A faithfully preserved description usually already ends in a period. */
function endWithPeriod(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Phase 2A: hard print/render palette — subject semantics stay in REQUIRED
 * DESIGN CONTENT; this section owns ink. Creative directions must not dilute it.
 */
function buildHardPrintPaletteSection(prompt: GenerationPromptRequest): string {
  const palette = prompt.colors.join(", ");
  const garment = prompt.productColor?.trim() || "the garment";
  const subjectOnly = prompt.subjectOnlyColors.filter(Boolean);
  const subjectOnlyList =
    subjectOnly.length > 0 ? subjectOnly.join(", ") : null;

  const lines = [
    "REQUIRED PRINT PALETTE — HARD PRODUCTION CONSTRAINT:",
    `Render the printable artwork primarily in: ${palette}.`,
    `Garment: ${garment} — maintain strong visible contrast against this fabric.`,
    "Colors named in REQUIRED DESIGN CONTENT describe real-world subject/object identity, not literal print ink. Preserve those objects' identity through linework, shading, negative space, silhouette, and print treatment in the required palette — do not repaint the subject as a different real-world color, and do not use large/dominant fills in subject-only colors merely because the real-world objects are described that way.",
    "The required print palette overrides literal subject-object color where the two conflict.",
    "Small dark accents for shading or anti-aliasing may exist; subject-only colors must not be the main printed design color when they conflict with this palette.",
  ];

  if (subjectOnlyList) {
    lines.push(
      `Subject-only colors (identity, not dominant ink): ${subjectOnlyList}.`,
    );
  }

  return lines.join("\n");
}

function buildPriorityLine(
  prompt: GenerationPromptRequest,
  noText: boolean,
): string {
  const hardPalette = prompt.printPaletteEnforcement === "hard";
  if (noText) {
    return hardPalette
      ? "PRIORITY when anything conflicts: the NO TEXT rule and the exclusions first — nothing overrides them; then the REQUIRED PRINT PALETTE hard constraint; then the required design content and composition; then the customer's stated style; then the creative direction above; then any default. Whenever a lower item would contradict a higher one, follow the higher one. No creative direction, badge convention, illustrative density, or stylistic habit justifies adding lettering or overriding the required print palette."
      : "PRIORITY when anything conflicts: the NO TEXT rule and the exclusions first — nothing overrides them; then the required design content and composition; then the customer's stated style and colors; then the creative direction above; then any default. Whenever a lower item would contradict a higher one, follow the higher one. No creative direction, badge convention, or stylistic habit justifies adding lettering.";
  }
  return hardPalette
    ? "PRIORITY when anything conflicts: required wording and exclusions first; then the REQUIRED PRINT PALETTE hard constraint; then the required design content and composition; then the customer's stated style; then the creative direction above; then any default. Whenever a lower item would contradict a higher one, follow the higher one. No creative direction may override the required print palette."
    : "PRIORITY when anything conflicts: required wording and exclusions first; then the required design content and composition; then the customer's stated style and colors; then the creative direction above; then any default. Whenever a lower item would contradict a higher one, follow the higher one.";
}

function buildCreativeFreedomLine(
  prompt: GenerationPromptRequest,
  noText: boolean,
): string {
  const hardPalette = prompt.printPaletteEnforcement === "hard";
  // Typography is removed from the creative-freedom list entirely for a
  // no-text design — listing it as a free choice directly contradicts the
  // NO TEXT rule above. Palette treatment is likewise removed when the
  // print palette is a hard production constraint.
  if (noText && hardPalette) {
    return "CREATIVE FREEDOM: illustration style, line weight, shape language, framing, decorative detail, and texture wherever the customer has not constrained them. Typography is not among them — this design has no text. Print palette / dominant ink color is not among them — the REQUIRED PRINT PALETTE is a hard constraint.";
  }
  if (noText) {
    return "CREATIVE FREEDOM: illustration style, line weight, shape language, framing, decorative detail, texture, and palette treatment wherever the customer has not constrained them. Typography is not among them — this design has no text.";
  }
  if (hardPalette) {
    return "CREATIVE FREEDOM: typography treatment, illustration style, line weight, framing, decorative detail, and texture wherever the customer has not constrained them. Print palette / dominant ink color is not among them — the REQUIRED PRINT PALETTE is a hard constraint.";
  }
  return "CREATIVE FREEDOM: typography treatment, illustration style, line weight, framing, decorative detail, texture, and palette treatment wherever the customer has not constrained them.";
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

/** Best-effort OpenAI usage object — numbers only, never prompt/image bytes. */
function extractUsage(payload: unknown): Record<string, number> | null {
  if (!payload || typeof payload !== "object") return null;
  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(usage as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    } else if (value && typeof value === "object") {
      for (const [nestedKey, nestedValue] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (typeof nestedValue === "number" && Number.isFinite(nestedValue)) {
          out[`${key}.${nestedKey}`] = nestedValue;
        }
      }
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}
