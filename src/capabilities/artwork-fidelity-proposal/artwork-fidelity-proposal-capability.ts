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
 */

import { createHash } from "node:crypto";

import type { ArtworkFidelityProposalProvider } from "./artwork-fidelity-proposal-provider";
import { downscaleForProposal } from "./downscale-for-proposal";
import {
  ARTWORK_FIDELITY_PROPOSAL_SCHEMA_VERSION,
  type ArtworkFidelityProposedFacts,
} from "./contracts";

export interface ArtworkFidelityProposalInput {
  bytes: Buffer;
  contentType: string;
}

export interface ArtworkFidelityProposalCapability {
  /**
   * Always resolves — never rejects for a provider failure. Returns a
   * `proposedFacts`-shaped payload (empty wording/protectedMarks arrays on
   * any failure, or when the image does not decode).
   */
  proposeFacts(
    input: ArtworkFidelityProposalInput,
  ): Promise<ArtworkFidelityProposedFacts>;
}

function emptyFacts(providerKey: string): ArtworkFidelityProposedFacts {
  return {
    schemaVersion: ARTWORK_FIDELITY_PROPOSAL_SCHEMA_VERSION,
    wording: [],
    protectedMarks: [],
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
        // Does not decode as a PNG -- nothing to honestly propose.
        return emptyFacts(provider.providerKey);
      }

      try {
        const result = await provider.propose({
          bytes: downscaled.bytes,
          contentType: "image/png",
        });
        return {
          schemaVersion: ARTWORK_FIDELITY_PROPOSAL_SCHEMA_VERSION,
          wording: result.wording,
          protectedMarks: result.protectedMarks,
          sanitizedProvider: {
            providerKey: provider.providerKey,
            proposedAt: new Date().toISOString(),
          },
        };
      } catch {
        // Advisory-only: any provider failure (network, rate limit,
        // malformed response, auth, timeout) degrades to an empty proposal
        // rather than blocking the customer or the confirmation flow. The
        // failure itself is not this capability's concern to log or retry
        // further -- the provider already applied its own bounded retry.
        return emptyFacts(provider.providerKey);
      }
    },
  };
}

/** Exported for the service layer -- source sha256 is always computed server-side from the FULL, undownscaled original bytes (never the downscaled copy sent to the provider, and never trusted from a client). */
export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
