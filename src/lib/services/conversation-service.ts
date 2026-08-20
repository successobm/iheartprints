import { ACQUISITION_UNAVAILABLE_MESSAGE } from "@/capabilities/acquisition";
import type {
  CustomerAcquisitionView,
  EmailCaptureResult,
} from "@/capabilities/acquisition";
import type { ArtworkPreparationView } from "@/capabilities/artwork-preparation";
import type { CustomerPaymentView } from "@/capabilities/payment";
import { getCapabilityGraph } from "@/capabilities/composition";
import type { DesignBriefDecisionAction } from "@/capabilities/conversation";
import {
  toCustomerArtworkVersions,
  toCustomerConceptStatusView,
  type CustomerArtworkVersion,
  type CustomerConceptStatusView,
} from "@/capabilities/shared/contracts";
import {
  describePrintReadySize,
  type PrintReadySizeView,
} from "@/capabilities/shared/print-ready-size";
import { getProjectRepository } from "@/lib/db";
import {
  isUnsupportedRequestedProductionOutput,
  productionIntentMatches,
} from "@/lib/domain/types";
import type {
  FinalArtworkJob,
  FinalArtworkJobStatus,
  ProjectSnapshot,
  ProjectStatus,
  StoredRequestedProductionOutput,
} from "@/lib/domain/types";
import { printPlacementLabel } from "@/lib/domain/print-placement";
import {
  maybeRecoverStrandedLocalFinalArtworkJobs,
  maybeTriggerLocalFinalArtworkWorker,
  type LocalFinalArtworkTriggerReason,
} from "@/lib/services/local-final-artwork-trigger";
import {
  maybeRecoverStrandedLocalGenerationJobs,
  maybeTriggerLocalGenerationWorker,
  type LocalGenerationTriggerReason,
} from "@/lib/services/local-generation-trigger";
import { buildPrintReadyFilename } from "@/lib/services/print-ready-filename";

/**
 * Stable facade for API routes and existing tests.
 * Delegates to the ConversationCapability composition root.
 *
 * Sprint 2G Part 3: every snapshot-returning function also attaches
 * `conceptStatus` — computed fresh from already-public snapshot data via
 * `ConceptGenerationCapability.describeConceptStatus`, not a new capability
 * dependency — so the UI's persistent concept-status action reflects
 * reality on every fetch, not only right after a revision turn.
 *
 * Sprint 2K Phase 1: this is also the one place that shapes `ArtworkVersion`
 * into the browser-safe `CustomerArtworkVersion` (see contracts.ts) before
 * it leaves the server — every route funnels through the functions below,
 * so there is a single choke point rather than per-route sanitization.
 */

/**
 * Sprint 2M Phase 2B/2C: customer-safe finalization state. Project terminal
 * states (`print_ready`, `finalization_required`) remain authoritative.
 * While the project is still `finalizing`, the current FinalArtworkJob
 * distinguishes in-progress work from a retryable infrastructure failure
 * — never a raw job id, provider name, `lastError`, or validation rule
 * (Goal 13/16). `"needs_review"` is a print-readiness verdict, not a
 * storage hiccup; `"retryable_failure"` is the latter and reuses the
 * existing Prepare action (no second retry API).
 */
export type CustomerFinalizationStatus =
  | "not_requested"
  | "preparing"
  | "retryable_failure"
  | "needs_review"
  | "print_ready";

export interface CustomerFinalizationView {
  status: CustomerFinalizationStatus;
}

/**
 * Pure customer-view derivation. Exported for tests; routes still go
 * through `getFinalizationStatus` / the snapshot choke point.
 *
 * Sprint A2 Correction 2 (Goal 8 / Goal 18): this now answers "how is the
 * customer's CURRENT request doing?", which is not the same question as
 * "what is `project.status`?".
 *
 * `project.status` is a durable record of the last thing the pipeline
 * achieved. It is genuinely useful and it is not wrong — but it is about the
 * PAST. A customer who has a `print_ready` PNG and has since asked for
 * separations has a real, valid plate on file AND an unmet request, and
 * showing them "print ready" answers a question they stopped asking. So the
 * derivation is anchored on current intent first:
 *
 *   1. Current request is unsupported (or unreadable) → `needs_review`,
 *      regardless of `project.status`. We do not claim to have produced what
 *      we do not produce. The previously produced PNG is NOT deleted — it
 *      simply stops being the answer.
 *   2. Otherwise the current request is the Production PNG, and the job
 *      bound to THAT intent is what speaks. A stale `failed` job for an
 *      abandoned intent cannot show a retry prompt for work nobody wants,
 *      and a `cancelled` (superseded) job reads as "not requested" — the
 *      customer can simply ask again.
 *
 * `projectStatus` still decides between `print_ready` and `needs_review`
 * once the matching job has completed, because that is exactly the fact it
 * durably records: whether authoritative validation passed.
 */
