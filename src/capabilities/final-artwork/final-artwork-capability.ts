/**
 * Sprint 2M Phase 2B: the reserved Final Artwork / production
 * orchestration boundary, and the sole owner of `FinalDirectionApproval`
 * writes — the explicit, durable customer decision that authorizes
 * production finalization for one exact `ArtworkVersion`.
 *
 * This capability answers a different question than concept *selection*
 * (`ArtworkVersion.isSelected` / `PrintProject.selectedArtworkVersionId`,
 * owned by `ConversationCapability.selectConcept`):
 *
 *   Selection — "This is the direction I want to work with." (revisable)
 *   Final direction approval — "Yes, this is the artwork I want finalized
 *     for production." (explicit, durable, and the sole gate that may ever
 *     authorize a `FinalArtworkJob`)
 *
 * Phase 2B does NOT perform any production transformation. `requestFinalArtwork`
 * only ever produces a `FinalArtworkJob` in status `"queued"` — no worker
 * claims or runs it yet. This capability must never:
 *   - select concepts, interpret conversation, or decide customer intent
 *     (the caller — `ConversationCapability` — already made that decision;
 *     this capability only persists and validates it)
 *   - evaluate creative quality (Concept Evaluation's job)
 *   - perform Print Validation internally by duplicating its rules
 *   - mark artwork print-ready without a real, authoritative validation run
 *     against a real production asset (which cannot exist yet in Phase 2B)
 */

import {
  UniqueConstraintViolationError,
  type ProjectRepository,
} from "@/lib/db/repository";
import {
  isUnsupportedRequestedProductionOutput,
  normalizeProductionIntent,
  productionIntentMatches,
} from "@/lib/domain/types";
import type {
  ArtworkPreparation,
  FinalArtworkJob,
  FinalDirectionApproval,
  StoredRequestedProductionOutput,
} from "@/lib/domain/types";
import {
  createAcquisitionCapability,
  type AcquisitionCapability,
} from "@/capabilities/acquisition";
import { diffBriefSections } from "@/capabilities/shared/brief-diff";
import { isConceptRelevantChange } from "@/capabilities/shared/concept-relevance";
import { resolveProductionWidth } from "@/capabilities/shared/print-placement-dimensions";

export interface RequestFinalArtworkResult {
  approval: FinalDirectionApproval;
  job: FinalArtworkJob;
  /**
   * True when this call reused an already-active approval for the exact
   * same `artworkVersionId` rather than creating a new one — a double
   * click, a duplicate request, a page reload, or a worker retry all land
   * here rather than producing a second approval/job (Goal 14).
   */
  alreadyRequested: boolean;
}

/**
 * Existing Artwork → Print Ready Phase 2: the upload workflow's counterpart.
 * There is no `approval` field because there is no separate approval record —
 * the `ArtworkPreparation` the customer approved IS the authority, and
 * inventing a second one would be exactly the duplicate authority this design
 * rejects (see `ArtworkPreparation`'s doc and ARCHITECTURE.md §13i).
 */
export interface RequestPreparedUploadFinalArtworkResult {
  preparation: ArtworkPreparation;
  job: FinalArtworkJob;
  /** The production width, in inches, this job is keyed to and will be produced at. */
  productionWidthIn: number;
  /**
   * True when this call reused an existing job for the exact same
   * (preparation approval, production width) rather than creating one — a
   * double click, a page reload, two tabs, or a retry all land here (Goal 14).
   */
  alreadyRequested: boolean;
}

/**
 * Two production widths count as "the same production intent" only when they
 * are the same number. `resolveProductionWidth` already snaps every width to a
 * quarter inch, so this exists purely to keep the comparison from being naked
 * float equality — never to tolerate a genuinely different size.
 */
const PRODUCTION_WIDTH_EPSILON_IN = 1e-6;

