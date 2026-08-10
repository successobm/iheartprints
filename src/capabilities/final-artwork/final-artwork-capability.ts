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
import type { FinalArtworkJob, FinalDirectionApproval } from "@/lib/domain/types";
import { diffBriefSections } from "@/capabilities/shared/brief-diff";
import { isConceptRelevantChange } from "@/capabilities/shared/concept-relevance";

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
   */
  getCurrentProductionAssetId(projectId: string): Promise<string | null>;
}

export function createFinalArtworkCapability(
  repo: ProjectRepository,
): FinalArtworkCapability {
  return {
    async requestFinalArtwork(projectId, artworkVersionId) {
      const snapshot = await repo.getProject(projectId);
      if (!snapshot) throw new Error("Project not found");

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

      const job = await createJobToleratingRace(repo, projectId, approval);

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
      if (job.status === "queued" || job.status === "running" || job.status === "recoverable") {
        await repo.setProjectStatus(projectId, "finalizing");
      }

      return { approval, job, alreadyRequested };
    },

    async getCurrentProductionAssetId(projectId) {
      const activeApproval = await repo.getActiveFinalDirectionApproval(projectId);
      if (!activeApproval) return null;

      const job = await repo.getFinalArtworkJobByApprovalId(projectId, activeApproval.id);
      if (!job) return null;

      const assets = await repo.listAssets(projectId);
      const productionAsset = assets.find(
        (asset) =>
          asset.finalArtworkJobId === job.id &&
          asset.productionRole === "production_png",
      );
      return productionAsset?.id ?? null;
    },
  };
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
): Promise<FinalArtworkJob> {
  const existing = await repo.getFinalArtworkJobByApprovalId(projectId, approval.id);
  if (existing) {
    if (existing.status === "failed") {
      return repo.updateFinalArtworkJob(existing.id, {
        status: "queued",
        lastError: null,
      });
    }
    return existing;
  }

  try {
    return await repo.createFinalArtworkJob(projectId, {
      finalDirectionApprovalId: approval.id,
      artworkVersionId: approval.artworkVersionId,
    });
  } catch (error) {
    if (error instanceof UniqueConstraintViolationError) {
      const raced = await repo.getFinalArtworkJobByApprovalId(projectId, approval.id);
      if (raced) return raced;
    }
    throw error;
  }
}
