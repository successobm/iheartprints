/**
 * Phase 2C0.5: the LOGICAL PAID IMAGE INTENT identity contract.
 *
 * WHAT PROBLEM THIS SOLVES
 *
 * `GenerationJob` enqueue has always been idempotent — one durable job per
 * (project, approved brief version[, batch]). Paid EXECUTION was not.
 * Initial concept generation produces three directions sequentially, and
 * OpenAI can bill Bold and Soft successfully before Minimal fails. Nothing
 * durable recorded that Bold and Soft had already been paid for, so a
 * worker reclaim of that same job re-ran all three directions and re-billed
 * two images the platform already owned.
 *
 * A logical paid image intent is the smallest unit that can say:
 *
 *   "This exact paid image has already successfully generated and must
 *    never be paid for again during recovery."
 *
 * IT MUST DISTINGUISH               IT MUST NOT CHANGE FOR
 *   initial concept direction         worker reclaim
 *   targeted revision                 GenerationJob.attempts
 *   Phase 2C replacement (future)     transport retry
 *   intentional Explore/new batch     timestamps / random UUIDs
 *                                     provider request ids
 *
 * so the key is built ONLY from durable, deterministic facts: the project,
 * the generation job, the generation kind, a logical epoch, and the scope
 * (direction, plus the revision target where one exists). An intentional
 * "Show Me 3 New Concepts" batch already owns its own `GenerationJob` (see
 * `ConceptGenerationCapability.exploreNewConceptBatch`), so it lands on
 * different keys by construction — no extra discriminator is needed here.
 *
 * Prompt text is deliberately NOT hashed into the key. Nothing in this
 * architecture regenerates the same job/direction with different prompt
 * text: `PromptTranslation` is a pure function of the approved brief
 * version the job already points at, and a genuinely different prompt means
 * a genuinely different approved version, which means a different job.
 * Hashing prompt text would only make recovery *less* idempotent (a
 * whitespace-level prompt change would silently authorize a second paid
 * call for artwork the platform already owns).
 */

import type { ConceptDirectionKey } from "@/lib/domain/types";

import { MAX_GENERATION_ATTEMPTS } from "./generation-retry-policy";

/**
 * Which customer-facing paid operation an intent belongs to. Deliberately
 * NOT the same enum as `GenerationJob.kind` ("initial" | "regeneration"):
 * a three-direction "show me alternatives" regeneration and a one-concept
 * targeted revision are the same job kind but genuinely different paid
 * operations, and Phase 2C replacement will be a third.
 */
export type PaidImageIntentKind =
  | "initial_concept"
  | "targeted_revision"
  /**
   * Phase 2C automatic hard-palette-failure replacement. Reserved by Phase
   * 2C0.5 and spent by Phase 2C: one new logical paid image that replaces a
   * candidate the deterministic validator hard-failed.
   */
  | "replacement";

/**
 * The direction an intent produces. `"batch"` is the honest identity for a
 * provider adapter that does not expose per-direction generation (the
 * placeholder stub, and the fakes existing tests are written against): the
 * whole batch is one indivisible unit of work there, so it is one logical
 * intent rather than three that cannot actually be checkpointed apart.
 */
export type PaidImageIntentScopeKey = ConceptDirectionKey | "batch";

/**
 * The logical revision/replacement epoch. `0` is the original set produced
 * by a job. Phase 2C replacement uses `1`, so a replacement of an
 * already-generated direction is a genuinely NEW paid intent rather than a
 * recovery of the one it replaces.
 */
export const ORIGINAL_PAID_INTENT_EPOCH = 0;

/**
 * Phase 2C: the epoch of an automatic replacement. Deliberately a CONSTANT,
 * not a counter.
 *
 * One automatic replacement per direction is the whole policy, so there is
 * no epoch 2 in this phase and nothing may compute one. Fixing it here is
 * also what makes recovery free: a reclaim, a transport retry, or a repeated
 * sweep of the same job all rebuild the identical key, match the same
 * durable row, and reuse the image instead of buying another.
 */