export interface FinalArtworkCapability {
  /**
   * The customer's explicit "prepare this for production" action, already
   * decided by the caller — this capability validates and persists it, it
   * never infers it. Validates that `artworkVersionId`:
   *   - exists and belongs to this exact project (a foreign/forged id is
   *     indistinguishable from "not found" — `snapshot.artworkVersions` is
   *     already scoped to `projectId` by the repository, so a cross-project
   *     id can never appear in it; Goal 15)
   *   - belongs to the current (most recently approved) concept batch, not
   *     an older, superseded one (Goal 3, Goal 18 Scenario G)
   *   - is the project's currently selected concept — approval can never
   *     target "whatever happens to be selected" implicitly; the caller
   *     must name the exact id, and it must match (Goal 3)
   *   - is not stale relative to the working brief (Goal 4 — approving a
   *     concept the customer has since revised past would silently carry
   *     approval across a change that hasn't been reflected in artwork yet)
   *
   * Idempotent: repeating this call for the same already-active
   * `artworkVersionId` returns the existing approval/job rather than
   * creating duplicates (Goal 14). Concurrency-safe: a race between two
   * concurrent requests is resolved by the repository's unique-constraint
   * guarantees, never by this capability assuming it "goes first".
   */
  requestFinalArtwork(
    projectId: string,
    artworkVersionId: string,
  ): Promise<RequestFinalArtworkResult>;
  /**
   * Existing Artwork → Print Ready Phase 2: the customer's "prepare my
   * print-ready artwork" action for artwork they uploaded themselves.
   *
   * THE AUTHORITY MODEL, stated once. Create New Artwork and Upload Existing
   * Artwork are PARALLEL customer-authority boundaries, not one pipeline with
   * two entrances:
   *
   *   create_new      — selected concept → final-direction approval → finalize
   *   prepare_existing— uploaded original → prepared artwork → prepared
   *                     approval → finalize
   *
   * So this method deliberately does NOT require `selectedArtworkVersionId`,
   * `finalDirectionConfirmed`, an approved `DesignBriefVersion`, or a
   * `FinalDirectionApproval`. Every one of those belongs to the creative
   * lifecycle: they mean "I am done revising the design you generated for
   * me", a question never asked of someone who arrived with finished artwork.
   * Forcing an upload through them would require fabricating a concept
   * selection and a brief approval for artwork no brief describes — a
   * synthetic paper trail asserting a decision the customer never made.
   *
   * What it requires instead is the decision they DID make:
   * `ArtworkPreparation.status === "approved"`, with the prepared asset and
   * the `prepared_upload` `ArtworkVersion` it produced.
   *
   * Idempotent on (preparation approval, production width): a double click, a
   * reload, two tabs, or a retry all return the same job (Goal 14). Choosing
   * a DIFFERENT print width is not a repeat request — it is a different
   * physical deliverable, and gets its own job rather than silently reusing a
   * plate produced at the old size.
   */
  requestPreparedUploadFinalArtwork(
    projectId: string,
  ): Promise<RequestPreparedUploadFinalArtworkResult>;
  /**
   * Sprint 2M Phase 2C (Goal 14): resolves the project's current
   * print-ready production PNG asset id, if any — the one piece of
   * repository knowledge a future secure download boundary needs, kept
   * inside this capability rather than exposed to a route or
   * `conversation-service` directly (Goal 15 — no raw storage keys, no
   * asset ids, no job/approval internals reach a caller outside this
   * layer). Resolves only via the project's currently *active*
   * `FinalDirectionApproval` — a superseded approval's production asset,
   * if one somehow still existed, is never returned. Returns `null` for
   * any miss (no active approval, no job, no production asset yet) —
   * callers must not distinguish those cases.
   *
   * Existing Artwork → Print Ready Phase 2: for an upload project (where no
   * `FinalDirectionApproval` exists, by design) this resolves through the
   * preparation's finalization job for the CURRENT production width instead.
   * A plate produced at a width the customer has since changed is never
   * returned — a mismatched deliverable is worse than none, because every
   * size on it would be a lie (Goal 14).
   *
   * Sprint A2 Correction 3: now resolves ONLY through a job that satisfies
   * the project's current production request — see
   * `resolveSatisfiedProductionDelivery`. A historical PNG is never returned
   * as the deliverable for a customer who has since asked for something
   * else, and a completed job with no `ready` validation is never returned
   * at all.
   */
  getCurrentProductionAssetId(projectId: string): Promise<string | null>;
  /**
   * Sprint A2 Correction 3: the same resolution, with the job it came from —
   * so a caller that must ALSO reconcile project status (or explain why it
   * cannot) does not have to re-derive the answer and risk disagreeing with
   * whatever the delivery routes concluded.
   */
  resolveCurrentProductionDelivery(
    projectId: string,
  ): Promise<CurrentProductionDelivery | null>;
}

