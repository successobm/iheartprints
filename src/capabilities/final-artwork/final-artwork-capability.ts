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
  AssetRecord,
  FinalArtworkJob,
  FinalDirectionApproval,
  SignPreparation,
  StoredRequestedProductionOutput,
  TShirtDesignBrief,
} from "@/lib/domain/types";
import { computeSignPlanKey } from "@/capabilities/sign-preparation";
import type { SignRepairPlan } from "@/capabilities/sign-preparation";
import {
  createAcquisitionCapability,
  type AcquisitionCapability,
} from "@/capabilities/acquisition";
import { diffBriefSections } from "@/capabilities/shared/brief-diff";
import { isConceptRelevantChange } from "@/capabilities/shared/concept-relevance";
import {
  PRODUCTION_SIZE_CONFIRMATION_REQUIRED_MESSAGE,
  resolveProductionSizeConfirmation,
  type ConfirmedProductionSize,
} from "@/capabilities/shared/confirmed-production-size";
import { resolveProductionWidth } from "@/capabilities/shared/print-placement-dimensions";
import {
  STANDARD_RASTER_TREATMENT_KEY,
  currentProductionTreatmentKey,
} from "@/capabilities/shared/production-treatment";
import { describeProductionVariantStatus } from "@/capabilities/shared/production-variant";
import { ArtworkFinalizationRasterNotReadyError } from "./raster-not-ready-error";
import {
  isReconstructionIntermediateAsset,
  productionAssetMatchesEffectiveTarget,
  resolveEffectiveProductionTargetIn,
  type EffectiveProductionTargetIn,
} from "./production-request-identity";

/**
 * Signs Phase S2: `requestSignFinalArtwork`'s result. There is no
 * `approval` field for the same reason `RequestPreparedUploadFinalArtworkResult`
 * has none — the `SignPreparation` itself (`status: "planned"`, a persisted,
 * canonically-keyed plan) IS the authority; inventing a second record for
 * the same decision would be exactly the duplicate-authority pattern both
 * prior workflows already rejected.
 */
export interface RequestSignFinalArtworkResult {
  preparation: SignPreparation;
  job: FinalArtworkJob;
  alreadyRequested: boolean;
}

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
   * Signs Phase S2: the operator's "execute this repair plan" action for a
   * rigid-sign preparation (Constitution §16A). A THIRD parallel
   * customer/operator-authority boundary, deliberately not routed through
   * either apparel path above:
   *
   *   - No acquisition/entitlement fence. Rigid signs are operator-only in
   *     V1 (Constitution §16A.1) with no commercial concept yet
   *     (`GRANTABLE_PRODUCTION_PROFILES` stays apparel-only) — gating on an
   *     apparel-shaped acquisition session would force sign work through
   *     semantics that do not apply to it.
   *   - No garment size, production treatment, or requested-output
   *     resolution. `SignPreparation` already carries its own confirmed
   *     ordered width AND height (§16A.2), and none of DTF halftone,
   *     apparel decoration-output vocabulary, or garment-box confirmation
   *     has any meaning for a sign.
   *
   * The authority is the preparation's own `status === "planned"` plan,
   * recomputed and verified here (never trusted from a stale read) — the
   * same "the row already records exactly this decision" reasoning the
   * upload workflow's `ArtworkPreparation.status === "approved"` uses.
   *
   * Idempotent on (sign preparation, plan key): a double click, a reload,
   * two tabs, or a retry all return the same job. A RE-PLAN (different
   * ordered size, different policy, different steps) is not a repeat
   * request — it produces its own job, never silently reusing evidence for
   * a plan that is no longer the one recorded.
   */
  requestSignFinalArtwork(
    projectId: string,
  ): Promise<RequestSignFinalArtworkResult>;
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
  /**
   * Print'em All Phase 2 — IS A PLATE BEING MADE RIGHT NOW?
   *
   * The only honest source for "production work is in flight", and the
   * replacement for reading `PrintProject.status === "finalizing"` as though
   * it meant that.
   *
   * `PrintProject.status` is a LIFECYCLE marker: `failJob` deliberately
   * leaves it at `"finalizing"` after a failure, because the lifecycle really
   * is still open and the customer's own action re-queues it. A JOB is what
   * says somebody is working. Conflating the two produced a live dead-end
   * where an operator whose Standard Raster attempt had failed was refused
   * every recovery action on the grounds that it was still running.
   *
   * Consulted by every guard that must not let an input change mid-bake —
   * print size, garment class, concept selection, production treatment — so
   * all four agree, and so a failed attempt can never lock any of them.
   */
  isFinalizationInFlight(projectId: string): Promise<boolean>;
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
  /**
   * Print'em All Phase 3 (V1 multi-variant package): the same job-resolution
   * logic `resolveCurrentMatchingProductionJob` uses, generalized to an
   * EXPLICIT treatment key instead of the project's current one — so a
   * caller can ask "what is the state of the halftone_dtf variant?" and "what
   * is the state of the standard_raster variant?" independently, regardless
   * of which one the operator currently has selected.
   *
   * Read-only, side-effect free. Never creates, revives, or mutates a job —
   * see `requestPreparedUploadFinalArtwork` for that. Physical width and
   * requested output are still read from the project's CURRENT authority
   * (Goal 14 — a plate made at a width the customer has since changed is
   * never presented as current for any treatment), so this answers "if the
   * operator switched to this treatment right now, what would they see?"
   * rather than "what did this treatment ever produce, at any size, ever."
   *
   * Returns a "nothing" shape (every field `null`) rather than `null` itself
   * — matching the historical no-project-found and no-job-yet cases
   * uniformly, so a caller building a package view never has to special-case
   * "resolution failed" versus "resolution found nothing".
   */
  resolveProductionVariantState(
    projectId: string,
    treatmentKey: string,
  ): Promise<ProductionVariantJobState>;
}

