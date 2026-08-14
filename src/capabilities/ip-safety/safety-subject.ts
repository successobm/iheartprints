/**
 * Sprint A3, Correction 2 & 3 — THE CANONICAL SAFETY SUBJECT.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MODULE EXISTS
 * ---------------------------------------------------------------------------
 *
 * The first implementation evaluated each structured field on its own. That
 * let an unsafe request escape by being SPLIT:
 *
 *     designDescription      = "Raiders"
 *     additionalInstructions = "use the exact shield"
 *
 * Neither field independently contains a complete unsafe request, so neither
 * fired — and the composed prompt sent to the provider would have contained
 * both. The same failure exists across TURNS:
 *
 *     turn 1: "I want a Raiders design."     ← a theme; allowed on its own
 *     turn 2: "Use their exact shield."      ← no brand named at all
 *
 * A safety boundary has to see the request the way the prompt translator
 * will: as one thing.
 *
 * ---------------------------------------------------------------------------
 * ONE BUILDER, TWO CALLERS, NO DRIFT
 * ---------------------------------------------------------------------------
 *
 * `buildGenerationIntentSubject` is the single construction used by BOTH the
 * enqueue fence (`ConceptGenerationCapability`) and the pre-provider fence
 * (`GenerationWorkerCapability`). They cannot disagree about what the
 * request is, because they do not each build it.
 *
 * ---------------------------------------------------------------------------
 * WHY JOINING WITH ", " IS THE WHOLE DESIGN
 * ---------------------------------------------------------------------------
 *
 * Fields and turns are joined with `", "` because of exactly how the
 * detector scopes (see `ip-safety-detection.ts`):
 *
 *   - a comma is NOT a clause boundary, so a referent in one field can still
 *     be associated with a binding in another — cross-field composition
 *     works; and
 *   - a comma IS a scope terminator, so a negation or removal in one field
 *     cannot leak forward and silently neutralize a different field.
 *
 * Trailing sentence punctuation is stripped from each part for the first
 * reason: a field ending in "." would otherwise split the subject into
 * separate clauses and defeat the composition entirely.
 *
 * ---------------------------------------------------------------------------
 * ORDER IS LOAD-BEARING: CURRENT INSTRUCTION FIRST
 * ---------------------------------------------------------------------------
 *
 * Operators scope FORWARD. Putting the customer's current, authoritative
 * instruction first is what lets a corrective instruction govern the context
 * behind it:
 *
 *     revision = "remove the logo and make it original"
 *     design   = "Raiders themed football design"
 *     → "remove the logo and make it original, Raiders themed football design"
 *       "remove" governs "the logo"; nothing binds the surviving "Raiders".
 *       ALLOWED — and correctly so, because that is what would be drawn.
 *
 * Reversed, the stale design context would sit in front of the correction and
 * read as a fresh request.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT IN THE SUBJECT
 * ---------------------------------------------------------------------------
 *
 * Only the generation-bearing free text that describes the ARTWORK is
 * included. Audited against `translateApprovedBrief`, which is the one place
 * a brief becomes a provider prompt:
 *
 *   INCLUDED  designDescription (→ subject), designStyle (→ style),
 *             additionalInstructions (→ notes), exclusions (→ exclusions),
 *             GenerationJob.revisionInstruction (→ RevisionDirective)
 *
 *   EXCLUDED  exactText — literal text to PRINT. A shirt that says "Raiders"
 *             is wording, not a logo request, and folding it in would refuse
 *             fan-club and team-name apparel outright.
 *             preferredColors — colour names carry no referent.
 *             productSummary / audience / purpose / shirtColor /
 *             printPlacement — these describe the garment, the recipient,
 *             the occasion and the placement, not the graphic. Including
 *             them would let "audience: Raiders fans" combine with an
 *             ordinary "logo" into a false refusal.
 *
 * ---------------------------------------------------------------------------
 * NO NEW PERSISTENCE
 * ---------------------------------------------------------------------------
 *
 * Every input here is state that already exists: the working/approved Design
 * Brief, the job's own `revisionInstruction`, and the conversation's own
 * messages. Nothing is stored, no verdict is cached, and no schema changed.
 */

