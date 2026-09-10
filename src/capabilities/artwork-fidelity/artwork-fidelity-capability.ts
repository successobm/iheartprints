/**
 * Universal Raster Reconstruction Phase R3B: durable persistence +
 * confirmation for the Artwork Fidelity Contract foundation. See
 * `ArtworkFidelityContract`'s own doc comment (`@/lib/domain/types`) and
 * `capability-boundaries.ts`'s "ARTWORK FIDELITY CONTRACT" section for the
 * full architectural context (Phase R3A audit). Phase R3B-R (independent
 * review) repaired confirmed-contract immutability and added a DB-level
 * status-consistency constraint — see `confirmContract`'s own doc comment
 * and the migration's own comment for the full reasoning.
 *
 * Structural properties, mirroring `SignPreparationCapability`:
 *
 *   - depends on `ProjectRepository` only — NO provider port of any kind.
 *     Nothing in this module can make a network call, extract vision
 *     evidence, run OCR, or call a reconstruction provider. Those are
 *     future, separately-approved phases that would CONSUME a confirmed
 *     contract this capability produces — never the other way around.
 *   - the source binding (`sourceAssetId`/`sourceSha256`) is set once, at
 *     `proposeContract`, and is NEVER patched afterward — a different
 *     source means a new contract, mirroring `SignPreparation
 *     .originalAssetId`'s immutability.
 *   - `confirmContract` is the ONLY way facts become authoritative, and may
 *     be called ONLY ONCE per contract — a CONFIRMED contract is an
 *     immutable authority snapshot, never mutated in place, mirroring
 *     `FinalDirectionApproval`/`DesignBriefVersion`'s own freeze-on-
 *     approve, supersede-not-overwrite precedent (never `SignPreparation
 *     .authorizedPlanKey`'s in-place-update precedent — that one is safe
 *     ONLY because a downstream `FinalArtworkJob` freezes its own copy of
 *     the key, which nothing in THIS phase does yet). A correction
 *     proposes and confirms a NEW contract; `getContract(projectId)`'s
 *     existing "latest by `createdAt`" resolution is what makes the new
 *     one "current" — no superseding flag needed.
 *   - Machine-proposed facts (`proposedFacts`) are never promoted to
 *     confirmed authority merely by existing — the caller must explicitly
 *     supply the confirmed values, even when they happen to equal the
 *     proposal.
 *   - all reads are project-scoped; a cross-project id resolves to
 *     not-found, never to another project's data.
 */

import type { ProjectRepository } from "@/lib/db/repository";
import type {
  ArtworkFidelityContract,
  ProtectedMarkType,
  SignPlanAuthorizationActor,
} from "@/lib/domain/types";
import {
  deriveArtworkFidelityContractKey,
  type ArtworkFidelityContractIdentityInput,
} from "./artwork-fidelity-contract-identity";

export class ArtworkFidelityContractStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtworkFidelityContractStateError";
  }
}

export interface ProposeArtworkFidelityContractInput {
  sourceAssetId: string;
  sourceSha256: string;
  /**
   * Non-authoritative machine-proposed evidence — "I believe this artwork
   * contains X" — from a future vision-extraction step. `null`/omitted is
   * entirely valid: a contract may be proposed with nothing pre-filled,
   * for a human to fill in from scratch.
   */
  proposedFacts?: Record<string, unknown> | null;
}

export interface ConfirmArtworkFidelityContractInput {
  /**
   * The CURRENT source sha256, as measured by the caller right now —
   * never trusted from a stale request body. Refused (fails closed) unless
   * it equals the contract's own `sourceSha256` (Phase R3A Step 9: "verify
   * source SHA binding").
   */
  currentSourceSha256: string;
  /**
   * A SET of exact required strings, not a sequence with its own meaning —
   * V1 represents no reading-order, placement, or layout/hierarchy
   * authority at all (no such field exists on this contract), so array
   * order is not semantically authoritative and `confirmContract`
   * deduplicates literal-duplicate entries before storing (Phase R3B-R:
   * `["ABC","ABC"]` and `["ABC"]` are the identical fidelity claim). The
   * STORED order is still whatever first-occurrence order the caller
   * supplied (useful for a future display/prompt-phrasing use), but
   * `deriveArtworkFidelityContractKey` treats it as order-insensitive. An
   * EMPTY array is a valid, explicit "confirmed: no required wording" fact
   * — distinct from `null` on the stored contract, which means "never
   * confirmed at all" (mirrors `RequiredWordingMode`'s own `"none"` vs
   * `"unknown"` distinction). Never normalized here or anywhere downstream
   * of this call — exact capitalization and punctuation ARE the fact.
   */
  confirmedWording: string[];
  /** Closed set, deduplicated the same way as `confirmedWording` (Phase R3B-R). An empty array is a valid, explicit "confirmed: no protected marks present" fact. */
  confirmedMarks: ProtectedMarkType[];
  confirmedBy: SignPlanAuthorizationActor;
  /**
   * Deterministic machine EVIDENCE, never customer-authored (Phase R3A
   * Step 4D) — optional; `undefined` leaves any previously-recorded value
   * untouched, `null` explicitly clears it.
   */
  sourceContentBoundingBoxAspectRatio?: number | null;
}