/**
 * Sprint A2 Correction 3: proof that a completed job currently satisfies the
 * project's Production PNG request — the job itself plus the exact validated
 * asset. Internal; the asset id never leaves the service layer.
 */
export interface CurrentProductionDelivery {
  job: FinalArtworkJob;
  assetId: string;
}

export function createFinalArtworkCapability(
  repo: ProjectRepository,
  /**
   * Sprint A4 — THE FINALIZATION FENCE.
   *
   * Both request methods below are the only paths that can ever create a
   * `FinalArtworkJob`, and a `FinalArtworkJob` is what the final-artwork
   * worker claims before dispatching paid production reconstruction
   * (Topaz). So refusing here refuses that spend structurally, exactly as
   * `ConceptGenerationCapability`'s enqueue fence does for image
   * generation: no job, no claim, no paid call.
   *
   * Until payment entitlement exists (Sprint A5) this is available to
   * internal-entitled and legacy-unbound projects only. Both the Create New
   * path and the Upload Existing Artwork path are covered — an upload never
   * consumes a free concept, so its ONLY acquisition gate is this one.
   *
   * Defaults to a fresh instance so a call site that forgets to pass one
   * still gets the boundary.
   */
  acquisition: AcquisitionCapability = createAcquisitionCapability(repo),
): FinalArtworkCapability {
  return {
    async requestFinalArtwork(projectId, artworkVersionId) {
      const snapshot = await repo.getProject(projectId);
      if (!snapshot) throw new Error("Project not found");

      // Checked before every other validation: a customer who may not
      // finalize at all should be told that, not walked through
      // increasingly specific reasons about artwork they are not going to
      // be allowed to finalize either way.
      const entitled = await acquisition.authorizeFinalization(projectId);
      if (!entitled.allowed) throw new Error(entitled.customerMessage);

      // Sprint 2M Phase 2G (Goal 6): a pending revision means the customer
      // has explicitly said the current artwork is not what they want —
      // the server is the authoritative gate here, independent of whatever
      // the UI shows (a stale browser tab, a race with an in-flight
      // revision turn). Customer-safe language only; no internal lifecycle
      // terminology, no artwork/job/approval id.
      if (snapshot.project.revisionPending) {
        throw new Error(
          "Your revised design needs to be reviewed before it can be finalized",
        );
      }

      const artwork = snapshot.artworkVersions.find(
        (version) => version.id === artworkVersionId,
      );
      if (!artwork) {
        // Covers both "never existed" and "belongs to another project" —
        // `snapshot.artworkVersions` only ever contains this project's own
        // rows (Goal 15).
        throw new Error("Artwork version not found for this project");
      }

      const latestBriefVersion = snapshot.designBriefVersions.at(-1);
      if (!latestBriefVersion) {
        throw new Error(
          "Cannot approve final artwork without an approved design brief",
        );
      }
      if (artwork.designBriefVersionId !== latestBriefVersion.id) {
        throw new Error(
          "This concept is from an earlier design direction and can no longer be approved for production",
        );
      }

      if (snapshot.project.selectedArtworkVersionId !== artworkVersionId) {
        throw new Error(
          "Select this concept before approving it for production",
        );
      }

      // Same staleness signal `ConceptGenerationCapability.describeConceptStatus`
      // uses ("needs_update") — reused via the same shared pure modules
      // rather than depending on ConceptGenerationCapability itself, so
      // this stays a pure-data dependency (Goal 4).
      const approvedAsBrief = { ...snapshot.brief, ...latestBriefVersion.content };
      const changedSinceApproval = diffBriefSections(approvedAsBrief, snapshot.brief);
      if (isConceptRelevantChange(changedSinceApproval)) {
        throw new Error(
          "Recent design changes are not yet reflected in this concept — generate updated concepts before approving it for production",
        );
      }

      // Live Acceptance Corrective Pass (Section 2): concept SELECTION
      // ("I want to work with this direction") is never, by itself, final
      // APPROVAL ("no more changes, produce this"). Checked last, only
      // once the artwork itself is confirmed valid/current/selected — a
      // customer who has never been explicitly asked/answered "does this
      // look right?" must never be able to finalize just because nothing
      // currently happens to be pending (the independent, stronger gate
      // `revisionPending` alone does not cover).
      if (!snapshot.project.finalDirectionConfirmed) {
        throw new Error(
          "Please confirm this is your final direction before it can be finalized",
        );
      }

      const existingActive = await repo.getActiveFinalDirectionApproval(projectId);

      let approval: FinalDirectionApproval;
      let alreadyRequested = false;

      if (existingActive && existingActive.artworkVersionId === artworkVersionId) {
        approval = existingActive;
        alreadyRequested = true;
      } else {
        if (existingActive) {
          await repo.supersedeActiveFinalDirectionApproval(projectId);
        }
        approval = await createApprovalToleratingRace(
          repo,
          projectId,
          artworkVersionId,
          latestBriefVersion.id,
        );
      }

      // Sprint A2 Correction 2 (Goal 3 / Goal 11): the job's bound intent is
      // snapshotted from the SERVER's current persisted authority, never
      // from anything the caller supplied. A stale browser tab that still
      // thinks the customer wants a PNG cannot resurrect that intent by
      // clicking Prepare — its request simply enqueues (or reuses) the job
      // for whatever the project currently asks for.
      const requestedProductionOutput = normalizeProductionIntent(
        snapshot.brief.requestedProductionOutput,
      );

      const job = await createJobToleratingRace(
        repo,
        projectId,
        approval,
        requestedProductionOutput,
      );

      // Sprint 2M Phase 2G (Goal 8): only claimable work justifies
      // "finalizing". A repeat Prepare against an already-`"completed"` job
      // (double click, page reload, duplicate request) must return the
      // worker's own truthful terminal state (`print_ready` /
      // `finalization_required`, already written by
      // `FinalArtworkWorkerCapability`) rather than stomping it back to
      // "finalizing" with no claimable job left to move it forward — the
      // exact stranding the Revision Lifecycle Audit found. A revived
      // `"failed"` job is returned as `"queued"` by `createJobToleratingRace`
      // above, so a legitimate retry still reaches this branch.
      // Sprint A2 Correction 3 (Goal 1 / Goal 4): the reused job is already
      // COMPLETE and still satisfies what the customer is asking for — the
      // PNG → unsupported → PNG round trip. `project.status` is stale
      // (`finalization_required`, written by the unsupported job that ran in
      // between), so without this the customer sits on `needs_review` forever
      // with a perfectly good, already-paid-for plate on file and nothing
      // able to move them off it.
      //
      // The job is NOT re-queued to achieve this. Reviving a completed job
      // just to restore state would risk re-running production work and would
      // rewrite history that is still true. State is reconciled from the
      // job's own immutable evidence instead — including its authoritative
      // validation, so this can never manufacture readiness the pipeline
      // did not assert.
      await reconcileCompletedProductionState(repo, projectId, job);

      if (job.status === "queued" || job.status === "running" || job.status === "recoverable") {
        await repo.setProjectStatus(projectId, "finalizing");
      }

      return { approval, job, alreadyRequested };
    },

    async requestPreparedUploadFinalArtwork(projectId) {
      const snapshot = await repo.getProject(projectId);
      if (!snapshot) throw new Error("Project not found");

      // Sprint A4: same fence as the create_new path. An upload project
      // never consumes a free concept, so this is the only acquisition gate
      // standing between an anonymous prospect and paid production
      // reconstruction.
      const entitled = await acquisition.authorizeFinalization(projectId);
      if (!entitled.allowed) throw new Error(entitled.customerMessage);

      const preparation = await repo.getArtworkPreparation(projectId);
      // Goal 18: `getArtworkPreparation` is already project-scoped, so a
      // preparation belonging to another project can never surface here; the
      // explicit re-check below makes that a guarantee rather than a property
      // of the current query.
      if (!preparation || preparation.projectId !== projectId) {
        throw new Error("This project has no uploaded artwork to prepare for print");
      }
      if (preparation.status !== "approved" || !preparation.preparedArtworkVersionId) {
        throw new Error(
          "Approve your prepared artwork before we can create the print-ready file",
        );
      }
      if (!preparation.preparedAssetId) {
        throw new Error(
          "Approve your prepared artwork before we can create the print-ready file",
        );
      }

      // Goal 18: `snapshot.artworkVersions` only ever contains this project's
      // own rows, so a preparation pointing at a foreign artwork version is
      // detected as "not found" rather than followed.
      const artwork = snapshot.artworkVersions.find(
        (version) => version.id === preparation.preparedArtworkVersionId,
      );
      if (!artwork || artwork.kind !== "prepared_upload") {
        throw new Error("Your prepared artwork could not be found for this project");
      }

      // Production size is read from the project's own persisted intent, never
      // from the request — a forged or stale finalize call cannot smuggle a
      // different physical size in (Goal 18).
      const resolvedWidth = resolveProductionWidth(
        snapshot.brief.printPlacement,
        snapshot.brief.intendedPrintWidthIn,
      );
      if (!resolvedWidth) {
        throw new Error(
          "I need to know where this prints before I can prepare your print-ready artwork",
        );
      }
      const productionWidthIn = resolvedWidth.widthIn;

      // Sprint A2 Correction 2 (Goal 3 / Goal 11): server-side current
      // authority, never anything the caller carried — see the create_new
      // path's identical reasoning.
      const { job, alreadyRequested } = await resolvePreparedUploadJob(
        repo,
        projectId,
        preparation.id,
        artwork.id,
        productionWidthIn,
        normalizeProductionIntent(snapshot.brief.requestedProductionOutput),
      );

      // Same rule as the create_new path (Sprint 2M Phase 2G Goal 8): only
      // claimable work justifies "finalizing". A repeat request against an
      // already-`"completed"` job must return the worker's own truthful
      // terminal state rather than stranding the project in "finalizing" with
      // nothing left to move it forward.
      // Sprint A2 Correction 3 (Goal 1 / Goal 4): the reused job is already
      // COMPLETE and still satisfies what the customer is asking for — the
      // PNG → unsupported → PNG round trip. `project.status` is stale
      // (`finalization_required`, written by the unsupported job that ran in
      // between), so without this the customer sits on `needs_review` forever
      // with a perfectly good, already-paid-for plate on file and nothing
      // able to move them off it.
      //
      // The job is NOT re-queued to achieve this. Reviving a completed job
      // just to restore state would risk re-running production work and would
      // rewrite history that is still true. State is reconciled from the
      // job's own immutable evidence instead — including its authoritative
      // validation, so this can never manufacture readiness the pipeline
      // did not assert.
      await reconcileCompletedProductionState(repo, projectId, job);

      if (job.status === "queued" || job.status === "running" || job.status === "recoverable") {
        await repo.setProjectStatus(projectId, "finalizing");
      }

      return { preparation, job, productionWidthIn, alreadyRequested };
    },

    async getCurrentProductionAssetId(projectId) {
      const satisfied = await resolveSatisfiedProductionDelivery(repo, projectId);
      return satisfied?.assetId ?? null;
    },

    async resolveCurrentProductionDelivery(projectId) {
      return resolveSatisfiedProductionDelivery(repo, projectId);
    },
  };
}

