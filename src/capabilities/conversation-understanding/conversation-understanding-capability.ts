import type { BriefSectionKey, DesignSummaryView } from "@/capabilities/shared/contracts";
import { traceConversationUnderstanding } from "@/lib/debug/conversation-understanding-trace";
import type { ConversationMessage } from "@/lib/domain/types";

import type { ConversationUnderstandingProvider } from "./conversation-understanding-provider";
import {
  EMPTY_UNDERSTANDING_RESULT,
  type BoundedConversationTurn,
  type ConversationUnderstandingRequest,
  type ConversationUnderstandingResult,
  type CustomerIntent,
  type ProposedDeferral,
  type ProposedFieldUpdate,
  type UnderstandingAmbiguity,
  type UnderstandingConfidence,
} from "./contracts";

/** Sole set of Design Brief sections Conversation Understanding may ever propose. Kept in sync with `reconcile-understanding.ts`'s SUPPORTED_SECTIONS — both must agree on what "supported" means. */
const SUPPORTED_SECTIONS = new Set<BriefSectionKey>([
  "product",
  "graphics",
  "requiredWording",
  "productColor",
  "style",
  "colors",
  "audience",
  "purpose",
  "exclusions",
  "additionalNotes",
  "printLocation",
  // Sprint A2 (corrected): which production ARTIFACT the customer asked us to
  // produce. Previously a dormant `BriefSectionKey`; now the structured
  // authority that replaced regex-over-prose at the finalization gate.
  "production",
]);

const CONFIDENCE_VALUES = new Set<UnderstandingConfidence>([
  "explicit",
  "inferred",
  "ambiguous",
]);
const CUSTOMER_INTENT_VALUES = new Set<CustomerIntent>([
  "provide_info",
  "correct",
  "defer",
  "approve",
  "request_revision",
  "ask_question",
  "unclear",
]);

/** Bounded-context caps (Goal 4 / Goal 12 — see ARCHITECTURE.md). */
const MAX_MESSAGE_CHARS = 2000;
const MAX_RECENT_TURNS = 6; // ~3 customer/assistant pairs
const MAX_TURN_CHARS = 300;
const MAX_EVIDENCE_CHARS = 200;
const MAX_VALUE_CHARS = 300;
const MAX_NOTE_CHARS = 200;
const MAX_LIST_ITEMS = 12;

export interface ConversationUnderstandingInput {
  message: string;
  /** Plain-language, already-resolved Design Brief facts (see `DesignSummaryView`) — never raw ids/timestamps. */
  knownBrief: DesignSummaryView;
  unresolvedSections: BriefSectionKey[];
  pendingSection: BriefSectionKey | null;
  /** Full transcript so far; the capability bounds it itself — callers never pre-truncate. */
  recentMessages: ConversationMessage[];
}

/**
 * Sprint 2L Phase 1: orchestrates Conversation Understanding.
 *
 * Provider-neutral — never knows OpenAI, GPT, or any vendor API by name
 * outside its own resolver. Never mutates the Design Brief, never writes
 * repositories, never decides what to ask next. `IntentExtractionCapability`
 * (via `reconcile-understanding.ts`) is the sole place a
 * `ConversationUnderstandingResult` is turned into a Design Brief change —
 * see `capability-boundaries.ts`.
 *
 * Owns:
 *   - building the bounded, customer-safe request a provider may see
 *   - the "is a provider call even worth making this turn" skip policy
 *     (Goal 12)
 *   - defensively validating/clamping whatever a provider returns, so a
 *     malformed, unsupported, or out-of-range value can never reach
 *     reconciliation (Goal 10)
 *   - graceful degradation to `EMPTY_UNDERSTANDING_RESULT` on any provider
 *     failure, with a bounded, customer-safe internal diagnostic only
 */
export interface ConversationUnderstandingCapability {
  interpret(
    input: ConversationUnderstandingInput,
  ): Promise<ConversationUnderstandingResult>;
  readonly providerKey: string;
}

export function createConversationUnderstandingCapability(
  provider: ConversationUnderstandingProvider,
): ConversationUnderstandingCapability {
  return {
    get providerKey() {
      return provider.providerKey;
    },

    async interpret(input) {
      const message = input.message.trim();
      if (!message) return EMPTY_UNDERSTANDING_RESULT;

      const skip = shouldSkipProviderCall(message);
      traceConversationUnderstanding({
        stage: "request",
        pendingSection: input.pendingSection,
        unresolvedSections: input.unresolvedSections,
        messageWordCount: message.split(/\s+/).filter(Boolean).length,
        willCallProvider: !skip,
      });

      if (skip) {
        return EMPTY_UNDERSTANDING_RESULT;
      }

      const request = buildRequest(input, message);

      try {
        const raw = await provider.interpret(request);
        const result = sanitizeResult(raw);
        traceConversationUnderstanding({
          stage: "provider_result",
          proposals: result.proposedUpdates.map((u) => ({
            section: u.section,
            confidence: u.confidence,
          })),
          deferrals: result.deferrals.map((d) => d.section),
          ambiguities: result.ambiguities.map((a) => a.section),
          customerIntent: result.customerIntent,
          failed: false,
        });
        return result;
      } catch {
        // Goal 10: never strand the customer, never leak provider/vendor
        // terminology. The caller (IntentExtractionCapability) already
        // treats an empty result as "fall back to deterministic
        // extraction alone" — exactly today's behavior.
        traceConversationUnderstanding({
          stage: "provider_result",
          proposals: [],
          deferrals: [],
          ambiguities: [],
          customerIntent: "unclear",
          failed: true,
        });
        return EMPTY_UNDERSTANDING_RESULT;
      }
    },
  };
}