export function toCustomerFinalizationView(
  projectStatus: ProjectStatus,
  latestJobStatus: FinalArtworkJobStatus | null = null,
  currentRequestedProductionOutput: StoredRequestedProductionOutput | null = null,
  /**
   * Whether a FinalArtworkJob bound to the CURRENT requested output exists at
   * all. Defaults to `true`, which preserves the pre-A2 contract for callers
   * that only know a project status — every such caller predates requestable
   * outputs, so "the job for what they are asking" is the only job there
   * could be.
   */
  matchingJobExists: boolean = true,
  /**
   * Sprint A2 Correction 3: whether a completed job, under the current
   * authority and bound to the current intent, has a production asset with
   * `ready` authoritative validation. Defaults to `false` so callers that
   * only know a project status keep their existing behavior.
   */
  currentRequestSatisfied: boolean = false,
): CustomerFinalizationView {
  // (1) The current request is one this product does not produce — or one an
  // older build cannot read (fail closed). Nothing achieved earlier, for a
  // different request, can make THIS one satisfied.
  if (isUnsupportedRequestedProductionOutput(currentRequestedProductionOutput)) {
    return { status: "needs_review" };
  }

  // (2) Sprint A2 Correction 3: a completed job already satisfies the current
  // request, proven by the same evidence the delivery routes use. Ahead of
  // `project.status` deliberately — that status records what the pipeline
  // last achieved, and after a PNG → unsupported → PNG round trip it is
  // stale (`finalization_required`, written by the unsupported job) while
  // the customer's actual plate is valid, current, and downloadable. Sharing
  // one source with delivery is also what makes "says print_ready" and "the
  // download works" impossible to disagree.
  if (currentRequestSatisfied) return { status: "print_ready" };

  // (3) Nothing has been enqueued for what the customer is asking for now.
  // `project.status` may well be a terminal state — but it is a terminal
  // state about a DIFFERENT request, and reporting it here would either
  // claim work that was never done or strand the customer on a `needs_review`
  // screen with no way to ask again. `not_requested` restores the Prepare
  // action, which is exactly what they need.
  if (!matchingJobExists) return { status: "not_requested" };

  // (3) The matching job was superseded by an intent change and then not
  // resumed. Same reasoning: offer the action rather than a stale verdict.
  if (latestJobStatus === "cancelled") return { status: "not_requested" };

  // (4) Project terminal states, which durably record what authoritative
  // validation concluded for a job bound to this same intent. These stay
  // ahead of job status on purpose: a `print_ready` project must not be
  // dragged back to a retry prompt by an older failed attempt that a later
  // one already superseded.
  if (projectStatus === "print_ready") return { status: "print_ready" };
  if (projectStatus === "finalization_required") return { status: "needs_review" };
  if (projectStatus === "finalizing") {
    if (latestJobStatus === "failed") return { status: "retryable_failure" };
    return { status: "preparing" };
  }
  return { status: "not_requested" };
}

/**
 * The job that currently owns customer-facing finalization: active Create
 * New approval's job, or the newest job on an approved upload preparation.
 * Older failed jobs on a superseded approval or earlier print size must
 * not leak into the view.
 */
async function resolveCurrentFinalArtworkJob(
  projectId: string,
  currentIntent: StoredRequestedProductionOutput | null,
): Promise<FinalArtworkJob | null> {
  try {
    const repo = getProjectRepository();
    // Sprint A2 Correction 2 (Goal 18): "the current job" means the job bound
    // to the intent the customer is asking for NOW. A job created for a
    // different requested output is not this project's current finalization,
    // however recently it ran — that is precisely how a stale `failed` PNG
    // job used to show a retry prompt to someone who had moved on to
    // separations, and how a completed unsupported job used to speak for a
    // customer who had retracted back to PNG.
    const matchesIntent = (job: FinalArtworkJob) =>
      productionIntentMatches(job.requestedProductionOutput, currentIntent);

    const approval = await repo.getActiveFinalDirectionApproval(projectId);
    if (approval) {
      const jobs = await repo.listFinalArtworkJobsForApproval(projectId, approval.id);
      return jobs.filter(matchesIntent).at(-1) ?? null;
    }

    const preparation = await repo.getArtworkPreparation(projectId);
    if (!preparation || preparation.status !== "approved") return null;

    const jobs = await repo.listFinalArtworkJobsForPreparation(
      projectId,
      preparation.id,
    );
    return jobs.filter(matchesIntent).at(-1) ?? null;
  } catch {
    return null;
  }
}

async function customerFinalizationViewForProject(
  projectId: string,
  projectStatus: ProjectStatus,
  currentIntent: StoredRequestedProductionOutput | null,
): Promise<CustomerFinalizationView> {
  // Sprint A2 Correction 2: the matching job is resolved for EVERY project
  // status now, not only `"finalizing"`. A project sitting at `print_ready`
  // still has to answer "…for the thing you are currently asking for?", and
  // that answer lives in whether a job bound to the current intent exists and
  // how it ended.
  const job = await resolveCurrentFinalArtworkJob(projectId, currentIntent);
  // Sprint A2 Correction 3: the same evidence the delivery routes resolve on,
  // read through the same capability, so the state a customer is shown and
  // the file they can actually download can never disagree.
  const satisfied = await getCapabilityGraph()
    .finalArtwork.resolveCurrentProductionDelivery(projectId)
    .catch(() => null);
  return toCustomerFinalizationView(
    projectStatus,
    job?.status ?? null,
    currentIntent,
    // Whether the project has ever had a job for THIS request. Distinguished
    // from "the job exists and is in some state" because the two mean
    // genuinely different things to a customer: nothing enqueued yet vs. a
    // verdict already reached.
    job !== null,
    satisfied !== null,
  );
}