export const REPLACEMENT_PAID_INTENT_EPOCH = 1;

export interface PaidImageIntentIdentity {
  projectId: string;
  generationJobId: string;
  kind: PaidImageIntentKind;
  scopeKey: PaidImageIntentScopeKey;
  /** Set only for `"targeted_revision"` — the artwork being revised. */
  targetArtworkVersionId?: string | null;
  /** Set only for `"replacement"` — the artwork being replaced (Phase 2C). */
  replacedArtworkVersionId?: string | null;
  /**
   * Phase 2C: the alternative `"replacement"` discriminator — the logical
   * paid intent whose candidate is being replaced.
   *
   * This exists because of WHEN automatic replacement happens. The customer
   * must never see a hard-failing concept that later disappears, so a
   * replacement is resolved BEFORE any `ArtworkVersion` row is written for
   * the batch — which means, at that moment, the thing being replaced has no
   * `ArtworkVersion` id to name. Its logical paid intent key is the durable,
   * deterministic identity it does have: pure over (project, job, kind,
   * epoch, direction), so a reclaim rebuilds it byte-for-byte.
   *
   * Exactly one of this and `replacedArtworkVersionId` must be set.
   */
  replacedPaidIntentKey?: string | null;
  /** Defaults to `ORIGINAL_PAID_INTENT_EPOCH`. */
  epoch?: number;
}

/** Versioned so a future contract change is visibly a different key space. */
const KEY_VERSION = "v1";

/**
 * The durable, deterministic identity of one paid image intent.
 *
 * Pure and total: the same identity always produces the same string, and
 * nothing time-, attempt-, worker-, or provider-dependent can enter it.
 */
export function buildPaidImageIntentKey(
  identity: PaidImageIntentIdentity,
): string {
  const epoch = identity.epoch ?? ORIGINAL_PAID_INTENT_EPOCH;
  if (!Number.isInteger(epoch) || epoch < 0) {
    throw new Error("Paid image intent epoch must be a non-negative integer.");
  }

  const scope = describeScope(identity);
  return [
    "paid-image",
    KEY_VERSION,
    identity.projectId,
    identity.generationJobId,
    identity.kind,
    `e${epoch}`,
    scope,
  ].join(":");
}

function describeScope(identity: PaidImageIntentIdentity): string {
  switch (identity.kind) {
    case "initial_concept":
      return `d=${identity.scopeKey}`;
    case "targeted_revision": {
      const target = identity.targetArtworkVersionId;
      if (!target) {
        throw new Error(
          "A targeted-revision paid image intent requires targetArtworkVersionId.",
        );
      }
      return `t=${target}:d=${identity.scopeKey}`;
    }
    case "replacement": {
      const replacedArtwork = identity.replacedArtworkVersionId;
      const replacedIntent = identity.replacedPaidIntentKey;
      if (replacedArtwork && replacedIntent) {
        throw new Error(
          "A replacement paid image intent must name exactly one thing it replaces.",
        );
      }
      if (replacedArtwork) return `d=${identity.scopeKey}:r=${replacedArtwork}`;
      if (replacedIntent) return `d=${identity.scopeKey}:ri=${replacedIntent}`;
      throw new Error(
        "A replacement paid image intent requires replacedArtworkVersionId or replacedPaidIntentKey.",
      );
    }
  }
}

// --- Paid intent budget -----------------------------------------------

/**
 * Phase 2C0.5 (§5): how many ADDITIONAL logical paid intents a job may ever
 * spend beyond the set it was enqueued to produce. Sized for the Phase 2C
 * automatic replacement feature that will consume it — at most two
 * replacement images per job — and for nothing else.
 *
 * Phase 2C spends against this and nothing else. It holds no counter of its
 * own: a replacement is attempted by trying to reserve a slot, and the
 * database refusing that reservation IS the limit. That is what makes the
 * bound survive a crash, a reclaim, and two workers racing — an in-memory
 * tally would survive none of them.
 */
