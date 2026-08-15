import { randomUUID } from "crypto";

import type { ProjectRepository } from "@/lib/db/repository";
import type {
  AssetRecord,
  ConceptDirectionKey,
  GenerationJob,
  PaidImageIntent,
} from "@/lib/domain/types";
import type { GeneratedConceptDraft } from "@/capabilities/shared/contracts";
import {
  buildPaidImageIntentKey,
  maxPhysicalDispatchesForGenerationJob,
  paidIntentBudgetForGenerationJob,
  type PaidImageIntentIdentity,
  type PaidImageIntentKind,
  type PaidImageIntentScopeKey,
} from "@/capabilities/shared/paid-image-intent";
import {
  classifyPaidImagePersistenceFailure,
  classifyProviderDispatchFailure,
  describePaidImageFailure,
  isPossiblyBilledFailureClass,
  type PaidImageFailureClass,
} from "@/capabilities/shared/paid-image-failure";
import {
  logPaidImageIntentDecision,
  logPaidImageIntentOutcome,
} from "@/lib/config/paid-image-intent-logging";

/**
 * Phase 2C0.5: the metadata key under which a persisted concept asset
 * records the logical paid intent that bought it.
 *
 * This is the SECOND line of defence, and it exists for exactly one crash
 * window: the bytes landed in storage and the `AssetRecord` was written,
 * but the process died before the intent row could be marked succeeded.
 * Without this, that image is paid for and invisible, and recovery would
 * dispatch again. With it, recovery finds the orphan, adopts it, and makes
 * no paid call at all.
 */
export const PAID_IMAGE_INTENT_METADATA_KEY = "logicalPaidIntentKey";
/** Companion key holding the sanitized concept envelope — never prompt text. */
export const PAID_IMAGE_CONCEPT_METADATA_KEY = "paidImageIntentConcept";

/**
 * The sanitized, durable record of one bought image. This is what gets
 * written to `PaidImageIntent.result`, and what a recovering worker
 * reconstructs a concept from WITHOUT contacting the provider.
 *
 * Deliberately excludes image bytes, prompt text, provider credentials, and
 * evaluation results. Evaluation is non-billable and is always re-run fresh
 * (see `GenerationWorkerCapability`), so caching it here would add nothing
 * and risk staleness.
 */
export interface PersistedPaidConcept {
  title: string;
  summary: string;
  placeholderLabel: string;
  accentColor: string;
  kind: "concept" | "revision";
  directionKey: ConceptDirectionKey | null;
  primaryAssetId: string | null;
  thumbnailAssetId: string | null;
  /** Asset facts provisional print validation needs; never storage keys. */
  contentType: string | null;
  widthPx: number | null;
  heightPx: number | null;
  hasTransparency: boolean | null;
  providerRequestId: string | null;
}

/**
 * Phase 2C0.5: a logical paid intent that cannot be executed again.
 *
 * Distinct from an ordinary provider failure because the correct response
 * is different: there is nothing transient left to wait for. Either the
 * job's paid-intent budget is spent, or this one image has already been
 * dispatched `MAX_PAID_DISPATCHES_PER_INTENT` times without ever producing
 * durable bytes. Both mean STOP SPENDING, and both must fail the job rather
 * than silently regenerate everything.
 */
export class PaidImageIntentBlockedError extends Error {
  readonly reason: "budget_exhausted" | "dispatches_exhausted" | "intent_failed";
  readonly logicalPaidIntentKey: string;

  constructor(
    reason: "budget_exhausted" | "dispatches_exhausted" | "intent_failed",
    logicalPaidIntentKey: string,
    message: string,
  ) {
    super(message);
    this.name = "PaidImageIntentBlockedError";
    this.reason = reason;
    this.logicalPaidIntentKey = logicalPaidIntentKey;
  }
}

/** Stable, greppable prefix on `GenerationJob.lastError`. Internal only. */
export const PAID_IMAGE_INTENT_BLOCKED_ERROR_PREFIX = "PAID_IMAGE_INTENT_BLOCKED:";

