import { withRetry } from "@/capabilities/shared/retry";
import {
  isRetryableProviderError,
  ProviderError,
} from "@/capabilities/providers/provider-error";

import type { ConversationUnderstandingProvider } from "./conversation-understanding-provider";
import type {
  ConversationUnderstandingRequest,
  ConversationUnderstandingResult,
} from "./contracts";

const OPENAI_CHAT_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MAX_ATTEMPTS = 2;
/**
 * Goal 12: this happens interactively inside a customer turn, not on the
 * ~2-minute image-generation worker — kept short so a slow provider call
 * degrades to the deterministic fallback quickly rather than stalling the
 * conversation.
 */
const DEFAULT_TIMEOUT_MS = 8_000;

export interface OpenAIConversationUnderstandingProviderConfig {
  apiKey: string;
  model: string;
  /** Injectable for tests — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests — defaults to a real timer. */
  sleepImpl?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  timeoutMs?: number;
}

/**
 * Sprint 2L Phase 1: the first real Conversation Understanding provider.
 *
 * Receives only the provider-neutral, bounded `ConversationUnderstandingRequest`
 * — never a customer id, conversation id, project id, or raw Design Brief —
 * and owns 100% of its own prompt dialect internally. None of that prompt
 * text is exported, logged, or persisted.
 *
 * Text-only chat completion — never an image model (Goal 12). Answers only
 * "what did the customer mean," never whether the brief is complete (Brief
 * Evaluation's job) or what to ask next (Interview Intelligence's job).
 */