export interface ArtworkFidelityCapability {
  /**
   * Creates a new, `"proposed"` contract bound to an immutable source —
   * carries NO reconstruction authority until `confirmContract` is called.
   */
  proposeContract(
    projectId: string,
    input: ProposeArtworkFidelityContractInput,
  ): Promise<ArtworkFidelityContract>;
  /**
   * Latest contract for the project under existing repository ordering
   * (most recent `createdAt` — mirrors `getSignPreparation`/
   * `getArtworkPreparation`'s own "latest for project" resolution). This IS
   * the "current contract" pointer: once a correction proposes and confirms
   * a NEW contract (see `confirmContract`'s own doc comment), this method
   * starts returning the new one, while the prior confirmed contract
   * remains reachable, unchanged, via `getContractById`.
   */
  getContract(projectId: string): Promise<ArtworkFidelityContract | null>;
  getContractById(id: string): Promise<ArtworkFidelityContract | null>;
  /**
   * Establishes CONFIRMED authority on a `"proposed"` contract. Refuses
   * (fails closed) if the source has changed underneath the contract since
   * it was proposed, if the confirming actor is missing, or — Phase R3B-R
   * (independent-review repair) — if the contract is ALREADY
   * `"confirmed"`.
   *
   * A CONFIRMED CONTRACT IS AN IMMUTABLE AUTHORITY SNAPSHOT. It is never
   * mutated in place after confirmation — not even to "correct" it. A
   * hash-mismatch staleness check alone (comparing a stored `contractKey`
   * against a freshly recomputed one) proves a prior authority is no
   * longer current, but it does NOT preserve what that prior authority
   * actually said once the row itself has been overwritten — and this
   * phase builds no downstream candidate/job record yet that would freeze
   * its own copy the way `FinalArtworkJob.signPlanKey` does for
   * `SignPreparation.planKey`. Without a frozen row, "the customer
   * confirmed ™, then later corrected it to ®" becomes permanently
   * unrecoverable the instant an in-place update lands — exactly the
   * `FinalDirectionApproval`/`DesignBriefVersion` freeze-on-approve,
   * supersede-not-overwrite precedent this codebase already established
   * for customer-confirmed creative/textual authority, and the precedent
   * this contract now follows too.
   *
   * A correction therefore requires the caller to `proposeContract` again
   * (a new row, bound to the same source) and `confirmContract` that new
   * id — never a second call to `confirmContract` against an id already
   * `"confirmed"`. `getContract(projectId)`'s existing "latest by
   * createdAt" resolution is sufficient to make the new contract "current"
   * with no further change — no new status value, no superseding flag, no
   * separate pointer table.
   */
  confirmContract(
    projectId: string,
    id: string,
    input: ConfirmArtworkFidelityContractInput,
  ): Promise<ArtworkFidelityContract>;
}

/**
 * Phase R3B-R (independent-review repair): collapses literal duplicate
 * entries while preserving first-occurrence order and exact content —
 * never lowercases, trims, or otherwise touches a string's own characters.
 * `["ABC","ABC"]` and `["ABC"]` become the same stored/hashed fact;
 * `["ABC","abc"]` do NOT collapse (different exact content, per Phase R3A
 * Step 11 — capitalization is never normalized away).
 */
function dedupePreservingOrder<T>(values: readonly T[]): T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

async function loadOwned(
  repo: ProjectRepository,
  projectId: string,
  id: string,
): Promise<ArtworkFidelityContract> {
  const project = await repo.getProject(projectId);
  if (!project) throw new ArtworkFidelityContractStateError("Project not found");
  const contract = await repo.getArtworkFidelityContractById(id);
  if (!contract || contract.projectId !== projectId) {
    throw new ArtworkFidelityContractStateError(
      "No artwork fidelity contract exists for this project with that id.",
    );
  }
  return contract;
}