export interface PaidImageUnit {
  /** Catalog direction, or `"batch"` for a provider with no per-direction path. */
  scopeKey: PaidImageIntentScopeKey;
  kind: PaidImageIntentKind;
  targetArtworkVersionId?: string | null;
  replacedArtworkVersionId?: string | null;
  /** Phase 2C: the logical paid intent this replacement supersedes. */
  replacedPaidIntentKey?: string | null;
  epoch?: number;
}

export interface ExecutePaidImageUnitDeps {
  repo: ProjectRepository;
  job: GenerationJob;
  providerKey: string;
  /**
   * Sprint A4 Correction 3: LOCAL readiness check, run immediately before
   * the dispatch claim and never after it.
   *
   * Must not contact anything. Throwing here means no claim is taken, no
   * dispatch is counted, and the failure stays retryable — which is the
   * whole point: a misconfigured deployment must not spend a customer's one
   * free attempt.
   *
   * Optional so existing call sites and fakes are unaffected; absence means
   * "ready", which is true of every adapter with no configuration to get
   * wrong.
   */
  preflight?: () => Promise<void> | void;
  /**
   * Makes the paid provider dispatch. Called at most once per invocation,
   * and ONLY after `beginPaidImageIntentDispatch` has durably authorized it.
   */
  dispatch: () => Promise<GeneratedConceptDraft[]>;
  /**
   * Uploads the returned bytes and registers `AssetRecord`s. Must stamp
   * every primary asset's metadata with `PAID_IMAGE_INTENT_METADATA_KEY` so
   * the orphan-adoption path can find it after a crash.
   */
  persist: (
    drafts: GeneratedConceptDraft[],
    intentKey: string,
  ) => Promise<PersistedPaidConcept[]>;
}

/**
 * Phase 2C0.5: run ONE logical paid image intent, at most once, ever.
 *
 * The whole spend-safety story of this phase lives in the ordering below,
 * so it is worth stating plainly:
 *
 *   1. RESERVE before paying.   A durable row exists before any request
 *                               leaves the process, so a crash mid-flight
 *                               leaves evidence that money may be gone.
 *   2. REUSE before paying.     A succeeded intent short-circuits with its
 *                               stored result and makes no call.
 *   3. ADOPT before paying.     An orphaned asset stamped with this intent
 *                               key is recovered rather than re-bought.
 *   4. AUTHORIZE before paying. `beginPaidImageIntentDispatch` is a
 *                               conditional DB write; if it refuses, the
 *                               provider is never contacted.
 *   5. PERSIST before claiming success. "Succeeded" means the bytes are
 *                               durably stored, not merely returned.
 *   6. FENCE the success write.  A zombie worker's late write is refused
 *                               instead of overwriting the live worker's.
 *
 * There is deliberately no fallback that regenerates everything.
 */