/**
 * See `FinalArtworkCapability.resolveProductionVariantState`.
 *
 * `asset` is populated for ANY completed job (not only a validated-`ready`
 * one) — a `needs_attention` variant still has a real production asset on
 * disk, and its measured pixel dimensions are exactly what a customer/
 * operator needs to understand why it fell short, not something only a
 * `print_ready` variant gets to report.
 */
export interface ProductionVariantJobState {
  job: FinalArtworkJob | null;
  asset: AssetRecord | null;
  validationStatus: string | null;
  validationReport: Record<string, unknown> | null;
  /**
   * Phase 28V: PASS 1's own paid request id, when this job's reconstruction
   * needed (and durably persisted) a second Topaz pass — `null` for every
   * job that never had one. Cost accounting (`describeProductionVariantCostSummary`)
   * uses this to report 2 distinct external provider calls for a genuine
   * two-pass job instead of 1, without inflating that count on a resumed
   * or idempotently-reused retry.
   */
  intermediateReconstructionProviderRequestId: string | null;
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

      // Print'em All Phase 1 (Goal 6) — THE PRODUCTION SIZE FENCE.
      // Read from the same persisted authority the upload path reads, for the
      // same reason: a recommendation is not spend authority, a default is not
      // spend authority, and only an explicit human confirmation is.
      const confirmedSize = requireConfirmedProductionSize(snapshot.brief);

