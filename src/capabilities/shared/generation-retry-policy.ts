/**
 * Sprint 2H Part 1 / 2B: shared generation retry budget.
 *
 * A generation job can reach a fresh attempt from two different places:
 *   1. `ConceptGenerationCapability`'s enqueue path — a customer implicitly
 *      retries by asking again (or pressing "try again") after an explicit
 *      failure message.
 *   2. `GenerationWorkerCapability`'s recovery path — a worker that died
 *      mid-attempt leaves its job "recoverable", and a later worker claims
 *      it again with no customer involved at all.
 *
 * Both paths must honor the same budget so a job can never retry more than
 * `MAX_GENERATION_ATTEMPTS` times in total, however the attempts are spread
 * across customer-initiated and recovery-initiated claims. A single shared
 * constant (rather than two independently-tuned ones) keeps that true by
 * construction instead of by convention.
 */
export const MAX_GENERATION_ATTEMPTS = 3;