export async function executePaidImageUnit(
  deps: ExecutePaidImageUnitDeps,
  unit: PaidImageUnit,
): Promise<{ concepts: PersistedPaidConcept[]; paidCallMade: boolean }> {
  const { repo, job, providerKey } = deps;
  const projectId = job.projectId;
  const budget = paidIntentBudgetForGenerationJob(job);
  // Sprint A4 Correction 2: resolved ONCE, from durable job authority, and
  // used at every point below that would otherwise reach for the module
  // constant. The acquisition free concept gets exactly ONE physical
  // provider submission; every ordinary job keeps its existing
  // ambiguity/retry policy completely unchanged.
  const maxDispatches = maxPhysicalDispatchesForGenerationJob(job);

  const identity: PaidImageIntentIdentity = {
    projectId,
    generationJobId: job.id,
    kind: unit.kind,
    scopeKey: unit.scopeKey,
    targetArtworkVersionId: unit.targetArtworkVersionId ?? null,
    replacedArtworkVersionId: unit.replacedArtworkVersionId ?? null,
    replacedPaidIntentKey: unit.replacedPaidIntentKey ?? null,
    epoch: unit.epoch,
  };
  const intentKey = buildPaidImageIntentKey(identity);

  const logBase = {
    projectId,
    generationJobId: job.id,
    jobAttempt: job.attempts,
    logicalPaidIntentKey: intentKey,
    directionKey: unit.scopeKey,
    generationKind: unit.kind,
    paidIntentBudget: budget,
    providerKey,
  };

  // --- 2. Reuse -------------------------------------------------------
  const existing = await repo.getPaidImageIntentByKey(projectId, intentKey);
  const reused = reuseCompletedIntent(existing);
  if (reused) {
    logPaidImageIntentDecision({
      ...logBase,
      decision: "reused_completed_intent",
      transportAttempt: 0,
      paidIntentOrdinal: existing?.paidIntentOrdinal ?? null,
    });
    return { concepts: reused, paidCallMade: false };
  }

  if (existing?.status === "failed") {
    throw new PaidImageIntentBlockedError(
      "intent_failed",
      intentKey,
      `This paid image intent already exhausted its dispatch budget (${maxDispatches}) without producing durable artwork.`,
    );
  }

  // --- 1. Reserve (allocating a budget slot if this is genuinely new) --
  const intent =
    existing ?? (await reserveWithBudget(repo, projectId, job, intentKey, unit, providerKey, budget, logBase));

  // --- 3. Adopt an orphan bought by a previous, crashed dispatch ------
  if (intent.dispatches > 0 && intent.claimToken) {
    const adopted = await adoptOrphanedPaidAsset(repo, projectId, intentKey);
    if (adopted) {
      // The token is whatever the crashed worker left behind. That worker
      // is provably gone (its job was reclaimed and re-claimed), so using
      // its token to close out the intent is the recovery, not a race —
      // and if some other worker got there first, the fenced write simply
      // returns null and the already-durable bytes are still what we hand
      // back. Either way, no paid call is made.
      await repo.completePaidImageIntent(intent.id, intent.claimToken, {
        status: "succeeded",
        result: { concepts: adopted },
      });
      logPaidImageIntentDecision({
        ...logBase,
        decision: "reused_completed_intent",
        transportAttempt: 0,
        paidIntentOrdinal: intent.paidIntentOrdinal,
      });
      return { concepts: adopted, paidCallMade: false };
    }
  }

  // --- 3.5. Preflight (Sprint A4 Correction 3) -------------------------
  //
  // THE PAID BOUNDARY IS HERE, and the claim below is what crosses it.
  //
  // The durable dispatch counter must mean "we have crossed the point where
  // an external paid request may actually be sent" — NOT "we entered the
  // code path that might eventually try". Before this step existed, an
  // adapter that fails on local configuration
  // (`UnavailableConceptGenerationProvider` is precisely that) threw from
  // inside `dispatch`, which runs AFTER the claim. A definite local failure
  // therefore produced dispatches = 1 with zero external submissions, and
  // for the acquisition free concept that was the customer's only attempt,
  // spent on our misconfiguration.
  //
  // Placed AFTER reuse and adoption on purpose: recovering an image the
  // platform has already bought must not be blocked by a provider whose
  // configuration has since broken. Those paths contact nothing.
  //
  // Placed IMMEDIATELY before the claim on purpose: every statement between
  // preflight and the external request is a window in which the claim can
  // be taken for a call that never happens. There is deliberately nothing
  // between them but the claim itself.
  //
  // This does NOT weaken concurrency safety. Two workers may both preflight
  // successfully; only one can win `beginPaidImageIntentDispatch`, and the
  // loser never reaches the provider. The claim remains the sole
  // concurrency authority.
  //
  // It also claims no certainty about billing. Preflight says only that
  // this process is configured to attempt a request. Once the claim is
  // taken, every subsequent failure — DNS, reset, timeout, 4xx, 5xx — is
  // treated as possibly billed, because none of them can be proven
  // otherwise.
  if (deps.preflight) await deps.preflight();

  // --- 4. Authorize ---------------------------------------------------
  const claimToken = randomUUID();
  const claimed = await repo.beginPaidImageIntentDispatch(
    intent.id,
    claimToken,
    maxDispatches,
  );
  if (!claimed) {
    // Refused. Either a concurrent worker just succeeded it (reuse), or
    // this intent is out of dispatches (stop spending). Never "call anyway".
    const refreshed = await repo.getPaidImageIntentByKey(projectId, intentKey);
    const recovered = reuseCompletedIntent(refreshed);
    if (recovered) {
      logPaidImageIntentDecision({
        ...logBase,
        decision: "reused_completed_intent",
        transportAttempt: 0,
        paidIntentOrdinal: refreshed?.paidIntentOrdinal ?? null,
      });
      return { concepts: recovered, paidCallMade: false };
    }
    throw new PaidImageIntentBlockedError(
      "dispatches_exhausted",
      intentKey,
      `This paid image intent has already been dispatched ${maxDispatches} time(s) without producing durable artwork; refusing to pay again.`,
    );
  }

  logPaidImageIntentDecision({
    ...logBase,
    decision: claimed.dispatches <= 1 ? "paid_call" : "retry_same_intent",
    transportAttempt: claimed.dispatches,
    paidIntentOrdinal: claimed.paidIntentOrdinal,
  });

  // Phase 2C.2C: every failure below this line goes through here, so a
  // dispatch that has begun ALWAYS leaves durable evidence — not only one
  // that exhausts the dispatch ceiling.
  //
  // Best-effort by construction: it must never mask the failure it is
  // describing. `intent_completion_failure` is the case that proves the
  // point — if the intent write just failed because persistence is down,
  // this write will fail too, and the original error is still what the
  // caller must see.
  const recordFailure = async (
    failureClass: PaidImageFailureClass,
    error: unknown,
    providerRequestId: string | null,
  ): Promise<boolean> => {
    // Terminal ONLY at the dispatch ceiling. A parent job that still intends
    // to retry keeps this intent retry-eligible — parent-COMPLETION hygiene
    // is a separate decision made by the worker (see
    // `terminalizeStrandedPaidIntents`), never guessed at here.
    const terminal = claimed.dispatches >= maxDispatches;
    const lastError = describePaidImageFailure(failureClass, error);
    try {
      await repo.recordPaidImageIntentFailure(intent.id, claimToken, {
        lastError,
        providerRequestId,
        terminal,
      });
    } catch {
      // Swallowed deliberately — see above.
    }
    logPaidImageIntentOutcome({
      projectId,
      generationJobId: job.id,
      logicalPaidIntentKey: intentKey,
      directionKey: unit.scopeKey,
      generationKind: unit.kind,
      paidIntentOrdinal: intent.paidIntentOrdinal,
      transportAttempt: claimed.dispatches,
      outcome: "failed",
      failureClassification: failureClass,
      possiblyBilled: isPossiblyBilledFailureClass(failureClass),
      providerRequestId,
      lastErrorSummary: lastError,
      terminalized: terminal,
    });
    return terminal;
  };

  // --- 5a. Dispatch ----------------------------------------------------
  let drafts: GeneratedConceptDraft[];
  try {
    drafts = await deps.dispatch();
  } catch (error) {
    await recordFailure(classifyProviderDispatchFailure(error), error, null);
    throw error;
  }

  // Phase 2C.2C, and the single most important line in this function: the
  // provider's request id is captured HERE, from the provider's own answer,
  // BEFORE anything local can fail. It used to be read only from the
  // successfully-persisted concepts, which meant the one case where it
  // matters most — the provider billed us and local persistence then died —
  // was structurally incapable of recording it.
  const providerRequestId = readDraftsProviderRequestId(drafts);

  // --- 5b. Persist BEFORE claiming success -----------------------------
  let persisted: PersistedPaidConcept[];
  try {
    persisted = await deps.persist(drafts, intentKey);
  } catch (error) {
    await recordFailure(
      classifyPaidImagePersistenceFailure(error),
      error,
      providerRequestId,
    );
    throw error;
  }

  // --- 6. Fenced success write ----------------------------------------
  const persistedRequestId =
    persisted.find((concept) => concept.providerRequestId)?.providerRequestId ??
    providerRequestId;
  let completed: PaidImageIntent | null;
  try {
    completed = await repo.completePaidImageIntent(intent.id, claimToken, {
      status: "succeeded",
      result: { concepts: persisted },
      providerRequestId: persistedRequestId,
    });
  } catch (error) {
    // The bytes ARE durable and stamped with this intent key at this point,
    // so the next claim adopts the orphan and pays nothing. Recording the
    // failure is what makes that recoverable state legible instead of
    // looking like a silent loss.
    await recordFailure("intent_completion_failure", error, persistedRequestId);
    throw error;
  }

  if (!completed) {
    // Fenced out: this worker's job was reclaimed while its paid call was
    // in flight, and a newer worker owns the intent now. The image this
    // worker bought is deliberately discarded in favour of the live
    // worker's — which is the correct trade, since two workers writing
    // competing results for one concept is worse than one wasted image.
    //
    // Deliberately NOT recorded onto the intent: a newer worker owns that
    // row, and the fencing that just refused this write would refuse a
    // failure write for exactly the same (correct) reason. The log line IS
    // the durable record for this case.
    logPaidImageIntentOutcome({
      projectId,
      generationJobId: job.id,
      logicalPaidIntentKey: intentKey,
      directionKey: unit.scopeKey,
      generationKind: unit.kind,
      paidIntentOrdinal: intent.paidIntentOrdinal,
      transportAttempt: claimed.dispatches,
      outcome: "fenced_out",
      failureClassification: "fenced_out",
      possiblyBilled: true,
      providerRequestId: persistedRequestId,
      terminalized: false,
    });
    const refreshed = await repo.getPaidImageIntentByKey(projectId, intentKey);
    const recovered = reuseCompletedIntent(refreshed);
    if (recovered) return { concepts: recovered, paidCallMade: true };
    throw new PaidImageIntentBlockedError(
      "dispatches_exhausted",
      intentKey,
      "This paid image intent was claimed by another worker while the provider call was in flight.",
    );
  }

  logPaidImageIntentOutcome({
    projectId,
    generationJobId: job.id,
    logicalPaidIntentKey: intentKey,
    directionKey: unit.scopeKey,
    generationKind: unit.kind,
    paidIntentOrdinal: intent.paidIntentOrdinal,
    transportAttempt: claimed.dispatches,
    outcome: "succeeded",
    possiblyBilled: true,
    providerRequestId: persistedRequestId,
    terminalized: false,
  });

  return { concepts: persisted, paidCallMade: true };
}