export type ApiProjectSnapshot = Omit<ProjectSnapshot, "artworkVersions"> & {
  artworkVersions: CustomerArtworkVersion[];
  conceptStatus: CustomerConceptStatusView;
  finalization: CustomerFinalizationView;
  /**
   * Live Acceptance Cleanup (Issue 5): the physical size the selected
   * concept will be prepared at, so the customer can decide before
   * finalization starts rather than discovering it afterwards. `null` when
   * there is nothing to state honestly — no concept selected, or no print
   * placement known yet. Every figure is derived server-side from the one
   * placement policy table; no client component computes inches.
   */
  printReadySize: PrintReadySizeView | null;
  /**
   * Existing Artwork → Print Ready Phase 1: the Upload Existing Artwork
   * workflow's state, already phrased for the customer (no analysis numbers,
   * no asset ids, no storage keys). `null` for every Create New Artwork
   * project — and that `null` IS the workflow identity the UI branches on,
   * which is why Phase 1 needs no workflow enum anywhere.
   */
  artworkPreparation: ArtworkPreparationView | null;
  /**
   * Sprint A4: where this session stands in the acquisition funnel, already
   * phrased for the customer. Never the persisted entitlement value, never
   * the acquisition session id, never the captured email ADDRESS — the UI
   * needs to know whether a gate is open, not who is behind it, and the
   * cheapest way to keep an address out of caches, logs, and screenshots is
   * to never put it in a response (Goal 19).
   */
  acquisition: CustomerAcquisitionView;
  /**
   * Sprint A5.5: where this project stands commercially, already phrased for
   * the customer.
   *
   * Carries a server-FORMATTED display amount and nothing else monetary — no
   * raw minor units, no currency code, no provider price id, no checkout
   * session id, no payment intent id, no internal transaction id, and no
   * configuration detail. The UI needs to know whether to offer a purchase
   * and what to say it costs; every other fact stays server-side.
   */
  payment: CustomerPaymentView;
};

async function withConceptStatus(
  snapshot: ProjectSnapshot,
): Promise<ApiProjectSnapshot> {
  const conceptStatus = getCapabilityGraph().conceptGeneration.describeConceptStatus(
    snapshot.brief,
    snapshot.artworkVersions,
    snapshot.designBriefVersions,
  );
  const artworkPreparation = await resolveArtworkPreparation(snapshot.project.id);
  return {
    ...snapshot,
    artworkVersions: toCustomerArtworkVersions(snapshot.artworkVersions),
    conceptStatus: toCustomerConceptStatusView(conceptStatus),
    finalization: await customerFinalizationViewForProject(
      snapshot.project.id,
      snapshot.project.status,
      snapshot.brief.requestedProductionOutput,
    ),
    printReadySize: await resolvePrintReadySize(snapshot, artworkPreparation),
    artworkPreparation,
    acquisition: await resolveAcquisitionView(snapshot),
    payment: await resolvePaymentView(snapshot.project.id),
  };
}

/**
 * Sprint A4. Never allowed to take down a snapshot the customer is waiting
 * on — same advisory-not-a-gate rule as `resolveArtworkPreparation`.
 *
 * Sprint A4 Correction 1: the failure degrades to `"unavailable"`, NOT to
 * `"open"`.
 *
 * Degrading to `"open"` was spend-safe — every real paid-value decision is
 * made independently by the capability that owns the spend, and those all
 * fail closed — but it was product-unsafe in a way that matters: `"open"`
 * renders a UI that offers actions the server is about to refuse. The
 * customer clicks, gets a refusal, and the page they are looking at
 * disagrees with the server that produced it. A neutral "can't continue
 * right now" is the only honest thing to show when the server does not know
 * what this session may do.
 *
 * Sprint A4 Correction C established that row existence is not delivery:
 * the generation worker writes artwork rows several separate writes before
 * the project leaves `generating` and the `concepts_ready` anchor message
 * the concept grid renders against exists, and a `prepared_upload` row is
 * the Existing Artwork customer's OWN pixels rather than a free concept.
 *
 * Sprint A4 Correction C2 moved that question INSIDE the capability, so
 * this function no longer supplies `conceptDelivered` at all. The
 * entitlement belongs to the acquisition SESSION, not to the project being
 * read: a prospect starting a second design in the same browser is refused
 * on project B for something that happened on project A, and project B's
 * snapshot holds no evidence of it. Computing delivery here could only ever
 * answer for the wrong project — which is exactly how the card came to say
 * `continue_locked` while the transcript asked for an email.
 *
 * `generating` stays an input because it genuinely is a property of THIS
 * project ("is this one busy right now"), not of the session.
 */