export function createArtworkFidelityCapability(
  repo: ProjectRepository,
): ArtworkFidelityCapability {
  return {
    async proposeContract(projectId, input) {
      const project = await repo.getProject(projectId);
      if (!project) throw new ArtworkFidelityContractStateError("Project not found");
      if (!input.sourceAssetId) {
        throw new ArtworkFidelityContractStateError("sourceAssetId is required.");
      }
      if (!input.sourceSha256) {
        throw new ArtworkFidelityContractStateError("sourceSha256 is required.");
      }
      return repo.createArtworkFidelityContract(projectId, {
        sourceAssetId: input.sourceAssetId,
        sourceSha256: input.sourceSha256,
        proposedFacts: input.proposedFacts ?? null,
      });
    },

    async getContract(projectId) {
      return repo.getArtworkFidelityContract(projectId);
    },

    async getContractById(id) {
      return repo.getArtworkFidelityContractById(id);
    },

    async confirmContract(projectId, id, input) {
      const contract = await loadOwned(repo, projectId, id);
      // Phase R3B-R (independent-review repair): a confirmed contract is an
      // immutable authority snapshot — see this method's own doc comment
      // for the full reasoning. Refuse outright rather than silently
      // overwriting a prior confirmation; the caller must propose a new
      // contract for a correction.
      if (contract.status === "confirmed") {
        throw new ArtworkFidelityContractStateError(
          "This contract is already confirmed and is immutable authority. Propose and confirm a new contract to record a correction.",
        );
      }
      // Phase R3A Step 9: verify source SHA binding before granting
      // authority — a source that changed underneath a proposed contract
      // must never let stale facts become confirmed authority for the
      // NEW bytes.
      if (input.currentSourceSha256 !== contract.sourceSha256) {
        throw new ArtworkFidelityContractStateError(
          "The source artwork has changed since this contract was proposed; propose a new contract instead of confirming a stale one.",
        );
      }
      if (
        input.confirmedBy !== "customer" &&
        input.confirmedBy !== "operator"
      ) {
        // Belt-and-suspenders: the TS type already restricts this, but a
        // boundary (a future API route) may hand this function an
        // unvalidated value — model-proposed content must never satisfy
        // confirmed authority by slipping through as an unrecognized actor.
        throw new ArtworkFidelityContractStateError(
          "confirmedBy must be an explicit customer or operator confirmation.",
        );
      }

      // Phase R3B-R (independent-review repair): deduplicate before storing
      // and before deriving identity. Confirmed wording/marks are each a
      // SET of exact required facts, never a sequence with its own
      // meaning — V1 represents no reading-order, placement, or hierarchy
      // authority at all (no such field exists on this contract), so
      // `["ABC","ABC"]` and `["ABC"]` must be the identical fidelity claim,
      // not two different ones that happen to produce different keys.
      // Exact string CONTENT is preserved verbatim (capitalization,
      // punctuation) — only literal duplicate entries collapse.
      const confirmedWording = dedupePreservingOrder(input.confirmedWording);
      const confirmedMarks = dedupePreservingOrder(input.confirmedMarks);

      const identity: ArtworkFidelityContractIdentityInput = {
        sourceAssetId: contract.sourceAssetId,
        sourceSha256: contract.sourceSha256,
        confirmedWording,
        confirmedMarks,
        sourceContentBoundingBoxAspectRatio:
          input.sourceContentBoundingBoxAspectRatio === undefined
            ? contract.sourceContentBoundingBoxAspectRatio
            : input.sourceContentBoundingBoxAspectRatio,
      };
      const contractKey = deriveArtworkFidelityContractKey(identity);

      return repo.updateArtworkFidelityContract(id, {
        status: "confirmed",
        confirmedWording,
        confirmedMarks,
        confirmedBy: input.confirmedBy,
        confirmedAt: new Date().toISOString(),
        sourceContentBoundingBoxAspectRatio: identity.sourceContentBoundingBoxAspectRatio,
        contractKey,
      });
    },
  };
}

// Exported for future callers (a future reconstruction capability) — see
// this function's own doc comment for exactly why a proposed contract's
// `contractKey` is never trusted, and why every field participating in the
// key is documented and stable.
export { deriveArtworkFidelityContractKey } from "./artwork-fidelity-contract-identity";
export type { ArtworkFidelityContractIdentityInput } from "./artwork-fidelity-contract-identity";
