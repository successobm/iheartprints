import type { AcquisitionCapability } from "@/capabilities/acquisition";
import type { ProjectRepository } from "@/lib/db/repository";

/**
 * Phase 28K: the narrow authorization boundary for the customer-owned
 * artwork-review/correction surface (separation review, consequential-region
 * decisions, the "Edit Artwork" manual-correction editor, and previewing
 * their results).
 *
 * WHY THIS EXISTS
 *
 * "Intelligent Separation Phase 9/10" and "Phase 27E" (the Magic Wand
 * editor) were both built and deliberately, extensively tested as
 * INTERNAL-STAFF-ONLY surfaces (`isInternalProject`) — proven correct for
 * that purpose by `separation-routes-authorization.test.ts`'s own "PUBLIC
 * SECURITY" tests. Phase 28F later mounted `SeparationReviewPanel` (and
 * `CorrectionWorkspace`/"Edit Artwork") directly into the ordinary,
 * non-internal CUSTOMER flow (`UploadedArtworkPanel.tsx`) as the one
 * consolidated review — but never widened the routes those components call.
 * The result: an ordinary customer whose own artwork genuinely has
 * consequential regions needing a decision hits a real, correct backend
 * refusal (`approvePreparedArtwork` in `artwork-preparation-capability.ts`)
 * with NO route capable of letting them see or resolve it — an impossible
 * gate found on a real acceptance run (Phase 28K).
 *
 * THE FIX, PRECISELY SCOPED
 *
 * This predicate widens exactly those routes' gate from "internal staff
 * only" to "internal staff OR this project's own owner" — nothing broader.
 * It does NOT touch `/api/internal/magic-wand/*` (a genuinely separate,
 * staff-only diagnostic surface with its own route tree), and it does NOT
 * touch `production-treatment/preview` (Halftone preview — out of this
 * phase's scope; Halftone is unreachable this early in the flow anyway,
 * per Phase 28I's Raster-first gate).
 *
 * THE AUTHORITY MODEL THIS REUSES, NOT REINVENTS
 *
 * `acquisition-capability.ts`'s own documented "AUTHORITY MODEL" is
 * explicit: this product has no login, no accounts, no per-request session
 * verification for ordinary customer actions — "every paid-value decision
 * resolves authority from the PROJECT... The cookie's only job is deciding
 * which session a BRAND NEW project is created under." Every existing
 * customer-facing artwork-preparation route (the main `/artwork-preparation`
 * route, `/print-size/confirm`, etc.) already authorizes solely on "this
 * project id resolves to a real project" — knowing the project's id IS
 * ownership in this system, exactly as documented. This predicate applies
 * that SAME existing boundary here, rather than inventing a stronger one
 * these routes never had and no other customer route enforces either.
 *
 * WHAT REMAINS SAFE
 *
 * Every downstream capability function this gate protects
 * (`getSeparationReview`, `submitRegionDecisions`, `approveSeparationMaster`,
 * `acceptCorrectionOperation`, `finalizeCorrection`, etc.) already resolves
 * ALL of its data — preparation, original asset, decisions — by looking it
 * up FROM the given `projectId` alone (`repo.getArtworkPreparation(projectId)`
 * and friends), never from a client-supplied preparation/asset id. A caller
 * can therefore never reach another project's preparation or asset through
 * this gate: passing a different project's id simply operates on THAT
 * project's own data, under this exact same rule. This predicate widens WHO
 * may pass the gate; it does not change what lies behind it.
 */
export async function isAuthorizedForArtworkCorrection(
  acquisition: AcquisitionCapability,
  repo: ProjectRepository,
  projectId: string,
): Promise<boolean> {
  if (await acquisition.isInternalProject(projectId)) return true;
  const snapshot = await repo.getProject(projectId);
  return snapshot !== null;
}