/**
 * Sprint A2 Correction 3 — THE SINGLE RECONCILIATION BOUNDARY.
 *
 * Answers one question, for both workflows: *does an already-completed
 * FinalArtworkJob currently satisfy this project's Production PNG request?*
 *
 * "Some completed job exists" is not that question, and treating it as such
 * was the defect this replaces. Delivery previously resolved through
 * `getFinalArtworkJobByApprovalId`, which returns the OLDEST job for an
 * approval with no regard for what was asked — so a historical PNG could be
 * handed over as the current deliverable to a customer who had since asked
 * for separations. Five things must ALL hold:
 *
 *   1. The current request is one this product produces at all. An
 *      unsupported (or unreadable) request is never satisfied by anything.
 *   2. A job exists under the CURRENT authority — the active final-direction
 *      approval, or the approved preparation at the CURRENT width.
 *   3. That job's immutable bound intent matches the current request.
 *   4. It completed and a production asset really exists for it.
 *   5. Authoritative production validation for THAT EXACT ASSET says `ready`.
 *
 * (5) is why this returns evidence rather than a boolean about job status.
 * `completed` only means the worker reached a conclusion — including "this
 * cannot be auto-finalized". Restoring `print_ready` from completion alone
 * would manufacture readiness the pipeline never asserted, which is the one
 * thing `print_ready` exists to prevent.
 *
 * Read-only and side-effect free, so both a delivery route and a status
 * read can call it without one of them quietly writing.
 */