      const job = await createJobToleratingRace(
        repo,
        projectId,
        approval,
        requestedProductionOutput,
        confirmedSize.widthIn,
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

      // Production size is read from the project's own persisted authority,
      // never from the request — a forged or stale finalize call cannot
      // smuggle a different physical size in (Goal 18).
      //
      // Print'em All Phase 1 (Goal 6): that authority is now the CONFIRMED
      // size, not `resolveProductionWidth`'s placement default. This is the exact
      // line the live Topaz credit was spent through: the old call read
      // `intendedPrintWidthIn = null`, fell back to the 10.5in placement
      // default, and enqueued a paid job for a physical size no human had
      // ever chosen or seen.
      const confirmedProductionSize = requireConfirmedProductionSize(snapshot.brief);
      const productionWidthIn = confirmedProductionSize.widthIn;
      // Phase 28T: the SAME canonical sizing authority Phase 28S
      // established — never a second calculation invented for job lookup
      // (Section 5 of the Phase 28T mission). `printPlacement` is
      // guaranteed non-null here: `requireConfirmedProductionSize` above
      // already throws if it is not.
      const effectiveTargetIn = resolveEffectiveProductionTargetIn(
        snapshot.brief.printPlacement!,
        confirmedProductionSize,
        preparation,
      );

      // Sprint A2 Correction 2 (Goal 3 / Goal 11): server-side current
      // authority, never anything the caller carried — see the create_new
      // path's identical reasoning.
      // Print'em All Phase 2: the treatment this job is FOR, resolved from
      // the project's own durable authority and frozen onto the job — never
      // read from the request, and never re-read while the job runs. An
      // operator who moves a screen control after enqueueing gets a new job
      // for the new settings; the queued one is superseded rather than
      // silently re-aimed at a plate nobody authorized.
      const productionTreatmentKey = currentProductionTreatmentKey(
        snapshot.brief,
      );

      // Phase 28I Section 9/10 — THE RASTER-FIRST HARD GATE, enforced HERE,
      // not in the UI. "Halftone must not be created until Standard Raster
      // is genuinely print_ready" is a production-integrity rule, and a
      // button being hidden is not integrity: a direct
      // `POST /production-treatment` + `POST /artwork-preparation`
      // sequence reaches this exact function, with or without the button
      // ever rendering. Checked against the SAME confirmed width and the
      // SAME approved preparation this job itself is about to target
      // (`resolveProductionVariantState` reads the project's own current
      // confirmed size), so a Halftone request can never race ahead of, or
      // disagree with, what Standard Raster's own card is showing.
      //
      // Scoped to NEW job creation only — an existing, already-completed
      // Halftone job from before this gate existed (Phase 28H's real
      // Chili & Salsa order) is untouched: nothing here mutates, hides, or
      // re-validates a prior result, and every READ path
      // (`resolveProductionVariantState`, the download route,
      // `resolveOneProductionVariant`) is completely unaffected by this
      // check, which only ever runs on the way IN to creating a job.
      if (productionTreatmentKey !== STANDARD_RASTER_TREATMENT_KEY) {
        const rasterState = await this.resolveProductionVariantState(
          projectId,
          STANDARD_RASTER_TREATMENT_KEY,
        );
        const rasterStatus = describeProductionVariantStatus(
          rasterState.job?.status ?? null,
          rasterState.validationStatus,
        );
        if (rasterStatus !== "print_ready") {
          throw new ArtworkFinalizationRasterNotReadyError(rasterStatus);
        }
      }

      const { job, alreadyRequested } = await resolvePreparedUploadJob(
        repo,
        projectId,
        preparation.id,
        artwork.id,
        productionWidthIn,
        normalizeProductionIntent(snapshot.brief.requestedProductionOutput),
        productionTreatmentKey,
        effectiveTargetIn,
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

    async requestSignFinalArtwork(projectId) {
      const snapshot = await repo.getProject(projectId);
      if (!snapshot) throw new Error("Project not found");

      const preparation = await repo.getSignPreparation(projectId);
      if (!preparation || preparation.projectId !== projectId) {
        throw new Error(
          "This project has no rigid-sign artwork prepared for production",
        );
      }
      if (
        preparation.status !== "planned" ||
        !preparation.plan ||
        !preparation.planKey
      ) {
        throw new Error(
          "A repair plan must be formulated before production can be requested",
        );
      }

      // Plan-replay discipline: never trust a stored key without
      // recomputing it. This is the belt; `FinalArtworkWorkerCapability`
      // re-verifies again (the suspenders) immediately before executing —
      // the two checks intentionally overlap rather than trusting either
      // alone.
      const plan = preparation.plan as unknown as SignRepairPlan;
      const recomputedKey = computeSignPlanKey(plan);
      if (recomputedKey !== preparation.planKey || recomputedKey !== plan.planKey) {
        throw new Error(
          "The recorded repair plan could not be verified. Please re-plan this artwork.",
        );
      }

      const { job, alreadyRequested } = await resolveSignJob(
        repo,
        projectId,
        preparation.id,
        preparation.planKey,
      );

      if (
        job.status === "queued" ||
        job.status === "running" ||
        job.status === "recoverable"
      ) {
        await repo.setProjectStatus(projectId, "finalizing");
      }

      return { preparation, job, alreadyRequested };
    },

    async isFinalizationInFlight(projectId) {
      const active = await repo.listActiveFinalArtworkJobs(projectId);
      return active.length > 0;
    },

    async getCurrentProductionAssetId(projectId) {
      const satisfied = await resolveSatisfiedProductionDelivery(repo, projectId);
      return satisfied?.assetId ?? null;
    },

    async resolveCurrentProductionDelivery(projectId) {
      return resolveSatisfiedProductionDelivery(repo, projectId);
    },

    async resolveProductionVariantState(projectId, treatmentKey) {
      const nothing: ProductionVariantJobState = {
        job: null,
        asset: null,
        validationStatus: null,
        validationReport: null,
        intermediateReconstructionProviderRequestId: null,
      };

      const snapshot = await repo.getProject(projectId);
      if (!snapshot) return nothing;

      const currentIntent = normalizeProductionIntent(
        snapshot.brief.requestedProductionOutput,
      );

      // Same width resolution as `resolveCurrentMatchingProductionJob` —
      // deliberately NOT `requireConfirmedProductionSize` (Goal 21: this
      // answers "what would show for this treatment", never "may we spend
      // money", so an unconfirmed project still gets an honest answer rather
      // than an exception).
      const confirmation = resolveProductionSizeConfirmation(snapshot.brief);
      const currentWidthIn = confirmation.confirmed
        ? confirmation.size.widthIn
        : (resolveProductionWidth(
            snapshot.brief.printPlacement,
            snapshot.brief.intendedPrintWidthIn,
          )?.widthIn ?? null);
      if (currentWidthIn === null) return nothing;

      let job: FinalArtworkJob | null = null;
      // Phase 28T: the artwork's EFFECTIVE resolved size for THIS request —
      // `null` for the create_new/active-approval branch (that workflow's
      // own artwork-bounds source is a separate, out-of-scope concern this
      // phase; see the Phase 28T report) and for any prepared_upload
      // project whose bounds cannot be read, in which case
      // `completedJobIsStaleForTarget` correctly abstains.
      let effectiveTargetIn: EffectiveProductionTargetIn | null = null;
      const activeApproval = await repo.getActiveFinalDirectionApproval(projectId);
      if (activeApproval) {
        job = findDeliverableJob(
          await repo.listFinalArtworkJobsForApproval(projectId, activeApproval.id),
          currentWidthIn,
          currentIntent,
          treatmentKey,
          activeApproval.artworkVersionId,
        );
      } else {
        const preparation = await repo.getArtworkPreparation(projectId);
        if (
          preparation &&
          preparation.status === "approved" &&
          preparation.preparedArtworkVersionId
        ) {
          job = findDeliverableJob(
            await repo.listFinalArtworkJobsForPreparation(projectId, preparation.id),
            currentWidthIn,
            currentIntent,
            treatmentKey,
            preparation.preparedArtworkVersionId,
          );
          if (confirmation.confirmed && snapshot.brief.printPlacement) {
            effectiveTargetIn = resolveEffectiveProductionTargetIn(
              snapshot.brief.printPlacement,
              confirmation.size,
              preparation,
            );
          }
        }
      }
      if (!job) return nothing;
      const intermediateReconstructionProviderRequestId =
        await findIntermediateReconstructionProviderRequestId(repo, projectId, job.id);
      if (job.status !== "completed") {
        return {
          job,
          asset: null,
          validationStatus: null,
          validationReport: null,
          intermediateReconstructionProviderRequestId,
        };
      }

      // Phase 28T: a completed job whose OWN produced pixels no longer
      // answer the current effective request (Section 15 — "no stale print
      // ready") is not this project's current deliverable, even though its
      // coarse (width/output/treatment/version) identity still matches.
      // `resolvePreparedUploadJob` is what actually revives such a job when
      // "Create Print-Ready Artwork" is next pressed; this read path simply
      // must not present it as current in the meantime.
      if (await completedJobIsStaleForTarget(repo, projectId, job.id, effectiveTargetIn)) {
        return nothing;
      }

      const assetId = await findProductionAssetIdForJob(repo, projectId, job.id, effectiveTargetIn);
      const asset = assetId ? await repo.getAssetById(assetId) : null;
      const validation = await repo.getLatestProductionAssetValidationForJob(
        projectId,
        job.id,
      );
      return {
        job,
        asset: asset ?? null,
        validationStatus: validation?.status ?? null,
        validationReport: validation?.report ?? null,
        intermediateReconstructionProviderRequestId,
      };
    },
  };
}

/**
 * Phase 28V — PASS 1's own paid request id, when a two-pass reconstruction
 * durably persisted one for this job (see `production-request-identity.ts`'s
 * `isReconstructionIntermediateAsset`). `null` for every job that never
 * needed a second pass. Read-only; never used to select "the" deliverable
 * for a job (that remains `findProductionAssetIdForJob`, which explicitly
 * excludes this same asset).
 */
async function findIntermediateReconstructionProviderRequestId(
  repo: ProjectRepository,
  projectId: string,
  finalArtworkJobId: string,
): Promise<string | null> {
  const assets = await repo.listAssets(projectId);
  const candidate = assets.find(
    (asset) =>
      asset.finalArtworkJobId === finalArtworkJobId &&
      asset.productionRole === "production_png" &&
      isReconstructionIntermediateAsset(asset),
  );
  if (!candidate) return null;
  const meta = candidate.metadata as Record<string, unknown> | null | undefined;
  return typeof meta?.providerRequestId === "string" ? meta.providerRequestId : null;
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

  // Phase 28T: no effective-size verification for the create_new path yet
  // (its artwork-bounds source is a separate, out-of-scope concern this
  // phase — see the Phase 28T report) — `null` preserves exactly this
  // function's pre-Phase-28T behavior (the job's own single/first asset).
  const assetId = await findProductionAssetIdForJob(repo, projectId, job.id, null);
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
  const snapshot = await repo.getProject(projectId);
  if (!snapshot) return null;

  // Print'em All Phase 1: the width a DELIVERY is matched against.
  //
  // Deliberately NOT `requireConfirmedProductionSize`. This function answers
  // "which finished file is the current one?", never "may we spend money?",
  // and the two need opposite failure modes. Refusing to resolve a delivery
  // for want of a confirmation would take an already-produced, already-paid-
  // for plate away from every project that predates confirmation — exactly
  // the retroactive invalidation of production files Goal 21 forbids.
  //
  // So: the confirmed size when there is one, the previously-resolved width
  // otherwise, which is byte-for-byte the behavior every historical project
  // already had.
  const confirmation = resolveProductionSizeConfirmation(snapshot.brief);
  const currentWidthIn = confirmation.confirmed
    ? confirmation.size.widthIn
    : (resolveProductionWidth(
        snapshot.brief.printPlacement,
        snapshot.brief.intendedPrintWidthIn,
      )?.widthIn ?? null);
  if (currentWidthIn === null) return null;

  // Print'em All Phase 2: the treatment a DELIVERY is matched against.
  //
  // Deliberately the resolved CURRENT treatment, with the same fail-toward-
  // standard-raster reading `resolveProductionTreatment` applies everywhere
  // else. A project whose halftone settings became unreadable is a project
  // whose current representation is standard raster, and the plate it should
  // be handed is the standard-raster one — not nothing, and not a screened
  // file whose settings can no longer be explained.
  const currentTreatmentKey = currentProductionTreatmentKey(snapshot.brief);

  const activeApproval = await repo.getActiveFinalDirectionApproval(projectId);
  if (activeApproval) {
    return findDeliverableJob(
      await repo.listFinalArtworkJobsForApproval(projectId, activeApproval.id),
      currentWidthIn,
      currentIntent,
      currentTreatmentKey,
      activeApproval.artworkVersionId,
    );
  }

  const preparation = await repo.getArtworkPreparation(projectId);
  if (!preparation || preparation.status !== "approved" || !preparation.preparedArtworkVersionId) {
    return null;
  }

  return findDeliverableJob(
    await repo.listFinalArtworkJobsForPreparation(projectId, preparation.id),
    currentWidthIn,
    currentIntent,
    currentTreatmentKey,
    preparation.preparedArtworkVersionId,
  );
}

/**
 * Phase 28T: the complete production request identity's pure arithmetic
 * (`resolveEffectiveProductionTargetIn`, `productionAssetMatchesEffectiveTarget`,
 * imported below) now lives in `./production-request-identity.ts` — shared
 * verbatim with `final-artwork-worker-capability.ts`'s own crash-recovery
 * short-circuit, which needed the exact same check (see that module's own
 * doc comment for why: `resolveExistingProductionAsset`'s "an asset already
 * exists for this job" idempotency guard predates Phase 28T and does not by
 * itself know whether that asset still answers the CURRENT request). See
 * `production-request-identity.ts`'s doc comment for the full rationale.
 */

/**
 * Phase 28T: whether a COMPLETED job's own production output is STALE for
 * the current effective request — the check `alreadyRequested`/deliverable
 * resolution both need before trusting a completed job's coarse
 * (width/output/treatment/version) match.
 *
 * Two DISTINCT reasons a completed job can have no asset matching the
 * current target, and only one of them means "stale":
 *
 *   - it produced a real `production_png` asset, but that asset's actual
 *     dimensions no longer answer today's effective size (Phase 28S changed
 *     what a confirmed box resolves to, or a future size picker did) — THIS
 *     is stale, and the caller should revive the job.
 *   - it produced NO asset at all, because completion itself was an HONEST,
 *     TERMINAL, non-retryable verdict that no plate could be produced at
 *     all (e.g. `insufficient_reconstruction`/`invalid_request` — Phase 27M/
 *     28N's own "needs_review, zero provider dispatch" case). This is NOT
 *     stale — re-deriving the SAME effective target against the SAME
 *     artwork would reach the exact same honest verdict, and revives here
 *     would spuriously re-run (and potentially re-dispatch) a job whose
 *     answer cannot change.
 *
 * `targetIn === null` means the effective size could not be verified (see
 * `resolveEffectiveProductionTargetIn`), in which case this also reports
 * "not stale" rather than second-guessing a coarse match with no evidence —
 * exactly as `jobIntentIsCurrent`'s own legacy-width abstention already
 * does.
 */
async function completedJobIsStaleForTarget(
  repo: ProjectRepository,
  projectId: string,
  jobId: string,
  targetIn: EffectiveProductionTargetIn | null,
): Promise<boolean> {
  if (!targetIn) return false;
  const assets = await repo.listAssets(projectId);
  const productionAssets = assets.filter(
    (asset) =>
      asset.finalArtworkJobId === jobId &&
      asset.productionRole === "production_png" &&
      // Phase 28V: a two-pass reconstruction's PASS 1 output is an
      // internal reconstruction-stage artifact, never proof this job
      // produced a (stale or current) customer deliverable.
      !isReconstructionIntermediateAsset(asset),
  );
  if (productionAssets.length === 0) return false;
  return !productionAssets.some((asset) => productionAssetMatchesEffectiveTarget(asset, targetIn));
}

/**
 * Print'em All Phase 1: which job's output may be presented as this project's
 * current deliverable.
 *
 * A job bound to the current width wins outright — the width match is as
 * load-bearing as the intent match, because a plate produced at 10.5in is the
 * wrong deliverable for someone who has since confirmed 12in.
 *
 * A job with NO bound width is a legacy create_new job, enqueued before
 * production width joined job identity. Its plate is real, was validated, and
 * is very possibly the only file the customer has; `null` there means "we did
 * not record what size this was made for", which is not the same as "it is
 * the wrong size". It stays deliverable, and is superseded the moment a job
 * bound to a real width exists for the same intent — which is why the exact
 * match is tried first rather than merged into one predicate.
 *
 * Print'em All Phase 2 extends the exact match to the production TREATMENT,
 * and deliberately does NOT extend the legacy fallback to it. A legacy row's
 * `null` treatment key genuinely means standard raster (there was no other
 * option when it was written), so it is already correctly matched by
 * `findJobForWidth`'s coalesce whenever the project's current treatment is
 * standard raster — and a project that has since moved to a halftone must not
 * be handed a continuous-tone plate as its current deliverable.
 */
function findDeliverableJob(
  jobs: FinalArtworkJob[],
  currentWidthIn: number,
  requestedProductionOutput: StoredRequestedProductionOutput,
  productionTreatmentKey: string,
  artworkVersionId: string,
): FinalArtworkJob | null {
  const boundToCurrentWidth = findJobForWidth(
    jobs,
    currentWidthIn,
    requestedProductionOutput,
    productionTreatmentKey,
    artworkVersionId,
  );
  if (boundToCurrentWidth) return boundToCurrentWidth;

  return (
    jobs.find(
      (job) =>
        job.productionWidthIn === null &&
        // Phase 28T: `artwork_version_id` has been `not null` on every job
        // since the very first `final_artwork_jobs` migration — even a
        // width-less legacy row always names a real artwork. A legacy plate
        // for a DIFFERENT artwork than the one currently approved/selected
        // is not this project's current deliverable either.
        job.artworkVersionId === artworkVersionId &&
        (job.productionTreatmentKey ?? STANDARD_RASTER_TREATMENT_KEY) ===
          productionTreatmentKey &&
        productionIntentMatches(
          job.requestedProductionOutput,
          requestedProductionOutput,
        ),
    ) ?? null
  );
}

/**
 * Phase 28T: a single job may now legitimately own MORE than one
 * `production_png` asset over its life — e.g. a job revived (see
 * `resolvePreparedUploadJob`) because its size stopped matching the current
 * effective request produces a NEW additive asset alongside the historical
 * one, exactly as Phase 28S's real car-show acceptance did by hand
 * (`32b504f9-...` at 2088x3150, `180d9606-...` at 2785x4200, same job).
 * `targetIn` (when resolvable) picks the one that actually answers TODAY's
 * request; `null`/no match falls back to the most recently created
 * candidate, which is both the pre-Phase-28T behavior for the common
 * single-asset case and the least-surprising answer when the target cannot
 * be verified at all.
 */
async function findProductionAssetIdForJob(
  repo: ProjectRepository,
  projectId: string,
  finalArtworkJobId: string,
  targetIn: EffectiveProductionTargetIn | null,
): Promise<string | null> {
  const assets = await repo.listAssets(projectId);
  const candidates = assets.filter(
    (asset) =>
      asset.finalArtworkJobId === finalArtworkJobId &&
      asset.productionRole === "production_png" &&
      // Phase 28V: never present a two-pass reconstruction's internal
      // PASS 1 artifact as this job's customer-facing deliverable.
      !isReconstructionIntermediateAsset(asset),
  );
  if (candidates.length === 0) return null;

  if (targetIn) {
    const matching = candidates.find((asset) => productionAssetMatchesEffectiveTarget(asset, targetIn));
    if (matching) return matching.id;
  }

  return candidates.reduce((newest, asset) =>
    asset.createdAt > newest.createdAt ? asset : newest,
  ).id;
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
  productionTreatmentKey: string,
  artworkVersionId: string,
): FinalArtworkJob | null {
  // Print'em All Phase 1: serves BOTH workflows now. A create_new job is
  // bound to its confirmed width exactly as a prepared_upload job always was.
  return (
    jobs.find(
      (job) =>
        job.productionWidthIn !== null &&
        Math.abs(job.productionWidthIn - productionWidthIn) <
          PRODUCTION_WIDTH_EPSILON_IN &&
        // Sprint A2 Correction 2: size and requested output are independent
        // specifications, and both distinguish a deliverable. A 12in PNG is
        // not an 11in PNG, and neither of them is a set of separations.
        productionIntentMatches(job.requestedProductionOutput, requestedProductionOutput) &&
        // Print'em All Phase 2: production TREATMENT is a third independent
        // specification, and it distinguishes a deliverable exactly as the
        // other two do. A 35 LPI screen is not a 45 LPI screen, and neither of
        // them is a continuous-tone plate. Legacy rows collapse to the
        // standard-raster key, matching the migration's coalesce.
        (job.productionTreatmentKey ?? STANDARD_RASTER_TREATMENT_KEY) ===
          productionTreatmentKey &&
        // Phase 28T: the fourth independent specification — WHICH approved
        // pixels this job is for. A 10x12 result from Artwork A is not a
        // 10x12 result from Artwork B just because the physical size and
        // treatment happen to match (Section 8 of the Phase 28T mission).
        // `artwork_version_id` is `not null` on every job ever written, so
        // this is never a legacy-abstention case the way width is.
        job.artworkVersionId === artworkVersionId,
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
 *   - a `"completed"` job is returned as-is when it is genuinely settled:
 *     re-running it unchanged would recompute the same answer at the same
 *     cost.
 *
 * "Restore Completed Print-Ready Download Flow" revises the LAST bullet's
 * premise for exactly one case: a completed job's own PRODUCTION PNG can be
 * genuinely unchanged while the VALIDATION POLICY governing it legitimately
 * changes (e.g. DTF Feature Integrity's explicitly provisional/uncalibrated
 * thresholds moving from blocking to diagnostic-only, per
 * `dtf-feature-integrity-profile.ts`'s own calibration-authority gate) — in
 * that case "recompute the same answer" is no longer a safe assumption, and
 * a customer whose artwork was correctly produced has no other path back to
 * `print_ready`. A completed job whose LATEST validation is not `"ready"` is
 * therefore ALSO revived to `"queued"`, exactly like the `"failed"` case
 * above — never a Topaz/provider call: `resolveExistingProductionAsset`
 * (the FIRST thing `produceProductionAsset` checks, unconditionally, before
 * any provider/attempt-budget logic runs at all) finds the SAME still-
 * matching production asset and short-circuits straight to re-running
 * PrintValidation against it. If the underlying issue is still genuinely
 * blocking (missing transparency, wrong geometry, etc.), revalidation
 * deterministically reproduces the SAME `finalization_required` verdict —
 * this is safe to attempt unconditionally, not merely when a policy change
 * is suspected. A job that IS still stale for the current target (the
 * pre-existing `isStale` branch) is unaffected by this addition.
 */
/**
 * Signs Phase S2: idempotent enqueue/reuse, keyed on (project, sign
 * preparation, plan key) — the sign workflow's own idempotency key, which
 * already encodes both ordered dimensions, the policy, and every step (see
 * the S2 authority migration's own doc). Deliberately simpler than
 * `resolvePreparedUploadJob`: no two-pass-reconstruction bookkeeping, no
 * effective-target staleness recheck — S2 makes zero provider calls, so
 * none of that apparatus has anything to apply to yet.
 *
 * A `"cancelled"` job matching the CURRENT plan key is returned as-is
 * rather than revived — a deliberately narrower simplification than the
 * apparel paths' cancelled-job revival, reasonable because reaching that
 * state requires the operator's own preparation to have been superseded
 * and then reverted back to byte-identical terms, a genuinely rare
 * operator-only edge case; an operator can always trigger a fresh plan.
 */
async function resolveSignJob(
  repo: ProjectRepository,
  projectId: string,
  signPreparationId: string,
  signPlanKey: string,
): Promise<{ job: FinalArtworkJob; alreadyRequested: boolean }> {
  const existingJobs = await repo.listFinalArtworkJobsForSignPreparation(
    projectId,
    signPreparationId,
  );
  const existing = existingJobs.find((job) => job.signPlanKey === signPlanKey);
  if (existing) {
    if (existing.status === "failed") {
      const revived = await repo.updateFinalArtworkJob(existing.id, {
        status: "queued",
        lastError: null,
        attempts: 0,
        startedAt: null,
        completedAt: null,
        heartbeatAt: null,
      });
      return { job: revived, alreadyRequested: true };
    }
    return { job: existing, alreadyRequested: true };
  }

  try {
    const job = await repo.createFinalArtworkJob(projectId, {
      sourceKind: "sign_preparation",
      signPreparationId,
      signPlanKey,
      // No `ArtworkVersion` exists for a sign job — see
      // `FinalArtworkJob.artworkVersionId`'s domain doc.
      artworkVersionId: signPreparationId,
    });
    return { job, alreadyRequested: false };
  } catch (error) {
    if (error instanceof UniqueConstraintViolationError) {
      // Lost a race to a concurrent request for the exact same plan — the
      // winning row now exists.
      const jobs = await repo.listFinalArtworkJobsForSignPreparation(
        projectId,
        signPreparationId,
      );
      const won = jobs.find((job) => job.signPlanKey === signPlanKey);
      if (won) return { job: won, alreadyRequested: true };
    }
    throw error;
  }
}

async function resolvePreparedUploadJob(
  repo: ProjectRepository,
  projectId: string,
  artworkPreparationId: string,
  artworkVersionId: string,
  productionWidthIn: number,
  requestedProductionOutput: StoredRequestedProductionOutput,
  productionTreatmentKey: string,
  /**
   * Phase 28T: the artwork's CURRENT effective resolved size — `null` when
   * it cannot be verified (see `resolveEffectiveProductionTargetIn`), in
   * which case a completed job's coarse match is trusted exactly as before
   * this phase.
   */
  effectiveTargetIn: EffectiveProductionTargetIn | null,
): Promise<{ job: FinalArtworkJob; alreadyRequested: boolean }> {
  const existingJobs = await repo.listFinalArtworkJobsForPreparation(
    projectId,
    artworkPreparationId,
  );
  const existing = findJobForWidth(
    existingJobs,
    productionWidthIn,
    requestedProductionOutput,
    productionTreatmentKey,
    artworkVersionId,
  );
  if (existing) {
    // Phase 28T: a completed job whose coarse identity (width/output/
    // treatment/version) still matches, but whose OWN produced pixels no
    // longer answer the CURRENT effective size (Phase 28S changed what this
    // confirmed box resolves to, or a future size picker did) — the two DB-
    // level unique indexes on `final_artwork_jobs` key on exactly this
    // coarse identity, so this job's row is the only one that could EVER
    // represent this (project, preparation, width, output, treatment)
    // combination; a genuinely new row is not possible without a schema
    // change (see the Phase 28T report's migration discussion). Reviving it
    // — precedented below for `failed`/`cancelled` — is the correct action:
    // `providerKey`/`providerRequestId` are untouched by revival, so the
    // worker RESUMES the existing paid reconstruction (if one is still
    // sufficient) rather than submitting a new one, and produces an
    // ADDITIVE new production asset (never overwriting the historical one)
    // at the corrected size — exactly what Phase 28S's real car-show
    // acceptance did by hand.
    if (existing.status === "completed") {
      const isStale = await completedJobIsStaleForTarget(
        repo,
        projectId,
        existing.id,
        effectiveTargetIn,
      );
      // "Restore Completed Print-Ready Download Flow": narrowly scoped to
      // a job that WAS actually validated and did not come back "ready" —
      // a job whose validation row is missing entirely (e.g. the legacy
      // pre-print-ready-normalization path) is a different, out-of-scope
      // situation and is left exactly as before (returned as-is below).
      const latestValidation = isStale
        ? null // already reviving below; no need to also check this.
        : await repo.getLatestProductionAssetValidationForJob(projectId, existing.id);
      const revalidationWorthwhile = latestValidation !== null && latestValidation.status !== "ready";
      if (isStale || revalidationWorthwhile) {
        const revived = await repo.updateFinalArtworkJob(existing.id, {
          status: "queued",
          lastError: null,
        });
        return { job: revived, alreadyRequested: false };
      }
    }
    if (existing.status === "failed" || existing.status === "cancelled") {
      // Sprint A2 Correction 2 (failed) / same reasoning (cancelled): a job
      // fenced out as stale becomes live again when the customer's request
      // comes back to what it was built for. The already-produced plate —
      // and, for uploads, the paid reconstruction behind it — is reused
      // rather than repeated.
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
      productionTreatmentKey,
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
        productionTreatmentKey,
        artworkVersionId,
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
  productionWidthIn: number,
): Promise<FinalArtworkJob> {
  // Sprint A2 Correction 2 (Goal 4): reuse is now keyed on the bound intent
  // as well as the approval. A job created to produce a PNG does not satisfy
  // a request for separations, and vice versa — previously the completed job
  // was returned for either, which is what let a retraction to PNG be
  // answered with "already done" by an unsupported job that produced nothing.
  // Print'em All Phase 1 (Goal 13): reuse is keyed on the confirmed WIDTH as
  // well as the bound intent. A job created for a 10.5in plate does not
  // satisfy a request for a 12in one — returning it would hand back a
  // finished (and possibly already paid for) file whose stated size is wrong.
  const existing = findJobForWidth(
    await repo.listFinalArtworkJobsForApproval(projectId, approval.id),
    productionWidthIn,
    requestedProductionOutput,
    // See the insert below: the Create New workflow is standard raster,
    // always, so reuse is keyed on the same constant it writes.
    STANDARD_RASTER_TREATMENT_KEY,
    // Phase 28T: this approval's own bound artwork — a job for a DIFFERENT
    // artwork version must never be reused merely because the size matches.
    approval.artworkVersionId,
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
      productionWidthIn,
      // Print'em All Phase 2: the Create New workflow is STANDARD RASTER,
      // always, and this is not a placeholder for a later wiring.
      //
      // The halftone treatment's input contract is an APPROVED, background-
      // prepared transparent source (Goals 5, 15, 26) — an immutable asset a
      // human looked at and approved, which the Create New path does not
      // produce. Writing the project's treatment key here instead would let an
      // operator select a screen on a generated-concept project and get a job
      // recorded as halftone that the worker then produces as continuous tone:
      // a plate whose own record disagrees with what it is. The treatment
      // endpoint refuses that selection at the source (eligibility's
      // `no_prepared_source`); this is the same refusal, made structural.
      productionTreatmentKey: STANDARD_RASTER_TREATMENT_KEY,
    });
  } catch (error) {
    if (error instanceof UniqueConstraintViolationError) {
      const raced = findJobForWidth(
        await repo.listFinalArtworkJobsForApproval(projectId, approval.id),
        productionWidthIn,
        requestedProductionOutput,
        STANDARD_RASTER_TREATMENT_KEY,
        approval.artworkVersionId,
      );
      if (raced) return raced;
    }
    throw error;
  }
}

/**
 * Print'em All Phase 1 (Goal 6) — the ONE place either workflow turns a
 * project into permission to enqueue production work.
 *
 * Throws rather than returning `null`, deliberately. Both call sites sit
 * immediately before a job is created, and a job is the thing that later
 * spends a Topaz credit; a nullable return invites a
 * `?? placementDefaultWidth` somewhere downstream, which is exactly how the
 * live credit was spent in the first place.
 *
 * The message is the plain operator/customer-facing one, because this is not
 * an error condition: nothing went wrong, a decision simply has not been made
 * yet, and the remedy is one click on a surface they are already looking at.
 */
function requireConfirmedProductionSize(
  brief: Pick<
    TShirtDesignBrief,
    | "printPlacement"
    | "productionSizeConfirmedAt"
    | "productionSizeConfirmedWidthIn"
    | "productionSizeConfirmedMaxHeightIn"
  >,
): ConfirmedProductionSize {
  const confirmation = resolveProductionSizeConfirmation(brief);
  if (!confirmation.confirmed) {
    throw new Error(
      confirmation.reason === "placement_unknown"
        ? "I need to know where this prints before I can prepare your print-ready artwork"
        : PRODUCTION_SIZE_CONFIRMATION_REQUIRED_MESSAGE,
    );
  }
  return confirmation.size;
}
