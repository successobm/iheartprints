/**
 * Sprint A4 Correction C: what "the free concept has been DELIVERED to the
 * customer" means, defined exactly once.
 *
 * WHY THIS EXISTS
 *
 * The acquisition email gate is allowed to appear only AFTER the customer
 * can actually see their free concept. That rule was previously encoded as
 * `snapshot.artworkVersions.length > 0`, which is two different kinds of
 * wrong:
 *
 *   1. A row is written well before the concept is renderable. The
 *      generation worker persists `ArtworkVersion` rows, then runs
 *      provisional print validation, then completes the job, then sets
 *      `project.status = "concepts_ready"`, then advances the conversation
 *      phase, then writes the `concepts_ready` anchor message. Every one of
 *      those is a separate write, so there is a real window in which rows
 *      exist while the project is still `generating`. A snapshot read in
 *      that window reported the concept as delivered, and the customer was
 *      shown "generating concepts…" and "enter your email" at the same
 *      time — the value asked for before the value was given.
 *
 *   2. A `prepared_upload` row is not a concept at all. It is the
 *      customer's OWN artwork, background-removed on the Existing Artwork
 *      path (`ArtworkKind` — provenance is never inferred). Counting it
 *      meant a technical upload-preparation step could trip the Create New
 *      acquisition gate.
 *
 * WHAT THE CONDITION MATCHES
 *
 * Deliberately the same three facts the concept grid itself renders
 * against, so "delivered" cannot become true before the customer can see
 * anything (`ChatApp` → `showConcepts`):
 *
 *   generation is not in progress   `project.status !== "generating"` —
 *                                   which is also what drops the
 *                                   conversation out of the phases
 *                                   `deriveChatAffordances` shows artwork
 *                                   surfaces in.
 *   a GENERATED concept exists      an `ArtworkVersion` the generation
 *                                   pipeline produced, never a prepared
 *                                   upload.
 *   the concept has been announced  a `concepts_ready` anchor message —
 *                                   the message the concept grid is
 *                                   rendered against. It is the LAST write
 *                                   of the completion sequence, so
 *                                   requiring it closes the whole window
 *                                   rather than most of it.
 *
 * Deliberately NOT `project.status === "concepts_ready"`: the customer
 * moves the project to `revision_requested` (and later `approved`,
 * `finalizing`, `print_ready`) simply by continuing to work, and their
 * already-delivered concept must not un-deliver itself when they do.
 *
 * Pure and dependency-free — no repository, no capability, no I/O.
 */

import type {
  ArtworkKind,
  ArtworkVersion,
  ConversationMessage,
  ProjectStatus,
} from "@/lib/domain/types";

/**
 * The artwork kinds the concept-generation pipeline produces. An explicit
 * allowlist rather than `kind !== "prepared_upload"`: a future kind should
 * have to opt IN to counting as delivered free-concept evidence, because the
 * failure direction of a wrong guess here is asking a customer for their
 * address before they have seen anything.
 *
 * `"final"` is deliberately absent — it is a dormant reserved role no
 * production path writes today, and on the Existing Artwork path it would
 * describe the customer's own artwork rather than a generated concept.
 */
export const GENERATED_CONCEPT_KINDS: readonly ArtworkKind[] = [
  "concept",
  "revision",
];

/**
 * Was this artwork produced by concept generation? False for
 * `"prepared_upload"` — the customer's own uploaded pixels, which are never
 * a free Create New concept (Constitution §6.11 / §16).
 */
export function isGeneratedConcept(version: ArtworkVersion): boolean {
  return GENERATED_CONCEPT_KINDS.includes(version.kind);
}

/** The metadata phase marking the "here is artwork" message the grid renders against. */
const CONCEPTS_READY_ANCHOR_PHASE = "concepts_ready";

function hasConceptsReadyAnchor(messages: readonly ConversationMessage[]): boolean {
  return messages.some(
    (message) => message.metadata?.phase === CONCEPTS_READY_ANCHOR_PHASE,
  );
}

export interface ConceptDeliveryInput {
  status: ProjectStatus;
  artworkVersions: readonly ArtworkVersion[];
  messages: readonly ConversationMessage[];
}

/**
 * THE definition of a delivered concept. The acquisition email gate reads
 * this and nothing else — see `resolveAcquisitionView` in
 * `lib/services/conversation-service.ts`.
 */
export function hasDeliveredGeneratedConcept(
  input: ConceptDeliveryInput,
): boolean {
  if (input.status === "generating") return false;
  if (!input.artworkVersions.some(isGeneratedConcept)) return false;
  return hasConceptsReadyAnchor(input.messages);
}