async function resolveSatisfiedProductionDelivery(
  repo: ProjectRepository,
  projectId: string,
): Promise<CurrentProductionDelivery | null> {
  const snapshot = await repo.getProject(projectId);
  if (!snapshot) return null;

  // (1) An unsupported request is unmet by definition. The historical plate
  // is not deleted — it simply is not an answer to this question.
  const currentIntent = normalizeProductionIntent(
    snapshot.brief.requestedProductionOutput,
  );
  if (isUnsupportedRequestedProductionOutput(currentIntent)) return null;

  // (2)+(3) The job under the current authority, bound to the current intent.
  const job = await resolveCurrentMatchingProductionJob(
    repo,
    projectId,
    currentIntent,
  );
  // (4) Completed, with a real asset.
  if (!job || job.status !== "completed") return null;

  const assetId = await findProductionAssetIdForJob(repo, projectId, job.id);
  if (!assetId) return null;

  // (5) Authoritative validation, for this asset, saying ready.
  const validation = await repo.getLatestProductionAssetValidationForJob(
    projectId,
    job.id,
  );
  if (!validation || validation.status !== "ready") return null;
  if (validation.assetId !== assetId) return null;

  return { job, assetId };
}

/**
 * Sprint A2 Correction 3 (Goal 1 / Goal 12): brings `PrintProject.status`
 * back in line with a completed job that genuinely satisfies the current
 * request.
 *
 * Deliberately narrow. It only ever writes `print_ready`, only when
 * `resolveSatisfiedProductionDelivery` has independently confirmed the whole
 * chain (current authority, matching intent, real asset, `ready` validation
 * for that asset), and only when the satisfying job is the one the caller is
 * holding. It never writes a failure state and never touches a project whose
 * request is unmet — that remains the worker's to decide.
 *
 * The guard against the obvious misreading, stated plainly: a `completed`
 * job is NOT evidence of readiness. `completeWithoutAsset` completes jobs
 * that produced nothing at all. Only the validation record says ready.
 */
