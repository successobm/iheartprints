/**
 * Signs QR Visual Revision Acceptance: "Approve revised artwork" — the ONE
 * governed action that persists a human's explicit visual acceptance of
 * the exact, current production candidate whose visible artwork a QR
 * replacement materially changed. See `SignCandidateVisualAcceptance`'s
 * own doc comment (`lib/domain/types.ts`) for the full four-authority
 * model this closes, and `isSignCandidateReadyForDelivery`
 * (`final-artwork-capability.ts`) for how this evidence is consumed by
 * Print Ready/delivery authority.
 *
 * IDENTITY, NEVER CLIENT INPUT: takes only `projectId`. The candidate
 * being approved is resolved entirely server-side, through the SAME
 * authoritative resolver (`resolveBlockedSignProductionCandidate`) the
 * operator review page itself uses to decide what to show for approval —
 * never an asset id a caller could supply, so a stale or foreign candidate
 * can never be approved by construction (mirrors `download/route.ts`'s
 * identical "no client-supplied asset id" discipline).
 *
 * Deliberately its own file rather than a new export inside
 * `sign-qr-preservation-service.ts`: this action's identity resolution is
 * about VISUAL REVIEW authority, never about QR decode/generation/
 * destination-confirmation mechanics — that file's own header comment
 * scopes it to exactly those four QR-technical actions.
 */
import { getCapabilityGraph } from "@/capabilities/composition";
import { doesSignCandidateContainQrReplacement } from "@/capabilities/final-artwork/sign-candidate-visual-acceptance";
import { isRigidSignValidationTrulyPrintReady } from "@/capabilities/print-validation/rigid-sign-print-ready-authority";
import { getProjectRepository } from "@/lib/db";
import { UniqueConstraintViolationError } from "@/lib/db/repository";

export class SignCandidateVisualAcceptanceError extends Error {}

export interface SignCandidateVisualAcceptanceResult {
  assetId: string;
  acceptedAt: string;
  alreadyAccepted: boolean;
}

export async function acceptSignCandidateVisualArtwork(
  projectId: string,
): Promise<SignCandidateVisualAcceptanceResult> {
  const repo = getProjectRepository();
  const preparation = await repo.getSignPreparation(projectId);
  if (!preparation || preparation.projectId !== projectId || !preparation.planKey) {
    throw new SignCandidateVisualAcceptanceError("No sign production plan exists for this project.");
  }

  // Blocked Production Candidate Inspection Phase's own resolver answers
  // exactly the question this action needs: "what should an operator
  // visually inspect right now for the CURRENT plan's job" — the identical
  // resolver the review page itself uses to decide what to show for
  // approval, never re-derived here.
  //
  // Idempotency (a repeated/double-click approval): once THIS EXACT
  // candidate is accepted, it is by definition no longer "blocked" —
  // `resolveBlockedSignProductionCandidate` correctly stops returning it,
  // the moment the very first approval succeeds. A second approval attempt
  // must not read that as "nothing to approve" — it falls back to the
  // satisfied-delivery resolver, which now names the SAME candidate, so the
  // idempotent-lookup branch below still finds and returns the existing row.
  const graph = getCapabilityGraph();
  const blocked = await graph.finalArtwork.resolveBlockedSignProductionCandidate(projectId);
  const current = blocked ?? (await graph.finalArtwork.resolveCurrentSignProductionDelivery(projectId));
  if (!current) {
    throw new SignCandidateVisualAcceptanceError(
      "There is no production candidate currently awaiting visual approval for this project.",
    );
  }

  const validation = await repo.getLatestProductionAssetValidationForJob(projectId, current.job.id);
  if (!validation || validation.assetId !== current.assetId) {
    // Lost a race against a newer validation persisted between the two
    // reads above — fail closed rather than approve evidence that may no
    // longer describe the current candidate.
    throw new SignCandidateVisualAcceptanceError(
      "This candidate's validation changed while approving it — please try again.",
    );
  }
  if (!isRigidSignValidationTrulyPrintReady(validation.report)) {
    throw new SignCandidateVisualAcceptanceError(
      "This candidate is not yet technically valid — there is nothing to approve yet.",
    );
  }

  const requiresAcceptance = await doesSignCandidateContainQrReplacement(
    repo,
    projectId,
    current.job.id,
    current.assetId,
  );
  if (!requiresAcceptance) {
    throw new SignCandidateVisualAcceptanceError(
      "This artwork has no material visible revision that requires approval.",
    );
  }

  const existing = await repo.getSignCandidateVisualAcceptance(projectId, current.assetId);
  if (existing) {
    return { assetId: current.assetId, acceptedAt: existing.acceptedAt, alreadyAccepted: true };
  }

  try {
    const acceptance = await repo.createSignCandidateVisualAcceptance(projectId, {
      finalArtworkJobId: current.job.id,
      assetId: current.assetId,
      planKey: preparation.planKey,
      // Internal-operator-gated route only in V1 — no customer-facing
      // counterpart exists yet, mirroring `sign_plan_authorization`'s own
      // narrow actor-type precedent.
      acceptedBy: "operator",
    });
    return { assetId: current.assetId, acceptedAt: acceptance.acceptedAt, alreadyAccepted: false };
  } catch (error) {
    if (error instanceof UniqueConstraintViolationError) {
      // Lost a race to a concurrent approval of the exact same candidate —
      // the winning row now exists; idempotent from the caller's view.
      const race = await repo.getSignCandidateVisualAcceptance(projectId, current.assetId);
      if (race) return { assetId: current.assetId, acceptedAt: race.acceptedAt, alreadyAccepted: true };
    }
    throw error;
  }
}