export const MAX_REPLACEMENT_PAID_INTENTS_PER_JOB = 2;

/**
 * The hard ceiling any single generation job may ever reach, whatever it
 * was enqueued for. Mirrored as a CHECK constraint on
 * `paid_image_intents.paid_intent_ordinal` so the database refuses a sixth
 * intent even if application logic is wrong.
 *
 * 3 initial directions + 2 Phase 2C replacements = 5.
 */
export const ABSOLUTE_MAX_PAID_INTENTS_PER_JOB = 5;

/**
 * The budget for one job: the intents it was enqueued to produce, plus the
 * future replacement allowance, clamped to the absolute ceiling.
 *
 * A targeted revision (`conceptCount === 1`) therefore gets 3, and an
 * initial/alternatives batch (`conceptCount === 3`) gets 5.
 *
 * IMPORTANT, and the whole point of counting INTENTS rather than calls:
 *   - recovering an already-succeeded intent consumes nothing (it is the
 *     same row, matched by key);
 *   - a transport retry consumes nothing (it bumps `attempts` on the same
 *     row);
 *   - only a genuinely new logical intent takes a new ordinal.
 */
export function paidIntentBudgetForJob(conceptCount: number): number {
  const enqueued =
    Number.isFinite(conceptCount) && conceptCount > 0 ? Math.floor(conceptCount) : 1;
  return Math.min(
    enqueued + MAX_REPLACEMENT_PAID_INTENTS_PER_JOB,
    ABSOLUTE_MAX_PAID_INTENTS_PER_JOB,
  );
}

/**
 * Sprint A4 Correction 1: the acquisition free-concept budget. Exactly ONE
 * paid image dispatch, for the whole job, forever.
 *
 * WHY THIS IS A SEPARATE NUMBER AND NOT `paidIntentBudgetForJob(1)`
 *
 * They are not the same value, and assuming they were is the defect this
 * constant exists to close. `paidIntentBudgetForJob` adds the Phase 2C
 * replacement allowance ON TOP OF the concept count, so a one-concept job
 * gets `1 + 2 = 3`. The acquisition promise — "one free concept" — was
 * therefore true of what the customer saw and false of what was spent: a
 * single free attempt could buy three images.
 *
 * The promise is one concept, not one concept of guaranteed quality. A free
 * concept may be imperfect; buying a second image to improve it is exactly
 * the unbounded-free-spend loop the entitlement exists to prevent.
 */
export const ACQUISITION_FREE_CONCEPT_PAID_INTENT_BUDGET = 1;

/**
 * The budget for one REAL job, resolved from durable job authority.
 *
 * This is the function production code must call. `paidIntentBudgetForJob`
 * above remains the pure concept-count policy (and the thing its own unit
 * tests exercise), but it cannot see the one fact that overrides it, so a
 * call site that reaches for it directly silently re-opens the defect.
 *
 * `acquisitionSessionId` is the durable marker, carried on the job row and
 * enforced unique per session by the database — so a worker that claimed
 * this job hours later, in another process, with no request context and no
 * cookie, still resolves the same answer.
 */
export function paidIntentBudgetForGenerationJob(job: {
  conceptCount: number;
  acquisitionSessionId?: string | null;
}): number {
  if (job.acquisitionSessionId) {
    return ACQUISITION_FREE_CONCEPT_PAID_INTENT_BUDGET;
  }
  return paidIntentBudgetForJob(job.conceptCount);
}

