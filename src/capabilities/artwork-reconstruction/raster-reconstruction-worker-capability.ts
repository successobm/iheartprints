/**
 * Phase R5: independent worker for `ArtworkReconstructionJob` — mirrors
 * `FinalArtworkWorkerCapability`'s architecture (claim, run, persist,
 * never runs inside a customer API request's synchronous body EXCEPT via
 * the same scheduler `runBatch()` every other worker uses — see
 * `artwork-reconstruction-scheduler-capability.ts`).
 *
 * Claims a job, RE-VERIFIES confirmed authority is still current (never
 * trusts the frozen `contractKey` alone — recomputes and compares against
 * the CURRENT contract before ever calling the provider), performs the
 * GENERATIVE reconstruction, normalizes provider canvas to content bounds,
 * runs exact-wording verification, persists a candidate asset (append-only,
 * never overwriting the original upload), and marks the job `completed`
 * with `reviewStatus: "pending_review"` — never `"accepted"`, never Print
 * Ready, never a production asset.
 *
 * DUPLICATE-SPEND DISCIPLINE (an honest v1 limitation, not silently
 * pretended away — see `raster-reconstruction-provider.ts`'s own doc
 * comment): OpenAI's `/v1/images/edits` is one synchronous call with no
 * "resume/fetch a previous result by request id" endpoint, unlike Topaz's
 * async job store. This worker therefore:
 *   - relies on the SAME claim-CAS `FinalArtworkJob`/`PaidImageIntent` use
 *     to guarantee only one worker ever holds a given queued job at a time
 *     (no two workers can call the provider for the same job concurrently);
 *   - persists the candidate asset IMMEDIATELY after a successful provider
 *     response, before marking the job `completed`, so a crash in that
 *     narrow window is the only way a paid call could need re-spending on
 *     retry — the same "persist before continuing" discipline
 *     `final-artwork-worker-capability.ts` uses for its own Topaz
 *     intermediate-persistence step;
 *   - bounds retries with the SAME `MAX_FINAL_ARTWORK_ATTEMPTS`-style
 *     ceiling so a permanently failing job cannot retry (and therefore
 *     cannot re-spend) forever.
 */

import { createHash } from "node:crypto";

import type { AssetCapability } from "@/capabilities/assets";
import type { ProjectRepository } from "@/lib/db/repository";
import type { ArtworkReconstructionJob } from "@/lib/domain/types";
import { deriveArtworkFidelityContractKey } from "@/capabilities/artwork-fidelity";

import { deriveReconstructionInstruction } from "./raster-reconstruction-instruction";
import { normalizeReconstructionCanvas } from "./content-bounds-normalization";
import type { RasterReconstructionProvider } from "./raster-reconstruction-provider";
import { createArtworkFidelityVerificationCapability } from "@/capabilities/artwork-fidelity-verification";
import type { ArtworkFidelityProposalProvider } from "@/capabilities/artwork-fidelity-proposal";

export const DEFAULT_ARTWORK_RECONSTRUCTION_STALE_JOB_MS = 15 * 60 * 1000;

/** Mirrors `MAX_FINAL_ARTWORK_ATTEMPTS` — a bounded attempt ceiling so a permanently failing job (and therefore its provider spend) cannot retry forever. */
export const MAX_ARTWORK_RECONSTRUCTION_ATTEMPTS = 3;

export interface ArtworkReconstructionProcessResult {
  processedJobId: string | null;
}

export interface ArtworkReconstructionRecoverResult {
  recoveredCount: number;
}

export interface RasterReconstructionWorkerCapability {
  processNextJob(): Promise<ArtworkReconstructionProcessResult>;
  recoverAbandonedJobs(
    staleAfterMs?: number,
  ): Promise<ArtworkReconstructionRecoverResult>;
}

async function failJob(
  repo: ProjectRepository,
  job: ArtworkReconstructionJob,
  message: string,
): Promise<void> {
  await repo.updateArtworkReconstructionJob(job.id, {
    status: "failed",
    lastError: message,
    completedAt: new Date().toISOString(),
  });
}

