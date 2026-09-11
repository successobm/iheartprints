/**
 * Universal Raster Reconstruction Phase R4A: the capability-layer adapter
 * over `ArtworkFidelityProposalProvider` — mirrors `ConceptEvaluationCapability`'s
 * own role (a thin, provider-consuming capability whose failures degrade to
 * a safe deterministic fallback, never propagate as a customer-facing
 * error). Bounds the source image (`downscaleForProposal`) before ever
 * handing bytes to the provider.
 *
 * Deliberately does NOT depend on `ProjectRepository`, `AssetCapability`, or
 * `ArtworkFidelityCapability` — asset resolution and persistence are
 * cross-capability orchestration and belong in the app-layer service file
 * (`artwork-fidelity-service.ts`), per `capability-boundaries.ts`'s own
 * "cross-capability orchestration... lives in an app-layer service file"
 * rule. This capability's only job is "bytes in, a proposal out" — it never
 * touches a project id, an asset id, or a database.
 *
 * A provider failure of ANY kind (network, rate limit, malformed response,
 * timeout, misconfiguration) degrades to the SAME safe empty result the
 * placeholder provider itself returns — this capability never throws for a
 * provider failure, exactly like `ConceptEvaluationCapability
 * .evaluationFailureFallback`. Proposal extraction is advisory-only; a
 * failed extraction must never block the customer from proceeding to fill
 * facts in by hand.
 *
 * Phase R4A-R (independent-review repair, Blockers 2/3): this is the ONE
 * place `id`s are assigned to wording/mark entries — a proposal-local,
 * position-derived string (`w0`, `w1`, ... / `m0`, `m1`, ...), stable for
 * the life of THIS proposal (a correction always proposes an entirely new
 * row via `proposeArtworkFidelity`, which calls this function again and
 * mints an entirely fresh set of ids — never reuses or renumbers an
 * existing proposal's ids in place). Deliberately the smallest safe
 * identifier scheme: proposal-local, deterministic, server-assigned, never
 * derived from or trusted from client input, and never free text (Section 4
 * of the R4A-R task) — a full UUID/random id would work too but adds
 * nothing this narrower scheme doesn't already provide, since uniqueness is
 * only ever required WITHIN one proposal, never across the whole table.
 *
 * Also the ONE place `proposalStatus` is derived: `"analyzed"` only when the
 * provider itself reports `analyzed: true` (a genuine successful response,
 * even one that found nothing); `"unavailable"` for the placeholder, for a
 * caught provider failure, and for an undecodable source image. See
 * `ProposalAnalysisStatus`'s own doc comment in `contracts.ts` for why this
 * distinction exists at all.
 */

import { createHash } from "node:crypto";

import type { ArtworkFidelityProposalProvider } from "./artwork-fidelity-proposal-provider";
import { downscaleForProposal } from "./downscale-for-proposal";
import {
  ARTWORK_FIDELITY_PROPOSAL_SCHEMA_VERSION,
  type ArtworkFidelityProposedFacts,
  type ProtectedMarkFactProposal,
  type RawProtectedMarkFactProposal,
  type RawWordingFactProposal,
  type WordingFactProposal,
} from "./contracts";

export interface ArtworkFidelityProposalInput {
  bytes: Buffer;
  contentType: string;
}

export interface ArtworkFidelityProposalCapability {
  /**
   * Always resolves — never rejects for a provider failure. Returns a
   * `proposedFacts`-shaped payload (empty wording/protectedMarks arrays,
   * `proposalStatus: "unavailable"` on any failure or when the image does
   * not decode).
   */
  proposeFacts(
    input: ArtworkFidelityProposalInput,
  ): Promise<ArtworkFidelityProposedFacts>;
}

function assignWordingIds(entries: RawWordingFactProposal[]): WordingFactProposal[] {
  return entries.map((entry, index) => ({ id: `w${index}`, ...entry }));
}

/**
 * Phase R4A-R (independent-review repair, Section 5): when the provider
 * proposes ZERO mark regions, the customer must still be given exactly one
 * explicit protected-mark question to resolve — never a silent "nothing to
 * ask, so nothing confirmed" default. A single, clearly-labeled catch-all
 * region (`id: "m0"`, `classification: "cannot_determine"`) lets the SAME
 * per-id resolution/validation mechanism
 * (`validateAndDeriveConfirmation`) cover this case identically to a real
 * detected region, rather than a separate, unvalidated "zero means none"
 * shortcut. Applied REGARDLESS of why zero marks resulted — a genuine
 * successful analysis that found nothing, a caught provider failure, and
 * the safe placeholder all go through this exact same path, so the
 * customer always gets exactly one mark decision to make either way.
 */
function assignMarkIds(entries: RawProtectedMarkFactProposal[]): ProtectedMarkFactProposal[] {
  if (entries.length === 0) {
    return [{ id: "m0", visualDescription: "", classification: "cannot_determine", confidence: "low" }];
  }
  return entries.map((entry, index) => ({ id: `m${index}`, ...entry }));
}

function unavailableFacts(providerKey: string): ArtworkFidelityProposedFacts {
  return {
    schemaVersion: ARTWORK_FIDELITY_PROPOSAL_SCHEMA_VERSION,
    proposalStatus: "unavailable",
    wording: [],
    protectedMarks: assignMarkIds([]),
    sanitizedProvider: { providerKey, proposedAt: new Date().toISOString() },
  };
}

export function createArtworkFidelityProposalCapability(
  provider: ArtworkFidelityProposalProvider,
): ArtworkFidelityProposalCapability {
  return {
    async proposeFacts(input) {
      const downscaled = downscaleForProposal(input.bytes);
      if (!downscaled) {
        // Does not decode as a PNG -- nothing to honestly propose, and no
        // real analysis happened.
        return unavailableFacts(provider.providerKey);
      }

      try {
        const result = await provider.propose({
          bytes: downscaled.bytes,
          contentType: "image/png",
        });
        return {
          schemaVersion: ARTWORK_FIDELITY_PROPOSAL_SCHEMA_VERSION,
          proposalStatus: result.analyzed ? "analyzed" : "unavailable",
          wording: assignWordingIds(result.wording),
          protectedMarks: assignMarkIds(result.protectedMarks),
          sanitizedProvider: {
            providerKey: provider.providerKey,
            proposedAt: new Date().toISOString(),
          },
        };
      } catch {
        // Advisory-only: any provider failure (network, rate limit,
        // malformed response, auth, timeout) degrades to an empty,
        // "unavailable" proposal rather than blocking the customer or the
        // confirmation flow. The failure itself is not this capability's
        // concern to log or retry further -- the provider already applied
        // its own bounded retry.
        return unavailableFacts(provider.providerKey);
      }
    },
  };
}

/** Exported for the service layer -- source sha256 is always computed server-side from the FULL, undownscaled original bytes (never the downscaled copy sent to the provider, and never trusted from a client). */
export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
