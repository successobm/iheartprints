/**
 * Sprint A3 — the ONE place an IP safety decision becomes language a
 * customer reads.
 *
 * Everything the boundary knows internally — reasons, evidence spans,
 * detector names, lexicon hits, confidence, which of the two layers fired —
 * stops here. Concentrating it in a single module is what makes "internal
 * enums never leak" checkable rather than hoped for.
 *
 * DESIGN RULES, in priority order:
 *
 *   1. NEVER make a legal conclusion. The product does not say the customer
 *      is infringing, that something is protected, that anything is
 *      licensed, or that anything is cleared. It says what iHeartPrints
 *      will and will not make.
 *   2. NEVER accuse. The customer is not told they did something wrong.
 *   3. NEVER teach evasion. No threshold, no percentage, no "if you change
 *      X it would be fine" — the whole reason evasion requests are blocked
 *      is so the product never has to answer that question.
 *   4. NEVER expose policy internals. No reason codes, no rule names, no
 *      mention of detection, scanning, or a "safety system".
 *   5. ALWAYS redirect. A dead end is a failed conversation; the customer
 *      came here to get artwork and there is almost always an original
 *      design that serves the same purpose.
 *
 * Deliberately ONE message for every reason. A reason-specific message
 * would let the internal classification be read straight off the wording —
 * "you asked me to evade a trademark" is an enum leak in prose — and would
 * put the product in the position of characterizing what the customer did.
 */

import type { IpSafetyDecision } from "./contracts";

/**
 * The redirect. Written to be usable at any point in the conversation: the
 * interview, a post-selection revision, or an uploaded-artwork redesign
 * request.
 */
const IP_SAFETY_REDIRECT_MESSAGE =
  "I can't recreate or closely imitate another company's or team's logo, mark, or characters — " +
  "but I can absolutely design something original for you along the same lines. " +
  "Tell me the colors, the theme, and the feel you're going for — a color pair, a mascot idea, " +
  "a city or regional angle, or a style like vintage, collegiate, or bold and aggressive — " +
  "and I'll build original artwork around that.";

/**
 * The customer-facing text for a decision.
 *
 * Returns `null` for an allowed decision: there is nothing to say, and a
 * "this looks fine" message would be both noise and an implied clearance
 * claim.
 */
export function describeIpSafetyDecisionForCustomer(
  decision: IpSafetyDecision,
): string | null {
  return decision.outcome === "block" ? IP_SAFETY_REDIRECT_MESSAGE : null;
}

/**
 * Exported for tests that assert the exact customer-facing copy and for the
 * generation fences, which post the same words a conversational block does —
 * one refusal, one voice, whichever boundary happens to catch it.
 */
export { IP_SAFETY_REDIRECT_MESSAGE };
