/**
 * Universal Raster Reconstruction Phase R3B: durable persistence +
 * confirmation for the Artwork Fidelity Contract foundation. See
 * `ArtworkFidelityContract`'s own doc comment (`@/lib/domain/types`) and
 * `capability-boundaries.ts`'s "ARTWORK FIDELITY CONTRACT" section for the
 * full architectural context (Phase R3A audit).
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
 *   - `confirmContract` is the ONLY way facts become authoritative.
 *     Machine-proposed facts (`proposedFacts`) are never promoted to
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
   * Exact strings, in confirmation order. An EMPTY array is a valid,
   * explicit "confirmed: no required wording" fact — distinct from `null`
   * on the stored contract, which means "never confirmed at all" (mirrors
   * `RequiredWordingMode`'s own `"none"` vs `"unknown"` distinction).
   * Never normalized here or anywhere downstream of this call — exact
   * capitalization and punctuation ARE the fact.
   */
  confirmedWording: string[];
  /** Closed set. An empty array is a valid, explicit "confirmed: no protected marks present" fact. */
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
  getContract(projectId: string): Promise<ArtworkFidelityContract | null>;
  getContractById(id: string): Promise<ArtworkFidelityContract | null>;
  /**
   * Establishes CONFIRMED authority. Refuses (fails closed) if the source
   * has changed underneath the contract since it was proposed, or if the
   * confirming actor is missing. Re-confirming an already-`"confirmed"`
   * contract with corrected facts is explicitly allowed — mirrors "if
   * correction occurs during confirmation, persist the corrected value as
   * authority" (Phase R3A Step 10) — and always recomputes `contractKey`
   * from the newly-confirmed facts, so a prior key becomes stale by
   * construction whenever a confirmed fact actually changed.
   */
  confirmContract(
    projectId: string,
    id: string,
    input: ConfirmArtworkFidelityContractInput,
  ): Promise<ArtworkFidelityContract>;
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

      const identity: ArtworkFidelityContractIdentityInput = {
        sourceAssetId: contract.sourceAssetId,
        sourceSha256: contract.sourceSha256,
        confirmedWording: input.confirmedWording,
        confirmedMarks: input.confirmedMarks,
        sourceContentBoundingBoxAspectRatio:
          input.sourceContentBoundingBoxAspectRatio === undefined
            ? contract.sourceContentBoundingBoxAspectRatio
            : input.sourceContentBoundingBoxAspectRatio,
      };
      const contractKey = deriveArtworkFidelityContractKey(identity);

      return repo.updateArtworkFidelityContract(id, {
        status: "confirmed",
        confirmedWording: input.confirmedWording,
        confirmedMarks: input.confirmedMarks,
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
