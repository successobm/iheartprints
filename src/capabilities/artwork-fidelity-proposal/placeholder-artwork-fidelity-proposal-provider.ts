/**
 * Universal Raster Reconstruction Phase R4A: the safe, network-free default
 * — mirrors `PlaceholderSignPreservationSemanticProvider`'s role exactly.
 * Used by `resolve-artwork-fidelity-proposal-provider.ts` whenever no real
 * provider is configured, and unconditionally forced by
 * `isAutomatedTestEnvironment()` regardless of ambient configuration.
 *
 * Proposes NOTHING — an empty `wording`/`protectedMarks` array — rather than
 * inventing a plausible-looking guess. This is the honest "we did not
 * actually look" answer. Safe by construction: an empty proposal can never
 * satisfy confirmation on its own (Section 9's completeness rule requires
 * every detected region to be resolved; zero detected regions means the
 * customer fills in everything from scratch, exactly as if no proposal
 * capability existed at all).
 *
 * Phase R4A-R (independent-review repair, Blocker 3): `analyzed: false` is
 * the explicit, typed signal that NO real analysis happened here — never to
 * be confused with a genuine successful provider response that happens to
 * have found nothing. See `ProposalAnalysisStatus`'s own doc comment.
 */

import type {
  ArtworkFidelityProposalImageInput,
  ArtworkFidelityProposalProvider,
} from "./artwork-fidelity-proposal-provider";
import type { ArtworkFidelityProposalResult } from "./contracts";

export class PlaceholderArtworkFidelityProposalProvider
  implements ArtworkFidelityProposalProvider
{
  readonly providerKey = "placeholder_artwork_fidelity_proposal";

  async propose(
    _input: ArtworkFidelityProposalImageInput,
  ): Promise<ArtworkFidelityProposalResult> {
    return { wording: [], protectedMarks: [], providerRequestId: null, analyzed: false };
  }
}