/**
 * Sprint A5.5. Same advisory-not-a-gate rule as `resolveAcquisitionView`: a
 * commercial view must never take down a snapshot the customer is waiting on.
 *
 * Degrades to `"unavailable"`, NOT to `"payment_required"` and never to
 * `"production_unlocked"`. The direction matters in both ways at once:
 * `payment_required` would render a checkout button whose POST is about to
 * fail for the same reason this read did, and `production_unlocked` would
 * claim an entitlement from an error. `unavailable` is the only honest thing
 * to show when the server cannot establish what this project may do.
 *
 * Every real commercial decision is made independently by
 * `PaymentCapability.createCheckout` and, for the entitlement itself, by
 * `AcquisitionCapability.authorizeFinalization` — both of which fail closed.
 * This function only decides what to draw.
 */
async function resolvePaymentView(
  projectId: string,
): Promise<CustomerPaymentView> {
  try {
    return await getCapabilityGraph().payment.describeForCustomer(projectId);
  } catch {
    return { state: "unavailable", offer: null, checkoutPending: false };
  }
}
async function resolveAcquisitionView(
  snapshot: ProjectSnapshot,
): Promise<CustomerAcquisitionView> {
  try {
    return await getCapabilityGraph().acquisition.describeForCustomer(
      snapshot.project.id,
      { generating: snapshot.project.status === "generating" },
    );
  } catch {
    return {
      state: "unavailable",
      message: ACQUISITION_UNAVAILABLE_MESSAGE,
      emailCaptured: false,
    };
  }
}

/**
 * Never allowed to take down a snapshot the customer is waiting on: a project
 * with no preparation is the overwhelmingly common case, and a lookup failure
 * must degrade to "no uploaded artwork" rather than a failed page load. Same
 * advisory-not-a-gate rule as `resolvePrintReadySize`.
 */
async function resolveArtworkPreparation(
  projectId: string,
): Promise<ArtworkPreparationView | null> {
  try {
    return await getCapabilityGraph().artworkPreparation.getPreparation(projectId);
  } catch {
    return null;
  }
}

/**
 * Live Acceptance Cleanup (Issue 5). Height comes from the SELECTED
 * concept's own pixel aspect ratio through the same
 * `resolveWidthConstrainedSizing` the production transform uses, so the
 * size shown before finalizing and the plate produced afterwards are the
 * same arithmetic rather than two independent estimates. When the artwork's
 * dimensions aren't resolvable, height is reported as unknown rather than
 * guessed.
 *
 * Skipped entirely once artwork is print-ready — the delivery card shows the
 * plate's real measured size at that point, which is strictly better than a
 * pre-finalization projection.
 */
async function resolvePrintReadySize(
  snapshot: ProjectSnapshot,
  preparation: ArtworkPreparationView | null,
): Promise<PrintReadySizeView | null> {
  // Existing Artwork → Print Ready Phase 2: an upload project has no
  // "selected concept" and never will — its production artwork is the
  // prepared upload the customer approved. Height comes from that artwork's
  // OWN visible bounds rather than its canvas, because the production
  // transform trims to those bounds before sizing; quoting the canvas would
  // promise a height the finished plate will not have.
  //
  // Unlike the create_new path below, this is NOT skipped once the artwork is
  // print-ready. A create_new customer who wants a different size reopens the
  // creative loop they are still in ("Make Another Change"); an upload
  // customer has no creative loop, so this control is their only route to a
  // different size, and hiding it would strand them.
  if (preparation?.approved) {
    return describePrintReadySize({
      printPlacement: snapshot.brief.printPlacement,
      intendedPrintWidthIn: snapshot.brief.intendedPrintWidthIn,
      artworkWidthPx: preparation.visibleArtworkWidthPx,
      artworkHeightPx: preparation.visibleArtworkHeightPx,
    });
  }

  if (snapshot.project.status === "print_ready") return null;

  const selectedId = snapshot.project.selectedArtworkVersionId;
  if (!selectedId) return null;

  const selected = snapshot.artworkVersions.find(
    (version) => version.id === selectedId,
  );
  if (!selected) return null;

  let artworkWidthPx: number | null = null;
  let artworkHeightPx: number | null = null;
  if (selected.primaryAssetId) {
    try {
      const assets = await getCapabilityGraph().assets.listAssets(
        snapshot.project.id,
      );
      const asset = assets.find((item) => item.id === selected.primaryAssetId);
      artworkWidthPx = asset?.widthPx ?? null;
      artworkHeightPx = asset?.heightPx ?? null;
    } catch {
      // Size is advisory copy, never a gate — an asset lookup failure must
      // not take down the whole snapshot the customer is waiting on.
      artworkWidthPx = null;
      artworkHeightPx = null;
    }
  }

  return describePrintReadySize({
    printPlacement: snapshot.brief.printPlacement,
    intendedPrintWidthIn: snapshot.brief.intendedPrintWidthIn,
    artworkWidthPx,
    artworkHeightPx,
  });
}