async function reconcileCompletedProductionState(
  repo: ProjectRepository,
  projectId: string,
  job: FinalArtworkJob,
): Promise<void> {
  if (job.status !== "completed") return;

  const satisfied = await resolveSatisfiedProductionDelivery(repo, projectId);
  if (!satisfied || satisfied.job.id !== job.id) return;

  const snapshot = await repo.getProject(projectId);
  if (!snapshot || snapshot.project.status === "print_ready") return;

  await repo.setProjectStatus(projectId, "print_ready");
}

/**
 * Sprint A2 Correction 3 (Goal 7): the job under the project's CURRENT
 * production authority that matches the given intent, or `null`.
 *
 * Deliberately not `getFinalArtworkJobByApprovalId` — that helper answers
 * "any job for this approval, oldest first", a question that stopped being
 * well-formed once one approval could own a job per requested output.
 */
async function resolveCurrentMatchingProductionJob(
  repo: ProjectRepository,
  projectId: string,
  currentIntent: StoredRequestedProductionOutput,
): Promise<FinalArtworkJob | null> {
  const activeApproval = await repo.getActiveFinalDirectionApproval(projectId);
  if (activeApproval) {
    return findJobForIntent(
      await repo.listFinalArtworkJobsForApproval(projectId, activeApproval.id),
      currentIntent,
    );
  }

  const preparation = await repo.getArtworkPreparation(projectId);
  if (!preparation || preparation.status !== "approved") return null;

  const snapshot = await repo.getProject(projectId);
  if (!snapshot) return null;

  // The width match is as load-bearing as the intent match: a plate produced
  // at 10.5in is the wrong deliverable for someone who has since chosen 12in.
  const resolvedWidth = resolveProductionWidth(
    snapshot.brief.printPlacement,
    snapshot.brief.intendedPrintWidthIn,
  );
  if (!resolvedWidth) return null;

  return findJobForWidth(
    await repo.listFinalArtworkJobsForPreparation(projectId, preparation.id),
    resolvedWidth.widthIn,
    currentIntent,
  );
}