import { IP_SAFETY_REDIRECT_MESSAGE } from "./customer-response";

/**
 * The generation-bearing free-text design fields, in the shape both
 * `TShirtDesignBrief` and `DesignBriefSnapshotContent` already provide.
 */
export interface DesignIntentFields {
  designDescription: string | null;
  designStyle: string | null;
  additionalInstructions: string | null;
  exclusions: string | null;
}

/** A conversation message, in the only shape this module needs. */
export interface SafetyTurn {
  role: string;
  content: string;
}

/**
 * How many prior customer turns the conversational gate composes with the
 * current message.
 *
 * BOUNDED ON PURPOSE, in both directions. Two turns is enough for the real
 * bypasses ("Raiders." → "Use the logo.") while keeping an old brand mention
 * from following the customer around: a mention rolls out of the window on
 * its own, so nothing here can permanently poison a project. The worker never
 * consults conversation text at all — it evaluates the structured brief.
 */
export const RECENT_CUSTOMER_TURN_WINDOW = 2;

/** Strips trailing sentence punctuation so joined parts stay in one clause. */
function normalizePart(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const stripped = trimmed.replace(/[.!?;:,\s]+$/g, "").trim();
  return stripped || null;
}

function compose(parts: (string | null | undefined)[]): string | null {
  const usable = parts.map(normalizePart).filter((part): part is string => part !== null);
  return usable.length > 0 ? usable.join(", ") : null;
}

/**
 * THE canonical subject for a generation request — the complete current
 * generation intent, as one text. Used identically by the enqueue fence and
 * the worker fence.
 */
export function buildGenerationIntentSubject(input: {
  design: DesignIntentFields;
  revisionInstruction: string | null;
}): string | null {
  return compose([
    // Current instruction first — see "ORDER IS LOAD-BEARING" above.
    input.revisionInstruction,
    input.design.designDescription,
    input.design.designStyle,
    input.design.additionalInstructions,
    input.design.exclusions,
  ]);
}

/**
 * THE canonical subject for one conversation turn: the customer's current
 * message plus a bounded window of their own recent, non-refused turns.
 *
 * The brief is deliberately NOT folded in here. A theme legitimately recorded
 * on the brief ("Raiders design") would otherwise combine with every later
 * mention of the word "logo" for the life of the project, and the customer
 * would have no way to talk their way out of it. The brief is exactly where
 * the two GENERATION fences do their work instead — which is the moment it
 * actually matters, because that is what gets drawn.
 */
export function buildConversationTurnSubject(input: {
  message: string;
  messages: readonly SafetyTurn[];
}): string | null {
  return compose([input.message, ...recentCustomerTurns(input.messages)]);
}

/**
 * The bounded window, newest first.
 *
 * A customer turn that was itself REFUSED is excluded. Without this, the
 * blocked message would stay in the window and keep re-blocking the next two
 * turns — the customer would be told to rephrase and then punished for their
 * rephrasing. Detected structurally: a user message whose next assistant
 * message is the IP safety redirect. That derives the fact from the
 * conversation record rather than persisting a safety verdict, which is
 * what keeps "no permanent poisoning" a property of the design.
 */
export function recentCustomerTurns(
  messages: readonly SafetyTurn[],
  limit: number = RECENT_CUSTOMER_TURN_WINDOW,
): string[] {
  const refused = new Set<number>();
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role !== "user") continue;
    const next = messages.slice(index + 1).find((message) => message.role !== "user");
    if (next?.role === "assistant" && next.content === IP_SAFETY_REDIRECT_MESSAGE) {
      refused.add(index);
    }
  }

  const turns: string[] = [];
  for (let index = messages.length - 1; index >= 0 && turns.length < limit; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user" || refused.has(index)) continue;
    const content = message.content.trim();
    if (content) turns.push(content);
  }
  return turns;
}