/**
 * Sprint A4: `acquisitionSessionId` binds the new project to the session
 * that created it, in the same insert that creates it. Every later
 * paid-value gate resolves authority from that binding rather than from a
 * cookie, which is what makes a direct API call no more powerful than the
 * UI. Omitted only by internal callers and tests, which produce a
 * legacy-unbound (grandfathered) project.
 */
export async function startConversation(
  acquisitionSessionId: string | null = null,
): Promise<ApiProjectSnapshot> {
  return await withConceptStatus(
    await getCapabilityGraph().conversation.start(acquisitionSessionId),
  );
}

/**
 * Sprint A4: the customer's email, captured so they can keep working on
 * their design. Returns the refreshed snapshot on success so the caller
 * renders state derived by the same path as every other read.
 *
 * Grants nothing. Capturing an address does not restore a spent free
 * concept, does not authorize generation, and does not unlock finalization
 * (Goal 14) — those remain the business of the capabilities that own the
 * spend. It is also not marketing consent, and no claim of an account is
 * made anywhere in this path.
 */
export async function captureAcquisitionEmail(
  projectId: string,
  rawEmail: unknown,
): Promise<
  | { ok: true; snapshot: ApiProjectSnapshot }
  | { ok: false; message: string }
> {
  const result: EmailCaptureResult =
    await getCapabilityGraph().acquisition.captureEmail(projectId, rawEmail);
  if (!result.ok) return result;

  const snapshot = await getConversation(projectId);
  if (!snapshot) return { ok: false, message: "Project not found" };
  return { ok: true, snapshot };
}

/**
 * Loading a project also repairs a generation request that a previous turn
 * left half-applied — an approved brief or a pending revision with no
 * `GenerationJob` behind it. See
 * `ConversationCapability.recoverInterruptedGenerationRequest` for why
 * those states are otherwise terminal, and why completing them honors the
 * customer's existing instruction rather than generating on the platform's
 * own initiative. Awaited, not fired and forgotten, so the snapshot the
 * customer receives already reflects the recovered work instead of a stale
 * "approved but idle".
 */
export async function getConversation(
  projectId: string,
): Promise<ApiProjectSnapshot | null> {
  const snapshot =
    await getCapabilityGraph().conversation.recoverInterruptedGenerationRequest(
      projectId,
    );
  if (!snapshot) return null;
  const apiSnapshot = await withConceptStatus(snapshot);
  if (apiSnapshot.project.status === "generating") {
    // A job this call just recovered is `queued` with zero attempts, which
    // is exactly what the existing stranded-job trigger already picks up in
    // interactive dev — no second trigger needed here.
    void maybeRecoverStrandedLocalGenerationJobs(projectId, "project_reload");
  }
  if (apiSnapshot.project.status === "finalizing") {
    void maybeRecoverStrandedLocalFinalArtworkJobs(projectId, "project_reload");
  }
  return apiSnapshot;
}

export async function handleUserMessage(
  projectId: string,
  content: string,
): Promise<ApiProjectSnapshot> {
  const snapshot = await getCapabilityGraph().conversation.handleUserMessage(
    projectId,
    content,
  );
  const apiSnapshot = await withConceptStatus(snapshot);
  maybeKickLocalGenerationWorker(projectId, apiSnapshot, "conversation_message");
  return apiSnapshot;
}

/**
 * Correction A: the "Create New Artwork" workflow choice.
 *
 * Deliberately NOT routed through `handleUserMessage`. A workflow choice is
 * control state, and expressing it as a synthetic customer sentence put
 * words in the customer's mouth in the transcript and then carried them
 * into the Design Brief and the generation prompt.
 *
 * No local worker kick: choosing a workflow enqueues nothing and can never
 * make generation eligible.
 */
export async function beginCreateNewWorkflow(
  projectId: string,
): Promise<ApiProjectSnapshot> {
  return withConceptStatus(
    await getCapabilityGraph().conversation.beginCreateNewWorkflow(projectId),
  );
}

export async function selectConcept(
  projectId: string,
  artworkVersionId: string,
): Promise<ApiProjectSnapshot> {
  const snapshot = await getCapabilityGraph().conversation.selectConcept(
    projectId,
    artworkVersionId,
  );
  return withConceptStatus(snapshot);
}

/**
 * Live Acceptance Corrective Pass (Section 2): the customer's explicit "no
 * more changes, use this design" confirmation — the [Use This Design]
 * action. Distinct from, and strictly stronger than, `selectConcept`;
 * `FinalArtworkCapability.requestFinalArtwork` refuses to finalize without
 * it, independent of revision-pending state.
 */
export async function confirmSelectedDirection(
  projectId: string,
  artworkVersionId: string,
): Promise<ApiProjectSnapshot> {
  const snapshot = await getCapabilityGraph().conversation.confirmSelectedDirection(
    projectId,
    artworkVersionId,
  );
  return withConceptStatus(snapshot);
}