/**
 * Phase 2C.2C: how many times this logical intent has been dispatched to the
 * provider, read from DURABLE state.
 *
 * This is the authoritative answer to "did we pay?" and the reason the live
 * replacement log said `paidCallMade: false` about an image OpenAI had
 * already billed: the caller inferred payment from whether the replacement
 * ASSET completed, which is a different question entirely. Comparing this
 * before and after gives the right answer for every failure shape, including
 * ones that throw before any value can be returned.
 *
 * Best-effort — observability must never fail a job — so an unreadable
 * intent reports `0` rather than throwing.
 */
export async function readPaidIntentDispatches(
  repo: ProjectRepository,
  projectId: string,
  intentKey: string,
): Promise<number> {
  try {
    const intent = await repo.getPaidImageIntentByKey(projectId, intentKey);
    return intent?.dispatches ?? 0;
  } catch {
    return 0;
  }
}

/**
 * The provider's own request id, read from the SANITIZED metadata envelope a
 * provider adapter already produces, straight off the drafts it returned.
 *
 * Never part of the logical intent identity (it changes on every dispatch,
 * which is exactly what the identity must not do) — but on a failure path it
 * is the only handle that joins a durable row to a provider-side usage
 * record, which is what makes "we paid; why did the result disappear?"
 * answerable at all.
 */