export class OpenAIConversationUnderstandingProvider
  implements ConversationUnderstandingProvider
{
  readonly providerKey = "openai_conversation_understanding";

  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;

  constructor(config: OpenAIConversationUnderstandingProviderConfig) {
    if (!config.apiKey) {
      throw new Error("OpenAIConversationUnderstandingProvider requires an API key");
    }
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.sleepImpl = config.sleepImpl ?? defaultSleep;
    this.maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async interpret(
    request: ConversationUnderstandingRequest,
  ): Promise<ConversationUnderstandingResult> {
    const raw = await withRetry(() => this.requestInterpretation(request), {
      attempts: this.maxAttempts,
      isRetryable: isRetryableProviderError,
      delayMs: (attempt) => 150 * attempt,
      sleep: this.sleepImpl,
    });

    return normalizeRawInterpretation(raw);
  }

  private async requestInterpretation(
    request: ConversationUnderstandingRequest,
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
          messages: buildMessages(request),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new ProviderError(
          "unavailable",
          "The conversation understanding provider timed out.",
        );
      }
      throw new ProviderError(
        "network",
        "The conversation understanding provider could not be reached.",
      );
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 429) {
      throw new ProviderError(
        "rate_limited",
        "The conversation understanding provider is rate-limiting requests right now.",
      );
    }
    if (response.status >= 500) {
      throw new ProviderError(
        "unavailable",
        "The conversation understanding provider is temporarily unavailable.",
      );
    }
    if (!response.ok) {
      throw new ProviderError(
        "malformed_response",
        `The conversation understanding provider returned an unexpected status (${response.status}).`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ProviderError(
        "malformed_response",
        "The conversation understanding provider returned an unreadable response.",
      );
    }

    const content = extractMessageContent(payload);
    if (content === null) {
      throw new ProviderError(
        "malformed_response",
        "The conversation understanding provider response did not include a message.",
      );
    }

    try {
      return JSON.parse(content);
    } catch {
      throw new ProviderError(
        "malformed_response",
        "The conversation understanding provider response was not valid JSON.",
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
 * Provider-specific prompt dialect lives only here — never exported, never
 * persisted, never logged, never shown to a customer. The model is
 * explicitly instructed never to request or include chain-of-thought/
 * reasoning — `evidence` is a short quote, not an explanation.
 */
function buildMessages(
  request: ConversationUnderstandingRequest,
): Array<Record<string, unknown>> {
  const systemPrompt = [
    "You are a print-shop design assistant's language-understanding module. You read one customer message, in context, and propose structured updates to a print Design Brief.",
    "You never decide what to ask next and never judge whether the brief is complete — only interpret what the customer said.",
    "Only propose an update for a section where the message (or the immediate conversational context) genuinely supports it. Do not guess or invent facts.",
    'For "requiredWording" specifically: the value must be the exact literal text the customer wants printed, character for character — never paraphrased, never re-spelled, never capitalized/punctuated differently. If a name (team, company, event) is mentioned but it is not clearly the text that must appear in the artwork, propose it with confidence "ambiguous" instead of "explicit"/"inferred", or omit it and add an ambiguity instead.',
    'For "product" specifically: "product" is the PHYSICAL ITEM the artwork gets printed on — a t-shirt, hoodie, tote bag, banner, yard sign, mug, sticker. Look for ANY such product noun anywhere in the message, even embedded inside a longer, run-on sentence that is mostly about something else (e.g. team name, occasion, audience). A product noun does not need to be the direct answer to a "what are we printing?" question to count — "help me create a design for team t-shirts" and "we need staff hoodies" both name the product just as concretely as "T-shirts." would. Propose the canonical, customer-facing product name (e.g. "T-shirt", "Hoodie", "Sweatshirt", "Tank top", "Polo", "Jersey", "Cap", "Hat" for common garment synonyms; otherwise the customer\'s own product noun, cleanly cased) as `value`, and quote the actual phrase the customer used (e.g. "team t-shirts", "staff hoodies") as `evidence` — `evidence` does not need to literally contain the word you chose for `value`, only the customer\'s own product phrase. Use confidence "explicit" whenever a concrete product noun is named, regardless of where in the sentence it appears or what else the sentence is also about.',
    'CRITICAL for "product": the words "design", "artwork", "graphic", "image", "picture", "logo", "concept" and "print" name the thing being CREATED, never the product it is printed on. They are never a "product" value, alone or as the head noun — "create a design of a red 1988 Toyota MR2", "make a graphic of our building" and "design something with our logo" all name NO product. In that case propose no "product" update at all and leave it unresolved; the assistant will simply ask what we are printing on, which is far better than recording "Design" as the product. When a product noun and one of these words appear together ("a t-shirt design", "artwork for a banner"), the product is the real product noun only — "T-shirt", "Banner" — never "T-shirt design".',
    'For every section EXCEPT "requiredWording": `value` must be a clean, normalized, plain-language synthesis of what the customer communicated — a short phrase a designer would actually write on a brief, not a verbatim transcript excerpt. "this is a take on the old sitcom my 3 sons, so i want to create a team logo but bowling themed, with that retro vibe" should synthesize to something like graphics = "Retro bowling team logo inspired by a classic sitcom-era aesthetic" and style = "Retro / mid-century" — never store the raw sentence fragment itself as the value. The verbatim customer wording still belongs in `evidence` (bounded, short) — never in `value`. `requiredWording` is the one deliberate exception: its `value` must be the exact literal text, character for character, never synthesized or cleaned up.',
    'Required wording can be established by combining two things said at different points in the SAME message or across recent turns: (1) a name is given for an entity (team/company/event — "our team is called My 3 Sons"), and (2) the customer expresses intent to create artwork/a logo/a design *for or about that same entity* ("I want to create a team logo"). That combination is enough to propose the name as requiredWording at "explicit" or "inferred" confidence — do not force the customer to repeat a name a third time once both halves are established. Without the second half (design intent connected to the name), or when the name is mentioned only as passing context ("make something cool for My 3 Sons"), keep it at "ambiguous" confidence or add an ambiguity instead — do not assume every name mentioned belongs on the artwork.',
    'A name can be given in EITHER order: "our team is called My 3 Sons" / "the boat name is GLORIOUS" (entity noun first) OR "My 3 Sons is our team name" / "GLORIOUS is the boat name" (the name itself comes first, followed by "is the/our/my <descriptor> name/title"). In BOTH orders, the required wording is only the name itself, never the surrounding descriptive clause — "GLORIOUS is the boat name" means requiredWording = "GLORIOUS", NOT "GLORIOUS is the boat name" or "GLORIOUS IS THE BOAT NAME". The clause "is the boat name" (or "is our team name", "is the company name", etc.) is the customer explaining/naming what the entity is, in plain English — it is contextual metadata about the entity, never literal print text, and must never be included in the requiredWording value or proposed as its own separate literal text.',
    'Use confidence "explicit" only when the customer directly stated the value. Use "inferred" when it is strongly implied by context (e.g. answering the pending question, or a deferral like "you choose" / "no preference" which should go in deferrals, not proposedUpdates). Use "ambiguous" — and do NOT rely on it being applied — whenever you are genuinely unsure.',
    'Colors play different roles — do not collapse them into one field. (1) "productColor" is the color of the physical garment/product itself ("the shirt is black"). (2) A color that describes the SUBJECT of the artwork or an object depicted within it (e.g. "a red car", "my red 1988 Toyota MR2", "a blue whale breaching") belongs to "graphics" as part of the subject description — never to "productColor", and never to "colors" either. (3) "colors" is the customer\'s stated palette PREFERENCE for how the artwork itself should be rendered ("use blue and gold in the design", "keep it black and white") — a preference about rendering, not a color that merely happens to be part of what the artwork depicts. When a message names an object\'s color as part of describing what the artwork should show, propose that color as part of the "graphics" value (the subject description), not as productColor or colors. A single message can correct more than one of these at once — attribute each color to its own role rather than defaulting to whichever is mentioned first.',
    "A correction (the customer changing a previously given answer) must be flagged isCorrection: true.",
    "Never include your reasoning, chain-of-thought, or explanations of your own reasoning process anywhere in the response — `evidence` must be a short, direct quote or near-quote from the customer's message only.",
    "Worked examples (illustrative only — apply the same reasoning to any domain, not just these):",
    JSON.stringify(
      [
        {
          message:
            "I'm in a bowling league and our team is called My 3 Sons help me create a design for team t-shirts",
          proposedUpdates: [
            { section: "product", value: "T-shirt", confidence: "explicit", evidence: "team t-shirts", isCorrection: false },
            { section: "requiredWording", value: "My 3 Sons", confidence: "explicit", evidence: "our team is called My 3 Sons", isCorrection: false },
            { section: "audience", value: "Bowling team", confidence: "inferred", evidence: "I'm in a bowling league", isCorrection: false },
            { section: "purpose", value: "Bowling league team apparel", confidence: "inferred", evidence: "I'm in a bowling league", isCorrection: false },
          ],
        },
        {
          message: "We need staff hoodies for Rivera Plumbing.",
          proposedUpdates: [
            { section: "product", value: "Hoodie", confidence: "explicit", evidence: "staff hoodies", isCorrection: false },
            { section: "audience", value: "Staff", confidence: "explicit", evidence: "staff hoodies", isCorrection: false },
            { section: "requiredWording", value: "Rivera Plumbing", confidence: "inferred", evidence: "for Rivera Plumbing", isCorrection: false },
          ],
        },
        {
          message: "Create school fun run tees for Lincoln Elementary.",
          proposedUpdates: [
            { section: "product", value: "T-shirt", confidence: "explicit", evidence: "fun run tees", isCorrection: false },
            { section: "purpose", value: "School fun run", confidence: "explicit", evidence: "school fun run", isCorrection: false },
            { section: "audience", value: "Lincoln Elementary", confidence: "inferred", evidence: "for Lincoln Elementary", isCorrection: false },
          ],
        },
        {
          message:
            "this is a take on the old sitcom my 3 sons, so i want to create a team logo but bowling themed, with that retro vibe",
          note:
            "Synthesis example: values are clean design language, never the raw sentence fragments quoted in evidence.",
          proposedUpdates: [
            { section: "graphics", value: "Retro bowling team logo inspired by a classic sitcom-era aesthetic", confidence: "explicit", evidence: "team logo but bowling themed, with that retro vibe", isCorrection: false },
            { section: "style", value: "Retro / mid-century", confidence: "explicit", evidence: "that retro vibe", isCorrection: false },
          ],
        },
        {
          message: "GLORIOUS is the boat name",
          note:
            "Reversed naming order: the requiredWording value is only the name itself — never the whole sentence.",
          proposedUpdates: [
            { section: "requiredWording", value: "GLORIOUS", confidence: "explicit", evidence: "GLORIOUS is the boat name", isCorrection: false },
          ],
        },
        {
          message:
            "the wording is the boat name shouldn't appear on the design. it was me telling you to use the word GLORIOUS",
          note:
            "Post-selection correction: the customer is explaining that an earlier turn's literal wording was wrong — only GLORIOUS is required wording; the explanatory clause is excluded, never re-proposed as literal text.",
          proposedUpdates: [
            { section: "requiredWording", value: "GLORIOUS", confidence: "explicit", evidence: "use the word GLORIOUS", isCorrection: true },
            { section: "exclusions", value: "No \"is the boat name\" wording on the design", confidence: "explicit", evidence: "shouldn't appear on the design", isCorrection: true },
          ],
        },
        {
          message: "lets create a t-shirt design of my Red 1988 Toyota MR2",
          note:
            "Color-role disambiguation: the vehicle's own color describes the SUBJECT of the artwork, never the garment. There is no productColor here at all.",
          proposedUpdates: [
            { section: "product", value: "T-shirt", confidence: "explicit", evidence: "t-shirt design", isCorrection: false },
            { section: "graphics", value: "A red 1988 Toyota MR2", confidence: "explicit", evidence: "my Red 1988 Toyota MR2", isCorrection: false },
          ],
        },
        {
          message: "create a design of a red 1988 toyota mr2",
          note:
            "No product is named — \"design\" is what we are making, not what we print on — so there is no product update at all. The car's color describes the subject, so it belongs in graphics and nowhere else.",
          proposedUpdates: [
            { section: "graphics", value: "A red 1988 Toyota MR2", confidence: "explicit", evidence: "a red 1988 toyota mr2", isCorrection: false },
          ],
        },
        {
          message: "create artwork for a banner",
          note:
            "\"artwork\" is what we are making; \"banner\" is the product. Non-garment products are proposed in the customer's own words.",
          proposedUpdates: [
            { section: "product", value: "Banner", confidence: "explicit", evidence: "a banner", isCorrection: false },
          ],
        },
        {
          message:
            "no the color of the shirt is black the design is my 1988 Toyota MR2 which is Red",
          note:
            "Two different color roles corrected in one message: the garment color (productColor) and the artwork subject's own color (part of graphics). Neither is proposed as `colors` (a palette preference), and graphics is a clean synthesis of just the design-relevant portion — never the whole raw sentence, which also carries an unrelated garment-color clause.",
          proposedUpdates: [
            { section: "productColor", value: "Black", confidence: "explicit", evidence: "the color of the shirt is black", isCorrection: true },
            { section: "graphics", value: "A red 1988 Toyota MR2", confidence: "explicit", evidence: "the design is my 1988 Toyota MR2 which is Red", isCorrection: true },
          ],
        },
      ],
      null,
      2,
    ),
    "Respond with a single JSON object only — no markdown fences, no commentary — matching exactly this shape:",
    JSON.stringify(
      {
        proposedUpdates: [
          {
            section:
              "product | graphics | requiredWording | productColor | style | colors | audience | purpose | exclusions | additionalNotes | printLocation",
            value: "string",
            confidence: "explicit | inferred | ambiguous",
            evidence: "short quote from the customer message",
            isCorrection: "boolean",
          },
        ],
        deferrals: [{ section: "string", evidence: "string" }],
        ambiguities: [{ section: "string", note: "string" }],
        customerIntent:
          "provide_info | correct | defer | approve | request_revision | ask_question | unclear",
        answeredPendingSection: "string or null",
      },
      null,
      2,
    ),
  ].join("\n");

  const contextLines: string[] = [];
  const knownEntries = Object.entries(request.knownBrief).filter(
    ([, v]) => typeof v === "string" && v.trim().length > 0,
  );
  if (knownEntries.length > 0) {
    contextLines.push(
      "Already known (do not re-ask for these unless the customer is correcting one):",
    );
    for (const [section, value] of knownEntries) {
      contextLines.push(`- ${section}: ${value}`);
    }
  }
  if (request.unresolvedSections.length > 0) {
    contextLines.push(`Still unresolved: ${request.unresolvedSections.join(", ")}.`);
  }
  if (request.pendingSection) {
    contextLines.push(
      `The assistant just asked about: ${request.pendingSection}. If this message answers it, set answeredPendingSection accordingly.`,
    );
  }
  if (request.recentTurns.length > 0) {
    contextLines.push("Recent conversation (oldest first):");
    for (const turn of request.recentTurns) {
      contextLines.push(`${turn.role}: ${turn.text}`);
    }
  }
  contextLines.push(`Customer message to interpret: ${request.message}`);

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: contextLines.join("\n") },
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

function normalizeRawInterpretation(raw: unknown): ConversationUnderstandingResult {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    proposedUpdates: Array.isArray(obj.proposedUpdates)
      ? (obj.proposedUpdates as ConversationUnderstandingResult["proposedUpdates"])
      : [],
    deferrals: Array.isArray(obj.deferrals)
      ? (obj.deferrals as ConversationUnderstandingResult["deferrals"])
      : [],
    ambiguities: Array.isArray(obj.ambiguities)
      ? (obj.ambiguities as ConversationUnderstandingResult["ambiguities"])
      : [],
    customerIntent:
      typeof obj.customerIntent === "string"
        ? (obj.customerIntent as ConversationUnderstandingResult["customerIntent"])
        : "unclear",
    answeredPendingSection:
      typeof obj.answeredPendingSection === "string"
        ? (obj.answeredPendingSection as ConversationUnderstandingResult["answeredPendingSection"])
        : null,
  };
}