/**
 * Sprint 2M Phase 2B: the customer's explicit "this is my final direction —
 * prepare it for production" action. Idempotent — see `FinalArtworkCapability`.
 * Interactive `next dev` kicks the in-process final-artwork scheduler after a
 * durable claimable enqueue (mirrors generation's local trigger).
 */
export async function approveFinalDirection(
  projectId: string,
  artworkVersionId: string,
): Promise<ApiProjectSnapshot> {
  const snapshot = await getCapabilityGraph().conversation.approveFinalDirection(
    projectId,
    artworkVersionId,
  );
  const apiSnapshot = await withConceptStatus(snapshot);
  maybeKickLocalFinalArtworkWorker(
    projectId,
    apiSnapshot,
    "approve_final_direction",
  );
  return apiSnapshot;
}

/**
 * Sprint 2D: Approve / Edit / Continue in response to a presented Design
 * Summary. Approval is idempotent and is the only path that can trigger
 * concept generation.
 */
export async function submitDesignBriefDecision(
  projectId: string,
  action: DesignBriefDecisionAction,
): Promise<ApiProjectSnapshot> {
  const snapshot = await getCapabilityGraph().conversation.submitDesignBriefDecision(
    projectId,
    action,
  );
  const apiSnapshot = await withConceptStatus(snapshot);
  if (action === "approve") {
    maybeKickLocalGenerationWorker(projectId, apiSnapshot, "approve_brief");
  }
  return apiSnapshot;
}

/**
 * Live Acceptance Cleanup (Issue 2): explicit "Change Selection" action.
 * Server-owned — never a client-side visual reset. See
 * `ConversationCapability.unselectConcept`.
 */
export async function unselectConcept(
  projectId: string,
): Promise<ApiProjectSnapshot> {
  return withConceptStatus(
    await getCapabilityGraph().conversation.unselectConcept(projectId),
  );
}

/**
 * Live Acceptance Cleanup (Issue 3): explicit "Show Me 3 New Concepts"
 * action — a fresh batch of three directions from the same approved brief.
 */
export async function exploreNewConceptBatch(
  projectId: string,
): Promise<ApiProjectSnapshot> {
  const snapshot =
    await getCapabilityGraph().conversation.exploreNewConceptBatch(projectId);
  const apiSnapshot = await withConceptStatus(snapshot);
  maybeKickLocalGenerationWorker(projectId, apiSnapshot, "regenerate_concepts");
  return apiSnapshot;
}

/**
 * Live Acceptance Cleanup (Issue 5): explicit "Change Size" action. A
 * production-specification change only — never generation, never a creative
 * revision, never a provider call.
 */
export async function setProductionPrintWidth(
  projectId: string,
  requestedWidthIn: number | null,
): Promise<ApiProjectSnapshot> {
  return withConceptStatus(
    await getCapabilityGraph().conversation.setProductionPrintWidth(
      projectId,
      requestedWidthIn,
    ),
  );
}

/** Sprint 2G Part 3: explicit action behind the persistent "Generate Updated Concepts" control. */
export async function regenerateConcepts(
  projectId: string,
): Promise<ApiProjectSnapshot> {
  const snapshot = await getCapabilityGraph().conversation.regenerateConcepts(
    projectId,
  );
  const apiSnapshot = await withConceptStatus(snapshot);
  maybeKickLocalGenerationWorker(projectId, apiSnapshot, "regenerate_concepts");
  return apiSnapshot;
}

/** Sprint 2G Part 3: explicit action behind an "Undo" control. */
export async function undoLastChange(
  projectId: string,
): Promise<ApiProjectSnapshot> {
  const snapshot = await getCapabilityGraph().conversation.undoLastChange(
    projectId,
  );
  return withConceptStatus(snapshot);
}

/**
 * Interactive `next dev` only: after enqueue persistence, kick the in-process
 * scheduler so local Approve/Create Concepts does not wait on a manual
 * `POST /api/worker/generation`. Production and automated tests no-op — see
 * `local-generation-trigger-policy.ts`. Never throws to the customer request.
 */
function maybeKickLocalGenerationWorker(
  projectId: string,
  snapshot: ApiProjectSnapshot,
  reason: LocalGenerationTriggerReason,
): void {
  if (snapshot.project.status !== "generating") return;
  maybeTriggerLocalGenerationWorker({ projectId, reason });
}

/**
 * Interactive `next dev` only: after FinalArtworkJob enqueue persistence,
 * kick the in-process final-artwork scheduler so local Prepare Print-Ready
 * does not wait on a manual `POST /api/worker/final-artwork`. Production
 * and automated tests no-op — shared policy in
 * `local-generation-trigger-policy.ts`. Never throws to the customer request.
 */
function maybeKickLocalFinalArtworkWorker(
  projectId: string,
  snapshot: ApiProjectSnapshot,
  reason: LocalFinalArtworkTriggerReason,
): void {
  if (snapshot.project.status !== "finalizing") return;
  maybeTriggerLocalFinalArtworkWorker({ projectId, reason });
}

