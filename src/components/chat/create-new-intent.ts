/**
 * Existing Artwork → Print Ready Phase 1, Create New correction.
 *
 * "Create New Artwork" is a conversational answer, not a mode switch. The
 * card offers the customer two ways to state what they want; picking the
 * design-it-with-me side is the same statement they could type, so it goes
 * through the same authoritative path every other customer turn goes
 * through (`POST /api/projects/:id/messages` via `ChatApp.sendMessage`).
 *
 * The button previously only flipped a transient client enum, which
 * unmounted the choice card and did nothing else — the composer and the
 * opening question were already mounted before the click, so the customer
 * saw the card vanish and no forward motion at all. Sending the intent is
 * what makes the assistant actually answer.
 *
 * This is the established shape in `ChatApp` for "a control that means a
 * conversational reply" — `RecommendationCard` submits its actions the
 * same way. It is deliberately NOT a new capability, route, or persisted
 * workflow column: no such thing exists, and workflow identity for the
 * other branch is already carried durably by the preparation record
 * (`uploaded-artwork-flow.ts`).
 */

/**
 * What the customer is saying by clicking "Create New Artwork", phrased as
 * they would say it. Must stay a non-empty string under 4000 characters —
 * the messages route rejects anything else.
 */
export const CREATE_NEW_ARTWORK_INTENT =
  "I'd like you to design new artwork for me.";