/**
 * Phase 2C0.5 (§6): how many times a single logical paid intent may ever be
 * DISPATCHED to the provider, across every worker, every reclaim, and every
 * transport attempt combined.
 *
 * Deliberately the SAME number as `MAX_GENERATION_ATTEMPTS`, and derived
 * from it rather than tuned independently. The point of this budget is to
 * make the existing retry ceiling durable, cross-worker, and per-image — it
 * is not an opportunity to quietly shrink how many times a customer's
 * explicit "try again" works. A separately-tuned smaller number would have
 * done exactly that: a job that legitimately reached its third attempt
 * would find its images refused before the provider was ever contacted.
 *
 * What this bound actually buys is enormous even at parity. Before this
 * phase a single initial job could reach
 *
 *   3 job attempts x 3 directions x 3 blind transport retries = 27 paid
 *   dispatches
 *
 * because a completed direction was never recorded and an ambiguous
 * post-dispatch failure was retried as if it were free. It is now bounded
 * at 3 dispatches for ONE image, only ever for an image that has never
 * durably succeeded, with transport-level retries restricted to failures
 * that provably never reached the provider (see `isRetryableProviderError`).
 *
 * Because the two ceilings are equal, the JOB attempt budget is normally
 * the one that trips first in practice — this is the durable, per-image
 * backstop underneath it, not a tighter gate. That distinction matters:
 * `GenerationJob.attempts` is a per-job counter that a future change to
 * claiming could reset or bypass, while this one is recorded against the
 * individual image and survives any such change.
 *
 * The residual risk is stated rather than hidden: an ambiguous
 * post-dispatch failure that the provider actually billed can be paid for
 * up to this many times for a single image. That is unavoidable without a
 * provider-side idempotency mechanism this endpoint does not document.
 */
export const MAX_PAID_DISPATCHES_PER_INTENT = MAX_GENERATION_ATTEMPTS;

/**
 * Sprint A4 Correction 2: how many times the acquisition free concept may
 * be PHYSICALLY SUBMITTED to an image provider. Once. Ever.
 *
 * WHY ONE INTENT WAS NOT ENOUGH
 *
 * Correction 1 capped the free job at one logical paid image INTENT, which
 * made "one free concept" true of the artwork. It was still false of the
 * money: a single intent may be dispatched `MAX_PAID_DISPATCHES_PER_INTENT`
 * times, because an ambiguous post-dispatch failure cannot be proven
 * un-billed and the ordinary policy prefers retrying to stranding a paying
 * customer. One free concept could therefore still reach three physical
 * submissions and three charges.
 *
 * That trade is correct for a paid job and wrong for a free one. For work
 * somebody paid for, refusing to retry an ambiguous failure risks taking
 * their money and delivering nothing — so the platform absorbs the
 * duplicate-billing risk. For an acquisition giveaway there is no such
 * obligation: the promise is one attempt at one concept. Preferring one
 * possibly-failed attempt over silently buying another image is the whole
 * point of the entitlement.
 *
 * The residual risk is stated rather than hidden: an ambiguous failure the
 * provider actually billed still costs one image. That is unavoidable
 * without provider-side idempotency this endpoint does not document — but
 * it is now bounded at one instead of three.
 */
export const ACQUISITION_FREE_CONCEPT_MAX_PHYSICAL_DISPATCHES = 1;

/**
 * The physical-dispatch ceiling for one REAL job, resolved from durable job
 * authority. THE ONLY thing production code may pass to
 * `beginPaidImageIntentDispatch`.
 *
 * Centralized for the same reason `paidIntentBudgetForGenerationJob` is: the
 * ceiling is read at four separate points in the executor (authorize, both
 * refusal messages, and the terminal-status decision), and four call sites
 * each reaching for the module constant is four chances for the free path to
 * silently regain two extra submissions.
 *
 * Deliberately keyed on `acquisitionSessionId`, NOT on `conceptCount`. A
 * targeted revision is also a one-concept job and must keep the ordinary
 * retry policy — it is paid work on a design the customer already chose, and
 * stranding it on one ambiguous transport failure would be the exact harm
 * the ordinary policy exists to prevent.
 */
export function maxPhysicalDispatchesForGenerationJob(job: {
  acquisitionSessionId?: string | null;
}): number {
  if (job.acquisitionSessionId) {
    return ACQUISITION_FREE_CONCEPT_MAX_PHYSICAL_DISPATCHES;
  }
  return MAX_PAID_DISPATCHES_PER_INTENT;
}