/**
 * Sprint 2H Part 2B: provider-neutral generation status, safe for the
 * conversation to poll every few seconds — no job id, no provider name, no
 * queue detail. Production and automated tests are purely read-only: a
 * status read and nothing else. They never recover abandoned jobs, never
 * claim work, and never run generation. Interactive `next dev` only may
 * kick a stranded `queued`/`attempts=0` job (missed post-enqueue trigger
 * or stale HMR) via `maybeRecoverStrandedLocalGenerationJobs`. Polling
 * still never revives a running/failed job and never calls a provider
 * itself.
 */
export type GenerationStatus = "idle" | "generating" | "ready" | "failed";

export interface GenerationStatusView {
  status: GenerationStatus;
}

function toGenerationStatusView(status: ProjectStatus): GenerationStatusView {
  if (status === "generating") return { status: "generating" };
  if (status === "concepts_ready") return { status: "ready" };
  if (status === "failed") return { status: "failed" };
  return { status: "idle" };
}

export async function getGenerationStatus(
  projectId: string,
): Promise<GenerationStatusView | null> {
  const snapshot = await getCapabilityGraph().conversation.get(projectId);
  if (!snapshot) return null;
  if (snapshot.project.status === "generating") {
    void maybeRecoverStrandedLocalGenerationJobs(projectId, "status_poll");
  }
  return toGenerationStatusView(snapshot.project.status);
}

/**
 * Customer-safe finalization status — the finalization counterpart of
 * `getGenerationStatus`. Same sanitization choke point as the snapshot's
 * `finalization` view (`toCustomerFinalizationView`): never a job id,
 * provider name, queue detail, or storage key. Production and automated
 * tests are purely read-only. Interactive `next dev` only may kick a
 * stranded `queued`/`attempts=0` FinalArtworkJob (missed post-enqueue
 * trigger or stale HMR) via `maybeRecoverStrandedLocalFinalArtworkJobs`.
 * Polling still never revives a failed/cancelled/completed job and never
 * calls a provider itself.
 */
export async function getFinalizationStatus(
  projectId: string,
): Promise<CustomerFinalizationView | null> {
  const snapshot = await getCapabilityGraph().conversation.get(projectId);
  if (!snapshot) return null;
  if (snapshot.project.status === "finalizing") {
    void maybeRecoverStrandedLocalFinalArtworkJobs(projectId, "status_poll");
  }
  return customerFinalizationViewForProject(
    projectId,
    snapshot.project.status,
    snapshot.brief.requestedProductionOutput,
  );
}

export interface ConceptImageView {
  /** Short-lived signed URL from `AssetCapability.getSignedUrl` — never a raw object key. */
  url: string;
}

/**
 * Sprint 2K Phase 1: the only path from a browser-visible `artworkVersionId`
 * to a real, renderable image. Looks the concept up in the internal
 * (unsanitized) snapshot purely to find its `primaryAssetId`, then asks
 * `AssetCapability` for a fresh signed URL — the asset id itself never
 * leaves the server. Returns `null` whenever the project, the concept, or a
 * generated image doesn't exist, so callers can render a uniform 404
 * without leaking which case applied.
 */
export async function getConceptImageUrl(
  projectId: string,
  artworkVersionId: string,
): Promise<ConceptImageView | null> {
  const graph = getCapabilityGraph();
  const snapshot = await graph.conversation.get(projectId);
  if (!snapshot) return null;

  const artwork = snapshot.artworkVersions.find(
    (version) => version.id === artworkVersionId && version.projectId === projectId,
  );
  if (!artwork || !artwork.primaryAssetId) return null;

  const url = await graph.assets.getSignedUrl(artwork.primaryAssetId);
  return url ? { url } : null;
}

export interface ProductionArtworkView {
  /** Short-lived signed URL — never a raw object key, asset id, or job/approval id. */
  url: string;
  /** Customer-safe download basename suggestion (e.g. `1988-toyota-mr2-print-ready.png`). */
  filename: string;
  mimeType: string;
  widthPx: number | null;
  heightPx: number | null;
  transparent: boolean | null;
  /** Plain-language print placement, e.g. "Full Front". */
  placementLabel: string | null;
  /** Customer-facing design label (required wording, else product summary). */
  designLabel: string | null;
  /**
   * Live Acceptance Cleanup (Issue 5): the plate's ACTUAL physical print
   * size and resolution, read from the production normalization record
   * persisted with the asset — never the placement default, and never
   * re-derived here. A customer who chose 12" must see 12", not a stale 10.5".
   * `null` for a production asset created before normalization recorded it.
   */
  widthIn: number | null;
  heightIn: number | null;
  dpi: number | null;
}

/**
 * Sprint 2M Phase 2C (Goal 14) + delivery-mode: the secure read boundary for
 * print-ready production artwork preview/download. Returns a fresh,
 * short-lived signed URL plus customer-safe metadata for the project's
 * current print-ready production PNG, or `null` on any miss (project not
 * found, not print-ready yet, or no production asset resolvable) — every
 * miss is deliberately indistinguishable. Never exposes asset/job/provider
 * ids or storage paths. Only ever exposes a URL once
 * `PrintProject.status === "print_ready"`.
 */