async function findProductionAssetIdForJob(
  repo: ProjectRepository,
  projectId: string,
  finalArtworkJobId: string,
): Promise<string | null> {
  const assets = await repo.listAssets(projectId);
  const productionAsset = assets.find(
    (asset) =>
      asset.finalArtworkJobId === finalArtworkJobId &&
      asset.productionRole === "production_png",
  );
  return productionAsset?.id ?? null;
}

/*
 * Sprint A2 Correction 3: the upload workflow's own asset resolver was folded
 * into `resolveCurrentMatchingProductionJob`, which now serves both workflows.
 *
 * Its reasoning survives intact and applies to Create New too: a customer who
 * changes their print size after a plate exists still has that older plate in
 * storage — immutable, correct for the size it was made at, and WRONG for the
 * size they now expect. Returning it would put "12 inches" in front of someone
 * holding a 10.5-inch file. Returning nothing surfaces honestly as "not ready
 * yet", which is what a new size genuinely means. Requested output behaves
 * exactly the same way, for exactly the same reason.
 */

function findJobForWidth(
  jobs: FinalArtworkJob[],
  productionWidthIn: number,
  requestedProductionOutput: StoredRequestedProductionOutput,
): FinalArtworkJob | null {
  return (
    jobs.find(
      (job) =>
        job.productionWidthIn !== null &&
        Math.abs(job.productionWidthIn - productionWidthIn) <
          PRODUCTION_WIDTH_EPSILON_IN &&
        // Sprint A2 Correction 2: size and requested output are independent
        // specifications, and both distinguish a deliverable. A 12in PNG is
        // not an 11in PNG, and neither of them is a set of separations.
        productionIntentMatches(job.requestedProductionOutput, requestedProductionOutput),
    ) ?? null
  );
}

/**
 * Sprint A2 Correction 2: the create_new equivalent of `findJobForWidth` —
 * which of an approval's jobs, if any, was created to satisfy the intent
 * being requested now. `null` means "no job here answers this request", and
 * the caller creates one.
 */
function findJobForIntent(
  jobs: FinalArtworkJob[],
  requestedProductionOutput: StoredRequestedProductionOutput,
): FinalArtworkJob | null {
  return (
    jobs.find((job) =>
      productionIntentMatches(job.requestedProductionOutput, requestedProductionOutput),
    ) ?? null
  );
}

/**
 * The upload workflow's idempotency resolution, mirroring
 * `createJobToleratingRace`'s reasoning exactly:
 *
 *   - an existing job for this (preparation, width) is REUSED, so a double
 *     click / reload / second tab never produces a second job — and therefore
 *     never a second paid reconstruction;
 *   - a `"failed"` job (an infrastructure problem — storage, decode,
 *     provider outage) is revived to `"queued"`, because the customer's retry
 *     path is the same button that got them here;
 *   - a `"completed"` job is returned as-is even when it landed on
 *     `finalization_required`: that is a real verdict about this artwork at
 *     this size, not a hiccup, and re-running it unchanged would recompute
 *     the same answer at the same cost.
 */
async function resolvePreparedUploadJob(
  repo: ProjectRepository,
  projectId: string,
  artworkPreparationId: string,
  artworkVersionId: string,
  productionWidthIn: number,
  requestedProductionOutput: StoredRequestedProductionOutput,
): Promise<{ job: FinalArtworkJob; alreadyRequested: boolean }> {
  const existingJobs = await repo.listFinalArtworkJobsForPreparation(
    projectId,
    artworkPreparationId,
  );
  const existing = findJobForWidth(
    existingJobs,
    productionWidthIn,
    requestedProductionOutput,
  );
  if (existing) {
    if (existing.status === "failed") {
      const revived = await repo.updateFinalArtworkJob(existing.id, {
        status: "queued",
        lastError: null,
      });
      return { job: revived, alreadyRequested: false };
    }
    // Sprint A2 Correction 2: a job fenced out as stale becomes live again
    // when the customer's request comes back to what it was built for. The
    // already-produced plate — and, for uploads, the paid reconstruction
    // behind it — is reused rather than repeated.
    if (existing.status === "cancelled") {
      const revived = await repo.updateFinalArtworkJob(existing.id, {
        status: "queued",
        lastError: null,
      });
      return { job: revived, alreadyRequested: false };
    }
    return { job: existing, alreadyRequested: true };
  }

  try {
    const job = await repo.createFinalArtworkJob(projectId, {
      sourceKind: "prepared_upload",
      artworkPreparationId,
      artworkVersionId,
      productionWidthIn,
      requestedProductionOutput,
    });
    return { job, alreadyRequested: false };
  } catch (error) {
    // A concurrent request won the insert between this call's own read and
    // write. The unique index is the source of truth; this is only the
    // retry-once fallback (same shape as `createApprovalToleratingRace`).
    if (error instanceof UniqueConstraintViolationError) {
      const raced = findJobForWidth(
        await repo.listFinalArtworkJobsForPreparation(projectId, artworkPreparationId),
        productionWidthIn,
        requestedProductionOutput,
      );
      if (raced) return { job: raced, alreadyRequested: true };
    }
    throw error;
  }
}

