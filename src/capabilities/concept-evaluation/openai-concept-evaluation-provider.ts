import { deriveRequiredWording } from "@/lib/domain/required-wording";
import { withRetry } from "@/capabilities/shared/retry";
import {
  isRetryableProviderError,
  ProviderError,
} from "@/capabilities/providers/provider-error";
import type { ConceptEvaluationCriterionScore } from "@/lib/domain/types";

import type { ConceptEvaluationProvider } from "./concept-evaluation-provider";
import {
  CONCEPT_EVALUATION_CRITERION_KEYS,
  type ConceptEvaluationAssetReference,
  type ConceptEvaluationRequest,
  type ConceptEvaluationResult,
} from "./contracts";

const OPENAI_CHAT_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 30_000;

/** A concept "passes" only above this alignment score, with real confidence behind it. */
const PASS_SCORE_THRESHOLD = 70;
/** Minimum confidence to let a positive OR negative signal decide the status at all. */
const CONFIDENCE_DECISION_THRESHOLD = 55;

const MAX_LIST_ITEMS = 5;
const MAX_NOTE_LENGTH = 200;

export interface OpenAIConceptEvaluationProviderConfig {
  apiKey: string;
  model: string;
  /** Injectable for tests — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests — defaults to a real timer. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Total attempts including the first. Defaults to 3. */
  maxAttempts?: number;
  /** Per-request timeout. Defaults to 30s. */
  timeoutMs?: number;
}

/**
 * Sprint 2I Phase 2: the first real Concept Evaluation provider. Receives
 * only the provider-neutral `ConceptEvaluationRequest` — never a customer
 * id, conversation id, generation job id, or repository handle — and owns
 * 100% of the vision-model prompt dialect, request shape, and response
 * parsing internally. None of that ever leaves this file: it is not
 * exported, never logged, never persisted, and never forwarded to a
 * customer-facing surface.
 *
 * Answers only whether the generated concept matches the approved Design
 * Brief (wording, style, graphics, color palette, exclusions, high-level
 * composition/readability, overall alignment). Never assesses DPI,
 * transparency, vector quality, print size, or embroidery limits — that is
 * Print Validation's job, not this adapter's.
 */
