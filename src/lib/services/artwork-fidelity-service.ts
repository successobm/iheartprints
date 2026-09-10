/**
 * Universal Raster Reconstruction Phase R4A: stable facade for the artwork
 * fidelity proposal + customer confirmation API route, mirroring
 * `artwork-preparation-service.ts`/`sign-artwork-service.ts`'s own role.
 *
 * Composes THREE capabilities (`ArtworkPreparationCapability` — to resolve
 * the immutable original source asset; `AssetCapability` — to read its
 * bytes server-side; `ArtworkFidelityProposalCapability` +
 * `ArtworkFidelityCapability` — to extract and then durably propose/confirm
 * facts). Per `capability-boundaries.ts`'s own rule, none of those
 * capabilities may depend on each other directly — this cross-capability
 * orchestration belongs here, at the app layer, exactly like
 * `sign-artwork-service.ts`'s `bridgeSignArtworkIfNeeded` composes
 * `ArtworkPreparationCapability` + `SignPreparationCapability`.
 *
 * SOURCE BINDING: always resolved from `artworkPreparation
 * .getOriginalAssetReference` — the SAME immutable original both the DTF
 * and (via `bridgeSignArtworkIfNeeded`) Signs paths already key off of.
 * Fidelity proposal/confirmation therefore runs against one shared source
 * identity regardless of which production profile the customer later
 * chooses, and — critically — BEFORE either profile's own destructive
 * processing (DTF background removal; Signs composition planning) has had
 * any chance to touch the evidence.
 *
 * `sourceSha256` is ALWAYS recomputed server-side from freshly downloaded
 * bytes, on both propose and confirm — NEVER trusted from a client request
 * body. This is what makes `confirmContract`'s own staleness check
 * (Phase R3A Step 9) actually mean something end-to-end.
 *
 * AUTHORITY RULE (restated from `ArtworkFidelityCapability`'s own doc
 * comment): a successful `proposeArtworkFidelity` call creates/updates ONLY
 * a `"proposed"` contract. It can NEVER set `confirmedBy`, `confirmedAt`,
 * `contractKey`, `confirmedWording`, or `confirmedMarks` — those fields are
 * set exclusively by `confirmArtworkFidelity`, which requires an explicit
 * customer (or operator) action.
 */

import { getCapabilityGraph } from "@/capabilities/composition";
import { sha256Hex, toProposedFactsRecord } from "@/capabilities/artwork-fidelity-proposal";
import { ArtworkFidelityContractStateError } from "@/capabilities/artwork-fidelity";
import type { ProtectedMarkType, SignPlanAuthorizationActor } from "@/lib/domain/types";
import {
  getConversation,
  type ApiProjectSnapshot,
} from "@/lib/services/conversation-service";

export class ArtworkFidelityServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtworkFidelityServiceError";
  }
}

/**
 * The customer-safe read model itself (`ArtworkFidelityView`) is defined
 * and resolved in `conversation-service.ts` (`resolveArtworkFidelityView`),
 * not here — that module is the ONE place `ApiProjectSnapshot` is
 * assembled, mirroring exactly how `SignArtworkView` lives there rather
 * than in `sign-artwork-service.ts`. This file imports `ApiProjectSnapshot`
 * FROM `conversation-service.ts`; defining the view type here too would
 * create a circular import between the two modules.
 */

async function resolveOriginalSourceBytes(
  projectId: string,
): Promise<{ assetId: string; bytes: Buffer; contentType: string; sha256: string }> {
  const graph = getCapabilityGraph();
  const reference = await graph.artworkPreparation.getOriginalAssetReference(projectId);
  if (!reference) {
    throw new ArtworkFidelityServiceError(
      "Upload your artwork before we can check it for text and symbols.",
    );
  }
  const downloaded = await graph.assets.downloadAssetBytes(reference.assetId);
  if (!downloaded) {
    throw new ArtworkFidelityServiceError(
      "We couldn't read your uploaded artwork. Please try uploading again.",
    );
  }
  return {
    assetId: reference.assetId,
    bytes: downloaded.bytes,
    contentType: downloaded.contentType,
    sha256: sha256Hex(downloaded.bytes),
  };
}