export function createRasterReconstructionWorkerCapability(
  repo: ProjectRepository,
  assets: AssetCapability,
  provider: RasterReconstructionProvider,
  fidelityProposalProvider: ArtworkFidelityProposalProvider,
): RasterReconstructionWorkerCapability {
  const verification = createArtworkFidelityVerificationCapability(fidelityProposalProvider);

  async function runClaimedJob(job: ArtworkReconstructionJob): Promise<void> {
    if (job.attempts > MAX_ARTWORK_RECONSTRUCTION_ATTEMPTS) {
      await failJob(
        repo,
        job,
        `Exceeded maximum reconstruction attempts (${MAX_ARTWORK_RECONSTRUCTION_ATTEMPTS}).`,
      );
      return;
    }

    // RE-VERIFY confirmed authority is still current before ever calling
    // the provider — never trusts the job's own frozen `contractKey` alone
    // (Section 8 of the R4B audit: "the contract/key/version used for
    // reconstruction must be recorded so candidate staleness can be
    // determined later" — this is that determination, performed BEFORE
    // spend, not only after).
    //
    // TWO INDEPENDENT checks, because a confirmed contract is IMMUTABLE
    // (`ArtworkFidelityCapability.confirmContract`'s own doc comment) — its
    // own fields, and therefore its own recomputed key, can never drift
    // out from under it. Staleness instead means a NEWER correction
    // superseded it (a customer proposed-and-confirmed a fresh contract for
    // the same source, e.g. TM -> R). Recomputing THIS contract's own key
    // alone cannot detect that — it would still match, since this row
    // itself never changed. The SECOND check (is this still the CURRENT
    // contract for the project?) is what actually catches it.
    const contract = await repo.getArtworkFidelityContractById(job.fidelityContractId);
    if (!contract || contract.status !== "confirmed") {
      await failJob(repo, job, "The bound fidelity contract is no longer confirmed authority.");
      return;
    }
    const currentContract = await repo.getArtworkFidelityContract(job.projectId);
    if (!currentContract || currentContract.id !== contract.id) {
      await failJob(
        repo,
        job,
        "The confirmed fidelity contract has been corrected since this reconstruction was requested; request reconstruction again.",
      );
      return;
    }
    const recomputedKey = deriveArtworkFidelityContractKey({
      sourceAssetId: contract.sourceAssetId,
      sourceSha256: contract.sourceSha256,
      confirmedWording: contract.confirmedWording,
      confirmedMarks: contract.confirmedMarks,
      sourceContentBoundingBoxAspectRatio: contract.sourceContentBoundingBoxAspectRatio,
    });
    if (recomputedKey !== job.contractKey) {
      // Belt-and-suspenders: should be unreachable given the two checks
      // above, but never trust a stored key alone regardless.
      await failJob(
        repo,
        job,
        "This confirmed contract's authority could not be verified. Request reconstruction again.",
      );
      return;
    }

    const source = await assets.downloadAssetBytes(job.sourceAssetId);
    if (!source) {
      await failJob(repo, job, "The source artwork could not be read.");
      return;
    }
    // Section 11 of the R5 task: this capability does not own background-
    // removal routing — it only avoids INVENTING transparency a fully
    // opaque source never had, and avoids discarding transparency a source
    // already has. Read straight from the source's own `AssetRecord`
    // (never re-derived by guessing from bytes) — `null`/unknown degrades
    // to "no transparency to preserve" rather than requesting it blind.
    const sourceAssetRecord = await repo.getAssetById(job.sourceAssetId);
    const sourceHasTransparency = sourceAssetRecord?.hasTransparency === true;
    // The source must also still match the sha this job (and the contract)
    // were bound to — never reconstruct against bytes that changed
    // underneath a durable authority binding.
    const currentSha256 = createHash("sha256").update(source.bytes).digest("hex");
    if (currentSha256 !== job.sourceSha256) {
      await failJob(repo, job, "The source artwork has changed since this job was created.");
      return;
    }

    const instruction = deriveReconstructionInstruction(contract);

    let providerResult;
    try {
      providerResult = await provider.reconstruct({
        sourceBytes: source.bytes,
        sourceContentType: source.contentType,
        sourceHasTransparency,
        instruction,
      });
    } catch (error) {
      await repo.updateArtworkReconstructionJob(job.id, {
        status: job.attempts >= MAX_ARTWORK_RECONSTRUCTION_ATTEMPTS ? "failed" : "recoverable",
        lastError: error instanceof Error ? error.message : String(error),
        completedAt:
          job.attempts >= MAX_ARTWORK_RECONSTRUCTION_ATTEMPTS ? new Date().toISOString() : null,
      });
      return;
    }

    // Persist provider provenance IMMEDIATELY after a successful response,
    // before any further processing that could fail — see this module's
    // own "duplicate-spend discipline" doc comment.
    await repo.updateArtworkReconstructionJob(job.id, {
      providerKey: provider.providerKey,
      providerRequestId: providerResult.providerRequestId,
    });

    const normalized = normalizeReconstructionCanvas(
      providerResult.bytes,
      contract.sourceContentBoundingBoxAspectRatio,
    );

    const wordingVerification = await verification.verifyReconstructionWording(
      normalized.bytes,
      "image/png",
      contract.confirmedWording ?? [],
    );

    const uploaded = await assets.uploadConceptImage(job.projectId, {
      conceptId: job.id,
      bytes: normalized.bytes,
      contentType: "image/png",
      widthPx: normalized.widthPx,
      heightPx: normalized.heightPx,
      hasTransparency: null,
      providerKey: provider.providerKey,
      // Deliberately null: this asset is neither a `GenerationJob` concept
      // output nor a `FinalArtworkJob` production output — see this
      // capability's own doc comment on why it is a genuinely third,
      // narrower bucket, and why `AssetKind`/the concept-vs-production FK
      // convention already tolerates both being null (every
      // `customer_upload` asset already does).
      generationJobId: null,
      metadata: {
        reconstructionCandidate: true,
        reconstructionJobId: job.id,
        fidelityContractId: contract.id,
        contractKey: recomputedKey,
        sourceAssetId: job.sourceAssetId,
        sourceSha256: job.sourceSha256,
        providerRequestId: providerResult.providerRequestId,
        geometryStatus: normalized.geometryStatus,
        geometryNote: normalized.geometryNote,
        wordingVerified: wordingVerification.wordingVerified,
        // Advisory only — never automatic mark verification (Section "R"
        // of the R5 task: R2/R3 proved this is not reliable enough).
        advisoryMarks: wordingVerification.advisoryMarks,
      },
    });

    await repo.updateArtworkReconstructionJob(job.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
      candidateAssetId: uploaded.primary.id,
      wordingVerified: wordingVerification.wordingVerified,
      geometryStatus: normalized.geometryStatus,
      reviewStatus: "pending_review",
    });
  }

  return {
    async processNextJob() {
      const job = await repo.claimNextQueuedArtworkReconstructionJob();
      if (!job) return { processedJobId: null };
      await runClaimedJob(job);
      return { processedJobId: job.id };
    },

    async recoverAbandonedJobs(
      staleAfterMs: number = DEFAULT_ARTWORK_RECONSTRUCTION_STALE_JOB_MS,
    ) {
      const recovered = await repo.recoverAbandonedArtworkReconstructionJobs(staleAfterMs);
      return { recoveredCount: recovered.length };
    },
  };
}