export class OpenAIConceptEvaluationProvider
  implements ConceptEvaluationProvider
{
  readonly providerKey = "openai_vision_concept_evaluation";

  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;

  constructor(config: OpenAIConceptEvaluationProviderConfig) {
    if (!config.apiKey) {
      throw new Error("OpenAIConceptEvaluationProvider requires an API key");
    }
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.sleepImpl = config.sleepImpl ?? defaultSleep;
    this.maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async evaluate(
    request: ConceptEvaluationRequest,
  ): Promise<ConceptEvaluationResult> {
    const imageUrl = selectImageUrl(request.assets);
    const applicability = deriveApplicability(request);

    if (!imageUrl) {
      // Nothing to look at — every criterion below depends on pixels
      // (including OCR for required wording). Never invented, never a
      // network call: a well-formed, honest "we could not assess this"
      // result, exactly like the failure fallback but without pretending a
      // provider call happened.
      return noImageResult(request);
    }

    const raw = await withRetry(
      () => this.requestEvaluation(applicability, imageUrl),
      {
        attempts: this.maxAttempts,
        isRetryable: isRetryableProviderError,
        delayMs: (attempt) => 250 * attempt,
        sleep: this.sleepImpl,
      },
    );

    return normalizeRawEvaluation(raw, applicability, this.model);
  }

  private async requestEvaluation(
    applicability: Applicability,
    imageUrl: string,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(OPENAI_CHAT_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          response_format: { type: "json_object" },
          temperature: 0,
          messages: buildMessages(applicability, imageUrl),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new ProviderError(
          "unavailable",
          "The concept evaluation provider timed out.",
        );
      }
      throw new ProviderError(
        "network",
        "The concept evaluation provider could not be reached.",
      );
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 429) {
      throw new ProviderError(
        "rate_limited",
        "The concept evaluation provider is rate-limiting requests right now.",
      );
    }
    if (response.status >= 500) {
      throw new ProviderError(
        "unavailable",
        "The concept evaluation provider is temporarily unavailable.",
      );
    }
    if (!response.ok) {
      throw new ProviderError(
        "malformed_response",
        `The concept evaluation provider returned an unexpected status (${response.status}).`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ProviderError(
        "malformed_response",
        "The concept evaluation provider returned an unreadable response.",
      );
    }

    const content = extractMessageContent(payload);
    if (content === null) {
      throw new ProviderError(
        "malformed_response",
        "The concept evaluation provider response did not include a message.",
      );
    }

    try {
      return JSON.parse(content);
    } catch {
      throw new ProviderError(
        "malformed_response",
        "The concept evaluation provider response was not valid JSON.",
      );
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

/**
 * Which brief-alignment requirements actually exist to check. Nothing here
 * is invented — a field is only "applicable" when the customer actually
 * specified it on the approved brief. Kept private to this adapter; the
 * capability layer never sees it.
 */
interface Applicability {
  requiredWording: string | null;
  /**
   * Phase 1.1: the customer explicitly asked for NO text. Distinct from
   * `requiredWording === null`, which also covers "not answered yet" — only
   * an explicit request may fail a concept for containing lettering. Live
   * acceptance showed the old code treating explicit no-text as simply "no
   * wording requirement to check", so concepts full of invented lettering
   * passed evaluation cleanly.
   */
  noText: boolean;
  exclusions: string | null;
  style: string | null;
  graphics: string | null;
  colors: string[];
  productSummary: string | null;
  productColor: string | null;
  printPlacement: string | null;
}

function deriveApplicability(request: ConceptEvaluationRequest): Applicability {
  const wording = deriveRequiredWording({ exactText: request.brief.exactText });
  return {
    requiredWording: wording.mode === "provided" ? wording.text : null,
    noText: wording.mode === "none",
    exclusions: nonEmpty(request.brief.exclusions),
    style: nonEmpty(request.brief.designStyle),
    graphics: nonEmpty(request.brief.designDescription),
    colors: request.brief.preferredColors.filter((c) => nonEmpty(c) !== null),
    productSummary: nonEmpty(request.brief.productSummary),
    productColor: nonEmpty(request.brief.shirtColor),
    printPlacement: request.brief.printPlacement,
  };
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Normalizes for a strict-but-forgiving text comparison: lowercase,
 * punctuation collapsed to spaces, whitespace collapsed. Deliberately not a
 * fuzzy/substring match — required wording must appear exactly, so "My 3
 * Sons" and "My 3 Son" (missing the plural) must NOT be treated as equal,
 * and "My 3 Sons Bowling Club" (invented extra wording) must NOT either.
 */
function normalizeWordingText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function wordingMatches(required: string, detected: string): boolean {
  const normalizedRequired = normalizeWordingText(required);
  if (!normalizedRequired) return true;
  return normalizedRequired === normalizeWordingText(detected);
}

/**
 * Prefers the primary (non-thumbnail) asset; falls back to a thumbnail only
 * if that's all that exists. Never fabricates a URL — `null` when nothing
 * is fetchable, which routes to `noImageResult` instead of a network call.
 */
function selectImageUrl(assets: ConceptEvaluationAssetReference[]): string | null {
  const primary = assets.find((a) => !a.isThumbnail && a.sourceUrl);
  if (primary?.sourceUrl) return primary.sourceUrl;
  const thumbnail = assets.find((a) => a.isThumbnail && a.sourceUrl);
  return thumbnail?.sourceUrl ?? null;
}

/**
 * Provider-specific prompt dialect lives only here — never exported, never
 * persisted, never logged, never shown to a customer. Only requirements the
 * customer actually specified are included; the model is explicitly told
 * not to invent unstated ones, and `normalizeRawEvaluation` enforces that
 * again in code regardless of what the model returns.
 */
function buildMessages(
  applicability: Applicability,
  imageUrl: string,
): Array<Record<string, unknown>> {
  const requirementLines: string[] = [];
  if (applicability.productSummary) {
    requirementLines.push(`Product: ${applicability.productSummary}.`);
  }
  if (applicability.graphics) {
    requirementLines.push(`Requested graphics/imagery: ${applicability.graphics}.`);
  }
  if (applicability.style) {
    requirementLines.push(`Requested style/direction: ${applicability.style}.`);
  }
  if (applicability.colors.length > 0) {
    requirementLines.push(`Requested colors: ${applicability.colors.join(", ")}.`);
  }
  if (applicability.requiredWording) {
    requirementLines.push(
      `Required wording that must appear, spelled correctly: "${applicability.requiredWording}".`,
    );
  }
  if (applicability.noText) {
    requirementLines.push(
      "NO TEXT: the customer explicitly asked for a design with no wording. The artwork must contain no words, letters, numbers, typography, labels, captions, monograms, dates, or decorative lettering anywhere — including on badges, banners, ribbons, borders, signs, or any object depicted.",
    );
  }
  if (applicability.exclusions) {
    requirementLines.push(`Explicit exclusions — must NOT appear: ${applicability.exclusions}.`);
  }
  if (applicability.productColor) {
    requirementLines.push(`Garment color for contrast context: ${applicability.productColor}.`);
  }

  const systemPrompt = [
    "You are a print-design quality reviewer. You compare one generated concept image against a customer's approved design brief.",
    "You judge brief alignment only — never DPI, resolution, transparency, vector quality, or other print/production mechanics.",
    "Only evaluate a requirement listed under 'Brief requirements' below. If a requirement is not listed, set its field to null in your response — never invent or assume a requirement that was not stated.",
    "Use broad semantic matching, not exact matching. Example: if green is requested, forest green, dark green, or olive all satisfy it. Example: if the brief asks for 'a bowling ball smashing pins', an image with a bowling ball and pins scores highly even if not mid-impact.",
    // Detailed-Description Fidelity (Phase 1): broad semantic matching is
    // right for HOW something is drawn and wrong for WHETHER it is there. A
    // richer, faithfully preserved design description is only useful if a
    // missing named subject actually fails.
    "Broad matching applies to how something is rendered, never to whether it is present. When the requested graphics description names several distinct subjects, gives a count, or states where things sit relative to each other, check each one: a named subject that is absent, a stated count that is wrong, or a stated relationship that is contradicted is a graphics MISMATCH — set graphics.matches to false and name what is missing in notes, rather than scoring it as a near-match. Simplified or stylized rendering of a subject that IS present is fine and must not be penalized.",
    "Judge style at a broad, high level only (e.g. vintage, minimalist, modern, retro, grunge, industrial) — never subjective artistic ranking.",
    "For required wording, read any visible text in the image. Minor uncertainty reading small or stylized text should lower your confidence, not automatically fail the match — report your actual confidence honestly.",
    // Phase 1.1: the no-text check. Deliberately a judgment about visible
    // lettering by the same vision model, not an OCR pass — adding OCR is a
    // separate capability and is out of scope.
    "When the requirements list a NO TEXT rule, inspect the whole image for lettering and report it in the `noText` field: set violated true if the artwork contains any readable word, letter, number, monogram, date, or shape clearly intended to be read as typography — anywhere, including small text on signs, hulls, banners, ribbons, or badge borders. Put whatever you can read into detectedText. Be conservative about ambiguity: incidental texture, brush marks, hatching, or abstract marks that merely resemble letters are NOT a violation, and low confidence should be reported honestly rather than guessed either way. Obvious lettering is a violation even when it is decorative, stylized, partially cropped, or clearly a placeholder.",
    "For exclusions, flag only obvious, clear violations (e.g. a skull when 'no skulls' was requested) — not speculative ones.",
    "Always assess composition and readability at a high level, and always give an overall alignment judgment, regardless of which specific requirements were stated.",
    "Respond with a single JSON object only — no markdown fences, no commentary — matching exactly this shape:",
    JSON.stringify(
      {
        requiredWording: { found: "boolean or null", detectedText: "string", confidence: "0-100", notes: "string" },
        noText: { violated: "boolean or null", detectedText: "string", confidence: "0-100", notes: "string" },
        exclusions: { violated: "boolean or null", details: "string", confidence: "0-100" },
        style: { matches: "boolean or null", score: "0-100", confidence: "0-100", notes: "string" },
        graphics: { matches: "boolean or null", score: "0-100", confidence: "0-100", notes: "string" },
        colorPalette: { matches: "boolean or null", score: "0-100", confidence: "0-100", notes: "string" },
        productCompatibility: { matches: "boolean or null", score: "0-100", confidence: "0-100", notes: "string" },
        composition: { score: "0-100", confidence: "0-100", notes: "string" },
        readability: { score: "0-100", confidence: "0-100", notes: "string" },
        overallAlignment: { score: "0-100", confidence: "0-100", notes: "string" },
        warnings: ["string"],
        recommendations: ["string"],
      },
      null,
      2,
    ),
  ].join("\n");

  const userText =
    requirementLines.length > 0
      ? `Brief requirements:\n${requirementLines.join("\n")}`
      : "Brief requirements: none of the optional fields were specified — assess only composition, readability, and overall alignment.";

  return [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: [
        { type: "text", text: userText },
        { type: "image_url", image_url: { url: imageUrl } },
      ],
    },
  ];
}

function extractMessageContent(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" && content.length > 0 ? content : null;
}

// --- Response normalization -------------------------------------------------

interface RawSignal {
  matches?: unknown;
  found?: unknown;
  violated?: unknown;
  score?: unknown;
  confidence?: unknown;
  notes?: unknown;
  details?: unknown;
  detectedText?: unknown;
}

function readSignal(raw: unknown, key: string): RawSignal | null {
  if (!raw || typeof raw !== "object") return null;
  const value = (raw as Record<string, unknown>)[key];
  if (!value || typeof value !== "object") return null;
  return value as RawSignal;
}

function clampScore(value: unknown): number | null {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(100, num));
}

function readBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function sanitizeNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_NOTE_LENGTH);
}

function sanitizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .slice(0, MAX_LIST_ITEMS)
    .map((item) => item.trim().slice(0, MAX_NOTE_LENGTH));
}