/**
 * Inserts a new active `FinalDirectionApproval`, tolerating the rare race
 * where a concurrent request already superseded-and-recreated one for the
 * same project between this call's own read and write (the repository's
 * unique-partial-index — or, for the local store, its own equivalent check
 * — is the actual source of truth; this is only the retry-once fallback).
 */
async function createApprovalToleratingRace(
  repo: ProjectRepository,
  projectId: string,
  artworkVersionId: string,
  designBriefVersionId: string,
): Promise<FinalDirectionApproval> {
  try {
    return await repo.createFinalDirectionApproval(projectId, {
      artworkVersionId,
      designBriefVersionId,
    });
  } catch (error) {
    if (error instanceof UniqueConstraintViolationError) {
      const raced = await repo.getActiveFinalDirectionApproval(projectId);
      if (raced && raced.artworkVersionId === artworkVersionId) return raced;
    }
    throw error;
  }
}

/**
 * Same race-tolerance as `createApprovalToleratingRace`, for the job's own
 * unique key.
 *
 * Sprint 2M Phase 2C (Goal 15/21): an already-existing job for this
 * approval that ended `"failed"` (an infrastructure problem —
 * storage/transformation failure, never a print-readiness verdict) is
 * revived back to `"queued"` rather than returned as a permanent dead end.
 * This is the customer's retry path: the same "Prepare Print-Ready
 * Artwork" action that got them here the first time. A `"completed"` job
 * (even one that landed on `finalization_required`) is returned as-is —
 * that is a real, honest verdict about *this* artwork, not an
 * infrastructure hiccup, and retrying it without anything having changed
 * would just recompute the same answer.
 */
async function createJobToleratingRace(
  repo: ProjectRepository,
  projectId: string,
  approval: FinalDirectionApproval,
  requestedProductionOutput: StoredRequestedProductionOutput,
): Promise<FinalArtworkJob> {
  // Sprint A2 Correction 2 (Goal 4): reuse is now keyed on the bound intent
  // as well as the approval. A job created to produce a PNG does not satisfy
  // a request for separations, and vice versa — previously the completed job
  // was returned for either, which is what let a retraction to PNG be
  // answered with "already done" by an unsupported job that produced nothing.
  const existing = findJobForIntent(
    await repo.listFinalArtworkJobsForApproval(projectId, approval.id),
    requestedProductionOutput,
  );
  if (existing) {
    if (existing.status === "failed") {
      return repo.updateFinalArtworkJob(existing.id, {
        status: "queued",
        lastError: null,
      });
    }
    // A previously superseded job for THIS intent becomes live again — this
    // is the PNG → unsupported → PNG path, where the customer's already
    // produced (and already paid for) plate is exactly what they now want
    // back. Re-queued rather than returned as-is so the worker re-runs the
    // authoritative validation and status transition it was fenced out of.
    if (existing.status === "cancelled") {
      return repo.updateFinalArtworkJob(existing.id, {
        status: "queued",
        lastError: null,
      });
    }
    return existing;
  }

  try {
    return await repo.createFinalArtworkJob(projectId, {
      sourceKind: "generated_concept",
      finalDirectionApprovalId: approval.id,
      artworkVersionId: approval.artworkVersionId,
      requestedProductionOutput,
    });
  } catch (error) {
    if (error instanceof UniqueConstraintViolationError) {
      const raced = findJobForIntent(
        await repo.listFinalArtworkJobsForApproval(projectId, approval.id),
        requestedProductionOutput,
      );
      if (raced) return raced;
    }
    throw error;
  }
}
