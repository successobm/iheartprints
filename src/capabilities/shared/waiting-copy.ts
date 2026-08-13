/**
 * Live Acceptance Cleanup (Issue 4): customer-facing waiting copy, in one
 * place.
 *
 * Live timings are genuinely long — initial concepts and targeted revisions
 * both land around 3–4 minutes, and print-ready finalization is comparable.
 * Silence for that long reads as "the app is frozen", so every wait states a
 * plain-language expectation.
 *
 * Deliberately NOT a progress system: no percentages, no fabricated pipeline
 * stages, no promised completion time, and no "do not refresh" warning
 * (refreshing is safe — every wait is backed by a durable job and a status
 * poll). The estimate is a single shared constant so it can be revised in one
 * edit when provider performance changes, rather than hunted down across
 * capabilities and components.
 *
 * Lives in `shared/` for the same reason `chat-input-policy.ts` does: it is
 * policy/copy with no persistence or provider knowledge, so both a capability
 * and a client component may import it.
 */

/**
 * The one place the "about 3–4 minutes" figure exists. Honest hedging
 * ("usually", "about") is load-bearing — the pipeline genuinely varies, and
 * a precise-sounding estimate we miss is worse than no estimate at all.
 */
export const APPROXIMATE_WAIT_NOTE =
  "Thanks for your patience; this usually takes about 3–4 minutes.";

/** Initial three-direction exploration, immediately after brief approval. */
export const INITIAL_CONCEPTS_WAITING_MESSAGE = `Design brief approved — generating three concept directions. ${APPROXIMATE_WAIT_NOTE}`;

/**
 * A fresh batch of three directions from the SAME approved brief — the
 * customer didn't like the current batch but the brief itself is right
 * (Live Acceptance Cleanup, Issue 3).
 */
export const NEW_CONCEPT_BATCH_WAITING_MESSAGE = `Exploring three new concept directions from your approved design brief. ${APPROXIMATE_WAIT_NOTE}`;

/** Three-direction regeneration after a brief change made the batch stale. */
export const ALTERNATIVE_CONCEPTS_WAITING_MESSAGE = `Generating a few new directions for you to consider. ${APPROXIMATE_WAIT_NOTE}`;

/** Targeted revision of the one selected concept. */
export const TARGETED_REVISION_WAITING_MESSAGE = `Updating your selected concept with those changes. ${APPROXIMATE_WAIT_NOTE}`;

/** Production finalization — the print-ready artwork pipeline. */
export const PRINT_READY_WAITING_MESSAGE = `Preparing your print-ready artwork. ${APPROXIMATE_WAIT_NOTE}`;

/**
 * Infrastructure/processing failure while the project is still finalizing.
 * The existing Prepare action is the retry — never a second API, never a
 * provider name, never the internal error string.
 */
export const PRINT_READY_RETRY_MESSAGE =
  "Print-ready preparation couldn't finish.";
export const PRINT_READY_RETRY_SUPPORTING_MESSAGE =
  "Your design is safe. Try preparing the file again.";
export const PRINT_READY_RETRY_ACTION_LABEL = "Retry Preparation";