/**
 * Goal 12: skip the provider call entirely for a single-token reply
 * ("black", "none", "navy") — deterministic extraction's pending-section
 * fallback and color/product vocabularies already resolve these
 * confidently and cheaply. Every reply with real sentence structure (2+
 * words) still gets exactly one semantic interpretation call — "target one
 * semantic interpretation call per customer turn when needed," not zero
 * and not more than one.
 */
function shouldSkipProviderCall(message: string): boolean {
  const wordCount = message.split(/\s+/).filter(Boolean).length;
  return wordCount <= 1;
}

function buildRequest(
  input: ConversationUnderstandingInput,
  message: string,
): ConversationUnderstandingRequest {
  return {
    message: message.slice(0, MAX_MESSAGE_CHARS),
    knownBrief: input.knownBrief,
    unresolvedSections: input.unresolvedSections.filter((s) =>
      SUPPORTED_SECTIONS.has(s),
    ),
    pendingSection: input.pendingSection,
    recentTurns: boundRecentTurns(input.recentMessages),
  };
}

/**
 * Bounded-context strategy (Goal 4 / Goal 12): the last few turns only,
 * role + truncated text — never full history, never message ids,
 * timestamps, or metadata (which can carry internal act/section/finding
 * identifiers not meant for a provider).
 */
function boundRecentTurns(
  messages: ConversationMessage[],
): BoundedConversationTurn[] {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-MAX_RECENT_TURNS)
    .map((m) => ({
      role: m.role === "user" ? "customer" : "assistant",
      text: m.content.trim().slice(0, MAX_TURN_CHARS),
    }));
}

/* ------------------------------------------------------------------ */
/* Defensive validation of provider output (Goal 10)                   */
/* ------------------------------------------------------------------ */

function sanitizeResult(
  raw: ConversationUnderstandingResult,
): ConversationUnderstandingResult {
  if (!raw || typeof raw !== "object") return EMPTY_UNDERSTANDING_RESULT;

  return {
    proposedUpdates: sanitizeUpdates(raw.proposedUpdates),
    deferrals: sanitizeDeferrals(raw.deferrals),
    ambiguities: sanitizeAmbiguities(raw.ambiguities),
    customerIntent: CUSTOMER_INTENT_VALUES.has(raw.customerIntent)
      ? raw.customerIntent
      : "unclear",
    answeredPendingSection:
      raw.answeredPendingSection && SUPPORTED_SECTIONS.has(raw.answeredPendingSection)
        ? raw.answeredPendingSection
        : null,
  };
}

function sanitizeUpdates(value: unknown): ProposedFieldUpdate[] {
  if (!Array.isArray(value)) return [];
  const out: ProposedFieldUpdate[] = [];
  for (const item of value.slice(0, MAX_LIST_ITEMS)) {
    if (!item || typeof item !== "object") continue;
    const update = item as Partial<ProposedFieldUpdate>;
    if (!update.section || !SUPPORTED_SECTIONS.has(update.section)) continue;
    if (typeof update.value !== "string") continue;
    if (!update.confidence || !CONFIDENCE_VALUES.has(update.confidence)) continue;
    out.push({
      section: update.section,
      value: update.value.trim().slice(0, MAX_VALUE_CHARS),
      confidence: update.confidence,
      evidence:
        typeof update.evidence === "string"
          ? update.evidence.trim().slice(0, MAX_EVIDENCE_CHARS)
          : "",
      isCorrection: update.isCorrection === true,
    });
  }
  return out;
}

function sanitizeDeferrals(value: unknown): ProposedDeferral[] {
  if (!Array.isArray(value)) return [];
  const out: ProposedDeferral[] = [];
  for (const item of value.slice(0, MAX_LIST_ITEMS)) {
    if (!item || typeof item !== "object") continue;
    const deferral = item as Partial<ProposedDeferral>;
    if (!deferral.section || !SUPPORTED_SECTIONS.has(deferral.section)) continue;
    out.push({
      section: deferral.section,
      evidence:
        typeof deferral.evidence === "string"
          ? deferral.evidence.trim().slice(0, MAX_EVIDENCE_CHARS)
          : "",
    });
  }
  return out;
}

function sanitizeAmbiguities(value: unknown): UnderstandingAmbiguity[] {
  if (!Array.isArray(value)) return [];
  const out: UnderstandingAmbiguity[] = [];
  for (const item of value.slice(0, MAX_LIST_ITEMS)) {
    if (!item || typeof item !== "object") continue;
    const ambiguity = item as Partial<UnderstandingAmbiguity>;
    const section =
      ambiguity.section === "general" ||
      (ambiguity.section && SUPPORTED_SECTIONS.has(ambiguity.section))
        ? ambiguity.section
        : null;
    if (!section) continue;
    if (typeof ambiguity.note !== "string") continue;
    out.push({ section, note: ambiguity.note.trim().slice(0, MAX_NOTE_CHARS) });
  }
  return out;
}