function readDraftsProviderRequestId(
  drafts: readonly GeneratedConceptDraft[],
): string | null {
  for (const draft of drafts) {
    const value = draft.asset?.providerMetadata?.providerRequestId;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * Allocates the next budget slot and durably reserves the intent.
 *
 * The retry loop is not defensive padding: `"ordinal_taken"` is the normal,
 * expected result of two workers computing the same next slot at the same
 * moment, and the unique constraint is precisely what makes exactly one of
 * them win. The loser re-reads and takes the next slot — or discovers the
 * budget is now spent, which is also the correct answer.
 */
async function reserveWithBudget(
  repo: ProjectRepository,
  projectId: string,
  job: GenerationJob,
  intentKey: string,
  unit: PaidImageUnit,
  providerKey: string,
  budget: number,
  logBase: Omit<
    Parameters<typeof logPaidImageIntentDecision>[0],
    "decision" | "transportAttempt" | "paidIntentOrdinal"
  >,
): Promise<PaidImageIntent> {
  for (let attempt = 0; attempt <= budget; attempt += 1) {
    const intents = await repo.listPaidImageIntentsForJob(projectId, job.id);
    const match = intents.find((item) => item.intentKey === intentKey);
    if (match) return match;

    const nextOrdinal =
      intents.reduce((max, item) => Math.max(max, item.paidIntentOrdinal), 0) + 1;

    if (nextOrdinal > budget) {
      logPaidImageIntentDecision({
        ...logBase,
        decision: "blocked_budget",
        transportAttempt: 0,
        paidIntentOrdinal: null,
      });
      throw new PaidImageIntentBlockedError(
        "budget_exhausted",
        intentKey,
        `This generation job has already reserved its maximum of ${budget} logical paid image intents.`,
      );
    }

    const reservation = await repo.reservePaidImageIntent(projectId, {
      generationJobId: job.id,
      intentKey,
      intentKind: unit.kind,
      directionKey: unit.scopeKey,
      paidIntentOrdinal: nextOrdinal,
      providerKey,
    });

    if (reservation.outcome !== "ordinal_taken") return reservation.intent;
  }

  throw new PaidImageIntentBlockedError(
    "budget_exhausted",
    intentKey,
    "Could not reserve a paid image intent slot for this generation job.",
  );
}

/**
 * A succeeded intent's stored result, or `null` if there is nothing durable
 * to reuse. Never trusts `status` alone: an intent marked succeeded with an
 * unreadable result is treated as not reusable rather than silently
 * producing a concept with no image.
 */
function reuseCompletedIntent(
  intent: PaidImageIntent | null,
): PersistedPaidConcept[] | null {
  if (!intent || intent.status !== "succeeded") return null;
  const result = intent.result;
  if (!result || typeof result !== "object") return null;
  const concepts = (result as { concepts?: unknown }).concepts;
  if (!Array.isArray(concepts) || concepts.length === 0) return null;
  return concepts as PersistedPaidConcept[];
}

/**
 * Crash window E: the asset row was written but the intent could not be
 * marked succeeded. The bytes are already bought and already durable — this
 * finds them by the intent stamp their metadata carries, so recovery costs
 * nothing.
 */
async function adoptOrphanedPaidAsset(
  repo: ProjectRepository,
  projectId: string,
  intentKey: string,
): Promise<PersistedPaidConcept[] | null> {
  let assets: AssetRecord[];
  try {
    assets = await repo.listAssets(projectId);
  } catch {
    return null;
  }

  const concepts: PersistedPaidConcept[] = [];
  for (const asset of assets) {
    if (asset.isThumbnail) continue;
    const metadata = asset.metadata ?? {};
    if (metadata[PAID_IMAGE_INTENT_METADATA_KEY] !== intentKey) continue;
    const envelope = metadata[PAID_IMAGE_CONCEPT_METADATA_KEY];
    if (!envelope || typeof envelope !== "object") continue;

    const concept = envelope as Partial<PersistedPaidConcept>;
    if (typeof concept.title !== "string") continue;

    concepts.push({
      title: concept.title,
      summary: typeof concept.summary === "string" ? concept.summary : "",
      placeholderLabel:
        typeof concept.placeholderLabel === "string"
          ? concept.placeholderLabel
          : concept.title,
      accentColor:
        typeof concept.accentColor === "string" ? concept.accentColor : "#000000",
      kind: concept.kind === "revision" ? "revision" : "concept",
      directionKey: (concept.directionKey as ConceptDirectionKey | null) ?? null,
      primaryAssetId: asset.id,
      // The thumbnail is a non-fatal companion (see `AssetCapability`); an
      // adopted orphan simply may not have one, exactly as a fresh upload
      // whose thumbnail generation failed would not.
      thumbnailAssetId:
        assets.find(
          (candidate) =>
            candidate.isThumbnail &&
            candidate.metadata?.[PAID_IMAGE_INTENT_METADATA_KEY] === intentKey,
        )?.id ?? null,
      contentType: asset.contentType,
      widthPx: asset.widthPx,
      heightPx: asset.heightPx,
      hasTransparency: asset.hasTransparency,
      providerRequestId: null,
    });
  }

  return concepts.length > 0 ? concepts : null;
}