function notAssessed(
  key: ConceptEvaluationCriterionScore["key"],
  notes = "not_specified_in_brief",
): ConceptEvaluationCriterionScore {
  return { key, score: null, passed: null, confidence: 0, notes };
}

function normalizeRawEvaluation(
  raw: unknown,
  applicability: Applicability,
  model: string,
): ConceptEvaluationResult {
  const criteria: ConceptEvaluationCriterionScore[] = [];
  const matchedRequirements: string[] = [];
  const missingRequirements: string[] = [];

  // required_wording — Phase 1.1: this one criterion now answers whichever
  // of the two mutually-exclusive wording contracts is in force. Explicit
  // no-text reuses it deliberately rather than introducing a new criterion
  // key: it IS the wording verdict for this design ("the wording rule was
  // 'none', was it honored?"), and a new key would mean a contracts change
  // and a persistence migration for no semantic gain.
  let requiredWordingFailed = false;
  if (applicability.noText) {
    const signal = readSignal(raw, "noText");
    const violated = readBool(signal?.violated);
    const confidence = clampScore(signal?.confidence) ?? 0;
    const detectedText = sanitizeNote(signal?.detectedText) ?? "";

    // The model's own boolean is cross-checked in code, exactly as the
    // required-wording path does: if it reports readable text it actually
    // saw, that IS a violation, whatever it set `violated` to.
    const readableTextSeen = normalizeWordingText(detectedText).length > 0;
    const effectiveViolated = readableTextSeen ? true : violated;

    criteria.push({
      key: "required_wording",
      score: effectiveViolated === false ? 100 : effectiveViolated === true ? 0 : null,
      passed: effectiveViolated === null ? null : !effectiveViolated,
      confidence,
      notes: sanitizeNote(signal?.notes) ?? "assessed_no_text",
    });
    if (effectiveViolated === false) {
      matchedRequirements.push("no text");
    } else if (effectiveViolated === true) {
      // Text the model actually read off the image is decisive on its own —
      // it does not also need the model's confidence to clear the threshold.
      if (readableTextSeen || confidence >= CONFIDENCE_DECISION_THRESHOLD) {
        missingRequirements.push("no text");
        requiredWordingFailed = true;
      }
    }
  } else if (applicability.requiredWording) {
    const signal = readSignal(raw, "requiredWording");
    const found = readBool(signal?.found);
    const confidence = clampScore(signal?.confidence) ?? 0;
    const detectedText = sanitizeNote(signal?.detectedText) ?? "";

    // Sprint 2K Phase 2 (Workstream E): the model's own `found` boolean is
    // not trusted blindly. `detectedText` is what the model actually read
    // off the image — cross-checking it against the brief's required
    // wording, in code, catches a lenient model claiming "found: true" for
    // text that is actually missing, misspelled, partial, or has invented
    // extra wording tacked on. Required wording must print exactly as
    // specified (Constitution §6.12): a near-match is still a miss.
    const textMismatch =
      found === true &&
      detectedText.length > 0 &&
      !wordingMatches(applicability.requiredWording, detectedText);
    const effectiveFound = textMismatch ? false : found;

    criteria.push({
      key: "required_wording",
      score: effectiveFound === true ? 100 : effectiveFound === false ? 0 : null,
      passed: effectiveFound,
      confidence,
      notes: sanitizeNote(signal?.notes) ?? "assessed",
    });
    if (effectiveFound === true) {
      matchedRequirements.push("required wording");
    } else if (effectiveFound === false) {
      // A code-verified text mismatch is decisive on its own — it does not
      // need the model's own confidence to also clear the threshold.
      if (textMismatch || confidence >= CONFIDENCE_DECISION_THRESHOLD) {
        missingRequirements.push("required wording");
        requiredWordingFailed = true;
      }
    }
  } else {
    criteria.push(notAssessed("required_wording"));
  }

  // exclusions
  let exclusionViolated = false;
  if (applicability.exclusions) {
    const signal = readSignal(raw, "exclusions");
    const violated = readBool(signal?.violated);
    const confidence = clampScore(signal?.confidence) ?? 0;
    criteria.push({
      key: "exclusions",
      score: violated === true ? 0 : violated === false ? 100 : null,
      passed: violated === null ? null : !violated,
      confidence,
      notes: sanitizeNote(signal?.details) ?? "assessed",
    });
    if (violated === false) {
      matchedRequirements.push("exclusions respected");
    } else if (violated === true) {
      if (confidence >= CONFIDENCE_DECISION_THRESHOLD) {
        missingRequirements.push("exclusions respected");
        exclusionViolated = true;
      }
    }
  } else {
    criteria.push(notAssessed("exclusions"));
  }

  // style / graphics / color_palette / product_compatibility share the
  // same {matches, score, confidence, notes} shape.
  pushMatchCriterion(
    "style",
    applicability.style,
    readSignal(raw, "style"),
    "requested style",
    criteria,
    matchedRequirements,
    missingRequirements,
  );
  pushMatchCriterion(
    "graphics",
    applicability.graphics,
    readSignal(raw, "graphics"),
    "requested graphics",
    criteria,
    matchedRequirements,
    missingRequirements,
  );
  pushMatchCriterion(
    "color_palette",
    applicability.colors.length > 0 ? applicability.colors.join(", ") : null,
    readSignal(raw, "colorPalette"),
    "requested colors",
    criteria,
    matchedRequirements,
    missingRequirements,
  );
  pushMatchCriterion(
    "product_compatibility",
    applicability.productSummary,
    readSignal(raw, "productCompatibility"),
    "product fit",
    criteria,
    matchedRequirements,
    missingRequirements,
  );

  // composition / readability / overall_alignment — always assessed
  // (high-level only) whenever an image was available at all.
  const compositionSignal = readSignal(raw, "composition");
  criteria.push({
    key: "composition",
    score: clampScore(compositionSignal?.score),
    passed: null,
    confidence: clampScore(compositionSignal?.confidence) ?? 0,
    notes: sanitizeNote(compositionSignal?.notes) ?? "assessed",
  });

  const readabilitySignal = readSignal(raw, "readability");
  criteria.push({
    key: "readability",
    score: clampScore(readabilitySignal?.score),
    passed: null,
    confidence: clampScore(readabilitySignal?.confidence) ?? 0,
    notes: sanitizeNote(readabilitySignal?.notes) ?? "assessed",
  });

  const overallSignal = readSignal(raw, "overallAlignment");
  const overallScore = clampScore(overallSignal?.score);
  const overallConfidence = clampScore(overallSignal?.confidence) ?? 0;
  criteria.push({
    key: "overall_alignment",
    score: overallScore,
    passed: null,
    confidence: overallConfidence,
    notes: sanitizeNote(overallSignal?.notes) ?? "assessed",
  });

  const status: ConceptEvaluationResult["status"] =
    exclusionViolated || requiredWordingFailed
      ? "failed"
      : overallScore !== null &&
          overallScore >= PASS_SCORE_THRESHOLD &&
          overallConfidence >= CONFIDENCE_DECISION_THRESHOLD
        ? "passed"
        : "needs_review";

  const passed = status === "failed" ? false : status === "passed" ? true : null;

  return {
    overallScore,
    passed,
    confidence: overallConfidence,
    status,
    criteria,
    warnings: sanitizeList((raw as { warnings?: unknown } | null)?.warnings),
    recommendations: sanitizeList((raw as { recommendations?: unknown } | null)?.recommendations),
    missingRequirements,
    matchedRequirements,
    providerMetadata: {
      mode: "openai_vision",
      model,
    },
  };
}