export async function getProductionArtworkUrl(
  projectId: string,
): Promise<ProductionArtworkView | null> {
  const resolved = await resolveCurrentProductionArtwork(projectId);
  if (!resolved) return null;

  const url = await getCapabilityGraph().assets.getSignedUrl(resolved.assetId);
  if (!url) return null;

  return {
    url,
    filename: resolved.filename,
    mimeType: resolved.mimeType,
    widthPx: resolved.widthPx,
    heightPx: resolved.heightPx,
    transparent: resolved.transparent,
    placementLabel: resolved.placementLabel,
    designLabel: resolved.designLabel,
    widthIn: resolved.widthIn,
    heightIn: resolved.heightIn,
    dpi: resolved.dpi,
  };
}

/**
 * Streams the current print-ready production PNG for a forced download with
 * a customer-safe Content-Disposition filename. Same authorization gates as
 * `getProductionArtworkUrl` — never a storage path or internal id.
 */
export async function getProductionArtworkDownload(
  projectId: string,
): Promise<{
  bytes: Buffer;
  contentType: string;
  filename: string;
} | null> {
  const resolved = await resolveCurrentProductionArtwork(projectId);
  if (!resolved) return null;

  const downloaded = await getCapabilityGraph().assets.downloadAssetBytes(
    resolved.assetId,
  );
  if (!downloaded) return null;

  return {
    bytes: downloaded.bytes,
    contentType: downloaded.contentType || resolved.mimeType,
    filename: resolved.filename,
  };
}

async function resolveCurrentProductionArtwork(projectId: string): Promise<{
  assetId: string;
  filename: string;
  mimeType: string;
  widthPx: number | null;
  heightPx: number | null;
  transparent: boolean | null;
  placementLabel: string | null;
  designLabel: string | null;
  widthIn: number | null;
  heightIn: number | null;
  dpi: number | null;
} | null> {
  const graph = getCapabilityGraph();
  const snapshot = await graph.conversation.get(projectId);
  if (!snapshot) return null;

  // Sprint A2 Correction 3 (Goal 5 / Goal 10): the ONLY gate is now whether a
  // completed job satisfies the CURRENT request — current authority, matching
  // bound intent, real asset, `ready` validation for that asset.
  //
  // `project.status === "print_ready"` used to guard this, and it is the
  // wrong question in both directions. It said yes to a historical PNG when
  // the customer had since asked for separations (the plate was still on
  // file, so the status still read print_ready) — handing over an artifact as
  // though it answered a request it does not. And it said no to a perfectly
  // valid, current plate whose project status was left stale at
  // `finalization_required` by an unsupported job that ran in between.
  // `getCurrentProductionAssetId` is strictly stronger than the status check
  // ever was, so nothing is loosened by dropping it.
  const assetId = await graph.finalArtwork.getCurrentProductionAssetId(projectId);
  if (!assetId) return null;

  const assets = await graph.assets.listAssets(projectId);
  const asset = assets.find((item) => item.id === assetId);
  if (!asset || asset.productionRole !== "production_png") return null;

  const placementRaw = printPlacementLabel(snapshot.brief.printPlacement);
  const placementLabel = placementRaw
    ? placementRaw.replace(/\b\w/g, (char) => char.toUpperCase())
    : null;
  const designLabel =
    snapshot.brief.exactText?.trim() ||
    snapshot.brief.productSummary?.trim() ||
    null;
  const mimeType = asset.contentType ?? "image/png";
  // The plate's own recorded production geometry (Print-Ready Normalization
  // Phase 1 writes it alongside the bytes) — the only honest source for
  // "what size is this file", since it is what the transform actually
  // produced rather than what policy would have asked for today.
  const normalization = asset.metadata?.normalization as
    | Record<string, unknown>
    | undefined;

  // Existing Artwork → Print Ready Phase 2: for an upload project, the
  // customer's own filename is the name they will recognize — see
  // `buildPrintReadyFilename`'s precedence. Resolved through the same
  // never-take-down-the-request helper as everywhere else: a filename is
  // presentation, and a lookup failure must degrade to the brief-derived
  // name rather than fail the download.
  const preparation = await resolveArtworkPreparation(projectId);

  return {
    assetId,
    widthIn: readFiniteNumber(normalization?.intendedWidthIn),
    heightIn: readFiniteNumber(normalization?.intendedHeightIn),
    dpi: readFiniteNumber(normalization?.targetPpi),
    filename: buildPrintReadyFilename({
      uploadedFilename: preparation?.originalFilename ?? null,
      exactText: snapshot.brief.exactText,
      productSummary: snapshot.brief.productSummary,
      mimeType,
    }),
    mimeType,
    widthPx: asset.widthPx,
    heightPx: asset.heightPx,
    transparent: asset.hasTransparency,
    placementLabel,
    designLabel,
  };
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