/**
 * The customer's (or, via the internal operator surface, an operator's)
 * "check my artwork for text and symbols" action. Idempotent against the
 * CURRENT immutable source: if a contract already exists bound to the same
 * `sourceAssetId`/`sourceSha256`, this is a no-op that returns the existing
 * proposal rather than re-spending a paid provider call — mirroring
 * `bridgeSignArtworkIfNeeded`'s own "second call is always a no-op"
 * discipline. A provider failure never throws here (see
 * `ArtworkFidelityProposalCapability`'s own doc comment) — it degrades to
 * an empty proposal, still persisted as `status: "proposed"`, so the
 * customer can fill in every field by hand exactly as if no proposal
 * capability existed.
 */
export async function proposeArtworkFidelity(
  projectId: string,
): Promise<ApiProjectSnapshot> {
  const graph = getCapabilityGraph();
  const source = await resolveOriginalSourceBytes(projectId);

  const existing = await graph.artworkFidelity.getContract(projectId);
  if (
    existing &&
    existing.sourceAssetId === source.assetId &&
    existing.sourceSha256 === source.sha256
  ) {
    return requireSnapshot(projectId);
  }

  const proposedFacts = await graph.artworkFidelityProposal.proposeFacts({
    bytes: source.bytes,
    contentType: source.contentType,
  });

  // AUTHORITY INVARIANT: `proposeContract` can only ever create a row with
  // `status: "proposed"` — see `ArtworkFidelityCapability.proposeContract`'s
  // own implementation. Nothing in this function path can set
  // `confirmedBy`/`confirmedAt`/`contractKey`.
  await graph.artworkFidelity.proposeContract(projectId, {
    sourceAssetId: source.assetId,
    sourceSha256: source.sha256,
    proposedFacts: toProposedFactsRecord(proposedFacts),
  });
  return requireSnapshot(projectId);
}

export interface ConfirmArtworkFidelityInput {
  confirmedWording: string[];
  confirmedMarks: ProtectedMarkType[];
  confirmedBy: SignPlanAuthorizationActor;
}

/**
 * The customer's (or operator's) explicit "Confirm what's in your artwork"
 * submission. Re-resolves and re-hashes the CURRENT source bytes server-side
 * — never trusts a client-supplied sha256 — so `ArtworkFidelityCapability
 * .confirmContract`'s own staleness check (Section 10) is checking a real,
 * freshly-measured fact, not a value the request body merely asserted.
 *
 * Every other confirmation rule (already-confirmed refusal, invalid-actor
 * refusal) is enforced by `confirmContract` itself and surfaces here as an
 * `ArtworkFidelityContractStateError`, translated by the API route into a
 * 409/400 the client can show the customer — never a partial mutation
 * (Section 10: "no partial mutation on refusal").
 */
export async function confirmArtworkFidelity(
  projectId: string,
  input: ConfirmArtworkFidelityInput,
): Promise<ApiProjectSnapshot> {
  const graph = getCapabilityGraph();
  const contract = await graph.artworkFidelity.getContract(projectId);
  if (!contract) {
    throw new ArtworkFidelityContractStateError(
      "No artwork fidelity proposal exists yet for this project — check your artwork before confirming.",
    );
  }
  const source = await resolveOriginalSourceBytes(projectId);

  await graph.artworkFidelity.confirmContract(projectId, contract.id, {
    currentSourceSha256: source.sha256,
    confirmedWording: input.confirmedWording,
    confirmedMarks: input.confirmedMarks,
    confirmedBy: input.confirmedBy,
  });
  return requireSnapshot(projectId);
}

async function requireSnapshot(projectId: string): Promise<ApiProjectSnapshot> {
  const snapshot = await getConversation(projectId);
  if (!snapshot) throw new ArtworkFidelityServiceError("Project not found");
  return snapshot;
}