function pushMatchCriterion(
  key: ConceptEvaluationCriterionScore["key"],
  requirement: string | null,
  signal: RawSignal | null,
  label: string,
  criteria: ConceptEvaluationCriterionScore[],
  matched: string[],
  missing: string[],
): void {
  if (!requirement) {
    criteria.push(notAssessed(key));
    return;
  }
  const matches = readBool(signal?.matches);
  const confidence = clampScore(signal?.confidence) ?? 0;
  criteria.push({
    key,
    score: clampScore(signal?.score),
    passed: matches,
    confidence,
    notes: sanitizeNote(signal?.notes) ?? "assessed",
  });
  if (matches === true) {
    matched.push(label);
  } else if (matches === false && confidence >= CONFIDENCE_DECISION_THRESHOLD) {
    missing.push(label);
  }
}

/**
 * No fetchable image exists for this concept. Every criterion depends on
 * pixels (including OCR for wording), so nothing is assessed — this is not
 * a provider failure, just an honest "nothing to look at" result. Never
 * discards the concept; matches `ConceptEvaluationCapability`'s failure
 * fallback shape so downstream persistence code treats both the same way.
 */
function noImageResult(request: ConceptEvaluationRequest): ConceptEvaluationResult {
  const criteria = CONCEPT_EVALUATION_CRITERION_KEYS.map((key) =>
    notAssessed(key, "no_image_available"),
  );

  return {
    overallScore: null,
    passed: null,
    confidence: 0,
    status: "needs_review",
    criteria,
    warnings: [
      "No generated image was available for automated evaluation; concept retained for customer review.",
    ],
    recommendations: [],
    missingRequirements: [],
    matchedRequirements: [],
    providerMetadata: {
      mode: "no_image_available",
      assetCount: request.assets.length,
    },
  };
}
